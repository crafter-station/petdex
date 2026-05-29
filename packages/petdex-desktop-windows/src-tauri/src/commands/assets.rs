use std::path::PathBuf;
use tauri::Manager;

#[tauri::command]
pub fn asset_url_for(name: String) -> Result<String, String> {
    // 拒绝路径遍历：只允许单个文件名，不含 .. 或路径分隔符
    if name.contains("..") || name.contains('\\') || name.contains('/') {
        return Err("invalid_slug".to_string());
    }

    let webview_dir = crate::utils::petdex_webview_dir();
    let path = webview_dir.join(&name);

    // 确保仍在 webview_dir 内（防御 .. 绕过了上面的检查，或符号链接攻击）
    let canonical_dir = webview_dir.canonicalize().unwrap_or_else(|_| webview_dir.clone());
    let canonical_path = match path.canonicalize() {
        Ok(p) => p,
        Err(_) => return Err(format!("Asset not found: {}", name)),
    };
    if !canonical_path.starts_with(&canonical_dir) {
        return Err("invalid_slug".to_string());
    }

    Ok(path.to_string_lossy().to_string())
}
