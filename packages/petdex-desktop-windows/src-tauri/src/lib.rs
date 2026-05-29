mod commands;
mod sidecar;
mod pets;
mod utils;

use tauri::{Manager, Emitter};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Forward deep link to existing window
            if let Some(url) = args.iter().find(|a| a.starts_with("petdex://")) {
                let _ = app.emit("petdex:deep-link", url.clone());
            }
            // Focus existing window
            if let Some(window) = app.get_webview_window("pet") {
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            // Register deep link schemes
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }

            // Bootstrap directories
            utils::bootstrap_dirs();

            // Surface the init banner when neither sidecar nor CLI is installed —
            // otherwise init-status.json stays absent, read_init_status defaults to
            // needsInit:false, and the "run petdex init" prompt never shows.
            {
                let home = dirs::home_dir().expect("HOME not set");
                let sidecar_js = home.join(".petdex").join("sidecar").join("server.js");
                let cli_js = home.join(".petdex").join("bin").join("petdex.js");
                let init_status = utils::petdex_runtime_dir().join("init-status.json");
                if !sidecar_js.exists() && !cli_js.exists() && !init_status.exists() {
                    let _ = std::fs::write(&init_status, r#"{"needsInit":true}"#);
                }
            }

            // Stage webview assets
            if let Err(e) = pets::stage_webview_assets() {
                eprintln!("Failed to stage webview assets: {}", e);
            }

            // Spawn sidecar
            if let Err(e) = sidecar::spawn() {
                eprintln!("Failed to spawn sidecar: {}", e);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::read_runtime_state,
            commands::read_runtime_bubble,
            commands::read_update_info,
            commands::read_init_status,
            commands::read_petdex_data,
            commands::set_active,
            commands::set_mascot_state,
            commands::install_pet,
            commands::trigger_update,
            commands::respawn_sidecar,
            commands::quit,
            commands::asset_url_for,
        ])
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { .. } => {
                    let _ = sidecar::kill();
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
