use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use petdex_core::{
    AttentionCoordinator, CodingAgent, FrameOutput, HookServer, HookServerConfig,
    PetAnimationEngine, PetState, DEFAULT_HOOK_PORT,
};

use crate::bubble_window::{BubbleContent, BubbleWindow};
use crate::sprite_loader::{
    discover_pets, DecodedFrame, InstalledWindowsPet, SpriteAtlas,
};

pub const WS_EX_TOPMOST: u32 = 0x0000_0008;
pub const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
pub const WS_EX_LAYERED: u32 = 0x0008_0000;
pub const PETDEX_WIN32_EX_STYLE: u32 = WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW;

pub const ATLAS_COLS: u64 = 8;
pub const ATLAS_ROWS: u64 = 9;
pub const DEFAULT_ATLAS_WIDTH: u32 = 1024;
pub const DEFAULT_ATLAS_HEIGHT: u32 = 1152;
pub const DEFAULT_WINDOW_WIDTH: i32 = 160;
pub const DEFAULT_WINDOW_HEIGHT: i32 = 160;
pub const DEFAULT_SCREEN_MARGIN: i32 = 24;
pub const DEFAULT_TICK_INTERVAL_MS: u32 = 16;

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const CMD_CYCLE_STATE: usize = 1001;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const CMD_TOGGLE_TOPMOST: usize = 1002;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const CMD_RESET_POSITION: usize = 1003;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const CMD_QUIT: usize = 1004;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const CMD_PET_BASE: usize = 2000;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const CMD_AGENT_BASE: usize = 3000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AtlasRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpriteAtlasSpec {
    pub sheet_width: u32,
    pub sheet_height: u32,
    pub cols: u64,
    pub rows: u64,
}

impl Default for SpriteAtlasSpec {
    fn default() -> Self {
        Self {
            sheet_width: DEFAULT_ATLAS_WIDTH,
            sheet_height: DEFAULT_ATLAS_HEIGHT,
            cols: ATLAS_COLS,
            rows: ATLAS_ROWS,
        }
    }
}

impl SpriteAtlasSpec {
    #[allow(dead_code)]
    pub const fn new(sheet_width: u32, sheet_height: u32, cols: u64, rows: u64) -> Self {
        Self {
            sheet_width,
            sheet_height,
            cols,
            rows,
        }
    }

    pub const fn cell_width(&self) -> u32 {
        if self.cols == 0 {
            0
        } else {
            self.sheet_width / (self.cols as u32)
        }
    }

    pub const fn cell_height(&self) -> u32 {
        if self.rows == 0 {
            0
        } else {
            self.sheet_height / (self.rows as u32)
        }
    }

    pub const fn frame_rect(&self, frame: FrameOutput) -> AtlasRect {
        let cell_w = self.cell_width();
        let cell_h = self.cell_height();
        if cell_w == 0 || cell_h == 0 {
            return AtlasRect {
                x: 0,
                y: 0,
                width: 0,
                height: 0,
            };
        }
        let max_col = self.cols - 1;
        let max_row = self.rows - 1;
        let col = if frame.col > max_col {
            max_col
        } else {
            frame.col
        };
        let row = if frame.row > max_row {
            max_row
        } else {
            frame.row
        };
        AtlasRect {
            x: (col as u32) * cell_w,
            y: (row as u32) * cell_h,
            width: cell_w,
            height: cell_h,
        }
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkArea {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[allow(dead_code)]
impl WorkArea {
    pub const fn width(&self) -> i32 {
        self.right.saturating_sub(self.left)
    }

    pub const fn height(&self) -> i32 {
        self.bottom.saturating_sub(self.top)
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowPlacement {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const fn compute_bottom_right_placement(
    work_area: WorkArea,
    width: i32,
    height: i32,
    margin: i32,
) -> WindowPlacement {
    let clamped_w = if width < 1 { 1 } else { width };
    let clamped_h = if height < 1 { 1 } else { height };
    let safe_margin = if margin < 0 { 0 } else { margin };

    let raw_x = work_area
        .right
        .saturating_sub(clamped_w)
        .saturating_sub(safe_margin);
    let raw_y = work_area
        .bottom
        .saturating_sub(clamped_h)
        .saturating_sub(safe_margin);

    let x = if raw_x < work_area.left {
        work_area.left
    } else {
        raw_x
    };
    let y = if raw_y < work_area.top {
        work_area.top
    } else {
        raw_y
    };

    WindowPlacement {
        x,
        y,
        width: clamped_w,
        height: clamped_h,
    }
}

#[allow(dead_code)]
pub const fn clamp_placement_to_work_area(
    placement: WindowPlacement,
    work_area: WorkArea,
) -> WindowPlacement {
    let width = if placement.width < 1 {
        1
    } else {
        placement.width
    };
    let height = if placement.height < 1 {
        1
    } else {
        placement.height
    };

    let max_x = work_area.right.saturating_sub(width);
    let max_y = work_area.bottom.saturating_sub(height);

    let x = if max_x <= work_area.left {
        work_area.left
    } else if placement.x < work_area.left {
        work_area.left
    } else if placement.x > max_x {
        max_x
    } else {
        placement.x
    };

    let y = if max_y <= work_area.top {
        work_area.top
    } else if placement.y < work_area.top {
        work_area.top
    } else if placement.y > max_y {
        max_y
    } else {
        placement.y
    };

    WindowPlacement {
        x,
        y,
        width,
        height,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Win32HostConfig {
    pub width: i32,
    pub height: i32,
    pub ex_style: u32,
    pub hook_port: u16,
    pub margin: i32,
    pub tick_interval_ms: u32,
    pub atlas: SpriteAtlasSpec,
}

impl Default for Win32HostConfig {
    fn default() -> Self {
        Self {
            width: DEFAULT_WINDOW_WIDTH,
            height: DEFAULT_WINDOW_HEIGHT,
            ex_style: PETDEX_WIN32_EX_STYLE,
            hook_port: DEFAULT_HOOK_PORT,
            margin: DEFAULT_SCREEN_MARGIN,
            tick_interval_ms: DEFAULT_TICK_INTERVAL_MS,
            atlas: SpriteAtlasSpec::default(),
        }
    }
}

pub struct Win32PetHost {
    config: Win32HostConfig,
    coordinator: Arc<Mutex<AttentionCoordinator>>,
    engine: PetAnimationEngine,
    server: HookServer,
    manual_override: Option<PetState>,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    topmost: bool,
    last_frame: FrameOutput,
    installed_pets: Vec<InstalledWindowsPet>,
    active_pet_index: Option<usize>,
    atlas: Option<SpriteAtlas>,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    bubble_window: BubbleWindow,
}

impl Win32PetHost {
    pub fn start(mut config: Win32HostConfig, update_token: impl Into<String>) -> std::io::Result<Self> {
        let coordinator = Arc::new(Mutex::new(AttentionCoordinator::new()));
        let server = HookServer::start(
            HookServerConfig::new(config.hook_port, update_token),
            Arc::clone(&coordinator),
        )?;
        let engine = PetAnimationEngine::new();
        let last_frame = engine.current_frame();
        let topmost = (config.ex_style & WS_EX_TOPMOST) != 0;

        let installed_pets = discover_pets();
        let mut active_pet_index = None;
        let mut atlas = None;
        for (idx, pet) in installed_pets.iter().enumerate() {
            if let Ok(loaded) = SpriteAtlas::from_file(&pet.spritesheet_path) {
                let (sw, sh) = loaded.sheet_dimensions();
                config.atlas.sheet_width = sw;
                config.atlas.sheet_height = sh;
                active_pet_index = Some(idx);
                atlas = Some(loaded);
                break;
            }
        }

        Ok(Self {
            config,
            coordinator,
            engine,
            server,
            manual_override: None,
            topmost,
            last_frame,
            installed_pets,
            active_pet_index,
            atlas,
            bubble_window: BubbleWindow::new(),
        })
    }

    pub fn config(&self) -> &Win32HostConfig {
        &self.config
    }

    pub fn port(&self) -> u16 {
        self.server.port()
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn is_topmost(&self) -> bool {
        self.topmost
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn toggle_topmost(&mut self) -> bool {
        self.topmost = !self.topmost;
        self.topmost
    }

    pub fn last_frame(&self) -> FrameOutput {
        self.last_frame
    }

    pub fn current_frame_rect(&self) -> AtlasRect {
        self.config.atlas.frame_rect(self.last_frame)
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn installed_pets(&self) -> &[InstalledWindowsPet] {
        &self.installed_pets
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn active_pet_index(&self) -> Option<usize> {
        self.active_pet_index
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn select_pet(&mut self, index: usize) -> bool {
        let Some(pet) = self.installed_pets.get(index) else {
            return false;
        };
        match SpriteAtlas::from_file(&pet.spritesheet_path) {
            Ok(loaded) => {
                let (sw, sh) = loaded.sheet_dimensions();
                self.config.atlas.sheet_width = sw;
                self.config.atlas.sheet_height = sh;
                self.atlas = Some(loaded);
                self.active_pet_index = Some(index);
                true
            }
            Err(err) => {
                eprintln!(
                    "petdex-windows: failed to load pet '{}': {err}",
                    pet.display_name
                );
                false
            }
        }
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn current_decoded_frame(&mut self) -> DecodedFrame {
        let target_w = self.config.width.max(1) as u32;
        let target_h = self.config.height.max(1) as u32;
        if let Some(atlas) = self.atlas.as_mut() {
            atlas.frame_scaled(self.last_frame.row, self.last_frame.col, target_w, target_h)
        } else {
            SpriteAtlas::cobalt_squircle_fallback(
                target_w,
                target_h,
                self.last_frame.state,
                self.last_frame.frame_index,
            )
        }
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn active_bubble_content(&self) -> Option<BubbleContent> {
        let now = now_ms();
        let bubbles = {
            let guard = self.coordinator.lock().unwrap_or_else(|e| e.into_inner());
            guard.active_bubbles(now)
        };
        BubbleContent::from_active_bubbles(&bubbles)
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn toggle_agent_hook(&self, agent: CodingAgent) -> std::io::Result<bool> {
        let status = petdex_core::hook_installer::detect_agent_status(agent);
        if status == petdex_core::hook_installer::AgentInstallStatus::Connected {
            petdex_core::hook_installer::disconnect_agent(agent)
        } else {
            petdex_core::hook_installer::connect_agent(agent)
        }
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn bubble_window_mut(&mut self) -> &mut BubbleWindow {
        &mut self.bubble_window
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn cycle_state(&mut self) -> FrameOutput {
        let next = self.engine.state().next();
        self.manual_override = Some(next);
        self.engine.set_state(next);
        self.last_frame = self.engine.current_frame();
        self.last_frame
    }

    pub fn step(&mut self, dt_ms: u32) -> FrameOutput {
        let now = now_ms();
        let active = {
            let guard = self.coordinator.lock().unwrap_or_else(|e| e.into_inner());
            guard.active_state(now)
        };
        let target = if active != PetState::Idle {
            self.manual_override = None;
            active
        } else {
            self.manual_override.unwrap_or(PetState::Idle)
        };
        self.engine.set_state(target);
        let frame = self.engine.tick(dt_ms);
        self.last_frame = frame;
        frame
    }

    pub fn run(&mut self) {
        self.step(self.config.tick_interval_ms);
        platform::run_host_loop(self);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(target_os = "windows")]
mod platform {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use std::ptr::{copy_nonoverlapping, null, null_mut};

    use petdex_core::hook_installer::{detect_agent_status, AgentInstallStatus};
    use petdex_core::CodingAgent;

    use super::{
        compute_bottom_right_placement, Win32PetHost, WindowPlacement, WorkArea, CMD_AGENT_BASE,
        CMD_CYCLE_STATE, CMD_PET_BASE, CMD_QUIT, CMD_RESET_POSITION, CMD_TOGGLE_TOPMOST,
    };

    type Handle = *mut c_void;
    type Hwnd = Handle;
    type Hinstance = Handle;
    type Hicon = Handle;
    type Hcursor = Handle;
    type Hbrush = Handle;
    type Hdc = Handle;
    type Hmenu = Handle;
    type Hbitmap = Handle;
    type WndProc = unsafe extern "system" fn(Hwnd, u32, usize, isize) -> isize;

    const CS_HREDRAW: u32 = 0x0002;
    const CS_VREDRAW: u32 = 0x0001;
    const WS_POPUP: u32 = 0x8000_0000;
    const WS_VISIBLE: u32 = 0x1000_0000;
    const SW_SHOW: i32 = 5;

    const WM_NULL: u32 = 0x0000;
    const WM_CREATE: u32 = 0x0001;
    const WM_DESTROY: u32 = 0x0002;
    const WM_MOVE: u32 = 0x0003;
    const WM_NCCREATE: u32 = 0x0081;
    const WM_NCHITTEST: u32 = 0x0084;
    const WM_NCRBUTTONUP: u32 = 0x00A5;
    const WM_COMMAND: u32 = 0x0111;
    const WM_TIMER: u32 = 0x0113;
    const WM_RBUTTONUP: u32 = 0x0205;
    const WM_APP: u32 = 0x8000;
    const WM_TRAYICON: u32 = WM_APP + 1;

    const HTCAPTION: isize = 2;
    const GWLP_USERDATA: i32 = -21;

    const ULW_ALPHA: u32 = 0x0000_0002;
    const AC_SRC_OVER: u8 = 0x00;
    const AC_SRC_ALPHA: u8 = 0x01;
    const BI_RGB: u32 = 0;
    const DIB_RGB_COLORS: u32 = 0;

    const MF_STRING: u32 = 0x0000_0000;
    const MF_GRAYED: u32 = 0x0000_0001;
    const MF_CHECKED: u32 = 0x0000_0008;
    const MF_POPUP: u32 = 0x0000_0010;
    const MF_SEPARATOR: u32 = 0x0000_0800;
    const TPM_RIGHTBUTTON: u32 = 0x0002;

    const NIM_ADD: u32 = 0x0000_0000;
    const NIM_DELETE: u32 = 0x0000_0002;
    const NIF_MESSAGE: u32 = 0x0000_0001;
    const NIF_ICON: u32 = 0x0000_0002;
    const NIF_TIP: u32 = 0x0000_0004;

    const SPI_GETWORKAREA: u32 = 0x0030;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const HWND_TOPMOST: Hwnd = (-1isize) as Hwnd;
    const HWND_NOTOPMOST: Hwnd = (-2isize) as Hwnd;

    const IDC_ARROW: *const u16 = 32512usize as *const u16;
    const IDI_APPLICATION: *const u16 = 32512usize as *const u16;

    const TIMER_ID: usize = 1;
    const TRAY_ICON_ID: u32 = 1;

    const HOOKABLE_AGENTS: [CodingAgent; 5] = [
        CodingAgent::ClaudeCode,
        CodingAgent::Codex,
        CodingAgent::Gemini,
        CodingAgent::OpenCode,
        CodingAgent::Hermes,
    ];

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Size {
        cx: i32,
        cy: i32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct BlendFunction {
        blend_op: u8,
        blend_flags: u8,
        source_constant_alpha: u8,
        alpha_format: u8,
    }

    #[repr(C)]
    struct BitmapInfoHeader {
        bi_size: u32,
        bi_width: i32,
        bi_height: i32,
        bi_planes: u16,
        bi_bit_count: u16,
        bi_compression: u32,
        bi_size_image: u32,
        bi_x_pels_per_meter: i32,
        bi_y_pels_per_meter: i32,
        bi_clr_used: u32,
        bi_clr_important: u32,
    }

    #[repr(C)]
    struct BitmapInfo {
        bmi_header: BitmapInfoHeader,
        bmi_colors: [u32; 1],
    }

    #[allow(dead_code)]
    #[repr(C)]
    struct Msg {
        hwnd: Hwnd,
        message: u32,
        wparam: usize,
        lparam: isize,
        time: u32,
        pt: Point,
    }

    #[repr(C)]
    struct WndClassExW {
        cb_size: u32,
        style: u32,
        lpfn_wnd_proc: WndProc,
        cb_cls_extra: i32,
        cb_wnd_extra: i32,
        h_instance: Hinstance,
        h_icon: Hicon,
        h_cursor: Hcursor,
        hbr_background: Hbrush,
        lpsz_menu_name: *const u16,
        lpsz_class_name: *const u16,
        h_icon_sm: Hicon,
    }

    #[allow(dead_code)]
    #[repr(C)]
    struct CreateStructW {
        lp_create_params: *mut c_void,
        h_instance: Hinstance,
        h_menu: Hmenu,
        hwnd_parent: Hwnd,
        cy: i32,
        cx: i32,
        y: i32,
        x: i32,
        style: i32,
        lpsz_name: *const u16,
        lpsz_class: *const u16,
        dw_ex_style: u32,
    }

    #[allow(dead_code)]
    #[repr(C)]
    struct NotifyIconDataW {
        cb_size: u32,
        hwnd: Hwnd,
        u_id: u32,
        u_flags: u32,
        u_callback_message: u32,
        h_icon: Hicon,
        sz_tip: [u16; 128],
        dw_state: u32,
        dw_state_mask: u32,
        sz_info: [u16; 256],
        u_timeout_or_version: u32,
        sz_info_title: [u16; 64],
        dw_info_flags: u32,
        guid_item: [u8; 16],
        h_balloon_icon: Hicon,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(lp_module_name: *const u16) -> Hinstance;
    }

    #[link(name = "user32")]
    extern "system" {
        fn RegisterClassExW(lpwcx: *const WndClassExW) -> u16;
        fn UnregisterClassW(lp_class_name: *const u16, h_instance: Hinstance) -> i32;
        fn CreateWindowExW(
            dw_ex_style: u32,
            lp_class_name: *const u16,
            lp_window_name: *const u16,
            dw_style: u32,
            x: i32,
            y: i32,
            n_width: i32,
            n_height: i32,
            hwnd_parent: Hwnd,
            h_menu: Hmenu,
            h_instance: Hinstance,
            lp_param: *mut c_void,
        ) -> Hwnd;
        fn DestroyWindow(hwnd: Hwnd) -> i32;
        fn ShowWindow(hwnd: Hwnd, n_cmd_show: i32) -> i32;
        fn DefWindowProcW(hwnd: Hwnd, msg: u32, wparam: usize, lparam: isize) -> isize;
        fn GetMessageW(
            lp_msg: *mut Msg,
            hwnd: Hwnd,
            wmsg_filter_min: u32,
            wmsg_filter_max: u32,
        ) -> i32;
        fn TranslateMessage(lp_msg: *const Msg) -> i32;
        fn DispatchMessageW(lp_msg: *const Msg) -> isize;
        fn PostQuitMessage(n_exit_code: i32);
        fn PostMessageW(hwnd: Hwnd, msg: u32, wparam: usize, lparam: isize) -> i32;
        fn SetTimer(
            hwnd: Hwnd,
            n_id_event: usize,
            u_elapse: u32,
            lp_timer_func: *const c_void,
        ) -> usize;
        fn KillTimer(hwnd: Hwnd, u_id_event: usize) -> i32;
        fn GetWindowRect(hwnd: Hwnd, lp_rect: *mut Rect) -> i32;
        fn GetCursorPos(lp_point: *mut Point) -> i32;
        fn SetForegroundWindow(hwnd: Hwnd) -> i32;
        fn SetWindowPos(
            hwnd: Hwnd,
            hwnd_insert_after: Hwnd,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            u_flags: u32,
        ) -> i32;
        fn SystemParametersInfoW(
            ui_action: u32,
            ui_param: u32,
            pv_param: *mut c_void,
            f_win_ini: u32,
        ) -> i32;
        fn CreatePopupMenu() -> Hmenu;
        fn AppendMenuW(
            h_menu: Hmenu,
            u_flags: u32,
            u_id_new_item: usize,
            lp_new_item: *const u16,
        ) -> i32;
        fn TrackPopupMenu(
            h_menu: Hmenu,
            u_flags: u32,
            x: i32,
            y: i32,
            n_reserved: i32,
            hwnd: Hwnd,
            prc_rect: *const Rect,
        ) -> i32;
        fn DestroyMenu(h_menu: Hmenu) -> i32;
        fn LoadCursorW(h_instance: Hinstance, lp_cursor_name: *const u16) -> Hcursor;
        fn LoadIconW(h_instance: Hinstance, lp_icon_name: *const u16) -> Hicon;
        fn GetDC(hwnd: Hwnd) -> Hdc;
        fn ReleaseDC(hwnd: Hwnd, hdc: Hdc) -> i32;
        fn UpdateLayeredWindow(
            hwnd: Hwnd,
            hdc_dst: Hdc,
            ppt_dst: *const Point,
            psize: *const Size,
            hdc_src: Hdc,
            ppt_src: *const Point,
            cr_key: u32,
            pblend: *const BlendFunction,
            dw_flags: u32,
        ) -> i32;
    }

    #[cfg(target_pointer_width = "64")]
    #[link(name = "user32")]
    extern "system" {
        fn GetWindowLongPtrW(hwnd: Hwnd, n_index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: Hwnd, n_index: i32, dw_new_long: isize) -> isize;
    }

    #[cfg(target_pointer_width = "32")]
    #[link(name = "user32")]
    extern "system" {
        fn GetWindowLongW(hwnd: Hwnd, n_index: i32) -> isize;
        fn SetWindowLongW(hwnd: Hwnd, n_index: i32, dw_new_long: isize) -> isize;
    }

    #[link(name = "gdi32")]
    extern "system" {
        fn CreateCompatibleDC(hdc: Hdc) -> Hdc;
        fn DeleteDC(hdc: Hdc) -> i32;
        fn SelectObject(hdc: Hdc, h: Handle) -> Handle;
        fn DeleteObject(ho: Handle) -> i32;
        fn CreateDIBSection(
            hdc: Hdc,
            pbmi: *const BitmapInfo,
            usage: u32,
            ppv_bits: *mut *mut c_void,
            h_section: Handle,
            offset: u32,
        ) -> Hbitmap;
    }

    #[link(name = "shell32")]
    extern "system" {
        fn Shell_NotifyIconW(dw_message: u32, lp_data: *mut NotifyIconDataW) -> i32;
    }

    unsafe fn get_user_data(hwnd: Hwnd) -> *mut Win32PetHost {
        #[cfg(target_pointer_width = "64")]
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
        #[cfg(target_pointer_width = "32")]
        let ptr = GetWindowLongW(hwnd, GWLP_USERDATA);
        ptr as *mut Win32PetHost
    }

    unsafe fn set_user_data(hwnd: Hwnd, host: *mut Win32PetHost) {
        #[cfg(target_pointer_width = "64")]
        {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, host as isize);
        }
        #[cfg(target_pointer_width = "32")]
        {
            SetWindowLongW(hwnd, GWLP_USERDATA, host as isize);
        }
    }

    fn wide_null(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn query_work_area() -> WorkArea {
        let mut rect = Rect {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };
        unsafe {
            SystemParametersInfoW(
                SPI_GETWORKAREA,
                0,
                (&mut rect as *mut Rect).cast::<c_void>(),
                0,
            );
        }
        WorkArea {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        }
    }

    unsafe fn query_pet_placement(hwnd: Hwnd, host: &Win32PetHost) -> WindowPlacement {
        let mut rect = Rect {
            left: 0,
            top: 0,
            right: host.config().width,
            bottom: host.config().height,
        };
        GetWindowRect(hwnd, &mut rect);
        WindowPlacement {
            x: rect.left,
            y: rect.top,
            width: (rect.right - rect.left).max(1),
            height: (rect.bottom - rect.top).max(1),
        }
    }

    unsafe fn sync_bubble(hwnd: Hwnd, host: &mut Win32PetHost) {
        let pet_placement = query_pet_placement(hwnd, host);
        let work_area = query_work_area();
        let content = host.active_bubble_content();
        let topmost = host.is_topmost();
        host.bubble_window_mut()
            .sync(pet_placement, work_area, content.as_ref(), topmost);
    }

    unsafe fn present_pet_frame(hwnd: Hwnd, host: &mut Win32PetHost) {
        let frame = host.current_decoded_frame();
        if frame.width == 0 || frame.height == 0 {
            return;
        }

        let screen_dc = GetDC(null_mut());
        if screen_dc.is_null() {
            return;
        }
        let mem_dc = CreateCompatibleDC(screen_dc);
        if mem_dc.is_null() {
            ReleaseDC(null_mut(), screen_dc);
            return;
        }

        let mut bmi: BitmapInfo = zeroed();
        bmi.bmi_header.bi_size = size_of::<BitmapInfoHeader>() as u32;
        bmi.bmi_header.bi_width = frame.width as i32;
        bmi.bmi_header.bi_height = -(frame.height as i32);
        bmi.bmi_header.bi_planes = 1;
        bmi.bmi_header.bi_bit_count = 32;
        bmi.bmi_header.bi_compression = BI_RGB;

        let mut bits: *mut c_void = null_mut();
        let hbitmap = CreateDIBSection(
            screen_dc,
            &bmi,
            DIB_RGB_COLORS,
            &mut bits,
            null_mut(),
            0,
        );
        if hbitmap.is_null() || bits.is_null() {
            DeleteDC(mem_dc);
            ReleaseDC(null_mut(), screen_dc);
            return;
        }

        copy_nonoverlapping(frame.bgra.as_ptr(), bits.cast::<u8>(), frame.bgra.len());
        let old_bmp = SelectObject(mem_dc, hbitmap);

        let pt_src = Point { x: 0, y: 0 };
        let size = Size {
            cx: frame.width as i32,
            cy: frame.height as i32,
        };
        let blend = BlendFunction {
            blend_op: AC_SRC_OVER,
            blend_flags: 0,
            source_constant_alpha: 255,
            alpha_format: AC_SRC_ALPHA,
        };

        UpdateLayeredWindow(
            hwnd,
            screen_dc,
            null(),
            &size,
            mem_dc,
            &pt_src,
            0,
            &blend,
            ULW_ALPHA,
        );

        SelectObject(mem_dc, old_bmp);
        DeleteObject(hbitmap);
        DeleteDC(mem_dc);
        ReleaseDC(null_mut(), screen_dc);
    }

    unsafe fn add_tray_icon(hwnd: Hwnd) {
        let mut nid: NotifyIconDataW = zeroed();
        nid.cb_size = size_of::<NotifyIconDataW>() as u32;
        nid.hwnd = hwnd;
        nid.u_id = TRAY_ICON_ID;
        nid.u_flags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
        nid.u_callback_message = WM_TRAYICON;
        nid.h_icon = LoadIconW(null_mut(), IDI_APPLICATION);

        let tip = wide_null("Petdex");
        let len = tip.len().min(nid.sz_tip.len());
        nid.sz_tip[..len].copy_from_slice(&tip[..len]);

        Shell_NotifyIconW(NIM_ADD, &mut nid);
    }

    unsafe fn remove_tray_icon(hwnd: Hwnd) {
        let mut nid: NotifyIconDataW = zeroed();
        nid.cb_size = size_of::<NotifyIconDataW>() as u32;
        nid.hwnd = hwnd;
        nid.u_id = TRAY_ICON_ID;
        Shell_NotifyIconW(NIM_DELETE, &mut nid);
    }

    unsafe fn show_context_menu(hwnd: Hwnd, host: &Win32PetHost) {
        let menu = CreatePopupMenu();
        if menu.is_null() {
            return;
        }

        let pets_menu = CreatePopupMenu();
        if !pets_menu.is_null() {
            if host.installed_pets().is_empty() {
                let empty_label = wide_null("Cobalt Fallback (No pets installed)");
                AppendMenuW(pets_menu, MF_STRING | MF_GRAYED, 0, empty_label.as_ptr());
            } else {
                for (idx, pet) in host.installed_pets().iter().enumerate() {
                    let flags = if host.active_pet_index() == Some(idx) {
                        MF_STRING | MF_CHECKED
                    } else {
                        MF_STRING
                    };
                    let label = wide_null(&pet.display_name);
                    AppendMenuW(pets_menu, flags, CMD_PET_BASE + idx, label.as_ptr());
                }
            }
            let pets_title = wide_null("Pets");
            AppendMenuW(menu, MF_POPUP, pets_menu as usize, pets_title.as_ptr());
        }

        let agents_menu = CreatePopupMenu();
        if !agents_menu.is_null() {
            for agent in HOOKABLE_AGENTS {
                let spec = agent.spec();
                let status = detect_agent_status(agent);
                let (flags, text) = match status {
                    AgentInstallStatus::Connected => (
                        MF_STRING | MF_CHECKED,
                        format!("{}: Disconnect", spec.display_name),
                    ),
                    AgentInstallStatus::Detected => {
                        (MF_STRING, format!("{}: Connect", spec.display_name))
                    }
                    AgentInstallStatus::NotFound => (
                        MF_STRING,
                        format!("{}: Connect (Not detected)", spec.display_name),
                    ),
                };
                let label = wide_null(&text);
                AppendMenuW(
                    agents_menu,
                    flags,
                    CMD_AGENT_BASE + (agent as usize),
                    label.as_ptr(),
                );
            }
            let agents_title = wide_null("Agents");
            AppendMenuW(menu, MF_POPUP, agents_menu as usize, agents_title.as_ptr());
        }

        AppendMenuW(menu, MF_SEPARATOR, 0, null());

        let cycle_label = wide_null("Cycle Pet State");
        let topmost_label = wide_null("Always on Top");
        let reset_label = wide_null("Reset Position");
        let quit_label = wide_null("Quit Petdex");

        AppendMenuW(menu, MF_STRING, CMD_CYCLE_STATE, cycle_label.as_ptr());
        let topmost_flags = if host.is_topmost() {
            MF_STRING | MF_CHECKED
        } else {
            MF_STRING
        };
        AppendMenuW(menu, topmost_flags, CMD_TOGGLE_TOPMOST, topmost_label.as_ptr());
        AppendMenuW(menu, MF_STRING, CMD_RESET_POSITION, reset_label.as_ptr());
        AppendMenuW(menu, MF_SEPARATOR, 0, null());
        AppendMenuW(menu, MF_STRING, CMD_QUIT, quit_label.as_ptr());

        let mut pt = Point { x: 0, y: 0 };
        GetCursorPos(&mut pt);
        SetForegroundWindow(hwnd);
        TrackPopupMenu(menu, TPM_RIGHTBUTTON, pt.x, pt.y, 0, hwnd, null());
        PostMessageW(hwnd, WM_NULL, 0, 0);
        DestroyMenu(menu);
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: Hwnd,
        msg: u32,
        wparam: usize,
        lparam: isize,
    ) -> isize {
        if msg == WM_NCCREATE {
            let cs = lparam as *const CreateStructW;
            if !cs.is_null() {
                set_user_data(hwnd, (*cs).lp_create_params as *mut Win32PetHost);
            }
            return 1;
        }

        let host_ptr = get_user_data(hwnd);

        match msg {
            WM_CREATE => {
                if !host_ptr.is_null() {
                    let tick_ms = (*host_ptr).config().tick_interval_ms.max(1);
                    SetTimer(hwnd, TIMER_ID, tick_ms, null());
                }
                add_tray_icon(hwnd);
                0
            }
            WM_NCHITTEST => HTCAPTION,
            WM_MOVE => {
                if !host_ptr.is_null() {
                    sync_bubble(hwnd, &mut *host_ptr);
                }
                0
            }
            WM_RBUTTONUP | WM_NCRBUTTONUP => {
                if !host_ptr.is_null() {
                    show_context_menu(hwnd, &*host_ptr);
                }
                0
            }
            WM_TRAYICON => {
                let mouse_msg = (lparam as u32) & 0xFFFF;
                if mouse_msg == WM_RBUTTONUP && !host_ptr.is_null() {
                    show_context_menu(hwnd, &*host_ptr);
                }
                0
            }
            WM_COMMAND => {
                let cmd_id = wparam & 0xFFFF;
                if !host_ptr.is_null() {
                    let host = &mut *host_ptr;
                    match cmd_id {
                        CMD_CYCLE_STATE => {
                            host.cycle_state();
                            present_pet_frame(hwnd, host);
                        }
                        CMD_TOGGLE_TOPMOST => {
                            let insert_after = if host.toggle_topmost() {
                                HWND_TOPMOST
                            } else {
                                HWND_NOTOPMOST
                            };
                            SetWindowPos(
                                hwnd,
                                insert_after,
                                0,
                                0,
                                0,
                                0,
                                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                            );
                            sync_bubble(hwnd, host);
                        }
                        CMD_RESET_POSITION => {
                            let work_area = query_work_area();
                            let placement = compute_bottom_right_placement(
                                work_area,
                                host.config().width,
                                host.config().height,
                                host.config().margin,
                            );
                            SetWindowPos(
                                hwnd,
                                null_mut(),
                                placement.x,
                                placement.y,
                                placement.width,
                                placement.height,
                                SWP_NOZORDER | SWP_NOACTIVATE,
                            );
                            sync_bubble(hwnd, host);
                        }
                        CMD_QUIT => {
                            DestroyWindow(hwnd);
                        }
                        id if (CMD_PET_BASE..CMD_AGENT_BASE).contains(&id) => {
                            let pet_index = id - CMD_PET_BASE;
                            if host.select_pet(pet_index) {
                                present_pet_frame(hwnd, host);
                            }
                        }
                        id if (CMD_AGENT_BASE..CMD_AGENT_BASE + CodingAgent::COUNT).contains(&id) => {
                            if let Some(agent) = CodingAgent::from_u8((id - CMD_AGENT_BASE) as u8) {
                                if let Err(err) = host.toggle_agent_hook(agent) {
                                    eprintln!(
                                        "petdex-windows: failed to toggle hook for {}: {err}",
                                        agent.spec().display_name
                                    );
                                }
                            }
                        }
                        _ => {}
                    }
                }
                0
            }
            WM_TIMER => {
                if wparam == TIMER_ID && !host_ptr.is_null() {
                    let host = &mut *host_ptr;
                    let prev = host.last_frame();
                    let next = host.step(host.config().tick_interval_ms);
                    if next != prev {
                        present_pet_frame(hwnd, host);
                    }
                    sync_bubble(hwnd, host);
                }
                0
            }
            WM_DESTROY => {
                if !host_ptr.is_null() {
                    (*host_ptr).bubble_window_mut().destroy();
                }
                KillTimer(hwnd, TIMER_ID);
                remove_tray_icon(hwnd);
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    pub fn run_host_loop(host: &mut Win32PetHost) {
        let class_name = wide_null("PetdexWin32LayeredHost");
        let window_title = wide_null("Petdex");

        unsafe {
            let h_instance = GetModuleHandleW(null());
            let wc = WndClassExW {
                cb_size: size_of::<WndClassExW>() as u32,
                style: CS_HREDRAW | CS_VREDRAW,
                lpfn_wnd_proc: wnd_proc,
                cb_cls_extra: 0,
                cb_wnd_extra: 0,
                h_instance,
                h_icon: LoadIconW(null_mut(), IDI_APPLICATION),
                h_cursor: LoadCursorW(null_mut(), IDC_ARROW),
                hbr_background: null_mut(),
                lpsz_menu_name: null(),
                lpsz_class_name: class_name.as_ptr(),
                h_icon_sm: null_mut(),
            };

            if RegisterClassExW(&wc) == 0 {
                eprintln!("petdex-windows: RegisterClassExW failed");
                return;
            }

            let work_area = query_work_area();
            let placement = compute_bottom_right_placement(
                work_area,
                host.config().width,
                host.config().height,
                host.config().margin,
            );

            let hwnd = CreateWindowExW(
                host.config().ex_style,
                class_name.as_ptr(),
                window_title.as_ptr(),
                WS_POPUP | WS_VISIBLE,
                placement.x,
                placement.y,
                placement.width,
                placement.height,
                null_mut(),
                null_mut(),
                h_instance,
                (host as *mut Win32PetHost).cast::<c_void>(),
            );

            if hwnd.is_null() {
                eprintln!("petdex-windows: CreateWindowExW failed");
                UnregisterClassW(class_name.as_ptr(), h_instance);
                return;
            }

            present_pet_frame(hwnd, host);
            sync_bubble(hwnd, host);
            ShowWindow(hwnd, SW_SHOW);

            eprintln!(
                "petdex-windows: Win32 host ready (ex_style=0x{:08x}, pos={},{} size={}x{}, hook=127.0.0.1:{}, state={}, pets={})",
                host.config().ex_style,
                placement.x,
                placement.y,
                placement.width,
                placement.height,
                host.port(),
                host.last_frame().state.slug(),
                host.installed_pets().len(),
            );

            let mut msg: Msg = zeroed();
            while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            UnregisterClassW(class_name.as_ptr(), h_instance);
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use super::Win32PetHost;

    pub fn run_host_loop(host: &mut Win32PetHost) {
        let frame = host.last_frame();
        let rect = host.current_frame_rect();
        eprintln!(
            "petdex-windows: non-Windows host stub (ex_style=0x{:08x}, size={}x{}, hook=127.0.0.1:{}, state={}, atlas_rect={},{} {}x{})",
            host.config().ex_style,
            host.config().width,
            host.config().height,
            host.port(),
            frame.state.slug(),
            rect.x,
            rect.y,
            rect.width,
            rect.height,
        );
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    use petdex_core::{PetAnimationEngine, PetState, UPDATE_TOKEN_HEADER};

    use super::*;

    fn send_http(port: u16, request: &str) -> (u16, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect hook server");
        stream
            .write_all(request.as_bytes())
            .expect("write http request");
        stream.flush().expect("flush http request");

        let mut response = String::new();
        stream
            .read_to_string(&mut response)
            .expect("read http response");
        let (head, body) = response
            .split_once("\r\n\r\n")
            .expect("http response delimiter");
        let status = head
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse::<u16>().ok())
            .expect("http status code");
        (status, body.to_string())
    }

    #[test]
    fn atlas_slicing_maps_all_eight_by_nine_cells() {
        let spec = SpriteAtlasSpec::default();
        assert_eq!(spec.cols, 8);
        assert_eq!(spec.rows, 9);
        assert_eq!(spec.cell_width(), 128);
        assert_eq!(spec.cell_height(), 128);

        for state in PetState::ALL {
            let mut engine = PetAnimationEngine::with_state(state);
            let def = state.def();
            for expected_col in 0..def.frames.len() {
                let frame = engine.current_frame();
                let rect = spec.frame_rect(frame);
                assert_eq!(rect.x, (expected_col as u32) * 128);
                assert_eq!(rect.y, (def.row as u32) * 128);
                assert_eq!(rect.width, 128);
                assert_eq!(rect.height, 128);
                engine.tick(frame.frame_dur_ms);
            }
        }
    }

    #[test]
    fn atlas_slicing_clamps_out_of_bounds_coordinates() {
        let spec = SpriteAtlasSpec::new(512, 576, 8, 9);
        assert_eq!(spec.cell_width(), 64);
        assert_eq!(spec.cell_height(), 64);

        let overflow = FrameOutput {
            state: PetState::Review,
            row: 99,
            col: 42,
            frame_index: 0,
            frame_dur_ms: 100,
        };
        let rect = spec.frame_rect(overflow);
        assert_eq!(
            rect,
            AtlasRect {
                x: 7 * 64,
                y: 8 * 64,
                width: 64,
                height: 64,
            }
        );
    }

    #[test]
    fn bottom_right_placement_respects_work_area_and_margin() {
        let area = WorkArea {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1040,
        };
        let placed = compute_bottom_right_placement(area, 160, 160, 24);
        assert_eq!(
            placed,
            WindowPlacement {
                x: 1736,
                y: 856,
                width: 160,
                height: 160,
            }
        );

        let secondary = WorkArea {
            left: 1920,
            top: 40,
            right: 3200,
            bottom: 760,
        };
        let secondary_placed = compute_bottom_right_placement(secondary, 160, 160, 20);
        assert_eq!(
            secondary_placed,
            WindowPlacement {
                x: 3020,
                y: 580,
                width: 160,
                height: 160,
            }
        );
    }

    #[test]
    fn placement_clamping_keeps_window_inside_work_area() {
        let area = WorkArea {
            left: 100,
            top: 50,
            right: 900,
            bottom: 650,
        };
        assert_eq!(area.width(), 800);
        assert_eq!(area.height(), 600);

        let too_far_left = clamp_placement_to_work_area(
            WindowPlacement {
                x: -40,
                y: 10,
                width: 160,
                height: 160,
            },
            area,
        );
        assert_eq!(too_far_left.x, 100);
        assert_eq!(too_far_left.y, 50);

        let too_far_right = clamp_placement_to_work_area(
            WindowPlacement {
                x: 1200,
                y: 900,
                width: 160,
                height: 160,
            },
            area,
        );
        assert_eq!(too_far_right.x, 740);
        assert_eq!(too_far_right.y, 490);
    }

    #[test]
    fn hook_server_bootstrap_syncs_host_animation_state() {
        let config = Win32HostConfig {
            hook_port: 0,
            ..Win32HostConfig::default()
        };
        let mut host = Win32PetHost::start(config, "secret-token").expect("start host");
        let port = host.port();
        assert_ne!(port, 0);
        assert_eq!(host.config().ex_style, PETDEX_WIN32_EX_STYLE);
        assert!(host.is_topmost());

        let (health_status, health_body) = send_http(
            port,
            "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        );
        assert_eq!(health_status, 200);
        assert!(health_body.contains("\"healthy\""));

        let payload = r#"{"session_id":"win-1","agent":"claude-code","status":"needs_input","summary":"approve tool"}"#;
        let unauth_req = format!(
            "POST /state HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            payload.len(),
            payload
        );
        let (unauth_status, _) = send_http(port, &unauth_req);
        assert_eq!(unauth_status, 401);

        let auth_req = format!(
            "POST /state HTTP/1.1\r\nHost: 127.0.0.1\r\n{}: secret-token\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            UPDATE_TOKEN_HEADER,
            payload.len(),
            payload
        );
        let (auth_status, auth_body) = send_http(port, &auth_req);
        assert_eq!(auth_status, 200);
        assert!(auth_body.contains("\"waiting\""));

        let frame = host.step(16);
        assert_eq!(frame.state, PetState::Waiting);
        assert_eq!(frame.row, 6);
        let rect = host.current_frame_rect();
        assert_eq!(rect.y, 6 * rect.height);
        assert!(rect.width > 0);
        assert!(rect.height > 0);

        let bubble = host.active_bubble_content().expect("active bubble");
        assert_eq!(bubble.agent_name, "Claude Code");
        assert_eq!(bubble.summary, "approve tool");

        let decoded = host.current_decoded_frame();
        assert_eq!(decoded.width, DEFAULT_WINDOW_WIDTH as u32);
        assert_eq!(decoded.height, DEFAULT_WINDOW_HEIGHT as u32);
        assert_eq!(
            decoded.bgra.len(),
            (DEFAULT_WINDOW_WIDTH as usize) * (DEFAULT_WINDOW_HEIGHT as usize) * 4
        );

        assert!(!host.toggle_topmost());
        assert!(host.toggle_topmost());
    }

    #[test]
    fn manual_state_cycle_advances_engine_and_atlas_row() {
        let config = Win32HostConfig {
            hook_port: 0,
            ..Win32HostConfig::default()
        };
        let mut host = Win32PetHost::start(config, "cycle-token").expect("start host");

        assert_eq!(host.last_frame().state, PetState::Idle);
        let cycled = host.cycle_state();
        assert_eq!(cycled.state, PetState::RunningRight);
        assert_eq!(cycled.row, 1);

        let stepped = host.step(16);
        assert_eq!(stepped.state, PetState::RunningRight);
        let rect = host.current_frame_rect();
        assert_eq!(rect.y, rect.height);
    }
}
