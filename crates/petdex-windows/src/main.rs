mod win32_host;

use petdex_core::DEFAULT_HOOK_PORT;
use win32_host::{Win32HostConfig, Win32PetHost};

fn main() -> std::io::Result<()> {
    let token = std::env::var("PETDEX_UPDATE_TOKEN")
        .unwrap_or_else(|_| "petdex-dev-token".to_string());
    let port = std::env::var("PETDEX_HOOK_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(DEFAULT_HOOK_PORT);

    let config = Win32HostConfig {
        hook_port: port,
        ..Win32HostConfig::default()
    };

    let mut host = Win32PetHost::start(config, token)?;
    host.run();
    Ok(())
}
