use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use petdex_core::{
    AgentEvent, AttentionCoordinator, CodingAgent, FrameOutput, HookServer, HookServerConfig,
    OAuthCallback, PetAnimationEngine, PetState, SessionStatus, DEFAULT_HOOK_PORT,
};

use crate::bubble_window::{BubbleContent, BubbleWindow};
use crate::physics::PetPhysics;
use crate::popup_menu::PopupMenu;
#[cfg(not(test))]
use crate::settings_window::default_settings_path;
use crate::settings_window::{
    apply_launch_at_login, clamp_scale_percent, step_scale_percent, PersistedWindowsSettings,
    SettingsState, SettingsWindow, DEFAULT_SCALE_PERCENT,
};
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
pub const CMD_OPEN_SETTINGS: usize = 1000;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const CMD_CYCLE_STATE: usize = 1001;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const CMD_TOGGLE_TOPMOST: usize = 1002;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const CMD_RESET_POSITION: usize = 1003;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const CMD_QUIT: usize = 1004;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const CMD_SHUFFLE_PET: usize = 1005;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const CMD_TOGGLE_FOCUS_MODE: usize = 1006;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const CMD_SEND_TEST_BUBBLE: usize = 1007;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const CMD_PET_BASE: usize = 2000;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const CMD_AGENT_BASE: usize = 3000;

#[cfg(target_os = "windows")]
pub const WM_PETDEX_SYNC_VISUALS: u32 = 0x8002;
#[cfg(target_os = "windows")]
pub const WM_PETDEX_SYNC_TOPMOST: u32 = 0x8003;
#[cfg(target_os = "windows")]
pub const WM_PETDEX_SYNC_SCALE: u32 = 0x8004;

pub const fn scaled_window_dimensions(
    base_width: i32,
    base_height: i32,
    scale_percent: u32,
) -> (i32, i32) {
    let clamped = clamp_scale_percent(scale_percent);
    let safe_w = if base_width < 1 { 1 } else { base_width } as u32;
    let safe_h = if base_height < 1 { 1 } else { base_height } as u32;
    let scaled_w = (safe_w * clamped) / 100;
    let scaled_h = (safe_h * clamped) / 100;
    (
        if scaled_w < 1 { 1 } else { scaled_w as i32 },
        if scaled_h < 1 { 1 } else { scaled_h as i32 },
    )
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const fn compute_resized_bottom_center_placement(
    current: WindowPlacement,
    new_width: i32,
    new_height: i32,
    work_area: WorkArea,
) -> WindowPlacement {
    let safe_w = if new_width < 1 { 1 } else { new_width };
    let safe_h = if new_height < 1 { 1 } else { new_height };
    let anchor_center_x = current.x.saturating_add(current.width / 2);
    let anchor_bottom_y = current.y.saturating_add(current.height);
    let desired = WindowPlacement {
        x: anchor_center_x.saturating_sub(safe_w / 2),
        y: anchor_bottom_y.saturating_sub(safe_h),
        width: safe_w,
        height: safe_h,
    };
    clamp_placement_to_work_area(desired, work_area)
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn pick_shuffle_index(total: usize, current: Option<usize>, seed: u64) -> Option<usize> {
    if total == 0 {
        return None;
    }
    if total == 1 {
        return Some(0);
    }
    match current {
        Some(curr) if curr < total => {
            let offset = ((seed % ((total - 1) as u64)) as usize) + 1;
            Some((curr + offset) % total)
        }
        _ => Some((seed % (total as u64)) as usize),
    }
}

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
    base_width: i32,
    base_height: i32,
    scale_percent: u32,
    bubbles_enabled: bool,
    focus_mode: bool,
    launch_at_login: bool,
    settings_path: Option<PathBuf>,
    shuffle_counter: u64,
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
    physics: PetPhysics,
    dragging: bool,
    drag_offset_x: i32,
    drag_offset_y: i32,
    pre_drag_state: Option<PetState>,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    last_tick_ms: u64,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    popup_menu: PopupMenu,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    bubble_window: BubbleWindow,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    settings_window: SettingsWindow,
}

impl Win32PetHost {
    pub fn start(config: Win32HostConfig, update_token: impl Into<String>) -> std::io::Result<Self> {
        #[cfg(not(test))]
        let settings_path = default_settings_path();
        #[cfg(test)]
        let settings_path = None;
        Self::start_with_settings_path(config, update_token, settings_path)
    }

    pub fn start_with_settings_path(
        mut config: Win32HostConfig,
        update_token: impl Into<String>,
        settings_path: Option<PathBuf>,
    ) -> std::io::Result<Self> {
        let coordinator = Arc::new(Mutex::new(AttentionCoordinator::new()));
        let server = HookServer::start(
            HookServerConfig::new(config.hook_port, update_token),
            Arc::clone(&coordinator),
        )?;
        let engine = PetAnimationEngine::new();
        let last_frame = engine.current_frame();
        let base_width = config.width.max(1);
        let base_height = config.height.max(1);

        let loaded_settings = settings_path
            .as_deref()
            .filter(|path| path.exists())
            .map(PersistedWindowsSettings::load_from_path);

        let scale_percent = loaded_settings
            .as_ref()
            .map(|s| clamp_scale_percent(s.scale_percent))
            .unwrap_or(DEFAULT_SCALE_PERCENT);
        let (scaled_w, scaled_h) = scaled_window_dimensions(base_width, base_height, scale_percent);
        config.width = scaled_w;
        config.height = scaled_h;

        let topmost = loaded_settings
            .as_ref()
            .map(|s| s.always_on_top)
            .unwrap_or((config.ex_style & WS_EX_TOPMOST) != 0);
        if topmost {
            config.ex_style |= WS_EX_TOPMOST;
        } else {
            config.ex_style &= !WS_EX_TOPMOST;
        }

        let bubbles_enabled = loaded_settings
            .as_ref()
            .map(|s| s.bubbles_enabled)
            .unwrap_or(true);
        let focus_mode = loaded_settings
            .as_ref()
            .map(|s| s.focus_mode)
            .unwrap_or(false);
        let launch_at_login = loaded_settings
            .as_ref()
            .map(|s| s.launch_at_login)
            .unwrap_or(false);
        let preferred_pet_id = loaded_settings
            .as_ref()
            .and_then(|s| s.active_pet.clone());

        let installed_pets = discover_pets();
        let mut active_pet_index = None;
        let mut atlas = None;

        if let Some(ref preferred_id) = preferred_pet_id {
            if let Some((idx, pet)) = installed_pets
                .iter()
                .enumerate()
                .find(|(_, pet)| pet.id.eq_ignore_ascii_case(preferred_id))
            {
                if let Ok(loaded) = SpriteAtlas::from_file(&pet.spritesheet_path) {
                    let (sw, sh) = loaded.sheet_dimensions();
                    config.atlas.sheet_width = sw;
                    config.atlas.sheet_height = sh;
                    active_pet_index = Some(idx);
                    atlas = Some(loaded);
                }
            }
        }

        if atlas.is_none() {
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
        }

        let settings_state = SettingsState::with_options(
            topmost,
            active_pet_index,
            scale_percent,
            bubbles_enabled,
            focus_mode,
            launch_at_login,
        );

        Ok(Self {
            config,
            base_width,
            base_height,
            scale_percent,
            bubbles_enabled,
            focus_mode,
            launch_at_login,
            settings_path,
            shuffle_counter: 0,
            coordinator,
            engine,
            server,
            manual_override: None,
            topmost,
            last_frame,
            installed_pets,
            active_pet_index,
            atlas,
            physics: PetPhysics::new(),
            dragging: false,
            drag_offset_x: 0,
            drag_offset_y: 0,
            pre_drag_state: None,
            last_tick_ms: now_ms(),
            popup_menu: PopupMenu::new(),
            bubble_window: BubbleWindow::new(),
            settings_window: SettingsWindow::with_state(settings_state),
        })
    }

    pub fn config(&self) -> &Win32HostConfig {
        &self.config
    }

    pub fn port(&self) -> u16 {
        self.server.port()
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn scale_percent(&self) -> u32 {
        self.scale_percent
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn set_scale_percent(&mut self, scale_percent: u32) -> u32 {
        let clamped = clamp_scale_percent(scale_percent);
        self.scale_percent = clamped;
        let (w, h) = scaled_window_dimensions(self.base_width, self.base_height, clamped);
        self.config.width = w;
        self.config.height = h;
        self.settings_window
            .state_mut()
            .set_scale_percent(clamped);
        self.persist_settings();
        clamped
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn step_scale(&mut self, delta: i32) -> u32 {
        let next = step_scale_percent(self.scale_percent, delta);
        self.set_scale_percent(next)
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn is_topmost(&self) -> bool {
        self.topmost
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn toggle_topmost(&mut self) -> bool {
        let next = !self.topmost;
        self.set_topmost(next)
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn set_topmost(&mut self, topmost: bool) -> bool {
        self.topmost = topmost;
        if topmost {
            self.config.ex_style |= WS_EX_TOPMOST;
        } else {
            self.config.ex_style &= !WS_EX_TOPMOST;
        }
        self.settings_window
            .state_mut()
            .set_always_on_top(topmost);
        self.persist_settings();
        self.topmost
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn bubbles_enabled(&self) -> bool {
        self.bubbles_enabled
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn set_bubbles_enabled(&mut self, enabled: bool) -> bool {
        self.bubbles_enabled = enabled;
        self.settings_window
            .state_mut()
            .set_bubbles_enabled(enabled);
        self.persist_settings();
        self.bubbles_enabled
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn focus_mode(&self) -> bool {
        self.focus_mode
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn set_focus_mode(&mut self, enabled: bool) -> bool {
        self.focus_mode = enabled;
        self.settings_window
            .state_mut()
            .set_focus_mode(enabled);
        self.persist_settings();
        self.focus_mode
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn should_show_bubbles(&self) -> bool {
        self.bubbles_enabled && !self.focus_mode
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn launch_at_login(&self) -> bool {
        self.launch_at_login
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn set_launch_at_login(&mut self, enabled: bool) -> bool {
        if let Err(err) = apply_launch_at_login(enabled) {
            eprintln!("petdex-windows: failed to update launch at login: {err}");
            return self.launch_at_login;
        }
        self.launch_at_login = enabled;
        self.settings_window
            .state_mut()
            .set_launch_at_login(enabled);
        self.persist_settings();
        self.launch_at_login
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn persisted_settings(&self) -> PersistedWindowsSettings {
        let active_pet = self
            .active_pet_index
            .and_then(|idx| self.installed_pets.get(idx))
            .map(|pet| pet.id.clone());
        PersistedWindowsSettings {
            scale_percent: self.scale_percent,
            active_pet,
            always_on_top: self.topmost,
            bubbles_enabled: self.bubbles_enabled,
            focus_mode: self.focus_mode,
            launch_at_login: self.launch_at_login,
        }
    }

    fn persist_settings(&self) {
        if let Some(ref path) = self.settings_path {
            if let Err(err) = self.persisted_settings().save_to_path(path) {
                eprintln!(
                    "petdex-windows: failed to save settings to {}: {err}",
                    path.display()
                );
            }
        }
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn shuffle_pet(&mut self) -> Option<usize> {
        let total = self.installed_pets.len();
        if total == 0 {
            return None;
        }
        self.shuffle_counter = self.shuffle_counter.wrapping_add(1);
        let seed = now_ms().wrapping_add(self.shuffle_counter);
        let start_idx = pick_shuffle_index(total, self.active_pet_index, seed)?;
        for step in 0..total {
            let candidate = (start_idx + step) % total;
            if total > 1 && self.active_pet_index == Some(candidate) {
                continue;
            }
            if self.select_pet(candidate) {
                return Some(candidate);
            }
        }
        if total == 1 && self.select_pet(0) {
            return Some(0);
        }
        None
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn take_oauth_callback(&self) -> Option<OAuthCallback> {
        self.server.take_oauth_callback()
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn refresh_pets(&mut self) {
        let current_id = self
            .active_pet_index
            .and_then(|idx| self.installed_pets.get(idx))
            .map(|pet| pet.id.clone());
        self.installed_pets = discover_pets();
        self.active_pet_index = current_id.and_then(|id| {
            self.installed_pets
                .iter()
                .position(|pet| pet.id.eq_ignore_ascii_case(&id))
        });
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn send_test_bubble(&mut self) {
        let now = now_ms();
        let event = AgentEvent {
            session_id: "petdex-settings-test".to_string(),
            agent: CodingAgent::ClaudeCode,
            status: SessionStatus::Completed,
            summary: "Test bubble from Petdex Settings!".to_string(),
        };
        {
            let mut guard = self.coordinator.lock().unwrap_or_else(|e| e.into_inner());
            guard.ingest(event, now);
        }
        self.manual_override = None;
        self.step(self.config.tick_interval_ms);
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
        let total = self.installed_pets.len();
        match SpriteAtlas::from_file(&pet.spritesheet_path) {
            Ok(loaded) => {
                let (sw, sh) = loaded.sheet_dimensions();
                self.config.atlas.sheet_width = sw;
                self.config.atlas.sheet_height = sh;
                self.atlas = Some(loaded);
                self.active_pet_index = Some(index);
                self.settings_window.state_mut().select_pet(index, total);
                self.persist_settings();
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
        if self.focus_mode || !self.bubbles_enabled {
            return None;
        }
        let now = now_ms();
        let bubbles = {
            let guard = self.coordinator.lock().unwrap_or_else(|e| e.into_inner());
            guard.active_bubbles(now)
        };
        BubbleContent::from_active_bubbles(&bubbles)
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn active_bubbles_content(&self) -> Vec<BubbleContent> {
        if self.focus_mode || !self.bubbles_enabled {
            return Vec::new();
        }
        let now = now_ms();
        let bubbles = {
            let guard = self.coordinator.lock().unwrap_or_else(|e| e.into_inner());
            guard.active_bubbles(now)
        };
        BubbleContent::vec_from_active_bubbles(&bubbles)
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn is_dragging(&self) -> bool {
        self.dragging
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn is_throwing(&self) -> bool {
        self.physics.is_throwing()
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn begin_drag(&mut self, cursor_x: i32, cursor_y: i32, win_x: i32, win_y: i32, now: u64) {
        self.dragging = true;
        self.drag_offset_x = cursor_x - win_x;
        self.drag_offset_y = cursor_y - win_y;
        if self.pre_drag_state.is_none() {
            self.pre_drag_state = Some(self.engine.state());
        }
        self.physics.begin_drag(win_x as f64, win_y as f64, now);
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn update_drag(&mut self, cursor_x: i32, cursor_y: i32, now: u64) -> (i32, i32) {
        let new_x = cursor_x - self.drag_offset_x;
        let new_y = cursor_y - self.drag_offset_y;
        if let Some(dir_state) = self.physics.update_drag(new_x as f64, new_y as f64, now) {
            self.manual_override = Some(dir_state);
            self.engine.set_state(dir_state);
            self.last_frame = self.engine.current_frame();
        }
        (new_x, new_y)
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn end_drag(&mut self, cursor_x: i32, cursor_y: i32, now: u64) -> bool {
        self.dragging = false;
        let new_x = cursor_x - self.drag_offset_x;
        let new_y = cursor_y - self.drag_offset_y;
        let launched = self.physics.end_drag(new_x as f64, new_y as f64, now);
        if !launched {
            self.restore_pre_drag_state();
        }
        launched
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn cancel_drag(&mut self) {
        self.dragging = false;
        self.physics.stop();
        self.restore_pre_drag_state();
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn restore_pre_drag_state(&mut self) {
        if let Some(prev) = self.pre_drag_state.take() {
            self.manual_override = if prev == PetState::Idle {
                None
            } else {
                Some(prev)
            };
            self.engine.set_state(prev);
            self.last_frame = self.engine.current_frame();
        }
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn step_throw(
        &mut self,
        dt_sec: f64,
        placement: WindowPlacement,
        work_area: WorkArea,
    ) -> Option<(i32, i32)> {
        if !self.physics.is_throwing() {
            return None;
        }
        let step = self.physics.step(
            dt_sec,
            placement.x as f64,
            placement.y as f64,
            placement.width,
            placement.height,
            (
                work_area.left,
                work_area.top,
                work_area.right,
                work_area.bottom,
            ),
        );
        if step.finished {
            self.restore_pre_drag_state();
        } else if let Some(dir_state) = step.suggested_state {
            self.manual_override = Some(dir_state);
            self.engine.set_state(dir_state);
        }
        Some((step.x.round() as i32, step.y.round() as i32))
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn consume_tick_dt_sec(&mut self) -> f64 {
        let now = now_ms();
        let elapsed_ms = now.saturating_sub(self.last_tick_ms);
        self.last_tick_ms = now;
        (elapsed_ms.clamp(1, 50) as f64) / 1000.0
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn popup_menu_mut(&mut self) -> &mut PopupMenu {
        &mut self.popup_menu
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

    #[cfg(target_os = "windows")]
    pub(crate) fn settings_window_mut(&mut self) -> &mut SettingsWindow {
        &mut self.settings_window
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

    use petdex_core::CodingAgent;

    use super::{
        compute_bottom_right_placement, compute_resized_bottom_center_placement, now_ms,
        Win32PetHost, WindowPlacement, WorkArea, CMD_AGENT_BASE, CMD_CYCLE_STATE,
        CMD_OPEN_SETTINGS, CMD_PET_BASE, CMD_QUIT, CMD_RESET_POSITION, CMD_SEND_TEST_BUBBLE,
        CMD_SHUFFLE_PET, CMD_TOGGLE_FOCUS_MODE, CMD_TOGGLE_TOPMOST, WM_PETDEX_SYNC_SCALE,
        WM_PETDEX_SYNC_TOPMOST, WM_PETDEX_SYNC_VISUALS,
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

    const WM_CREATE: u32 = 0x0001;
    const WM_DESTROY: u32 = 0x0002;
    const WM_MOVE: u32 = 0x0003;
    const WM_NCCREATE: u32 = 0x0081;
    const WM_NCRBUTTONUP: u32 = 0x00A5;
    const WM_COMMAND: u32 = 0x0111;
    const WM_TIMER: u32 = 0x0113;
    const WM_MOUSEMOVE: u32 = 0x0200;
    const WM_LBUTTONDOWN: u32 = 0x0201;
    const WM_LBUTTONUP: u32 = 0x0202;
    const WM_LBUTTONDBLCLK: u32 = 0x0203;
    const WM_RBUTTONUP: u32 = 0x0205;
    const WM_CAPTURECHANGED: u32 = 0x0215;
    const WM_APP: u32 = 0x8000;
    const WM_TRAYICON: u32 = WM_APP + 1;

    const GWLP_USERDATA: i32 = -21;

    const ULW_ALPHA: u32 = 0x0000_0002;
    const AC_SRC_OVER: u8 = 0x00;
    const AC_SRC_ALPHA: u8 = 0x01;
    const BI_RGB: u32 = 0;
    const DIB_RGB_COLORS: u32 = 0;

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
        fn SetCapture(hwnd: Hwnd) -> Hwnd;
        fn ReleaseCapture() -> i32;
        fn SetTimer(
            hwnd: Hwnd,
            n_id_event: usize,
            u_elapse: u32,
            lp_timer_func: *const c_void,
        ) -> usize;
        fn KillTimer(hwnd: Hwnd, u_id_event: usize) -> i32;
        fn GetWindowRect(hwnd: Hwnd, lp_rect: *mut Rect) -> i32;
        fn GetCursorPos(lp_point: *mut Point) -> i32;
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

    unsafe fn sync_bubble(hwnd: Hwnd, host: &mut Win32PetHost, dt_sec: f32) {
        let pet_placement = query_pet_placement(hwnd, host);
        let work_area = query_work_area();
        let bubbles = host.active_bubbles_content();
        let topmost = host.is_topmost();
        host.bubble_window_mut()
            .sync_deck(pet_placement, work_area, &bubbles, topmost, dt_sec);
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

    unsafe fn open_settings_window(hwnd: Hwnd, host_ptr: *mut Win32PetHost) {
        crate::settings_window::open_settings_dialog(hwnd, host_ptr);
    }

    unsafe fn apply_topmost(hwnd: Hwnd, host: &mut Win32PetHost) {
        let insert_after = if host.is_topmost() {
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
        sync_bubble(hwnd, host, 0.0);
    }

    unsafe fn apply_scale_resize(hwnd: Hwnd, host: &mut Win32PetHost) {
        let current = query_pet_placement(hwnd, host);
        let work_area = query_work_area();
        let resized = compute_resized_bottom_center_placement(
            current,
            host.config().width,
            host.config().height,
            work_area,
        );
        SetWindowPos(
            hwnd,
            null_mut(),
            resized.x,
            resized.y,
            resized.width,
            resized.height,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
        present_pet_frame(hwnd, host);
        sync_bubble(hwnd, host, 0.0);
    }

    unsafe fn show_context_menu(hwnd: Hwnd, host: &mut Win32PetHost) {
        let mut pt = Point { x: 0, y: 0 };
        GetCursorPos(&mut pt);
        let work_area = query_work_area();
        let always_on_top = host.is_topmost();
        let focus_mode = host.focus_mode();
        host.popup_menu_mut()
            .show(hwnd, pt.x, pt.y, work_area, always_on_top, focus_mode);
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
            WM_LBUTTONDOWN => {
                if !host_ptr.is_null() {
                    let host = &mut *host_ptr;
                    host.popup_menu_mut().dismiss();
                    SetCapture(hwnd);
                    let mut pt = Point { x: 0, y: 0 };
                    GetCursorPos(&mut pt);
                    let placement = query_pet_placement(hwnd, host);
                    host.begin_drag(pt.x, pt.y, placement.x, placement.y, now_ms());
                }
                0
            }
            WM_MOUSEMOVE => {
                if !host_ptr.is_null() {
                    let host = &mut *host_ptr;
                    if host.is_dragging() {
                        let mut pt = Point { x: 0, y: 0 };
                        GetCursorPos(&mut pt);
                        let (nx, ny) = host.update_drag(pt.x, pt.y, now_ms());
                        SetWindowPos(
                            hwnd,
                            null_mut(),
                            nx,
                            ny,
                            0,
                            0,
                            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                        );
                        sync_bubble(hwnd, host, 0.0);
                    }
                }
                0
            }
            WM_LBUTTONUP => {
                if !host_ptr.is_null() {
                    let host = &mut *host_ptr;
                    if host.is_dragging() {
                        ReleaseCapture();
                        let mut pt = Point { x: 0, y: 0 };
                        GetCursorPos(&mut pt);
                        host.end_drag(pt.x, pt.y, now_ms());
                        present_pet_frame(hwnd, host);
                    }
                }
                0
            }
            WM_CAPTURECHANGED => {
                if !host_ptr.is_null() {
                    let host = &mut *host_ptr;
                    if host.is_dragging() {
                        host.cancel_drag();
                        present_pet_frame(hwnd, host);
                    }
                }
                0
            }
            WM_MOVE => {
                if !host_ptr.is_null() {
                    sync_bubble(hwnd, &mut *host_ptr, 0.0);
                }
                0
            }
            WM_RBUTTONUP | WM_NCRBUTTONUP => {
                if !host_ptr.is_null() {
                    show_context_menu(hwnd, &mut *host_ptr);
                }
                0
            }
            WM_TRAYICON => {
                let mouse_msg = (lparam as u32) & 0xFFFF;
                if !host_ptr.is_null() {
                    if mouse_msg == WM_RBUTTONUP {
                        show_context_menu(hwnd, &mut *host_ptr);
                    } else if mouse_msg == WM_LBUTTONDBLCLK {
                        open_settings_window(hwnd, host_ptr);
                    }
                }
                0
            }
            WM_COMMAND => {
                let cmd_id = wparam & 0xFFFF;
                if !host_ptr.is_null() {
                    let host = &mut *host_ptr;
                    match cmd_id {
                        CMD_OPEN_SETTINGS => {
                            open_settings_window(hwnd, host_ptr);
                        }
                        CMD_SHUFFLE_PET => {
                            if host.shuffle_pet().is_some() {
                                present_pet_frame(hwnd, host);
                            }
                        }
                        CMD_TOGGLE_FOCUS_MODE => {
                            let next = !host.focus_mode();
                            host.set_focus_mode(next);
                            sync_bubble(hwnd, host, 0.0);
                        }
                        CMD_SEND_TEST_BUBBLE => {
                            host.send_test_bubble();
                            present_pet_frame(hwnd, host);
                            sync_bubble(hwnd, host, 0.0);
                        }
                        CMD_CYCLE_STATE => {
                            host.cycle_state();
                            present_pet_frame(hwnd, host);
                        }
                        CMD_TOGGLE_TOPMOST => {
                            let enabled = host.toggle_topmost();
                            host.settings_window_mut()
                                .state_mut()
                                .set_always_on_top(enabled);
                            apply_topmost(hwnd, host);
                        }
                        CMD_RESET_POSITION => {
                            host.cancel_drag();
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
                            present_pet_frame(hwnd, host);
                            sync_bubble(hwnd, host, 0.0);
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
                    let dt_sec = host.consume_tick_dt_sec();
                    if host.is_throwing() {
                        let placement = query_pet_placement(hwnd, host);
                        let work_area = query_work_area();
                        if let Some((nx, ny)) = host.step_throw(dt_sec, placement, work_area) {
                            SetWindowPos(
                                hwnd,
                                null_mut(),
                                nx,
                                ny,
                                0,
                                0,
                                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                            );
                        }
                    }
                    let prev = host.last_frame();
                    let next = host.step(host.config().tick_interval_ms);
                    if next != prev {
                        present_pet_frame(hwnd, host);
                    }
                    sync_bubble(hwnd, host, dt_sec as f32);
                }
                0
            }
            WM_PETDEX_SYNC_VISUALS => {
                if !host_ptr.is_null() {
                    let host = &mut *host_ptr;
                    present_pet_frame(hwnd, host);
                    sync_bubble(hwnd, host, 0.0);
                }
                0
            }
            WM_PETDEX_SYNC_TOPMOST => {
                if !host_ptr.is_null() {
                    apply_topmost(hwnd, &mut *host_ptr);
                }
                0
            }
            WM_PETDEX_SYNC_SCALE => {
                if !host_ptr.is_null() {
                    apply_scale_resize(hwnd, &mut *host_ptr);
                }
                0
            }
            WM_DESTROY => {
                if !host_ptr.is_null() {
                    (*host_ptr).popup_menu_mut().destroy();
                    (*host_ptr).settings_window_mut().destroy();
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
            sync_bubble(hwnd, host, 0.0);
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

    #[test]
    fn settings_oauth_callback_and_test_bubble_flow_end_to_end() {
        let config = Win32HostConfig {
            hook_port: 0,
            ..Win32HostConfig::default()
        };
        let mut host = Win32PetHost::start(config, "settings-token").expect("start host");
        let port = host.port();

        let mut settings = crate::settings_window::SettingsState::new(host.is_topmost(), None);
        let challenge = settings.begin_sign_in(port);
        assert!(challenge
            .authorize_url
            .contains(&format!("redirect_uri=http%3A%2F%2F127.0.0.1%3A{port}%2Fcallback")));
        assert_eq!(settings.account.status_label(), "Waiting for browser...");

        let req = format!(
            "GET /callback?code=clerk_code_42&state={} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            challenge.state
        );
        let (status, body) = send_http(port, &req);
        assert_eq!(status, 200);
        assert!(body.contains("Signed in to Petdex!"));

        let callback = host.take_oauth_callback().expect("oauth callback queued");
        assert!(settings.handle_oauth_callback(callback));
        assert_eq!(settings.account.status_label(), "Signed in!");

        host.send_test_bubble();
        let bubble = host.active_bubble_content().expect("test bubble active");
        assert_eq!(bubble.summary, "Test bubble from Petdex Settings!");
        assert_eq!(host.last_frame().state, PetState::Review);
    }

    #[test]
    fn scaled_dimensions_and_bottom_center_resize_anchor_preserve_position() {
        assert_eq!(scaled_window_dimensions(160, 160, 60), (96, 96));
        assert_eq!(scaled_window_dimensions(160, 160, 100), (160, 160));
        assert_eq!(scaled_window_dimensions(160, 160, 140), (224, 224));
        assert_eq!(scaled_window_dimensions(160, 160, 20), (96, 96));
        assert_eq!(scaled_window_dimensions(160, 160, 200), (224, 224));

        assert_eq!(scaled_window_dimensions(192, 208, 100), (192, 208));
        assert_eq!(scaled_window_dimensions(192, 208, 60), (115, 124));
        assert_eq!(scaled_window_dimensions(192, 208, 140), (268, 291));

        let work_area = WorkArea {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1040,
        };
        let current = WindowPlacement {
            x: 1000,
            y: 700,
            width: 160,
            height: 160,
        };
        let resized = compute_resized_bottom_center_placement(current, 224, 224, work_area);
        assert_eq!(resized.x + resized.width / 2, current.x + current.width / 2);
        assert_eq!(resized.y + resized.height, current.y + current.height);
        assert_eq!(resized.width, 224);
        assert_eq!(resized.height, 224);
    }

    #[test]
    fn focus_mode_and_bubbles_toggle_suppress_active_bubbles() {
        let config = Win32HostConfig {
            hook_port: 0,
            ..Win32HostConfig::default()
        };
        let mut host = Win32PetHost::start(config, "focus-token").expect("start host");
        host.send_test_bubble();
        assert!(host.should_show_bubbles());
        assert!(host.active_bubble_content().is_some());

        host.set_focus_mode(true);
        assert!(!host.should_show_bubbles());
        assert!(host.active_bubble_content().is_none());

        host.set_focus_mode(false);
        assert!(host.should_show_bubbles());
        assert!(host.active_bubble_content().is_some());

        host.set_bubbles_enabled(false);
        assert!(!host.should_show_bubbles());
        assert!(host.active_bubble_content().is_none());

        host.set_bubbles_enabled(true);
        assert!(host.should_show_bubbles());
        assert!(host.active_bubble_content().is_some());
    }

    #[test]
    fn shuffle_pet_index_avoids_current_pet_when_multiple_installed() {
        assert_eq!(pick_shuffle_index(0, None, 42), None);
        assert_eq!(pick_shuffle_index(1, Some(0), 42), Some(0));

        for current in 0..4 {
            for seed in 0..12 {
                let picked = pick_shuffle_index(4, Some(current), seed).expect("picked index");
                assert!(picked < 4);
                assert_ne!(picked, current);
            }
        }
    }

    #[test]
    fn host_live_scale_and_settings_persistence_roundtrip() {
        let temp_dir = std::env::temp_dir().join(format!(
            "petdex-win-host-persist-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let settings_path = temp_dir.join("windows-settings.json");

        {
            let config = Win32HostConfig {
                hook_port: 0,
                ..Win32HostConfig::default()
            };
            let mut host = Win32PetHost::start_with_settings_path(
                config,
                "persist-token-1",
                Some(settings_path.clone()),
            )
            .expect("start host 1");

            assert_eq!(host.scale_percent(), 100);
            assert_eq!(host.step_scale(20), 120);
            assert_eq!(host.config().width, 192);
            assert_eq!(host.config().height, 192);

            let frame = host.current_decoded_frame();
            assert_eq!(frame.width, 192);
            assert_eq!(frame.height, 192);

            host.set_topmost(false);
            host.set_bubbles_enabled(false);
            host.set_focus_mode(true);
            host.set_launch_at_login(true);
        }

        {
            let config = Win32HostConfig {
                hook_port: 0,
                ..Win32HostConfig::default()
            };
            let host = Win32PetHost::start_with_settings_path(
                config,
                "persist-token-2",
                Some(settings_path.clone()),
            )
            .expect("start host 2");

            assert_eq!(host.scale_percent(), 120);
            assert_eq!(host.config().width, 192);
            assert_eq!(host.config().height, 192);
            assert!(!host.is_topmost());
            assert_eq!(host.config().ex_style & WS_EX_TOPMOST, 0);
            assert!(!host.bubbles_enabled());
            assert!(host.focus_mode());
            assert!(host.launch_at_login());
        }

        let _ = std::fs::remove_file(&settings_path);
        let _ = std::fs::remove_dir(&temp_dir);
    }
}
