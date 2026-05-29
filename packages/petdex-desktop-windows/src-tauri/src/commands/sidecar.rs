use crate::{sidecar, utils};
use serde_json::json;

#[tauri::command]
pub fn respawn_sidecar() -> Result<serde_json::Value, String> {
    sidecar::kill().map_err(|e| e.to_string())?;
    sidecar::spawn().map_err(|e| e.to_string())?;
    Ok(json!({"ok": true}))
}

#[tauri::command]
pub async fn set_mascot_state(state: String) -> Result<serde_json::Value, String> {
    let token_path = utils::petdex_runtime_dir().join("update-token");
    let token = std::fs::read_to_string(&token_path).unwrap_or_default();
    let token = token.trim();
    if token.is_empty() {
        return Ok(json!({"ok": false, "error": "no_token"}));
    }

    let client = reqwest::Client::new();
    let res = client
        .post("http://127.0.0.1:7777/state")
        .header("X-Petdex-Update-Token", token)
        .header("Content-Type", "application/json")
        .json(&json!({"state": state, "duration": 3000}))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if res.status().is_success() {
        Ok(json!({"ok": true}))
    } else {
        Ok(json!({"ok": false, "error": format!("curl_exit_{}", res.status().as_u16())}))
    }
}

#[tauri::command]
pub async fn trigger_update() -> Result<serde_json::Value, String> {
    let token_path = utils::petdex_runtime_dir().join("update-token");
    let token = std::fs::read_to_string(&token_path).unwrap_or_default();
    let token = token.trim();
    if token.is_empty() {
        return Ok(json!({"ok": false, "error": "no_token"}));
    }

    let client = reqwest::Client::new();
    let res = client
        .post("http://127.0.0.1:7777/update")
        .header("X-Petdex-Update-Token", token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if res.status().is_success() {
        Ok(json!({"ok": true}))
    } else {
        Ok(json!({"ok": false, "error": format!("curl_exit_{}", res.status().as_u16())}))
    }
}