use std::process::{Child, Command};
use std::sync::Mutex;
use crate::utils;

static SIDECAR: Mutex<Option<Child>> = Mutex::new(None);

pub fn spawn() -> Result<(), String> {
    // Kill existing sidecar first
    kill()?;

    let home = dirs::home_dir().ok_or("HOME not set")?;
    let sidecar_js = home.join(".petdex").join("sidecar").join("server.js");

    if !sidecar_js.exists() {
        // Check if sidecar exists at alternative location
        let alt = home.join(".petdex").join("bin").join("petdex.js");
        if alt.exists() {
            // Use CLI as sidecar fallback
            return spawn_cli_sidecar();
        }
        return Err("Sidecar not found. Run: npx petdex init".to_string());
    }

    let child = Command::new("node")
        .arg(&sidecar_js)
        .env("PETDEX_PARENT_PID", std::process::id().to_string())
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

    *SIDECAR.lock().unwrap() = Some(child);
    Ok(())
}

fn spawn_cli_sidecar() -> Result<(), String> {
    let home = dirs::home_dir().ok_or("HOME not set")?;
    let cli_path = home.join(".petdex").join("bin").join("petdex.js");

    let child = Command::new("node")
        .arg(&cli_path)
        .arg("desktop")
        .arg("start")
        .env("PETDEX_PARENT_PID", std::process::id().to_string())
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

    *SIDECAR.lock().unwrap() = Some(child);
    Ok(())
}

pub fn kill() -> Result<(), String> {
    let child = SIDECAR.lock().unwrap().take();
    if let Some(mut child) = child {
        #[cfg(windows)]
        {
            let pid = child.id();
            let _ = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .output();
        }
        let _ = child.kill();
    }
    Ok(())
}
