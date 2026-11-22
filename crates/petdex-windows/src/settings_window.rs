use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use petdex_core::hook_installer::AgentInstallStatus;
use petdex_core::{CodingAgent, OAuthCallback};

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const SETTINGS_WINDOW_WIDTH: i32 = 480;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const SETTINGS_WINDOW_HEIGHT: i32 = 500;

pub const CLERK_AUTHORIZE_URL: &str = "https://clerk.petdex.dev/oauth/authorize";
pub const CLERK_CLIENT_ID: &str = "LcThwEayl6KAA1Qm";
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const CLERK_REDIRECT_URI: &str = "http://127.0.0.1:7777/callback";
pub const CLERK_SCOPES: &str = "profile email openid offline_access";
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const PETDEX_WEBSITE_URL: &str = "https://petdex.dev";

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const SETTINGS_AGENTS: [CodingAgent; 5] = [
    CodingAgent::ClaudeCode,
    CodingAgent::Codex,
    CodingAgent::Gemini,
    CodingAgent::OpenCode,
    CodingAgent::Hermes,
];

static PKCE_NONCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PkceChallenge {
    pub code_verifier: String,
    pub code_challenge: String,
    pub state: String,
    pub authorize_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountAuthState {
    SignedOut,
    WaitingForBrowser {
        expected_state: String,
        code_verifier: String,
    },
    SignedIn {
        authorization_code: String,
    },
    Error(String),
}

impl AccountAuthState {
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn status_label(&self) -> String {
        match self {
            AccountAuthState::SignedOut => "Not signed in".to_string(),
            AccountAuthState::WaitingForBrowser { .. } => "Waiting for browser...".to_string(),
            AccountAuthState::SignedIn { .. } => "Signed in!".to_string(),
            AccountAuthState::Error(msg) => format!("Sign-in failed: {msg}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsState {
    pub account: AccountAuthState,
    pub always_on_top: bool,
    pub selected_pet_index: Option<usize>,
}

impl SettingsState {
    pub fn new(always_on_top: bool, selected_pet_index: Option<usize>) -> Self {
        Self {
            account: AccountAuthState::SignedOut,
            always_on_top,
            selected_pet_index,
        }
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn begin_sign_in_with(&mut self, challenge: &PkceChallenge) -> String {
        self.account = AccountAuthState::WaitingForBrowser {
            expected_state: challenge.state.clone(),
            code_verifier: challenge.code_verifier.clone(),
        };
        challenge.authorize_url.clone()
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn begin_sign_in(&mut self, port: u16) -> PkceChallenge {
        let redirect_uri = redirect_uri_for_port(port);
        let challenge = generate_pkce_challenge(&redirect_uri);
        self.begin_sign_in_with(&challenge);
        challenge
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn handle_oauth_callback(&mut self, callback: OAuthCallback) -> bool {
        if !callback.error.is_empty() {
            self.account = AccountAuthState::Error(callback.error);
            return true;
        }

        let expected_state = match &self.account {
            AccountAuthState::WaitingForBrowser { expected_state, .. } => expected_state.clone(),
            _ => return false,
        };

        if callback.state != expected_state {
            self.account = AccountAuthState::Error("state_mismatch".to_string());
            return true;
        }

        if callback.code.is_empty() {
            self.account = AccountAuthState::Error("missing_code".to_string());
            return true;
        }

        self.account = AccountAuthState::SignedIn {
            authorization_code: callback.code,
        };
        true
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn select_pet(&mut self, index: usize, total_pets: usize) -> bool {
        if index < total_pets {
            self.selected_pet_index = Some(index);
            true
        } else {
            false
        }
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn set_always_on_top(&mut self, enabled: bool) {
        self.always_on_top = enabled;
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn redirect_uri_for_port(port: u16) -> String {
    format!("http://127.0.0.1:{port}/callback")
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn default_pets_folder() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .map(|home| home.join(".petdex").join("pets"))
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn agent_status_text(status: AgentInstallStatus) -> &'static str {
    match status {
        AgentInstallStatus::Connected => "Connected",
        AgentInstallStatus::Detected => "Detected",
        AgentInstallStatus::NotFound => "Not detected",
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn agent_action_label(status: AgentInstallStatus) -> &'static str {
    match status {
        AgentInstallStatus::Connected => "Disconnect",
        AgentInstallStatus::Detected | AgentInstallStatus::NotFound => "Connect",
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn build_pkce_challenge(
    code_verifier: impl Into<String>,
    state: impl Into<String>,
    redirect_uri: &str,
) -> PkceChallenge {
    let code_verifier = code_verifier.into();
    let state = state.into();
    let digest = sha256(code_verifier.as_bytes());
    let code_challenge = base64url_encode(&digest);

    let authorize_url = format!(
        "{CLERK_AUTHORIZE_URL}?client_id={CLERK_CLIENT_ID}&redirect_uri={}&response_type=code&scope={}&code_challenge={code_challenge}&code_challenge_method=S256&state={}",
        percent_encode(redirect_uri),
        percent_encode(CLERK_SCOPES),
        percent_encode(&state),
    );

    PkceChallenge {
        code_verifier,
        code_challenge,
        state,
        authorize_url,
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn generate_pkce_challenge(redirect_uri: &str) -> PkceChallenge {
    let verifier_bytes = random_entropy_bytes(48);
    let state_bytes = random_entropy_bytes(24);
    let code_verifier = base64url_encode(&verifier_bytes);
    let state = base64url_encode(&state_bytes);
    build_pkce_challenge(code_verifier, state, redirect_uri)
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn random_entropy_bytes(len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    while out.len() < len {
        let mut seed = Vec::with_capacity(40);
        let nonce = PKCE_NONCE.fetch_add(1, Ordering::Relaxed);
        seed.extend_from_slice(&nonce.to_le_bytes());

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        seed.extend_from_slice(&now.to_le_bytes());
        seed.extend_from_slice(&std::process::id().to_le_bytes());

        let rs = RandomState::new();
        let mut hasher = rs.build_hasher();
        hasher.write(&seed);
        seed.extend_from_slice(&hasher.finish().to_le_bytes());

        let digest = sha256(&seed);
        let remaining = len - out.len();
        out.extend_from_slice(&digest[..remaining.min(digest.len())]);
    }
    out
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn percent_encode(input: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(input.len() + 16);
    for &b in input.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 0x0F) as usize] as char);
        }
    }
    out
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn base64url_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((input.len() * 4).div_ceil(3));

    let mut i = 0;
    while i + 3 <= input.len() {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8) | (input[i + 2] as u32);
        out.push(TABLE[((n >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3F) as usize] as char);
        out.push(TABLE[((n >> 6) & 0x3F) as usize] as char);
        out.push(TABLE[(n & 0x3F) as usize] as char);
        i += 3;
    }

    match input.len() - i {
        1 => {
            let n = (input[i] as u32) << 16;
            out.push(TABLE[((n >> 18) & 0x3F) as usize] as char);
            out.push(TABLE[((n >> 12) & 0x3F) as usize] as char);
        }
        2 => {
            let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8);
            out.push(TABLE[((n >> 18) & 0x3F) as usize] as char);
            out.push(TABLE[((n >> 12) & 0x3F) as usize] as char);
            out.push(TABLE[((n >> 6) & 0x3F) as usize] as char);
        }
        _ => {}
    }

    out
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn sha256(data: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut padded = Vec::with_capacity(data.len() + 72);
    padded.extend_from_slice(data);
    padded.push(0x80);
    while (padded.len() % 64) != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in padded.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut digest = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        digest[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    digest
}

#[cfg(target_os = "windows")]
pub use platform::{open_settings_dialog, SettingsWindow};

#[cfg(not(target_os = "windows"))]
pub struct SettingsWindow {
    state: SettingsState,
}

#[cfg(not(target_os = "windows"))]
impl SettingsWindow {
    pub fn new(always_on_top: bool, selected_pet_index: Option<usize>) -> Self {
        Self {
            state: SettingsState::new(always_on_top, selected_pet_index),
        }
    }

    #[allow(dead_code)]
    pub fn state(&self) -> &SettingsState {
        &self.state
    }

    #[allow(dead_code)]
    pub fn state_mut(&mut self) -> &mut SettingsState {
        &mut self.state
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::ffi::c_void;
    use std::fs;
    use std::mem::size_of;
    use std::ptr::{null, null_mut};

    use petdex_core::hook_installer::detect_agent_status;

    use super::{
        agent_action_label, agent_status_text, default_pets_folder, SettingsState,
        PETDEX_WEBSITE_URL, SETTINGS_AGENTS, SETTINGS_WINDOW_HEIGHT, SETTINGS_WINDOW_WIDTH,
    };
    use crate::win32_host::{Win32PetHost, WM_PETDEX_SYNC_TOPMOST, WM_PETDEX_SYNC_VISUALS};

    type Handle = *mut c_void;
    type Hwnd = Handle;
    type Hinstance = Handle;
    type Hicon = Handle;
    type Hcursor = Handle;
    type Hbrush = Handle;
    type Hdc = Handle;
    type Hmenu = Handle;
    type Hfont = Handle;
    type WndProc = unsafe extern "system" fn(Hwnd, u32, usize, isize) -> isize;

    const CS_HREDRAW: u32 = 0x0002;
    const CS_VREDRAW: u32 = 0x0001;

    const WS_OVERLAPPED: u32 = 0x0000_0000;
    const WS_CAPTION: u32 = 0x00C0_0000;
    const WS_SYSMENU: u32 = 0x0008_0000;
    const WS_CHILD: u32 = 0x4000_0000;
    const WS_VISIBLE: u32 = 0x1000_0000;
    const WS_TABSTOP: u32 = 0x0001_0000;
    const WS_VSCROLL: u32 = 0x0020_0000;
    const WS_BORDER: u32 = 0x0080_0000;

    const BS_PUSHBUTTON: u32 = 0x0000_0000;
    const BS_AUTOCHECKBOX: u32 = 0x0000_0003;
    const BS_GROUPBOX: u32 = 0x0000_0007;

    const LBS_NOTIFY: u32 = 0x0000_0001;
    const LBS_NOINTEGRALHEIGHT: u32 = 0x0000_0100;

    const SW_SHOW: i32 = 5;
    const SW_RESTORE: i32 = 9;

    const WM_CREATE: u32 = 0x0001;
    const WM_DESTROY: u32 = 0x0002;
    const WM_CLOSE: u32 = 0x0010;
    const WM_SETFONT: u32 = 0x0030;
    const WM_NCCREATE: u32 = 0x0081;
    const WM_NCDESTROY: u32 = 0x0082;
    const WM_COMMAND: u32 = 0x0111;
    const WM_TIMER: u32 = 0x0113;
    const WM_CTLCOLORSTATIC: u32 = 0x0138;

    const BM_GETCHECK: u32 = 0x00F0;
    const BM_SETCHECK: u32 = 0x00F1;
    const BST_UNCHECKED: usize = 0;
    const BST_CHECKED: usize = 1;

    const LB_ADDSTRING: u32 = 0x0180;
    const LB_RESETCONTENT: u32 = 0x0184;
    const LB_SETCURSEL: u32 = 0x0186;
    const LB_GETCURSEL: u32 = 0x0188;

    const GWLP_USERDATA: i32 = -21;
    const COLOR_BTNFACE: i32 = 15;
    const TRANSPARENT: i32 = 1;

    const DEFAULT_CHARSET: u32 = 1;
    const OUT_DEFAULT_PRECIS: u32 = 0;
    const CLIP_DEFAULT_PRECIS: u32 = 0;
    const CLEARTYPE_QUALITY: u32 = 5;
    const DEFAULT_PITCH: u32 = 0;
    const FW_NORMAL: i32 = 400;

    const IDC_ARROW: *const u16 = 32512usize as *const u16;
    const IDI_APPLICATION: *const u16 = 32512usize as *const u16;
    const SPI_GETWORKAREA: u32 = 0x0030;

    const OAUTH_POLL_TIMER_ID: usize = 101;
    const OAUTH_POLL_INTERVAL_MS: u32 = 250;

    const ID_SIGN_IN_BTN: usize = 4001;
    const ID_ACCOUNT_STATUS: usize = 4002;
    const ID_PETS_LISTBOX: usize = 4010;
    const ID_USE_SELECTED_BTN: usize = 4011;
    const ID_OPEN_PETS_FOLDER_BTN: usize = 4012;
    const ID_BROWSE_PETDEX_BTN: usize = 4013;
    const ID_TOPMOST_CHECKBOX: usize = 4020;
    const ID_SEND_TEST_BUBBLE_BTN: usize = 4021;
    const ID_CYCLE_STATE_BTN: usize = 4022;
    const ID_AGENT_STATUS_BASE: usize = 4100;
    const ID_AGENT_BTN_BASE: usize = 4200;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
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

    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(lp_module_name: *const u16) -> Hinstance;
    }

    #[link(name = "user32")]
    extern "system" {
        fn RegisterClassExW(lpwcx: *const WndClassExW) -> u16;
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
        fn IsWindow(hwnd: Hwnd) -> i32;
        fn ShowWindow(hwnd: Hwnd, n_cmd_show: i32) -> i32;
        fn SetForegroundWindow(hwnd: Hwnd) -> i32;
        fn DefWindowProcW(hwnd: Hwnd, msg: u32, wparam: usize, lparam: isize) -> isize;
        fn SendMessageW(hwnd: Hwnd, msg: u32, wparam: usize, lparam: isize) -> isize;
        fn PostMessageW(hwnd: Hwnd, msg: u32, wparam: usize, lparam: isize) -> i32;
        fn SetWindowTextW(hwnd: Hwnd, lp_string: *const u16) -> i32;
        fn GetDlgItem(h_dlg: Hwnd, n_id_dlg_item: i32) -> Hwnd;
        fn SetTimer(
            hwnd: Hwnd,
            n_id_event: usize,
            u_elapse: u32,
            lp_timer_func: *const c_void,
        ) -> usize;
        fn KillTimer(hwnd: Hwnd, u_id_event: usize) -> i32;
        fn LoadCursorW(h_instance: Hinstance, lp_cursor_name: *const u16) -> Hcursor;
        fn LoadIconW(h_instance: Hinstance, lp_icon_name: *const u16) -> Hicon;
        fn GetSysColorBrush(n_index: i32) -> Hbrush;
        fn SystemParametersInfoW(
            ui_action: u32,
            ui_param: u32,
            pv_param: *mut c_void,
            f_win_ini: u32,
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
        fn CreateFontW(
            c_height: i32,
            c_width: i32,
            c_escapement: i32,
            c_orientation: i32,
            c_weight: i32,
            b_italic: u32,
            b_underline: u32,
            b_strike_out: u32,
            i_char_set: u32,
            i_out_precision: u32,
            i_clip_precision: u32,
            i_quality: u32,
            i_pitch_and_family: u32,
            psz_face_name: *const u16,
        ) -> Hfont;
        fn DeleteObject(ho: Handle) -> i32;
        fn SetBkMode(hdc: Hdc, mode: i32) -> i32;
    }

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: Hwnd,
            lp_operation: *const u16,
            lp_file: *const u16,
            lp_parameters: *const u16,
            lp_directory: *const u16,
            n_show_cmd: i32,
        ) -> Hinstance;
    }

    struct SettingsDialogContext {
        owner_hwnd: Hwnd,
        host_ptr: *mut Win32PetHost,
        font: Hfont,
    }

    pub struct SettingsWindow {
        hwnd: Hwnd,
        class_registered: bool,
        state: SettingsState,
    }

    impl SettingsWindow {
        pub fn new(always_on_top: bool, selected_pet_index: Option<usize>) -> Self {
            Self {
                hwnd: null_mut(),
                class_registered: false,
                state: SettingsState::new(always_on_top, selected_pet_index),
            }
        }

        pub fn state_mut(&mut self) -> &mut SettingsState {
            &mut self.state
        }

        pub fn clear_hwnd(&mut self) {
            self.hwnd = null_mut();
        }

        pub unsafe fn destroy(&mut self) {
            if !self.hwnd.is_null() {
                let hwnd = self.hwnd;
                self.hwnd = null_mut();
                if IsWindow(hwnd) != 0 {
                    DestroyWindow(hwnd);
                }
            }
        }
    }

    pub unsafe fn open_settings_dialog(owner_hwnd: Hwnd, host_ptr: *mut Win32PetHost) {
        if host_ptr.is_null() {
            return;
        }

        let existing = (*host_ptr).settings_window_mut().hwnd;
        if !existing.is_null() && IsWindow(existing) != 0 {
            refresh_all_controls(existing, host_ptr);
            ShowWindow(existing, SW_RESTORE);
            SetForegroundWindow(existing);
            return;
        }

        let h_instance = GetModuleHandleW(null());
        let class_name = wide_null("PetdexWin32SettingsWindow");

        if !(*host_ptr).settings_window_mut().class_registered {
            let wc = WndClassExW {
                cb_size: size_of::<WndClassExW>() as u32,
                style: CS_HREDRAW | CS_VREDRAW,
                lpfn_wnd_proc: settings_wnd_proc,
                cb_cls_extra: 0,
                cb_wnd_extra: 0,
                h_instance,
                h_icon: LoadIconW(null_mut(), IDI_APPLICATION),
                h_cursor: LoadCursorW(null_mut(), IDC_ARROW),
                hbr_background: (COLOR_BTNFACE + 1) as Hbrush,
                lpsz_menu_name: null(),
                lpsz_class_name: class_name.as_ptr(),
                h_icon_sm: null_mut(),
            };
            if RegisterClassExW(&wc) != 0 {
                (*host_ptr).settings_window_mut().class_registered = true;
            }
        }

        let (x, y) = centered_origin(SETTINGS_WINDOW_WIDTH, SETTINGS_WINDOW_HEIGHT);
        let ctx = Box::new(SettingsDialogContext {
            owner_hwnd,
            host_ptr,
            font: null_mut(),
        });
        let ctx_ptr = Box::into_raw(ctx);

        let title = wide_null("Petdex Settings");
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            title.as_ptr(),
            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
            x,
            y,
            SETTINGS_WINDOW_WIDTH,
            SETTINGS_WINDOW_HEIGHT,
            owner_hwnd,
            null_mut(),
            h_instance,
            ctx_ptr.cast::<c_void>(),
        );

        if hwnd.is_null() {
            drop(Box::from_raw(ctx_ptr));
            return;
        }

        (*host_ptr).settings_window_mut().hwnd = hwnd;
        refresh_all_controls(hwnd, host_ptr);
        ShowWindow(hwnd, SW_SHOW);
        SetForegroundWindow(hwnd);
    }

    unsafe fn get_ctx(hwnd: Hwnd) -> *mut SettingsDialogContext {
        #[cfg(target_pointer_width = "64")]
        {
            GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut SettingsDialogContext
        }
        #[cfg(target_pointer_width = "32")]
        {
            GetWindowLongW(hwnd, GWLP_USERDATA) as *mut SettingsDialogContext
        }
    }

    unsafe fn set_ctx(hwnd: Hwnd, ptr: *mut SettingsDialogContext) {
        #[cfg(target_pointer_width = "64")]
        {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, ptr as isize);
        }
        #[cfg(target_pointer_width = "32")]
        {
            SetWindowLongW(hwnd, GWLP_USERDATA, ptr as isize);
        }
    }

    fn wide_null(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn centered_origin(width: i32, height: i32) -> (i32, i32) {
        let mut rect = Rect {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };
        SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            (&mut rect as *mut Rect).cast::<c_void>(),
            0,
        );
        let work_w = (rect.right - rect.left).max(width);
        let work_h = (rect.bottom - rect.top).max(height);
        let x = rect.left + (work_w - width) / 2;
        let y = rect.top + (work_h - height) / 2;
        (x, y)
    }

    unsafe fn create_ui_font() -> Hfont {
        let face = wide_null("Segoe UI");
        CreateFontW(
            -14,
            0,
            0,
            0,
            FW_NORMAL,
            0,
            0,
            0,
            DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            CLEARTYPE_QUALITY,
            DEFAULT_PITCH,
            face.as_ptr(),
        )
    }

    unsafe fn create_child(
        parent: Hwnd,
        h_instance: Hinstance,
        font: Hfont,
        class_name: &str,
        text: &str,
        style: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        control_id: usize,
    ) -> Hwnd {
        let cls = wide_null(class_name);
        let label = wide_null(text);
        let child = CreateWindowExW(
            0,
            cls.as_ptr(),
            label.as_ptr(),
            WS_CHILD | WS_VISIBLE | style,
            x,
            y,
            w,
            h,
            parent,
            control_id as Hmenu,
            h_instance,
            null_mut(),
        );
        if !child.is_null() && !font.is_null() {
            SendMessageW(child, WM_SETFONT, font as usize, 1);
        }
        child
    }

    unsafe fn create_controls(hwnd: Hwnd, font: Hfont) {
        let h_instance = GetModuleHandleW(null());

        // Section 1: Petdex Account
        create_child(
            hwnd,
            h_instance,
            font,
            "BUTTON",
            "Petdex Account",
            BS_GROUPBOX,
            14,
            10,
            436,
            66,
            0,
        );
        create_child(
            hwnd,
            h_instance,
            font,
            "STATIC",
            "Status: Not signed in",
            0,
            26,
            34,
            250,
            22,
            ID_ACCOUNT_STATUS,
        );
        create_child(
            hwnd,
            h_instance,
            font,
            "BUTTON",
            "Sign in with Petdex",
            BS_PUSHBUTTON | WS_TABSTOP,
            284,
            30,
            154,
            28,
            ID_SIGN_IN_BTN,
        );

        // Section 2: Installed Pets
        create_child(
            hwnd,
            h_instance,
            font,
            "BUTTON",
            "Installed Pets",
            BS_GROUPBOX,
            14,
            84,
            436,
            124,
            0,
        );
        create_child(
            hwnd,
            h_instance,
            font,
            "LISTBOX",
            "",
            LBS_NOTIFY | LBS_NOINTEGRALHEIGHT | WS_VSCROLL | WS_BORDER | WS_TABSTOP,
            26,
            104,
            258,
            92,
            ID_PETS_LISTBOX,
        );
        create_child(
            hwnd,
            h_instance,
            font,
            "BUTTON",
            "Use Selected",
            BS_PUSHBUTTON | WS_TABSTOP,
            294,
            104,
            144,
            26,
            ID_USE_SELECTED_BTN,
        );
        create_child(
            hwnd,
            h_instance,
            font,
            "BUTTON",
            "Open Pets Folder",
            BS_PUSHBUTTON | WS_TABSTOP,
            294,
            136,
            144,
            26,
            ID_OPEN_PETS_FOLDER_BTN,
        );
        create_child(
            hwnd,
            h_instance,
            font,
            "BUTTON",
            "Browse petdex.dev",
            BS_PUSHBUTTON | WS_TABSTOP,
            294,
            168,
            144,
            26,
            ID_BROWSE_PETDEX_BTN,
        );

        // Section 3: Coding Agents
        create_child(
            hwnd,
            h_instance,
            font,
            "BUTTON",
            "Coding Agents",
            BS_GROUPBOX,
            14,
            216,
            436,
            162,
            0,
        );
        for (idx, agent) in SETTINGS_AGENTS.iter().enumerate() {
            let row_y = 236 + (idx as i32) * 27;
            create_child(
                hwnd,
                h_instance,
                font,
                "STATIC",
                agent.spec().display_name,
                0,
                26,
                row_y + 2,
                122,
                20,
                0,
            );
            create_child(
                hwnd,
                h_instance,
                font,
                "STATIC",
                "Checking...",
                0,
                154,
                row_y + 2,
                138,
                20,
                ID_AGENT_STATUS_BASE + idx,
            );
            create_child(
                hwnd,
                h_instance,
                font,
                "BUTTON",
                "Connect",
                BS_PUSHBUTTON | WS_TABSTOP,
                304,
                row_y,
                134,
                23,
                ID_AGENT_BTN_BASE + idx,
            );
        }

        // Section 4: Appearance & Test
        create_child(
            hwnd,
            h_instance,
            font,
            "BUTTON",
            "Appearance & Test",
            BS_GROUPBOX,
            14,
            386,
            436,
            64,
            0,
        );
        create_child(
            hwnd,
            h_instance,
            font,
            "BUTTON",
            "Always on Top",
            BS_AUTOCHECKBOX | WS_TABSTOP,
            26,
            410,
            126,
            24,
            ID_TOPMOST_CHECKBOX,
        );
        create_child(
            hwnd,
            h_instance,
            font,
            "BUTTON",
            "Send Test Bubble",
            BS_PUSHBUTTON | WS_TABSTOP,
            162,
            408,
            136,
            28,
            ID_SEND_TEST_BUBBLE_BTN,
        );
        create_child(
            hwnd,
            h_instance,
            font,
            "BUTTON",
            "Cycle State",
            BS_PUSHBUTTON | WS_TABSTOP,
            306,
            408,
            132,
            28,
            ID_CYCLE_STATE_BTN,
        );
    }

    unsafe fn set_item_text(hwnd: Hwnd, id: usize, text: &str) {
        let ctrl = GetDlgItem(hwnd, id as i32);
        if !ctrl.is_null() {
            let wide = wide_null(text);
            SetWindowTextW(ctrl, wide.as_ptr());
        }
    }

    unsafe fn refresh_account_ui(hwnd: Hwnd, host: &mut Win32PetHost) {
        let status_text = format!(
            "Status: {}",
            host.settings_window_mut().state_mut().account.status_label()
        );
        set_item_text(hwnd, ID_ACCOUNT_STATUS, &status_text);
    }

    unsafe fn refresh_pets_ui(hwnd: Hwnd, host: &mut Win32PetHost) {
        host.refresh_pets();
        let listbox = GetDlgItem(hwnd, ID_PETS_LISTBOX as i32);
        if listbox.is_null() {
            return;
        }
        SendMessageW(listbox, LB_RESETCONTENT, 0, 0);
        let active_idx = host.active_pet_index();
        if host.installed_pets().is_empty() {
            let empty = wide_null("Cobalt Fallback (No pets installed)");
            SendMessageW(listbox, LB_ADDSTRING, 0, empty.as_ptr() as isize);
            SendMessageW(listbox, LB_SETCURSEL, 0, 0);
        } else {
            for (idx, pet) in host.installed_pets().iter().enumerate() {
                let label = if active_idx == Some(idx) {
                    format!("{} (Active)", pet.display_name)
                } else {
                    pet.display_name.clone()
                };
                let wide = wide_null(&label);
                SendMessageW(listbox, LB_ADDSTRING, 0, wide.as_ptr() as isize);
            }
            if let Some(sel) = active_idx {
                SendMessageW(listbox, LB_SETCURSEL, sel, 0);
            } else {
                SendMessageW(listbox, LB_SETCURSEL, 0, 0);
            }
        }
    }

    unsafe fn refresh_agents_ui(hwnd: Hwnd) {
        for (idx, agent) in SETTINGS_AGENTS.iter().enumerate() {
            let status = detect_agent_status(*agent);
            set_item_text(hwnd, ID_AGENT_STATUS_BASE + idx, agent_status_text(status));
            set_item_text(hwnd, ID_AGENT_BTN_BASE + idx, agent_action_label(status));
        }
    }

    unsafe fn refresh_appearance_ui(hwnd: Hwnd, host: &Win32PetHost) {
        let checkbox = GetDlgItem(hwnd, ID_TOPMOST_CHECKBOX as i32);
        if !checkbox.is_null() {
            let state = if host.is_topmost() {
                BST_CHECKED
            } else {
                BST_UNCHECKED
            };
            SendMessageW(checkbox, BM_SETCHECK, state, 0);
        }
    }

    unsafe fn refresh_all_controls(hwnd: Hwnd, host_ptr: *mut Win32PetHost) {
        if host_ptr.is_null() {
            return;
        }
        let host = &mut *host_ptr;
        refresh_account_ui(hwnd, host);
        refresh_pets_ui(hwnd, host);
        refresh_agents_ui(hwnd);
        refresh_appearance_ui(hwnd, host);
    }

    unsafe fn shell_open(hwnd: Hwnd, target: &str) {
        let verb = wide_null("open");
        let file = wide_null(target);
        ShellExecuteW(hwnd, verb.as_ptr(), file.as_ptr(), null(), null(), SW_SHOW);
    }

    unsafe extern "system" fn settings_wnd_proc(
        hwnd: Hwnd,
        msg: u32,
        wparam: usize,
        lparam: isize,
    ) -> isize {
        if msg == WM_NCCREATE {
            let cs = lparam as *const CreateStructW;
            if !cs.is_null() {
                set_ctx(hwnd, (*cs).lp_create_params as *mut SettingsDialogContext);
            }
            return 1;
        }

        let ctx_ptr = get_ctx(hwnd);

        match msg {
            WM_CREATE => {
                if !ctx_ptr.is_null() {
                    let font = create_ui_font();
                    (*ctx_ptr).font = font;
                    create_controls(hwnd, font);
                    SetTimer(hwnd, OAUTH_POLL_TIMER_ID, OAUTH_POLL_INTERVAL_MS, null());
                }
                0
            }
            WM_CTLCOLORSTATIC => {
                let hdc = wparam as Hdc;
                if !hdc.is_null() {
                    SetBkMode(hdc, TRANSPARENT);
                }
                GetSysColorBrush(COLOR_BTNFACE) as isize
            }
            WM_TIMER => {
                if wparam == OAUTH_POLL_TIMER_ID && !ctx_ptr.is_null() {
                    let host_ptr = (*ctx_ptr).host_ptr;
                    if !host_ptr.is_null() {
                        let host = &mut *host_ptr;
                        if let Some(callback) = host.take_oauth_callback() {
                            if host
                                .settings_window_mut()
                                .state_mut()
                                .handle_oauth_callback(callback)
                            {
                                refresh_account_ui(hwnd, host);
                            }
                        }
                    }
                }
                0
            }
            WM_COMMAND => {
                let control_id = wparam & 0xFFFF;
                if !ctx_ptr.is_null() && !(*ctx_ptr).host_ptr.is_null() {
                    let owner_hwnd = (*ctx_ptr).owner_hwnd;
                    let host = &mut *(*ctx_ptr).host_ptr;
                    match control_id {
                        ID_SIGN_IN_BTN => {
                            let port = host.port();
                            let challenge = host.settings_window_mut().state_mut().begin_sign_in(port);
                            refresh_account_ui(hwnd, host);
                            shell_open(hwnd, &challenge.authorize_url);
                        }
                        ID_USE_SELECTED_BTN => {
                            let listbox = GetDlgItem(hwnd, ID_PETS_LISTBOX as i32);
                            if !listbox.is_null() && !host.installed_pets().is_empty() {
                                let sel = SendMessageW(listbox, LB_GETCURSEL, 0, 0);
                                if sel >= 0 {
                                    let idx = sel as usize;
                                    let total = host.installed_pets().len();
                                    if host.select_pet(idx) {
                                        host.settings_window_mut()
                                            .state_mut()
                                            .select_pet(idx, total);
                                        refresh_pets_ui(hwnd, host);
                                        PostMessageW(owner_hwnd, WM_PETDEX_SYNC_VISUALS, 0, 0);
                                    }
                                }
                            }
                        }
                        ID_OPEN_PETS_FOLDER_BTN => {
                            if let Some(folder) = default_pets_folder() {
                                let _ = fs::create_dir_all(&folder);
                                if let Some(path_str) = folder.to_str() {
                                    shell_open(hwnd, path_str);
                                }
                            }
                        }
                        ID_BROWSE_PETDEX_BTN => {
                            shell_open(hwnd, PETDEX_WEBSITE_URL);
                        }
                        ID_TOPMOST_CHECKBOX => {
                            let checkbox = GetDlgItem(hwnd, ID_TOPMOST_CHECKBOX as i32);
                            if !checkbox.is_null() {
                                let checked = SendMessageW(checkbox, BM_GETCHECK, 0, 0) as usize
                                    == BST_CHECKED;
                                host.set_topmost(checked);
                                host.settings_window_mut()
                                    .state_mut()
                                    .set_always_on_top(checked);
                                PostMessageW(owner_hwnd, WM_PETDEX_SYNC_TOPMOST, 0, 0);
                            }
                        }
                        ID_SEND_TEST_BUBBLE_BTN => {
                            host.send_test_bubble();
                            PostMessageW(owner_hwnd, WM_PETDEX_SYNC_VISUALS, 0, 0);
                        }
                        ID_CYCLE_STATE_BTN => {
                            host.cycle_state();
                            PostMessageW(owner_hwnd, WM_PETDEX_SYNC_VISUALS, 0, 0);
                        }
                        id if (ID_AGENT_BTN_BASE..ID_AGENT_BTN_BASE + SETTINGS_AGENTS.len())
                            .contains(&id) =>
                        {
                            let idx = id - ID_AGENT_BTN_BASE;
                            let agent = SETTINGS_AGENTS[idx];
                            if let Err(err) = host.toggle_agent_hook(agent) {
                                eprintln!(
                                    "petdex-windows: settings failed to toggle {}: {err}",
                                    agent.spec().display_name
                                );
                            }
                            refresh_agents_ui(hwnd);
                        }
                        _ => {}
                    }
                }
                0
            }
            WM_CLOSE => {
                DestroyWindow(hwnd);
                0
            }
            WM_DESTROY => {
                KillTimer(hwnd, OAUTH_POLL_TIMER_ID);
                if !ctx_ptr.is_null() {
                    if !(*ctx_ptr).font.is_null() {
                        DeleteObject((*ctx_ptr).font);
                        (*ctx_ptr).font = null_mut();
                    }
                    if !(*ctx_ptr).host_ptr.is_null() {
                        (*(*ctx_ptr).host_ptr).settings_window_mut().clear_hwnd();
                    }
                }
                0
            }
            WM_NCDESTROY => {
                if !ctx_ptr.is_null() {
                    set_ctx(hwnd, null_mut());
                    drop(Box::from_raw(ctx_ptr));
                }
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_standard_rfc7636_pkce_vector() {
        // RFC 7636 Appendix B test vector
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let digest = sha256(verifier.as_bytes());
        let challenge = base64url_encode(&digest);
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn pkce_authorize_url_contains_required_clerk_parameters() {
        let challenge = build_pkce_challenge(
            "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
            "state-xyz-123",
            CLERK_REDIRECT_URI,
        );

        assert!(challenge.authorize_url.starts_with(CLERK_AUTHORIZE_URL));
        assert!(challenge
            .authorize_url
            .contains(&format!("client_id={CLERK_CLIENT_ID}")));
        assert!(challenge
            .authorize_url
            .contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A7777%2Fcallback"));
        assert!(challenge.authorize_url.contains("response_type=code"));
        assert!(challenge
            .authorize_url
            .contains("scope=profile%20email%20openid%20offline_access"));
        assert!(challenge
            .authorize_url
            .contains("code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
        assert!(challenge
            .authorize_url
            .contains("code_challenge_method=S256"));
        assert!(challenge.authorize_url.contains("state=state-xyz-123"));
    }

    #[test]
    fn generated_pkce_challenges_are_unique_and_valid() {
        let first = generate_pkce_challenge(&redirect_uri_for_port(7777));
        let second = generate_pkce_challenge(&redirect_uri_for_port(7777));

        assert_ne!(first.code_verifier, second.code_verifier);
        assert_ne!(first.state, second.state);
        assert!(first.code_verifier.len() >= 43);
        assert_eq!(first.code_challenge.len(), 43);
        assert!(!first.code_challenge.contains('='));
        assert!(!first.code_challenge.contains('+'));
        assert!(!first.code_challenge.contains('/'));
    }

    #[test]
    fn settings_state_transitions_through_oauth_sign_in_flow() {
        let mut state = SettingsState::new(true, Some(0));
        assert_eq!(state.account, AccountAuthState::SignedOut);
        assert_eq!(state.account.status_label(), "Not signed in");

        let challenge = build_pkce_challenge("verifier-1", "expected-state", CLERK_REDIRECT_URI);
        let url = state.begin_sign_in_with(&challenge);
        assert!(url.contains("state=expected-state"));
        assert_eq!(state.account.status_label(), "Waiting for browser...");

        let changed = state.handle_oauth_callback(OAuthCallback {
            code: "auth-code-999".to_string(),
            state: "expected-state".to_string(),
            error: String::new(),
        });
        assert!(changed);
        assert_eq!(
            state.account,
            AccountAuthState::SignedIn {
                authorization_code: "auth-code-999".to_string()
            }
        );
        assert_eq!(state.account.status_label(), "Signed in!");
    }

    #[test]
    fn settings_state_rejects_mismatched_state_and_surfaces_oauth_errors() {
        let mut state = SettingsState::new(true, None);
        let challenge = build_pkce_challenge("verifier-2", "good-state", CLERK_REDIRECT_URI);
        state.begin_sign_in_with(&challenge);

        assert!(state.handle_oauth_callback(OAuthCallback {
            code: "code-1".to_string(),
            state: "wrong-state".to_string(),
            error: String::new(),
        }));
        assert_eq!(
            state.account,
            AccountAuthState::Error("state_mismatch".to_string())
        );

        state.begin_sign_in_with(&challenge);
        assert!(state.handle_oauth_callback(OAuthCallback {
            code: String::new(),
            state: "good-state".to_string(),
            error: "access_denied".to_string(),
        }));
        assert_eq!(
            state.account,
            AccountAuthState::Error("access_denied".to_string())
        );
        assert_eq!(state.account.status_label(), "Sign-in failed: access_denied");
    }

    #[test]
    fn settings_state_updates_pet_selection_topmost_and_agent_labels() {
        let mut state = SettingsState::new(true, None);
        assert!(!state.select_pet(2, 2));
        assert!(state.select_pet(1, 2));
        assert_eq!(state.selected_pet_index, Some(1));

        state.set_always_on_top(false);
        assert!(!state.always_on_top);

        assert_eq!(agent_status_text(AgentInstallStatus::Connected), "Connected");
        assert_eq!(agent_action_label(AgentInstallStatus::Connected), "Disconnect");
        assert_eq!(agent_status_text(AgentInstallStatus::Detected), "Detected");
        assert_eq!(agent_action_label(AgentInstallStatus::Detected), "Connect");
        assert_eq!(agent_status_text(AgentInstallStatus::NotFound), "Not detected");
        assert_eq!(agent_action_label(AgentInstallStatus::NotFound), "Connect");
    }
}
