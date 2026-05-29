use std::path::PathBuf;

pub fn petdex_home() -> PathBuf {
    dirs::home_dir()
        .expect("HOME not set")
        .join(".petdex")
}

pub fn codex_pets_dir() -> PathBuf {
    dirs::home_dir()
        .expect("HOME not set")
        .join(".codex")
        .join("pets")
}

pub fn petdex_pets_dir() -> PathBuf {
    petdex_home().join("pets")
}

pub fn petdex_runtime_dir() -> PathBuf {
    petdex_home().join("runtime")
}

pub fn petdex_webview_dir() -> PathBuf {
    petdex_runtime_dir().join("webview")
}

pub fn petdex_sidecar_dir() -> PathBuf {
    petdex_home().join("sidecar")
}

pub fn bootstrap_dirs() {
    let dirs = [
        petdex_home(),
        petdex_pets_dir(),
        petdex_runtime_dir(),
        petdex_webview_dir(),
        petdex_webview_dir().join("agents"),
    ];
    for dir in &dirs {
        let _ = std::fs::create_dir_all(dir);
    }
}

pub fn read_runtime_file(name: &str) -> serde_json::Value {
    let path = petdex_runtime_dir().join(name);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| default_runtime_value(name))
}

fn default_runtime_value(name: &str) -> serde_json::Value {
    match name {
        "state.json" => serde_json::json!({"state":"idle","counter":0}),
        "bubble.json" => serde_json::json!({"text":"","counter":0}),
        "update.json" => serde_json::json!({"available":false,"status":"idle"}),
        "init-status.json" => serde_json::json!({"needsInit":false}),
        _ => serde_json::json!({}),
    }
}

pub fn is_valid_slug(slug: &str) -> bool {
    slug.len() <= 64
        && !slug.is_empty()
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}
