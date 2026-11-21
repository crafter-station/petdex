use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use petdex_core::{
    AttentionCoordinator, HookServer, HookServerConfig, PetAnimationEngine, DEFAULT_HOOK_PORT,
};

pub const WS_EX_TOPMOST: u32 = 0x0000_0008;
pub const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
pub const WS_EX_LAYERED: u32 = 0x0008_0000;
pub const PETDEX_WIN32_EX_STYLE: u32 = WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW;

#[derive(Debug, Clone, Copy)]
pub struct Win32HostConfig {
    pub width: i32,
    pub height: i32,
    pub ex_style: u32,
    pub hook_port: u16,
}

impl Default for Win32HostConfig {
    fn default() -> Self {
        Self {
            width: 160,
            height: 160,
            ex_style: PETDEX_WIN32_EX_STYLE,
            hook_port: DEFAULT_HOOK_PORT,
        }
    }
}

pub struct Win32PetHost {
    config: Win32HostConfig,
    coordinator: Arc<Mutex<AttentionCoordinator>>,
    engine: PetAnimationEngine,
    server: HookServer,
}

impl Win32PetHost {
    pub fn start(config: Win32HostConfig, update_token: impl Into<String>) -> std::io::Result<Self> {
        let coordinator = Arc::new(Mutex::new(AttentionCoordinator::new()));
        let server = HookServer::start(
            HookServerConfig::new(config.hook_port, update_token),
            Arc::clone(&coordinator),
        )?;
        let engine = PetAnimationEngine::new();
        Ok(Self {
            config,
            coordinator,
            engine,
            server,
        })
    }

    pub fn step(&mut self, dt_ms: u32) -> petdex_core::FrameOutput {
        let now = now_ms();
        let active = {
            let guard = self.coordinator.lock().unwrap_or_else(|e| e.into_inner());
            guard.active_state(now)
        };
        self.engine.set_state(active);
        self.engine.tick(dt_ms)
    }

    pub fn run(&mut self) {
        let frame = self.step(16);
        platform::run_host_loop(&self.config, self.server.port(), frame);
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::ffi::c_void;

    use petdex_core::FrameOutput;

    use super::Win32HostConfig;

    #[repr(C)]
    struct Msg {
        hwnd: *mut c_void,
        message: u32,
        wparam: usize,
        lparam: isize,
        time: u32,
        pt_x: i32,
        pt_y: i32,
    }

    extern "system" {
        fn GetMessageW(
            lp_msg: *mut Msg,
            hwnd: *mut c_void,
            wmsg_filter_min: u32,
            wmsg_filter_max: u32,
        ) -> i32;
        fn TranslateMessage(lp_msg: *const Msg) -> i32;
        fn DispatchMessageW(lp_msg: *const Msg) -> isize;
    }

    pub fn run_host_loop(config: &Win32HostConfig, port: u16, initial_frame: FrameOutput) {
        eprintln!(
            "petdex-windows: Win32 host ready (ex_style=0x{:08x}, size={}x{}, hook=127.0.0.1:{}, state={})",
            config.ex_style,
            config.width,
            config.height,
            port,
            initial_frame.state.slug(),
        );

        let mut msg = Msg {
            hwnd: std::ptr::null_mut(),
            message: 0,
            wparam: 0,
            lparam: 0,
            time: 0,
            pt_x: 0,
            pt_y: 0,
        };

        unsafe {
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use petdex_core::FrameOutput;

    use super::Win32HostConfig;

    pub fn run_host_loop(config: &Win32HostConfig, port: u16, initial_frame: FrameOutput) {
        eprintln!(
            "petdex-windows: non-Windows host stub (ex_style=0x{:08x}, size={}x{}, hook=127.0.0.1:{}, state={})",
            config.ex_style,
            config.width,
            config.height,
            port,
            initial_frame.state.slug(),
        );
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

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
