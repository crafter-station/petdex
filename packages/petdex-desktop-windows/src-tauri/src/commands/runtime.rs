use crate::utils;

#[tauri::command]
pub fn read_runtime_state() -> serde_json::Value {
    utils::read_runtime_file("state.json")
}

#[tauri::command]
pub fn read_runtime_bubble() -> serde_json::Value {
    utils::read_runtime_file("bubble.json")
}

#[tauri::command]
pub fn read_update_info() -> serde_json::Value {
    utils::read_runtime_file("update.json")
}

#[tauri::command]
pub fn read_init_status() -> serde_json::Value {
    utils::read_runtime_file("init-status.json")
}