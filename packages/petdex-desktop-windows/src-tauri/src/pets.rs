use std::fs;
use std::path::Path;
use crate::utils;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetInfo {
    pub slug: String,
    pub display_name: String,
}

pub fn scan_pets() -> Vec<PetInfo> {
    let mut pets = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for root in &[utils::petdex_pets_dir(), utils::codex_pets_dir()] {
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                let slug = entry.file_name().to_string_lossy().to_string();
                if !seen.insert(slug.clone()) {
                    continue; // Skip duplicates
                }
                let pet_json = entry.path().join("pet.json");
                if let Ok(content) = fs::read_to_string(&pet_json) {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                        let display_name = json["displayName"]
                            .as_str()
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| slug.clone());
                        pets.push(PetInfo {
                            slug,
                            display_name,
                        });
                    }
                }
            }
        }
    }

    pets.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    pets
}

pub fn stage_webview_assets() -> Result<(), String> {
    let webview_dir = utils::petdex_webview_dir();
    let agents_dir = webview_dir.join("agents");
    fs::create_dir_all(&agents_dir).map_err(|e| e.to_string())?;

    // Stage agent SVGs (inline for now, or copy from resources)
    // For MVP, we'll create simple SVGs
    for (name, content) in AGENT_SVGS {
        let path = agents_dir.join(name);
        if !path.exists() {
            fs::write(&path, content).map_err(|e| e.to_string())?;
        }
    }

    // Stage pet thumbnails
    let pets = scan_pets();
    for pet in &pets {
        let src_dir = find_pet_root(&pet.slug);
        if let Some(src) = src_dir {
            // Try webp first, then png
            let src_webp = src.join("spritesheet.webp");
            let src_png = src.join("spritesheet.png");
            let dst_dir = webview_dir.join(&pet.slug);
            fs::create_dir_all(&dst_dir).map_err(|e| e.to_string())?;

            if src_webp.exists() {
                let _ = fs::copy(&src_webp, dst_dir.join("spritesheet.webp"));
            } else if src_png.exists() {
                let _ = fs::copy(&src_png, dst_dir.join("spritesheet.png"));
            }
        }
    }

    // First-launch idle loads `webview/spritesheet.webp` directly; without this
    // copy the path stays empty until set_active runs and the pet renders blank.
    let active_slug = get_active_slug().or_else(|| pets.first().map(|p| p.slug.clone()));
    if let Some(slug) = active_slug {
        if let Some(src) = find_pet_root(&slug) {
            for name in ["spritesheet.webp", "spritesheet.png"] {
                let src_file = src.join(name);
                if src_file.exists() {
                    let _ = fs::copy(&src_file, webview_dir.join(name));
                    break;
                }
            }
        }
    }

    Ok(())
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

static AGENT_SVGS: &[(&str, &str)] = &[
    ("claude-code.svg", r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
</svg>
"#),
    ("codex.svg", r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
</svg>
"#),
    ("gemini.svg", r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 2v20M2 12h20"/>
</svg>
"#),
    ("opencode.svg", r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="16 18 22 12 16 6"/>
  <polyline points="8 6 2 12 8 18"/>
</svg>
"#),
    ("fallback.svg", r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="10"/>
  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
  <line x1="12" y1="17" x2="12.01" y2="17"/>
</svg>
"#),
];

pub fn get_active_slug() -> Option<String> {
    let active_path = utils::petdex_runtime_dir().join("active.json");
    if let Ok(content) = fs::read_to_string(&active_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
            return json["slug"].as_str().map(|s| s.to_string());
        }
    }
    None
}
