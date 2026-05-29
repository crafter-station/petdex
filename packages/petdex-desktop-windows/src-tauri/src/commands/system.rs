#[tauri::command]
pub fn quit(app_handle: tauri::AppHandle) {
    app_handle.exit(0);
}
