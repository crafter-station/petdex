use petdex_core::{BubbleEntry, SessionStatus};

use crate::sprite_loader::{premultiply_rgba_pixel, DecodedFrame};
use crate::win32_host::{
    WindowPlacement, WorkArea, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
};

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const BUBBLE_EX_STYLE: u32 = WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const DEFAULT_BUBBLE_WIDTH: i32 = 248;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const DEFAULT_BUBBLE_HEIGHT: i32 = 72;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const DEFAULT_BUBBLE_GAP: i32 = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BubbleContent {
    pub agent_name: String,
    pub status: SessionStatus,
    pub summary: String,
    pub extra_count: usize,
}

impl BubbleContent {
    pub fn from_active_bubbles(bubbles: &[BubbleEntry]) -> Option<Self> {
        let primary = bubbles.first()?;
        let agent_name = primary.agent.spec().display_name.to_string();
        let trimmed = primary.summary.trim();
        let summary = if trimmed.is_empty() {
            default_summary_for(primary.status).to_string()
        } else {
            trimmed.to_string()
        };
        Some(Self {
            agent_name,
            status: primary.status,
            summary,
            extra_count: bubbles.len().saturating_sub(1),
        })
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn header_line(&self) -> String {
        let mut line = self.agent_name.clone();
        if let Some(tag) = status_badge_label(self.status) {
            line.push_str(" [");
            line.push_str(tag);
            line.push(']');
        }
        if self.extra_count > 0 {
            line.push_str(&format!(" +{}", self.extra_count));
        }
        line
    }
}

fn default_summary_for(status: SessionStatus) -> &'static str {
    match status {
        SessionStatus::NeedsInput => "Waiting for input",
        SessionStatus::Failed => "Session failed",
        SessionStatus::Running => "Working...",
        SessionStatus::Completed => "Completed",
        SessionStatus::Idle => "Idle",
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn status_badge_label(status: SessionStatus) -> Option<&'static str> {
    match status {
        SessionStatus::NeedsInput => Some("INPUT"),
        SessionStatus::Failed => Some("FAILED"),
        SessionStatus::Running => Some("RUNNING"),
        SessionStatus::Completed => Some("DONE"),
        SessionStatus::Idle => None,
    }
}

pub const fn compute_bubble_placement(
    pet: WindowPlacement,
    work_area: WorkArea,
    bubble_width: i32,
    bubble_height: i32,
    gap: i32,
) -> WindowPlacement {
    let width = if bubble_width < 1 { 1 } else { bubble_width };
    let height = if bubble_height < 1 { 1 } else { bubble_height };
    let safe_gap = if gap < 0 { 0 } else { gap };

    let raw_x = pet.x.saturating_add((pet.width.saturating_sub(width)) / 2);
    let max_x = work_area.right.saturating_sub(width);
    let x = if max_x <= work_area.left {
        work_area.left
    } else if raw_x < work_area.left {
        work_area.left
    } else if raw_x > max_x {
        max_x
    } else {
        raw_x
    };

    let above_y = pet.y.saturating_sub(height).saturating_sub(safe_gap);
    let below_y = pet.y.saturating_add(pet.height).saturating_add(safe_gap);
    let max_y = work_area.bottom.saturating_sub(height);

    let y = if above_y >= work_area.top {
        if above_y > max_y {
            max_y
        } else {
            above_y
        }
    } else if below_y <= max_y {
        below_y
    } else {
        work_area.top
    };

    WindowPlacement {
        x,
        y,
        width,
        height,
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn render_pearl_bubble_frame(width: u32, height: u32, status: SessionStatus) -> DecodedFrame {
    let w = width.max(16);
    let h = height.max(16);
    let mut bgra = vec![0u8; (w as usize) * (h as usize) * 4];

    let tail_h = 8i32;
    let card_h = (h as i32 - tail_h).max(8);
    let radius = 12.0_f32;
    let border = 1.5_f32;

    let (dot_r, dot_g, dot_b) = match status {
        SessionStatus::NeedsInput => (245u8, 196u8, 48u8),
        SessionStatus::Failed => (224u8, 72u8, 88u8),
        SessionStatus::Running => (59u8, 89u8, 242u8),
        SessionStatus::Completed => (44u8, 176u8, 128u8),
        SessionStatus::Idle => (132u8, 148u8, 184u8),
    };

    let center_x = (w as f32) * 0.5;

    for y in 0..h {
        let yf = y as f32 + 0.5;
        let grad_t = (yf / (card_h as f32)).clamp(0.0, 1.0);
        let fill_r = (255.0 - grad_t * 10.0) as u8;
        let fill_g = (255.0 - grad_t * 7.0) as u8;
        let fill_b = 255u8;

        for x in 0..w {
            let xf = x as f32 + 0.5;
            let idx = ((y as usize) * (w as usize) + (x as usize)) * 4;

            let in_card = if (y as i32) < card_h {
                let dx = (xf - radius)
                    .min(0.0)
                    .abs()
                    .max((xf - (w as f32 - radius)).max(0.0));
                let dy = (yf - radius)
                    .min(0.0)
                    .abs()
                    .max((yf - (card_h as f32 - radius)).max(0.0));
                let corner_dist = (dx * dx + dy * dy).sqrt();
                if corner_dist <= radius - border {
                    Some((fill_r, fill_g, fill_b, 255u8))
                } else if corner_dist <= radius {
                    Some((59u8, 89u8, 242u8, 255u8))
                } else {
                    None
                }
            } else {
                let ty = (y as i32 - card_h) as f32;
                let half_span = ((tail_h as f32 - ty) / (tail_h as f32)) * 7.0;
                let dist_x = (xf - center_x).abs();
                if dist_x <= half_span - 1.2 {
                    Some((fill_r, fill_g, fill_b, 255u8))
                } else if dist_x <= half_span {
                    Some((59u8, 89u8, 242u8, 255u8))
                } else {
                    None
                }
            };

            if let Some((mut r, mut g, mut b, a)) = in_card {
                let ddx = xf - 14.0;
                let ddy = yf - 16.0;
                if ddx * ddx + ddy * ddy <= 16.0 {
                    r = dot_r;
                    g = dot_g;
                    b = dot_b;
                }
                let px = premultiply_rgba_pixel(r, g, b, a);
                bgra[idx..idx + 4].copy_from_slice(&px);
            }
        }
    }

    DecodedFrame {
        width: w,
        height: h,
        bgra,
    }
}

#[cfg(target_os = "windows")]
pub struct BubbleWindow {
    hwnd: *mut std::ffi::c_void,
    h_instance: *mut std::ffi::c_void,
    class_registered: bool,
    visible: bool,
    last_content: Option<BubbleContent>,
    last_placement: Option<WindowPlacement>,
}

#[cfg(target_os = "windows")]
mod platform {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use std::ptr::{copy_nonoverlapping, null, null_mut};

    use super::{
        compute_bubble_placement, render_pearl_bubble_frame, BubbleContent, BubbleWindow,
        BUBBLE_EX_STYLE, DEFAULT_BUBBLE_GAP, DEFAULT_BUBBLE_HEIGHT, DEFAULT_BUBBLE_WIDTH,
    };
    use crate::win32_host::{WindowPlacement, WorkArea};

    type Handle = *mut c_void;
    type Hwnd = Handle;
    type Hinstance = Handle;
    type Hdc = Handle;
    type Hbitmap = Handle;
    type Hfont = Handle;
    type WndProc = unsafe extern "system" fn(Hwnd, u32, usize, isize) -> isize;

    const WS_POPUP: u32 = 0x8000_0000;
    const SW_HIDE: i32 = 0;
    const SW_SHOWNOACTIVATE: i32 = 4;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const HWND_TOPMOST: Hwnd = (-1isize) as Hwnd;
    const HWND_NOTOPMOST: Hwnd = (-2isize) as Hwnd;

    const ULW_ALPHA: u32 = 0x0000_0002;
    const AC_SRC_OVER: u8 = 0x00;
    const AC_SRC_ALPHA: u8 = 0x01;
    const BI_RGB: u32 = 0;
    const DIB_RGB_COLORS: u32 = 0;

    const TRANSPARENT_BK: i32 = 1;
    const DT_LEFT: u32 = 0x0000_0000;
    const DT_SINGLELINE: u32 = 0x0000_0020;
    const DT_END_ELLIPSIS: u32 = 0x0000_8000;
    const DT_NOPREFIX: u32 = 0x0000_0800;

    const FW_SEMIBOLD: i32 = 600;
    const FW_NORMAL: i32 = 400;
    const DEFAULT_CHARSET: u32 = 1;
    const OUT_DEFAULT_PRECIS: u32 = 0;
    const CLIP_DEFAULT_PRECIS: u32 = 0;
    const CLEARTYPE_QUALITY: u32 = 5;
    const DEFAULT_PITCH: u32 = 0;

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

    #[repr(C)]
    struct WndClassExW {
        cb_size: u32,
        style: u32,
        lpfn_wnd_proc: WndProc,
        cb_cls_extra: i32,
        cb_wnd_extra: i32,
        h_instance: Hinstance,
        h_icon: Handle,
        h_cursor: Handle,
        hbr_background: Handle,
        lpsz_menu_name: *const u16,
        lpsz_class_name: *const u16,
        h_icon_sm: Handle,
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
        fn ShowWindow(hwnd: Hwnd, n_cmd_show: i32) -> i32;
        fn SetWindowPos(
            hwnd: Hwnd,
            hwnd_insert_after: Hwnd,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            u_flags: u32,
        ) -> i32;
        fn DefWindowProcW(hwnd: Hwnd, msg: u32, wparam: usize, lparam: isize) -> isize;
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
        fn DrawTextW(
            hdc: Hdc,
            lpch_text: *const u16,
            cch_text: i32,
            lprc: *mut Rect,
            format: u32,
        ) -> i32;
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

    fn wide_null(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe extern "system" fn bubble_wnd_proc(
        hwnd: Hwnd,
        msg: u32,
        wparam: usize,
        lparam: isize,
    ) -> isize {
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    const BUBBLE_CLASS_NAME: &str = "PetdexWin32BubbleWindow";

    impl BubbleWindow {
        pub fn new() -> Self {
            Self {
                hwnd: null_mut(),
                h_instance: null_mut(),
                class_registered: false,
                visible: false,
                last_content: None,
                last_placement: None,
            }
        }

        fn ensure_created(&mut self, placement: WindowPlacement) -> bool {
            if !self.hwnd.is_null() {
                return true;
            }
            let class_name = wide_null(BUBBLE_CLASS_NAME);
            let title = wide_null("Petdex Bubble");
            unsafe {
                let h_instance = GetModuleHandleW(null());
                self.h_instance = h_instance;
                if !self.class_registered {
                    let wc = WndClassExW {
                        cb_size: size_of::<WndClassExW>() as u32,
                        style: 0,
                        lpfn_wnd_proc: bubble_wnd_proc,
                        cb_cls_extra: 0,
                        cb_wnd_extra: 0,
                        h_instance,
                        h_icon: null_mut(),
                        h_cursor: null_mut(),
                        hbr_background: null_mut(),
                        lpsz_menu_name: null(),
                        lpsz_class_name: class_name.as_ptr(),
                        h_icon_sm: null_mut(),
                    };
                    if RegisterClassExW(&wc) != 0 {
                        self.class_registered = true;
                    }
                }

                let hwnd = CreateWindowExW(
                    BUBBLE_EX_STYLE,
                    class_name.as_ptr(),
                    title.as_ptr(),
                    WS_POPUP,
                    placement.x,
                    placement.y,
                    placement.width,
                    placement.height,
                    null_mut(),
                    null_mut(),
                    h_instance,
                    null_mut(),
                );
                if hwnd.is_null() {
                    return false;
                }
                self.hwnd = hwnd;
                true
            }
        }

        pub fn sync(
            &mut self,
            pet_placement: WindowPlacement,
            work_area: WorkArea,
            content: Option<&BubbleContent>,
            topmost: bool,
        ) {
            let Some(content) = content else {
                if self.visible && !self.hwnd.is_null() {
                    unsafe {
                        ShowWindow(self.hwnd, SW_HIDE);
                    }
                    self.visible = false;
                }
                self.last_content = None;
                return;
            };

            let placement = compute_bubble_placement(
                pet_placement,
                work_area,
                DEFAULT_BUBBLE_WIDTH,
                DEFAULT_BUBBLE_HEIGHT,
                DEFAULT_BUBBLE_GAP,
            );

            if !self.ensure_created(placement) {
                return;
            }

            let needs_redraw = self.last_content.as_ref() != Some(content)
                || self.last_placement != Some(placement)
                || !self.visible;

            if needs_redraw {
                unsafe {
                    self.render_layered(placement, content);
                    let insert_after = if topmost { HWND_TOPMOST } else { HWND_NOTOPMOST };
                    SetWindowPos(
                        self.hwnd,
                        insert_after,
                        placement.x,
                        placement.y,
                        placement.width,
                        placement.height,
                        SWP_NOACTIVATE,
                    );
                    if !self.visible {
                        ShowWindow(self.hwnd, SW_SHOWNOACTIVATE);
                        self.visible = true;
                    }
                }
                self.last_content = Some(content.clone());
                self.last_placement = Some(placement);
            }
        }

        unsafe fn render_layered(&self, placement: WindowPlacement, content: &BubbleContent) {
            let w = placement.width.max(16) as u32;
            let h = placement.height.max(16) as u32;
            let frame = render_pearl_bubble_frame(w, h, content.status);

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
            bmi.bmi_header.bi_width = w as i32;
            bmi.bmi_header.bi_height = -(h as i32);
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

            SetBkMode(mem_dc, TRANSPARENT_BK);
            let font_face = wide_null("Segoe UI");
            let header_font = CreateFontW(
                -13,
                0,
                0,
                0,
                FW_SEMIBOLD,
                0,
                0,
                0,
                DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS,
                CLIP_DEFAULT_PRECIS,
                CLEARTYPE_QUALITY,
                DEFAULT_PITCH,
                font_face.as_ptr(),
            );
            let body_font = CreateFontW(
                -12,
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
                font_face.as_ptr(),
            );

            let header = wide_null(&content.header_line());
            let mut header_rect = Rect {
                left: 24,
                top: 8,
                right: (w as i32) - 10,
                bottom: 26,
            };
            let old_font = if !header_font.is_null() {
                SelectObject(mem_dc, header_font)
            } else {
                null_mut()
            };
            SetTextColor(mem_dc, 0x0047_1E15);
            DrawTextW(
                mem_dc,
                header.as_ptr(),
                (header.len().saturating_sub(1)) as i32,
                &mut header_rect,
                DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX,
            );

            let summary = wide_null(&content.summary);
            let mut body_rect = Rect {
                left: 12,
                top: 28,
                right: (w as i32) - 10,
                bottom: (h as i32) - 14,
            };
            if !body_font.is_null() {
                SelectObject(mem_dc, body_font);
            }
            SetTextColor(mem_dc, 0x0091_6354);
            DrawTextW(
                mem_dc,
                summary.as_ptr(),
                (summary.len().saturating_sub(1)) as i32,
                &mut body_rect,
                DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX,
            );

            if !old_font.is_null() {
                SelectObject(mem_dc, old_font);
            }
            if !header_font.is_null() {
                DeleteObject(header_font);
            }
            if !body_font.is_null() {
                DeleteObject(body_font);
            }

            // Restore opaque alpha inside the interior card text region after GDI DrawTextW.
            let pixels = std::slice::from_raw_parts_mut(bits.cast::<u8>(), frame.bgra.len());
            let min_x = 10usize.min(w as usize);
            let max_x = (w as usize).saturating_sub(10);
            let min_y = 6usize.min(h as usize);
            let max_y = (h as usize).saturating_sub(12);
            for py in min_y..max_y {
                for px in min_x..max_x {
                    let idx = (py * (w as usize) + px) * 4;
                    pixels[idx + 3] = 255;
                }
            }

            let pt_dst = Point {
                x: placement.x,
                y: placement.y,
            };
            let pt_src = Point { x: 0, y: 0 };
            let size = Size {
                cx: w as i32,
                cy: h as i32,
            };
            let blend = BlendFunction {
                blend_op: AC_SRC_OVER,
                blend_flags: 0,
                source_constant_alpha: 255,
                alpha_format: AC_SRC_ALPHA,
            };

            UpdateLayeredWindow(
                self.hwnd,
                screen_dc,
                &pt_dst,
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

        pub fn destroy(&mut self) {
            unsafe {
                if !self.hwnd.is_null() {
                    DestroyWindow(self.hwnd);
                    self.hwnd = null_mut();
                }
                if self.class_registered && !self.h_instance.is_null() {
                    let class_name = wide_null(BUBBLE_CLASS_NAME);
                    UnregisterClassW(class_name.as_ptr(), self.h_instance);
                    self.class_registered = false;
                }
            }
            self.visible = false;
        }
    }
}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
pub struct BubbleWindow {
    visible: bool,
    last_content: Option<BubbleContent>,
    last_placement: Option<WindowPlacement>,
}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
impl BubbleWindow {
    pub fn new() -> Self {
        Self {
            visible: false,
            last_content: None,
            last_placement: None,
        }
    }

    pub fn sync(
        &mut self,
        pet_placement: WindowPlacement,
        work_area: WorkArea,
        content: Option<&BubbleContent>,
        _topmost: bool,
    ) {
        match content {
            Some(c) => {
                self.visible = true;
                self.last_content = Some(c.clone());
                self.last_placement = Some(compute_bubble_placement(
                    pet_placement,
                    work_area,
                    DEFAULT_BUBBLE_WIDTH,
                    DEFAULT_BUBBLE_HEIGHT,
                    DEFAULT_BUBBLE_GAP,
                ));
            }
            None => {
                self.visible = false;
                self.last_content = None;
            }
        }
    }

    pub fn destroy(&mut self) {
        self.visible = false;
        self.last_content = None;
    }
}

#[cfg(test)]
mod tests {
    use petdex_core::CodingAgent;

    use super::*;

    fn make_bubble(
        session_id: &str,
        agent: CodingAgent,
        status: SessionStatus,
        summary: &str,
    ) -> BubbleEntry {
        BubbleEntry {
            session_id: session_id.to_string(),
            agent,
            status,
            summary: summary.to_string(),
            updated_at_ms: 1000,
            expires_at_ms: None,
        }
    }

    #[test]
    fn bubble_placement_anchors_centered_above_pet() {
        let work_area = WorkArea {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1040,
        };
        let pet = WindowPlacement {
            x: 1000,
            y: 800,
            width: 160,
            height: 160,
        };
        let placed = compute_bubble_placement(pet, work_area, 240, 72, 8);
        assert_eq!(
            placed,
            WindowPlacement {
                x: 960,
                y: 720,
                width: 240,
                height: 72,
            }
        );
    }

    #[test]
    fn bubble_placement_clamps_to_work_area_edges_and_flips_near_top() {
        let work_area = WorkArea {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1040,
        };
        let right_edge_pet = WindowPlacement {
            x: 1736,
            y: 856,
            width: 160,
            height: 160,
        };
        let clamped = compute_bubble_placement(right_edge_pet, work_area, 248, 72, 8);
        assert_eq!(clamped.x, 1920 - 248);
        assert_eq!(clamped.y, 856 - 72 - 8);

        let top_edge_pet = WindowPlacement {
            x: 20,
            y: 12,
            width: 160,
            height: 160,
        };
        let flipped = compute_bubble_placement(top_edge_pet, work_area, 248, 72, 8);
        assert_eq!(flipped.x, 0);
        assert_eq!(flipped.y, 12 + 160 + 8);
    }

    #[test]
    fn bubble_content_formats_agent_summary_and_extra_session_count() {
        assert_eq!(BubbleContent::from_active_bubbles(&[]), None);

        let single = vec![make_bubble(
            "s1",
            CodingAgent::ClaudeCode,
            SessionStatus::NeedsInput,
            "Approve shell command",
        )];
        let single_content = BubbleContent::from_active_bubbles(&single).expect("single bubble");
        assert_eq!(single_content.agent_name, "Claude Code");
        assert_eq!(single_content.summary, "Approve shell command");
        assert_eq!(single_content.extra_count, 0);
        assert_eq!(single_content.header_line(), "Claude Code [INPUT]");

        let multi = vec![
            make_bubble("s1", CodingAgent::Codex, SessionStatus::NeedsInput, "Review patch"),
            make_bubble("s2", CodingAgent::ClaudeCode, SessionStatus::Running, "Building"),
            make_bubble("s3", CodingAgent::Gemini, SessionStatus::Completed, "Done"),
        ];
        let multi_content = BubbleContent::from_active_bubbles(&multi).expect("multi bubble");
        assert_eq!(multi_content.agent_name, "Codex");
        assert_eq!(multi_content.extra_count, 2);
        assert_eq!(multi_content.header_line(), "Codex [INPUT] +2");
    }

    #[test]
    fn pearl_bubble_frame_has_transparent_corners_and_opaque_interior() {
        let frame = render_pearl_bubble_frame(248, 72, SessionStatus::NeedsInput);
        assert_eq!(frame.width, 248);
        assert_eq!(frame.height, 72);
        assert_eq!(frame.bgra.len(), 248 * 72 * 4);

        // Top-left corner outside rounded rect is transparent.
        assert_eq!(&frame.bgra[0..4], &[0, 0, 0, 0]);

        // Center of card is opaque pearl white.
        let center_idx = (30 * 248 + 124) * 4;
        let center = &frame.bgra[center_idx..center_idx + 4];
        assert_eq!(center[3], 255);
        assert!(center[0] >= 240 && center[1] >= 240 && center[2] >= 240);
    }
}
