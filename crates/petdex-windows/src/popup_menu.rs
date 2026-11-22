#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

use crate::win32_host::{
    WorkArea, CMD_CYCLE_STATE, CMD_OPEN_SETTINGS, CMD_QUIT, CMD_RESET_POSITION,
    CMD_SEND_TEST_BUBBLE, CMD_SHUFFLE_PET, CMD_TOGGLE_FOCUS_MODE, CMD_TOGGLE_TOPMOST,
};

pub const POPUP_MENU_WIDTH: i32 = 212;
pub const POPUP_PADDING_X: i32 = 6;
pub const POPUP_PADDING_Y: i32 = 6;
pub const POPUP_ITEM_HEIGHT: i32 = 32;
pub const POPUP_SEPARATOR_HEIGHT: i32 = 9;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PopupMenuEntry {
    Item {
        command_id: usize,
        label: &'static str,
        checked: bool,
    },
    Separator,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PopupItemRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
    pub clickable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PopupMenuLayout {
    pub width: i32,
    pub height: i32,
    pub rects: Vec<PopupItemRect>,
}

impl PopupMenuLayout {
    pub fn hit_test(&self, x: i32, y: i32) -> Option<usize> {
        if x < 0 || y < 0 || x >= self.width || y >= self.height {
            return None;
        }
        for (idx, rect) in self.rects.iter().enumerate() {
            if rect.clickable
                && x >= rect.left
                && x < rect.right
                && y >= rect.top
                && y < rect.bottom
            {
                return Some(idx);
            }
        }
        None
    }
}

pub fn build_default_menu_entries(always_on_top: bool, focus_mode: bool) -> Vec<PopupMenuEntry> {
    vec![
        PopupMenuEntry::Item {
            command_id: CMD_OPEN_SETTINGS,
            label: "Settings...",
            checked: false,
        },
        PopupMenuEntry::Item {
            command_id: CMD_SHUFFLE_PET,
            label: "Shuffle Pet",
            checked: false,
        },
        PopupMenuEntry::Separator,
        PopupMenuEntry::Item {
            command_id: CMD_TOGGLE_TOPMOST,
            label: "Always on Top",
            checked: always_on_top,
        },
        PopupMenuEntry::Item {
            command_id: CMD_TOGGLE_FOCUS_MODE,
            label: "Focus Mode",
            checked: focus_mode,
        },
        PopupMenuEntry::Separator,
        PopupMenuEntry::Item {
            command_id: CMD_SEND_TEST_BUBBLE,
            label: "Send Test Bubble",
            checked: false,
        },
        PopupMenuEntry::Item {
            command_id: CMD_CYCLE_STATE,
            label: "Cycle State",
            checked: false,
        },
        PopupMenuEntry::Item {
            command_id: CMD_RESET_POSITION,
            label: "Reset Position",
            checked: false,
        },
        PopupMenuEntry::Separator,
        PopupMenuEntry::Item {
            command_id: CMD_QUIT,
            label: "Quit Petdex",
            checked: false,
        },
    ]
}

pub fn compute_menu_layout(entries: &[PopupMenuEntry]) -> PopupMenuLayout {
    let mut y = POPUP_PADDING_Y;
    let mut rects = Vec::with_capacity(entries.len());

    for entry in entries {
        match entry {
            PopupMenuEntry::Item { .. } => {
                let top = y;
                let bottom = y + POPUP_ITEM_HEIGHT;
                rects.push(PopupItemRect {
                    left: POPUP_PADDING_X,
                    top,
                    right: POPUP_MENU_WIDTH - POPUP_PADDING_X,
                    bottom,
                    clickable: true,
                });
                y = bottom;
            }
            PopupMenuEntry::Separator => {
                let top = y;
                let bottom = y + POPUP_SEPARATOR_HEIGHT;
                rects.push(PopupItemRect {
                    left: POPUP_PADDING_X,
                    top,
                    right: POPUP_MENU_WIDTH - POPUP_PADDING_X,
                    bottom,
                    clickable: false,
                });
                y = bottom;
            }
        }
    }

    PopupMenuLayout {
        width: POPUP_MENU_WIDTH,
        height: y + POPUP_PADDING_Y,
        rects,
    }
}

pub const fn compute_popup_origin(
    cursor_x: i32,
    cursor_y: i32,
    width: i32,
    height: i32,
    work_area: WorkArea,
) -> (i32, i32) {
    let max_x = work_area.right.saturating_sub(width);
    let max_y = work_area.bottom.saturating_sub(height);

    let x = if max_x <= work_area.left {
        work_area.left
    } else if cursor_x > max_x {
        let flipped = cursor_x.saturating_sub(width);
        if flipped < work_area.left {
            work_area.left
        } else if flipped > max_x {
            max_x
        } else {
            flipped
        }
    } else if cursor_x < work_area.left {
        work_area.left
    } else {
        cursor_x
    };

    let y = if max_y <= work_area.top {
        work_area.top
    } else if cursor_y > max_y {
        let flipped = cursor_y.saturating_sub(height);
        if flipped < work_area.top {
            work_area.top
        } else if flipped > max_y {
            max_y
        } else {
            flipped
        }
    } else if cursor_y < work_area.top {
        work_area.top
    } else {
        cursor_y
    };

    (x, y)
}

#[cfg(target_os = "windows")]
pub use platform::PopupMenu;

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
pub struct PopupMenu;

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
impl PopupMenu {
    pub fn new() -> Self {
        Self
    }

    pub fn dismiss(&mut self) {}

    pub fn destroy(&mut self) {}
}

#[cfg(target_os = "windows")]
mod platform {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use std::ptr::{null, null_mut};

    use super::{
        build_default_menu_entries, compute_menu_layout, compute_popup_origin, PopupMenuEntry,
        PopupMenuLayout,
    };
    use crate::win32_host::{WorkArea, WS_EX_TOOLWINDOW, WS_EX_TOPMOST};

    type Handle = *mut c_void;
    type Hwnd = Handle;
    type Hinstance = Handle;
    type Hcursor = Handle;
    type Hbrush = Handle;
    type Hpen = Handle;
    type Hdc = Handle;
    type Hfont = Handle;
    type WndProc = unsafe extern "system" fn(Hwnd, u32, usize, isize) -> isize;

    const CS_HREDRAW: u32 = 0x0002;
    const CS_VREDRAW: u32 = 0x0001;
    const WS_POPUP: u32 = 0x8000_0000;
    const SW_SHOW: i32 = 5;

    const WM_DESTROY: u32 = 0x0002;
    const WM_ACTIVATE: u32 = 0x0006;
    const WM_KILLFOCUS: u32 = 0x0008;
    const WM_PAINT: u32 = 0x000F;
    const WM_ERASEBKGND: u32 = 0x0014;
    const WM_NCCREATE: u32 = 0x0081;
    const WM_NCDESTROY: u32 = 0x0082;
    const WM_KEYDOWN: u32 = 0x0100;
    const WM_COMMAND: u32 = 0x0111;
    const WM_MOUSEMOVE: u32 = 0x0200;
    const WM_LBUTTONUP: u32 = 0x0202;
    const WM_MOUSELEAVE: u32 = 0x02A3;

    const WA_INACTIVE: usize = 0;
    const VK_ESCAPE: usize = 0x1B;
    const TME_LEAVE: u32 = 0x0000_0002;
    const GWLP_USERDATA: i32 = -21;

    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_ROUND: u32 = 2;
    const DWMWA_BORDER_COLOR: u32 = 34;

    const IDC_ARROW: *const u16 = 32512usize as *const u16;
    const NULL_PEN: i32 = 8;
    const PS_SOLID: i32 = 0;
    const TRANSPARENT_BK: i32 = 1;

    const DT_LEFT: u32 = 0x0000_0000;
    const DT_VCENTER: u32 = 0x0000_0004;
    const DT_SINGLELINE: u32 = 0x0000_0020;
    const DT_NOPREFIX: u32 = 0x0000_0800;

    const FW_NORMAL: i32 = 400;
    const FW_SEMIBOLD: i32 = 600;
    const DEFAULT_CHARSET: u32 = 1;
    const OUT_DEFAULT_PRECIS: u32 = 0;
    const CLIP_DEFAULT_PRECIS: u32 = 0;
    const CLEARTYPE_QUALITY: u32 = 5;
    const DEFAULT_PITCH: u32 = 0;

    // Warm pearl surface #F7F9FF (COLORREF = 0x00BBGGRR)
    const COLOR_PEARL_BG: u32 = 0x00FF_F9F7;
    // Soft cobalt hover pill #E6ECFF
    const COLOR_HOVER_FILL: u32 = 0x00FF_ECE6;
    // Deep cobalt hover text #1D2F8A
    const COLOR_HOVER_TEXT: u32 = 0x008A_2F1D;
    // Deep navy text #151E47
    const COLOR_NAVY_TEXT: u32 = 0x0047_1E15;
    // Pocket Toy Cobalt checkmark #3B59F2
    const COLOR_COBALT_ACCENT: u32 = 0x00F2_593B;
    // Subtle cobalt-tinted border #D6DEF5
    const COLOR_BORDER_TINT: u32 = 0x00F5_DED6;
    // Subtle separator #E2E8FA
    const COLOR_SEPARATOR: u32 = 0x00FA_E8E2;

    const POPUP_CLASS_NAME: &str = "PetdexWin32PopupMenu";

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    struct PaintStruct {
        hdc: Hdc,
        f_erase: i32,
        rc_paint: Rect,
        f_restore: i32,
        f_inc_update: i32,
        rgb_reserved: [u8; 32],
    }

    #[repr(C)]
    struct TrackMouseEventStruct {
        cb_size: u32,
        dw_flags: u32,
        hwnd_track: Hwnd,
        dw_hover_time: u32,
    }

    #[repr(C)]
    struct WndClassExW {
        cb_size: u32,
        style: u32,
        lpfn_wnd_proc: WndProc,
        cb_cls_extra: i32,
        cb_wnd_extra: i32,
        h_instance: Hinstance,
        h_icon: Handle,
        h_cursor: Hcursor,
        hbr_background: Hbrush,
        lpsz_menu_name: *const u16,
        lpsz_class_name: *const u16,
        h_icon_sm: Handle,
    }

    #[allow(dead_code)]
    #[repr(C)]
    struct CreateStructW {
        lp_create_params: *mut c_void,
        h_instance: Hinstance,
        h_menu: Handle,
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
            h_menu: Handle,
            h_instance: Hinstance,
            lp_param: *mut c_void,
        ) -> Hwnd;
        fn DestroyWindow(hwnd: Hwnd) -> i32;
        fn IsWindow(hwnd: Hwnd) -> i32;
        fn ShowWindow(hwnd: Hwnd, n_cmd_show: i32) -> i32;
        fn SetForegroundWindow(hwnd: Hwnd) -> i32;
        fn SetFocus(hwnd: Hwnd) -> Hwnd;
        fn DefWindowProcW(hwnd: Hwnd, msg: u32, wparam: usize, lparam: isize) -> isize;
        fn PostMessageW(hwnd: Hwnd, msg: u32, wparam: usize, lparam: isize) -> i32;
        fn LoadCursorW(h_instance: Hinstance, lp_cursor_name: *const u16) -> Hcursor;
        fn BeginPaint(hwnd: Hwnd, lp_paint: *mut PaintStruct) -> Hdc;
        fn EndPaint(hwnd: Hwnd, lp_paint: *const PaintStruct) -> i32;
        fn FillRect(hdc: Hdc, lprc: *const Rect, hbr: Hbrush) -> i32;
        fn InvalidateRect(hwnd: Hwnd, lp_rect: *const Rect, b_erase: i32) -> i32;
        fn TrackMouseEvent(lp_event_track: *mut TrackMouseEventStruct) -> i32;
        fn DrawTextW(
            hdc: Hdc,
            lpch_text: *const u16,
            cch_text: i32,
            lprc: *mut Rect,
            format: u32,
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
        fn CreateSolidBrush(color: u32) -> Hbrush;
        fn CreatePen(i_style: i32, c_width: i32, color: u32) -> Hpen;
        fn GetStockObject(i: i32) -> Handle;
        fn SelectObject(hdc: Hdc, h: Handle) -> Handle;
        fn DeleteObject(ho: Handle) -> i32;
        fn RoundRect(
            hdc: Hdc,
            left: i32,
            top: i32,
            right: i32,
            bottom: i32,
            width: i32,
            height: i32,
        ) -> i32;
        fn MoveToEx(hdc: Hdc, x: i32, y: i32, lppt: *mut c_void) -> i32;
        fn LineTo(hdc: Hdc, x: i32, y: i32) -> i32;
        fn SetBkMode(hdc: Hdc, mode: i32) -> i32;
        fn SetTextColor(hdc: Hdc, color: u32) -> u32;
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
    }

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: Hwnd,
            dw_attribute: u32,
            pv_attribute: *const c_void,
            cb_attribute: u32,
        ) -> i32;
    }

    fn wide_null(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn get_ctx(hwnd: Hwnd) -> *mut PopupMenuContext {
        #[cfg(target_pointer_width = "64")]
        {
            GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PopupMenuContext
        }
        #[cfg(target_pointer_width = "32")]
        {
            GetWindowLongW(hwnd, GWLP_USERDATA) as *mut PopupMenuContext
        }
    }

    unsafe fn set_ctx(hwnd: Hwnd, ptr: *mut PopupMenuContext) {
        #[cfg(target_pointer_width = "64")]
        {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, ptr as isize);
        }
        #[cfg(target_pointer_width = "32")]
        {
            SetWindowLongW(hwnd, GWLP_USERDATA, ptr as isize);
        }
    }

    unsafe fn create_menu_font(weight: i32) -> Hfont {
        let face = wide_null("Segoe UI");
        CreateFontW(
            -14,
            0,
            0,
            0,
            weight,
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

    struct PopupMenuContext {
        owner_hwnd: Hwnd,
        entries: Vec<PopupMenuEntry>,
        layout: PopupMenuLayout,
        hovered_index: Option<usize>,
        tracking_mouse: bool,
        dismissed: bool,
        font_normal: Hfont,
        font_semibold: Hfont,
    }

    pub struct PopupMenu {
        hwnd: Hwnd,
        h_instance: Hinstance,
        class_registered: bool,
    }

    impl PopupMenu {
        pub fn new() -> Self {
            Self {
                hwnd: null_mut(),
                h_instance: null_mut(),
                class_registered: false,
            }
        }

        pub fn dismiss(&mut self) {
            unsafe {
                if !self.hwnd.is_null() {
                    let hwnd = self.hwnd;
                    self.hwnd = null_mut();
                    if IsWindow(hwnd) != 0 {
                        DestroyWindow(hwnd);
                    }
                }
            }
        }

        pub fn show(
            &mut self,
            owner_hwnd: Hwnd,
            cursor_x: i32,
            cursor_y: i32,
            work_area: WorkArea,
            always_on_top: bool,
            focus_mode: bool,
        ) {
            self.dismiss();

            let entries = build_default_menu_entries(always_on_top, focus_mode);
            let layout = compute_menu_layout(&entries);
            let (x, y) = compute_popup_origin(
                cursor_x,
                cursor_y,
                layout.width,
                layout.height,
                work_area,
            );

            let class_name = wide_null(POPUP_CLASS_NAME);
            let title = wide_null("Petdex Menu");

            unsafe {
                let h_instance = GetModuleHandleW(null());
                self.h_instance = h_instance;

                if !self.class_registered {
                    let wc = WndClassExW {
                        cb_size: size_of::<WndClassExW>() as u32,
                        style: CS_HREDRAW | CS_VREDRAW,
                        lpfn_wnd_proc: popup_wnd_proc,
                        cb_cls_extra: 0,
                        cb_wnd_extra: 0,
                        h_instance,
                        h_icon: null_mut(),
                        h_cursor: LoadCursorW(null_mut(), IDC_ARROW),
                        hbr_background: null_mut(),
                        lpsz_menu_name: null(),
                        lpsz_class_name: class_name.as_ptr(),
                        h_icon_sm: null_mut(),
                    };
                    if RegisterClassExW(&wc) != 0 {
                        self.class_registered = true;
                    }
                }

                let ctx = Box::new(PopupMenuContext {
                    owner_hwnd,
                    entries,
                    layout: layout.clone(),
                    hovered_index: None,
                    tracking_mouse: false,
                    dismissed: false,
                    font_normal: create_menu_font(FW_NORMAL),
                    font_semibold: create_menu_font(FW_SEMIBOLD),
                });
                let ctx_ptr = Box::into_raw(ctx);

                let hwnd = CreateWindowExW(
                    WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                    class_name.as_ptr(),
                    title.as_ptr(),
                    WS_POPUP,
                    x,
                    y,
                    layout.width,
                    layout.height,
                    owner_hwnd,
                    null_mut(),
                    h_instance,
                    ctx_ptr.cast::<c_void>(),
                );

                if hwnd.is_null() {
                    let boxed = Box::from_raw(ctx_ptr);
                    if !boxed.font_normal.is_null() {
                        DeleteObject(boxed.font_normal);
                    }
                    if !boxed.font_semibold.is_null() {
                        DeleteObject(boxed.font_semibold);
                    }
                    return;
                }

                let corner_pref: u32 = DWMWCP_ROUND;
                DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_WINDOW_CORNER_PREFERENCE,
                    (&corner_pref as *const u32).cast::<c_void>(),
                    size_of::<u32>() as u32,
                );
                let border_color: u32 = COLOR_BORDER_TINT;
                DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_BORDER_COLOR,
                    (&border_color as *const u32).cast::<c_void>(),
                    size_of::<u32>() as u32,
                );

                self.hwnd = hwnd;
                ShowWindow(hwnd, SW_SHOW);
                SetForegroundWindow(hwnd);
                SetFocus(hwnd);
            }
        }

        pub fn destroy(&mut self) {
            self.dismiss();
            unsafe {
                if self.class_registered && !self.h_instance.is_null() {
                    let class_name = wide_null(POPUP_CLASS_NAME);
                    UnregisterClassW(class_name.as_ptr(), self.h_instance);
                    self.class_registered = false;
                }
            }
        }
    }

    unsafe fn paint_menu(hwnd: Hwnd, ctx: &PopupMenuContext) {
        let mut ps: PaintStruct = zeroed();
        let hdc = BeginPaint(hwnd, &mut ps);
        if hdc.is_null() {
            return;
        }

        let full_rect = Rect {
            left: 0,
            top: 0,
            right: ctx.layout.width,
            bottom: ctx.layout.height,
        };
        let bg_brush = CreateSolidBrush(COLOR_PEARL_BG);
        if !bg_brush.is_null() {
            FillRect(hdc, &full_rect, bg_brush);
            DeleteObject(bg_brush);
        }

        let hover_brush = CreateSolidBrush(COLOR_HOVER_FILL);
        let sep_pen = CreatePen(PS_SOLID, 1, COLOR_SEPARATOR);
        let check_pen = CreatePen(PS_SOLID, 2, COLOR_COBALT_ACCENT);
        let null_pen = GetStockObject(NULL_PEN);

        SetBkMode(hdc, TRANSPARENT_BK);

        for (idx, (entry, rect)) in ctx.entries.iter().zip(ctx.layout.rects.iter()).enumerate() {
            match entry {
                PopupMenuEntry::Separator => {
                    let mid_y = (rect.top + rect.bottom) / 2;
                    let old_pen = SelectObject(hdc, sep_pen);
                    MoveToEx(hdc, rect.left + 8, mid_y, null_mut());
                    LineTo(hdc, rect.right - 8, mid_y);
                    SelectObject(hdc, old_pen);
                }
                PopupMenuEntry::Item { label, checked, .. } => {
                    let is_hovered = ctx.hovered_index == Some(idx);
                    if is_hovered && !hover_brush.is_null() {
                        let old_brush = SelectObject(hdc, hover_brush);
                        let old_pen = SelectObject(hdc, null_pen);
                        RoundRect(
                            hdc,
                            rect.left,
                            rect.top + 1,
                            rect.right,
                            rect.bottom - 1,
                            10,
                            10,
                        );
                        SelectObject(hdc, old_pen);
                        SelectObject(hdc, old_brush);
                    }

                    if *checked && !check_pen.is_null() {
                        let old_pen = SelectObject(hdc, check_pen);
                        let cx = rect.left + 14;
                        let cy = (rect.top + rect.bottom) / 2;
                        MoveToEx(hdc, cx - 4, cy, null_mut());
                        LineTo(hdc, cx - 1, cy + 3);
                        LineTo(hdc, cx + 5, cy - 4);
                        SelectObject(hdc, old_pen);
                    }

                    let font = if is_hovered {
                        ctx.font_semibold
                    } else {
                        ctx.font_normal
                    };
                    let old_font = if !font.is_null() {
                        SelectObject(hdc, font)
                    } else {
                        null_mut()
                    };

                    SetTextColor(
                        hdc,
                        if is_hovered {
                            COLOR_HOVER_TEXT
                        } else {
                            COLOR_NAVY_TEXT
                        },
                    );

                    let wide = wide_null(label);
                    let mut text_rect = Rect {
                        left: rect.left + 28,
                        top: rect.top,
                        right: rect.right - 10,
                        bottom: rect.bottom,
                    };
                    DrawTextW(
                        hdc,
                        wide.as_ptr(),
                        (wide.len().saturating_sub(1)) as i32,
                        &mut text_rect,
                        DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX,
                    );

                    if !old_font.is_null() {
                        SelectObject(hdc, old_font);
                    }
                }
            }
        }

        if !hover_brush.is_null() {
            DeleteObject(hover_brush);
        }
        if !sep_pen.is_null() {
            DeleteObject(sep_pen);
        }
        if !check_pen.is_null() {
            DeleteObject(check_pen);
        }

        EndPaint(hwnd, &ps);
    }

    unsafe extern "system" fn popup_wnd_proc(
        hwnd: Hwnd,
        msg: u32,
        wparam: usize,
        lparam: isize,
    ) -> isize {
        if msg == WM_NCCREATE {
            let cs = lparam as *const CreateStructW;
            if !cs.is_null() {
                set_ctx(hwnd, (*cs).lp_create_params as *mut PopupMenuContext);
            }
            return 1;
        }

        let ctx_ptr = get_ctx(hwnd);

        match msg {
            WM_ERASEBKGND => 1,
            WM_PAINT => {
                if !ctx_ptr.is_null() {
                    paint_menu(hwnd, &*ctx_ptr);
                }
                0
            }
            WM_MOUSEMOVE => {
                if !ctx_ptr.is_null() {
                    let ctx = &mut *ctx_ptr;
                    if !ctx.tracking_mouse {
                        let mut tme = TrackMouseEventStruct {
                            cb_size: size_of::<TrackMouseEventStruct>() as u32,
                            dw_flags: TME_LEAVE,
                            hwnd_track: hwnd,
                            dw_hover_time: 0,
                        };
                        if TrackMouseEvent(&mut tme) != 0 {
                            ctx.tracking_mouse = true;
                        }
                    }
                    let x = (lparam & 0xFFFF) as i16 as i32;
                    let y = ((lparam >> 16) & 0xFFFF) as i16 as i32;
                    let next_hover = ctx.layout.hit_test(x, y);
                    if next_hover != ctx.hovered_index {
                        ctx.hovered_index = next_hover;
                        InvalidateRect(hwnd, null(), 0);
                    }
                }
                0
            }
            WM_MOUSELEAVE => {
                if !ctx_ptr.is_null() {
                    let ctx = &mut *ctx_ptr;
                    ctx.tracking_mouse = false;
                    if ctx.hovered_index.is_some() {
                        ctx.hovered_index = None;
                        InvalidateRect(hwnd, null(), 0);
                    }
                }
                0
            }
            WM_LBUTTONUP => {
                if !ctx_ptr.is_null() {
                    let ctx = &mut *ctx_ptr;
                    let x = (lparam & 0xFFFF) as i16 as i32;
                    let y = ((lparam >> 16) & 0xFFFF) as i16 as i32;
                    let chosen_cmd = ctx.layout.hit_test(x, y).and_then(|idx| {
                        match ctx.entries.get(idx) {
                            Some(PopupMenuEntry::Item { command_id, .. }) => Some(*command_id),
                            _ => None,
                        }
                    });
                    let owner = ctx.owner_hwnd;
                    ctx.dismissed = true;
                    DestroyWindow(hwnd);
                    if let Some(cmd) = chosen_cmd {
                        PostMessageW(owner, WM_COMMAND, cmd, 0);
                    }
                }
                0
            }
            WM_KEYDOWN => {
                if wparam == VK_ESCAPE && !ctx_ptr.is_null() {
                    let ctx = &mut *ctx_ptr;
                    if !ctx.dismissed {
                        ctx.dismissed = true;
                        DestroyWindow(hwnd);
                    }
                }
                0
            }
            WM_KILLFOCUS => {
                if !ctx_ptr.is_null() {
                    let ctx = &mut *ctx_ptr;
                    if !ctx.dismissed {
                        ctx.dismissed = true;
                        DestroyWindow(hwnd);
                    }
                }
                0
            }
            WM_ACTIVATE => {
                let active_state = wparam & 0xFFFF;
                if active_state == WA_INACTIVE && !ctx_ptr.is_null() {
                    let ctx = &mut *ctx_ptr;
                    if !ctx.dismissed {
                        ctx.dismissed = true;
                        DestroyWindow(hwnd);
                    }
                }
                0
            }
            WM_DESTROY => {
                if !ctx_ptr.is_null() {
                    let ctx = &mut *ctx_ptr;
                    if !ctx.font_normal.is_null() {
                        DeleteObject(ctx.font_normal);
                        ctx.font_normal = null_mut();
                    }
                    if !ctx.font_semibold.is_null() {
                        DeleteObject(ctx.font_semibold);
                        ctx.font_semibold = null_mut();
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
    fn popup_menu_layout_hit_tests_items_and_skips_separators_and_padding() {
        let entries = build_default_menu_entries(true, false);
        assert_eq!(entries.len(), 11);

        let layout = compute_menu_layout(&entries);
        assert_eq!(layout.width, POPUP_MENU_WIDTH);
        assert_eq!(
            layout.height,
            POPUP_PADDING_Y * 2 + 8 * POPUP_ITEM_HEIGHT + 3 * POPUP_SEPARATOR_HEIGHT
        );

        // Outside bounds and outer padding return None.
        assert_eq!(layout.hit_test(-1, 10), None);
        assert_eq!(layout.hit_test(POPUP_MENU_WIDTH, 10), None);
        assert_eq!(layout.hit_test(50, POPUP_PADDING_Y - 1), None);
        assert_eq!(layout.hit_test(POPUP_PADDING_X - 1, POPUP_PADDING_Y + 5), None);
        assert_eq!(
            layout.hit_test(POPUP_MENU_WIDTH - POPUP_PADDING_X, POPUP_PADDING_Y + 5),
            None
        );

        // First item ("Settings...") hit.
        assert_eq!(layout.hit_test(40, POPUP_PADDING_Y + 10), Some(0));
        // Second item ("Shuffle Pet") hit.
        assert_eq!(
            layout.hit_test(40, POPUP_PADDING_Y + POPUP_ITEM_HEIGHT + 10),
            Some(1)
        );
        // First separator (index 2) is not clickable.
        let sep_y = POPUP_PADDING_Y + 2 * POPUP_ITEM_HEIGHT + 4;
        assert_eq!(layout.hit_test(40, sep_y), None);

        // "Always on Top" (index 3) is checked and clickable.
        let topmost_y = POPUP_PADDING_Y + 2 * POPUP_ITEM_HEIGHT + POPUP_SEPARATOR_HEIGHT + 12;
        assert_eq!(layout.hit_test(40, topmost_y), Some(3));
        assert_eq!(
            entries[3],
            PopupMenuEntry::Item {
                command_id: CMD_TOGGLE_TOPMOST,
                label: "Always on Top",
                checked: true,
            }
        );

        // Last item ("Quit Petdex", index 10) hit.
        let quit_rect = layout.rects[10];
        assert_eq!(
            layout.hit_test(quit_rect.left + 10, quit_rect.top + 10),
            Some(10)
        );
    }

    #[test]
    fn popup_origin_flips_and_clamps_inside_work_area() {
        let work_area = WorkArea {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1040,
        };
        assert_eq!(
            compute_popup_origin(300, 400, 212, 295, work_area),
            (300, 400)
        );
        // Near bottom-right edge flips left and up so menu stays fully visible.
        assert_eq!(
            compute_popup_origin(1900, 1020, 212, 295, work_area),
            (1900 - 212, 1020 - 295)
        );
    }
}
