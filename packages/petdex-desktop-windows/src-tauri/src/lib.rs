use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::State;

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

// ── Pet scanner ───────────────────────────────────────────────────────────────

/// Spritesheet size cap — mirrors MAX_PET_BYTES in main.zig (16 MiB).
/// Keeps listing behaviour in lockstep with the loader: a pet that
/// would be rejected at load time is also excluded from the listing.
const MAX_PET_BYTES: u64 = 16 * 1024 * 1024;

fn pet_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".petdex").join("pets"));
        roots.push(home.join(".codex").join("pets"));
    }
    roots
}

/// Canonicalize `p` and strip the Windows verbatim prefix `\\?\` so that
/// `starts_with` comparisons work correctly on all platforms.
/// On non-Windows (and when canonicalization fails) returns the path as-is.
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

/// Returns the path of the first valid sprite file found in `pet_dir`.
/// Valid means: regular non-empty file, within MAX_PET_BYTES, one of the known extensions.
/// pet.json is NOT required — the sprite file is the authoritative marker.
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

    // Sprite file is required; no valid sprite → this slug is not a usable pet.
    let sprite_path = find_valid_sprite(&pet_dir)?;

    // pet.json is best-effort: missing or malformed falls back to slug as name.
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

/// Read the active slug from ~/.petdex/active.json ({"slug":"<slug>"}).
/// Returns None if the file is absent, unreadable, or malformed.
fn read_active_slug() -> Option<String> {
    let path = dirs::home_dir()?.join(".petdex").join("active.json");
    let raw = fs::read_to_string(&path).ok()?;
    let val: serde_json::Value = serde_json::from_str(&raw).ok()?;
    val.get("slug").and_then(|v| v.as_str()).map(|s| s.to_string())
}

// ── Sidecar helpers ───────────────────────────────────────────────────────────

/// Resolve the node executable — tries common install locations so we work
/// even when app.exe inherits a PATH that doesn't include nodejs.
fn find_node() -> PathBuf {
    // Try PATH first (works in dev when launched from a node-aware shell)
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
    // Common fixed install paths on Windows
    for candidate in &[
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
    ] {
        let p = PathBuf::from(candidate);
        if p.exists() { return p; }
    }
    // Final fallback — let OS resolve it
    PathBuf::from("node")
}

fn find_sidecar_js() -> Option<PathBuf> {
    // Production install path (set by `petdex install desktop`)
    if let Some(home) = dirs::home_dir() {
        let installed = home.join(".petdex").join("sidecar").join("server.js");
        if installed.exists() {
            return Some(installed);
        }
    }
    // Dev/CI override — set PETDEX_SIDECAR_PATH to the absolute path of server.js
    if let Ok(env_path) = std::env::var("PETDEX_SIDECAR_PATH") {
        let p = PathBuf::from(&env_path);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// Port is fixed at 7777 (or PETDEX_PORT env var).
/// Token is written by the sidecar to ~/.petdex/runtime/update-token as plain text.
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

// ── Tauri commands — pet ──────────────────────────────────────────────────────

/// Return the slugs of all pets that have a valid spritesheet.
/// pet.json is not required — sprite presence is the authoritative check.
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

/// Load metadata for a specific pet by slug; returns None if not installed.
#[tauri::command]
fn get_pet(slug: String) -> Option<PetMeta> {
    for root in pet_roots() {
        if let Some(meta) = load_pet_from_dir(&slug, &root) {
            return Some(meta);
        }
    }
    None
}

/// Return the active pet: reads ~/.petdex/active.json first, then iterates
/// all pet roots in order until one loads. Mirrors main.zig's startup logic.
#[tauri::command]
fn get_active_pet() -> Option<PetMeta> {
    if let Some(slug) = read_active_slug() {
        if let Some(meta) = get_pet(slug) {
            return Some(meta);
        }
    }
    // Fallback: first loadable pet across all roots in alphabetical order.
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

/// Read a spritesheet and return its contents as a base64 string.
///
/// Security restrictions (both must hold):
///   1. Canonical path must be inside one of the known pet roots
///      (~/.petdex/pets/ or ~/.codex/pets/). This closes the path-traversal
///      window: JS in the WebView cannot escape to arbitrary files.
///   2. File size must be ≤ MAX_PET_BYTES (16 MiB). Mirrors the loader
///      cap in main.zig so an oversized spritesheet can't crash the renderer.
///
/// Uses canonical_normalize to strip the Windows \\?\ verbatim prefix so
/// the starts_with comparison against pet_roots() works correctly.
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

// ── Tauri commands — runtime file reads ──────────────────────────────────────

/// Read the sidecar state from ~/.petdex/runtime/state.json.
///
/// The sidecar writes this file on every state change (not on a timer), so
/// reading it directly is both lower-latency and CORS-free compared to
/// fetching from the sidecar's HTTP server from inside the WebView.
/// Returns None if the file is absent, unreadable, or not valid JSON.
#[tauri::command]
fn read_runtime_state() -> Option<serde_json::Value> {
    let path = dirs::home_dir()?
        .join(".petdex")
        .join("runtime")
        .join("state.json");
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Read the sidecar bubble from ~/.petdex/runtime/bubble.json.
///
/// Same rationale as read_runtime_state: file-based reads sidestep
/// the CORS issue that blocks cross-origin fetch() inside WebView2.
/// Returns None if the file is absent, unreadable, or not valid JSON.
#[tauri::command]
fn read_runtime_bubble() -> Option<serde_json::Value> {
    let path = dirs::home_dir()?
        .join(".petdex")
        .join("runtime")
        .join("bubble.json");
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

// ── Tauri commands — sidecar ──────────────────────────────────────────────────

/// Spawn the sidecar server; kill any stale instance first. Returns the port (default 7777).
#[tauri::command]
fn spawn_sidecar(state: State<Mutex<SidecarState>>) -> Result<u16, String> {
    let sidecar_path = find_sidecar_js()
        .ok_or_else(|| "sidecar server.js not found in ~/.petdex/sidecar/ or repo".to_string())?;

    // Kill any stale sidecar first so port 7777 is free
    {
        let mut s = state.lock().unwrap();
        if let Some(mut old) = s.child.take() {
            let _ = old.kill();
        }
    }

    let node = find_node();
    let mut cmd = std::process::Command::new(&node);
    cmd.arg(&sidecar_path)
        // Tell the sidecar our PID so its parent-watchdog can exit cleanly
        // when this desktop process terminates. Mirrors main.zig line 1086.
        .env("PETDEX_PARENT_PID", std::process::id().to_string())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    // Prevent a console window from appearing when node is spawned from a
    // Windows GUI subsystem process (CREATE_NO_WINDOW = 0x08000000).
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

    // Return port immediately — JS polls /health until sidecar is ready
    Ok(port)
}

/// Return the port the sidecar is currently listening on (0 if not running).
#[tauri::command]
fn get_sidecar_port(state: State<Mutex<SidecarState>>) -> u16 {
    state.lock().unwrap().port
}

/// Kill the sidecar process and clear its port/token from state.
#[tauri::command]
fn stop_sidecar(state: State<Mutex<SidecarState>>) {
    let mut s = state.lock().unwrap();
    if let Some(mut child) = s.child.take() {
        let _ = child.kill();
    }
    s.port = 0;
    s.token = String::new();
}

// ── Tauri commands — app ──────────────────────────────────────────────────────

/// Exit the application cleanly (triggered by right-click).
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(SidecarState::default()))
        .invoke_handler(tauri::generate_handler![
            list_pets,
            get_pet,
            get_active_pet,
            read_file_as_base64,
            read_runtime_state,
            read_runtime_bubble,
            quit_app,
            spawn_sidecar,
            get_sidecar_port,
            stop_sidecar,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
