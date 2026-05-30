use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

// Bring in the Windows-only CommandExt trait so we can set creation_flags.
#[cfg(windows)]
use std::os::windows::process::CommandExt;

// ── Pet types ─────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PetMeta {
    pub slug: String,
    pub name: String,
    pub sprite_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PetInfo {
    pub slug: String,
    pub display_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetdexData {
    pub pets: Vec<PetInfo>,
    pub active: Option<String>,
    pub compact_width: u32,
    pub compact_height: u32,
    pub menu_width: u32,
    pub menu_height: u32,
}

// ── Sidecar state ─────────────────────────────────────────────────────────────

pub struct SidecarState {
    pub child: Option<std::process::Child>,
    pub port: u16,
    pub token: String,
}

impl Default for SidecarState {
    fn default() -> Self {
        Self { child: None, port: 0, token: String::new() }
    }
}

// ── Utils ─────────────────────────────────────────────────────────────────────

fn petdex_home() -> PathBuf {
    dirs::home_dir().expect("HOME not set").join(".petdex")
}

fn codex_pets_dir() -> PathBuf {
    dirs::home_dir().expect("HOME not set").join(".codex").join("pets")
}

fn petdex_pets_dir() -> PathBuf {
    petdex_home().join("pets")
}

fn petdex_runtime_dir() -> PathBuf {
    petdex_home().join("runtime")
}

fn petdex_webview_dir() -> PathBuf {
    petdex_runtime_dir().join("webview")
}

fn petdex_sidecar_dir() -> PathBuf {
    petdex_home().join("sidecar")
}

fn bootstrap_dirs() {
    let dirs = [
        petdex_home(),
        petdex_pets_dir(),
        petdex_runtime_dir(),
        petdex_webview_dir(),
        petdex_webview_dir().join("agents"),
    ];
    for dir in &dirs {
        let _ = fs::create_dir_all(dir);
    }
}

fn is_valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 64
        && slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn read_runtime_file(name: &str) -> serde_json::Value {
    let path = petdex_runtime_dir().join(name);
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| default_runtime_value(name))
}

fn default_runtime_value(name: &str) -> serde_json::Value {
    match name {
        "state.json" => json!({"state":"idle","counter":0}),
        "bubble.json" => json!({"text":"","counter":0}),
        "update.json" => json!({"available":false,"status":"idle"}),
        "init-status.json" => json!({"needsInit":false}),
        _ => json!({}),
    }
}

// ── Pet scanner ───────────────────────────────────────────────────────────────

const MAX_PET_BYTES: u64 = 16 * 1024 * 1024;

fn pet_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".petdex").join("pets"));
        roots.push(home.join(".codex").join("pets"));
    }
    roots
}

fn canonical_normalize(p: &std::path::Path) -> PathBuf {
    match fs::canonicalize(p) {
        Ok(c) => {
            let s = c.to_string_lossy();
            if let Some(stripped) = s.strip_prefix(r"\\?\") {
                PathBuf::from(stripped.to_string())
            } else {
                c
            }
        }
        Err(_) => p.to_path_buf(),
    }
}

fn find_valid_sprite(pet_dir: &std::path::Path) -> Option<PathBuf> {
    for name in &[
        "spritesheet.webp",
        "spritesheet.png",
        "sprite.webp",
        "sprite.png",
    ] {
        let p = pet_dir.join(name);
        if let Ok(meta) = fs::metadata(&p) {
            if meta.is_file() && meta.len() > 0 && meta.len() <= MAX_PET_BYTES {
                return Some(p);
            }
        }
    }
    None
}

fn load_pet_from_dir(slug: &str, dir: &std::path::Path) -> Option<PetMeta> {
    let pet_dir = dir.join(slug);
    let sprite_path = find_valid_sprite(&pet_dir)?;
    let name = fs::read_to_string(pet_dir.join("pet.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|val| {
            val.get("displayName")
                .or_else(|| val.get("name"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| slug.to_string());

    Some(PetMeta {
        slug: slug.to_string(),
        name,
        sprite_path: sprite_path.to_string_lossy().to_string(),
    })
}

fn read_active_slug() -> Option<String> {
    let path = dirs::home_dir()?.join(".petdex").join("active.json");
    let raw = fs::read_to_string(&path).ok()?;
    let val: serde_json::Value = serde_json::from_str(&raw).ok()?;
    val.get("slug").and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn find_pet_root(slug: &str) -> Option<PathBuf> {
    for root in pet_roots() {
        let path = root.join(slug);
        if path.exists() {
            return Some(path);
        }
    }
    None
}

// ── Sidecar helpers ───────────────────────────────────────────────────────────

fn find_node() -> PathBuf {
    if let Ok(out) = std::process::Command::new("where.exe").arg("node").output() {
        if out.status.success() {
            if let Ok(s) = std::str::from_utf8(&out.stdout) {
                if let Some(line) = s.lines().next() {
                    let p = PathBuf::from(line.trim());
                    if p.exists() { return p; }
                }
            }
        }
    }
    for candidate in &[
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
    ] {
        let p = PathBuf::from(candidate);
        if p.exists() { return p; }
    }
    PathBuf::from("node")
}

fn find_sidecar_js() -> Option<PathBuf> {
    if let Some(home) = dirs::home_dir() {
        let installed = home.join(".petdex").join("sidecar").join("server.js");
        if installed.exists() {
            return Some(installed);
        }
    }
    if let Ok(env_path) = std::env::var("PETDEX_SIDECAR_PATH") {
        let p = PathBuf::from(&env_path);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn read_runtime_info() -> Option<(u16, String)> {
    let port: u16 = std::env::var("PETDEX_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(7777);

    let token_path = dirs::home_dir()?
        .join(".petdex")
        .join("runtime")
        .join("update-token");

    let token = if token_path.exists() {
        fs::read_to_string(&token_path)
            .ok()
            .map(|t| t.trim().to_string())
            .unwrap_or_default()
    } else {
        String::new()
    };

    Some((port, token))
}

fn spawn_sidecar_inner(state: &Mutex<SidecarState>) -> Result<u16, String> {
    let sidecar_path = find_sidecar_js()
        .ok_or_else(|| "sidecar server.js not found in ~/.petdex/sidecar/ or repo".to_string())?;

    {
        let mut s = state.lock().unwrap();
        if let Some(mut old) = s.child.take() {
            let _ = old.kill();
        }
    }

    let node = find_node();
    let mut cmd = std::process::Command::new(&node);
    cmd.arg(&sidecar_path)
        .env("PETDEX_PARENT_PID", std::process::id().to_string())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar (node={:?}): {e}", node))?;

    let (port, token) = read_runtime_info()
        .ok_or_else(|| "could not determine port/token".to_string())?;

    let mut s = state.lock().unwrap();
    s.child = Some(child);
    s.port = port;
    s.token = token;

    Ok(port)
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn list_pets() -> Vec<String> {
    let mut slugs = Vec::new();
    for root in pet_roots() {
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() && find_valid_sprite(&path).is_some() {
                    if let Some(name) = entry.file_name().to_str() {
                        slugs.push(name.to_string());
                    }
                }
            }
        }
    }
    slugs.sort();
    slugs.dedup();
    slugs
}

#[tauri::command]
fn get_pet(slug: String) -> Option<PetMeta> {
    for root in pet_roots() {
        if let Some(meta) = load_pet_from_dir(&slug, &root) {
            return Some(meta);
        }
    }
    None
}

#[tauri::command]
fn get_active_pet() -> Option<PetMeta> {
    if let Some(slug) = read_active_slug() {
        if let Some(meta) = get_pet(slug) {
            return Some(meta);
        }
    }
    for root in pet_roots() {
        if let Ok(entries) = fs::read_dir(&root) {
            let mut slugs: Vec<String> = entries
                .flatten()
                .filter(|e| e.path().is_dir())
                .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
                .collect();
            slugs.sort();
            for slug in slugs {
                if let Some(meta) = load_pet_from_dir(&slug, &root) {
                    return Some(meta);
                }
            }
        }
    }
    None
}

#[tauri::command]
fn read_file_as_base64(path: String) -> Result<String, String> {
    use std::io::Read;
    let canonical = canonical_normalize(std::path::Path::new(&path));
    let in_pet_root = pet_roots().iter().any(|r| {
        let root = canonical_normalize(r);
        canonical.starts_with(&root)
    });
    if !in_pet_root {
        return Err(format!(
            "path is outside allowed pet directories: {}",
            canonical.display()
        ));
    }
    let meta = fs::metadata(&canonical)
        .map_err(|e| format!("cannot stat file: {e}"))?;
    if meta.len() == 0 {
        return Err("file is empty".into());
    }
    if meta.len() > MAX_PET_BYTES {
        return Err(format!(
            "file too large ({} bytes, cap {} bytes)",
            meta.len(),
            MAX_PET_BYTES
        ));
    }
    let mut f = fs::File::open(&canonical)
        .map_err(|e| format!("cannot open file: {e}"))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)
        .map_err(|e| format!("read failed: {e}"))?;
    Ok(base64_encode(&buf))
}

fn base64_encode(input: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { CHARS[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { CHARS[(n & 63) as usize] as char } else { '=' });
    }
    out
}

#[tauri::command]
fn read_runtime_state() -> Option<serde_json::Value> {
    let path = dirs::home_dir()?
        .join(".petdex")
        .join("runtime")
        .join("state.json");
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

#[tauri::command]
fn read_runtime_bubble() -> Option<serde_json::Value> {
    let path = dirs::home_dir()?
        .join(".petdex")
        .join("runtime")
        .join("bubble.json");
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

#[tauri::command]
fn read_update_info() -> serde_json::Value {
    read_runtime_file("update.json")
}

#[tauri::command]
fn read_init_status() -> serde_json::Value {
    read_runtime_file("init-status.json")
}

#[tauri::command]
fn read_petdex_data() -> PetdexData {
    let all_pets = scan_pets();
    let active = read_active_slug().or_else(|| {
        all_pets.first().map(|p| p.slug.clone())
    });

    PetdexData {
        pets: all_pets,
        active,
        compact_width: 192,
        compact_height: 288,
        menu_width: 480,
        menu_height: 420,
    }
}

fn scan_pets() -> Vec<PetInfo> {
    let mut pets = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for root in pet_roots() {
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                let slug = entry.file_name().to_string_lossy().to_string();
                if !seen.insert(slug.clone()) {
                    continue;
                }
                let pet_json = entry.path().join("pet.json");
                if let Ok(content) = fs::read_to_string(&pet_json) {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                        let display_name = json["displayName"]
                            .as_str()
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| slug.clone());
                        pets.push(PetInfo { slug, display_name });
                    }
                }
            }
        }
    }

    pets.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    pets
}

#[tauri::command]
fn set_active(slug: String) -> Result<serde_json::Value, String> {
    if !is_valid_slug(&slug) {
        return Err("invalid_slug".to_string());
    }

    let pet_root = find_pet_root(&slug).ok_or("Pet not found")?;
    let pet_json_path = pet_root.join("pet.json");
    if !pet_json_path.exists() {
        return Err("Pet not found".to_string());
    }

    let webp_path = pet_root.join("spritesheet.webp");
    let png_path = pet_root.join("spritesheet.png");
    let (sprite_path, ext) = if webp_path.exists() {
        (webp_path, "webp")
    } else if png_path.exists() {
        (png_path, "png")
    } else {
        return Err("Spritesheet not found".to_string());
    };

    let webview_dir = petdex_webview_dir();
    let dst = if ext == "webp" {
        webview_dir.join("spritesheet.webp")
    } else {
        webview_dir.join("spritesheet.png")
    };
    fs::copy(&sprite_path, &dst).map_err(|e| e.to_string())?;

    let active_path = petdex_runtime_dir().join("active.json");
    let active_data = json!({
        "slug": slug,
        "dir": pet_root.to_string_lossy().to_string(),
    });
    fs::write(&active_path, active_data.to_string()).map_err(|e| e.to_string())?;

    Ok(json!({"ok": true}))
}

#[tauri::command]
async fn install_pet(slug: String) -> Result<serde_json::Value, String> {
    if !is_valid_slug(&slug) {
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
        Ok(json!({"ok": true}))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Ok(json!({"ok": false, "error": format!("exit_{}: {}", output.status.code().unwrap_or(-1), stderr)}))
    }
}

#[tauri::command]
async fn set_mascot_state(state: String) -> Result<serde_json::Value, String> {
    let token_path = petdex_runtime_dir().join("update-token");
    let token = fs::read_to_string(&token_path).unwrap_or_default();
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
async fn trigger_update() -> Result<serde_json::Value, String> {
    let token_path = petdex_runtime_dir().join("update-token");
    let token = fs::read_to_string(&token_path).unwrap_or_default();
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

#[tauri::command]
fn respawn_sidecar(state: State<Mutex<SidecarState>>) -> Result<serde_json::Value, String> {
    spawn_sidecar_inner(state.inner()).map_err(|e| e.to_string())?;
    Ok(json!({"ok": true}))
}

#[tauri::command]
fn spawn_sidecar(state: State<Mutex<SidecarState>>) -> Result<u16, String> {
    spawn_sidecar_inner(state.inner())
}

#[tauri::command]
fn get_sidecar_port(state: State<Mutex<SidecarState>>) -> u16 {
    state.lock().unwrap().port
}

#[tauri::command]
fn stop_sidecar(state: State<Mutex<SidecarState>>) {
    let mut s = state.lock().unwrap();
    if let Some(mut child) = s.child.take() {
        let _ = child.kill();
    }
    s.port = 0;
    s.token = String::new();
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn asset_url_for(name: String) -> Result<String, String> {
    if name.contains("..") || name.contains('\\') || name.contains('/') {
        return Err("invalid_name".to_string());
    }
    let webview_dir = petdex_webview_dir();
    let path = webview_dir.join(&name);
    let canonical_dir = webview_dir.canonicalize().unwrap_or_else(|_| webview_dir.clone());
    let canonical_path = match path.canonicalize() {
        Ok(p) => p,
        Err(_) => return Err(format!("Asset not found: {}", name)),
    };
    if !canonical_path.starts_with(&canonical_dir) {
        return Err("invalid_name".to_string());
    }
    Ok(path.to_string_lossy().to_string())
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(url) = args.iter().find(|a| a.starts_with("petdex://")) {
                let _ = app.emit("petdex:deep-link", url.clone());
            }
            if let Some(window) = app.get_webview_window("pet") {
                let _ = window.set_focus();
            }
        }))
        .manage(Mutex::new(SidecarState::default()))
        .setup(|app| {
            // Register deep link schemes
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }

            // Bootstrap directories
            bootstrap_dirs();

            // Init status detection: show banner when neither sidecar nor CLI is installed
            {
                let home = dirs::home_dir().expect("HOME not set");
                let sidecar_js = home.join(".petdex").join("sidecar").join("server.js");
                let cli_js = home.join(".petdex").join("bin").join("petdex.js");
                let init_status = petdex_runtime_dir().join("init-status.json");
                if !sidecar_js.exists() && !cli_js.exists() && !init_status.exists() {
                    let _ = fs::write(&init_status, r#"{"needsInit":true}"#);
                }
            }

            // Auto-spawn sidecar on startup
            if let Some(state) = app.try_state::<Mutex<SidecarState>>() {
                if let Err(e) = spawn_sidecar_inner(state.inner()) {
                    eprintln!("Failed to auto-spawn sidecar: {}", e);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_pets,
            get_pet,
            get_active_pet,
            read_file_as_base64,
            read_runtime_state,
            read_runtime_bubble,
            read_update_info,
            read_init_status,
            read_petdex_data,
            set_active,
            install_pet,
            set_mascot_state,
            trigger_update,
            respawn_sidecar,
            quit_app,
            spawn_sidecar,
            get_sidecar_port,
            stop_sidecar,
            asset_url_for,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
