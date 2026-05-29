use crate::{pets, utils};
use serde_json::json;
use std::fs;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetdexData {
    pub pets: Vec<pets::PetInfo>,
    pub active: Option<String>,
    pub compact_width: u32,
    pub compact_height: u32,
    pub menu_width: u32,
    pub menu_height: u32,
}

#[tauri::command]
pub fn read_petdex_data() -> PetdexData {
    let all_pets = pets::scan_pets();
    let active = pets::get_active_slug().or_else(|| {
        all_pets.first().map(|p| p.slug.clone())
    });

    PetdexData {
        pets: all_pets,
        active,
        compact_width: 140,
        compact_height: 180,
        menu_width: 480,
        menu_height: 420,
    }
}

#[tauri::command]
pub fn set_active(slug: String) -> Result<serde_json::Value, String> {
    if !utils::is_valid_slug(&slug) {
        return Err("invalid_slug".to_string());
    }

    // Find pet root
    let pet_root = find_pet_root(&slug).ok_or("Pet not found")?;

    // Validate pet.json exists
    let pet_json_path = pet_root.join("pet.json");
    if !pet_json_path.exists() {
        return Err("Pet not found".to_string());
    }

    // Find spritesheet (webp or png)
    let webp_path = pet_root.join("spritesheet.webp");
    let png_path = pet_root.join("spritesheet.png");
    let (sprite_path, ext) = if webp_path.exists() {
        (webp_path, "webp")
    } else if png_path.exists() {
        (png_path, "png")
    } else {
        return Err("Spritesheet not found".to_string());
    };

    // Copy spritesheet to webview root
    let webview_dir = utils::petdex_webview_dir();
    let dst = if ext == "webp" {
        webview_dir.join("spritesheet.webp")
    } else {
        webview_dir.join("spritesheet.png")
    };
    fs::copy(&sprite_path, &dst).map_err(|e| e.to_string())?;

    // Write active.json
    let active_path = utils::petdex_runtime_dir().join("active.json");
    let active_data = json!({
        "slug": slug,
        "dir": pet_root.to_string_lossy().to_string(),
    });
    fs::write(&active_path, active_data.to_string()).map_err(|e| e.to_string())?;

    Ok(json!({"ok": true}))
}

#[tauri::command]
pub async fn install_pet(slug: String) -> Result<serde_json::Value, String> {
    if !utils::is_valid_slug(&slug) {
        return Ok(json!({"ok": false, "error": "invalid_slug"}));
    }

    let home = dirs::home_dir().ok_or("HOME not set")?;
    let cli_path = home.join(".petdex").join("bin").join("petdex.js");

    if !cli_path.exists() {
        return Ok(json!({"ok": false, "error": "cli_not_persisted"}));
    }

    let output = tokio::process::Command::new("node")
        .arg(&cli_path)
        .arg("install")
        .arg(&slug)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        // Restage assets after install
        let _ = pets::stage_webview_assets();
        Ok(json!({"ok": true}))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Ok(json!({"ok": false, "error": format!("exit_{}: {}", output.status.code().unwrap_or(-1), stderr)}))
    }
}

fn find_pet_root(slug: &str) -> Option<std::path::PathBuf> {
    for root in &[utils::petdex_pets_dir(), utils::codex_pets_dir()] {
        let path = root.join(slug);
        if path.exists() {
            return Some(path);
        }
    }
    None
}