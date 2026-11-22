use petdex_core::{BubbleEntry, SessionStatus};

use crate::sprite_loader::{premultiply_rgba_pixel, DecodedFrame};
use crate::win32_host::{
    WindowPlacement, WorkArea, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
};

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const BUBBLE_EX_STYLE: u32 = WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW;
#[allow(dead_code)]
pub const DEFAULT_BUBBLE_WIDTH: i32 = 248;
#[allow(dead_code)]
pub const DEFAULT_BUBBLE_HEIGHT: i32 = 72;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const DEFAULT_BUBBLE_GAP: i32 = 8;

const DECK_MAX_VISIBLE_CARDS: usize = 4;
const DECK_CARD_WIDTH: f32 = 248.0;
const DECK_CARD_HEIGHT: f32 = 64.0;
const DECK_CARD_RADIUS: f32 = 16.0;
const DECK_TAIL_HEIGHT: f32 = 8.0;
const DECK_LIP_OFFSET: f32 = 2.0;
const DECK_EXPANDED_STEP: f32 = 74.0;
const DECK_MARGIN_X: f32 = 20.0;
const DECK_MARGIN_TOP: f32 = 24.0;
const DECK_MARGIN_BOTTOM: f32 = 18.0;

const SPRING_STIFFNESS: f32 = 280.0;
const SPRING_DAMPING: f32 = 28.0;
const SPRING_MAX_SUBSTEP: f32 = 1.0 / 120.0;

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn spring_step(pos: f32, vel: f32, target: f32, dt: f32) -> (f32, f32) {
    if !dt.is_finite() || dt <= 0.0 {
        return (pos, vel);
    }

    let mut remaining = dt.min(0.25);
    let mut p = pos;
    let mut v = vel;

    while remaining > 0.0 {
        let step = remaining.min(SPRING_MAX_SUBSTEP);
        let accel = SPRING_STIFFNESS * (target - p) - SPRING_DAMPING * v;
        v += accel * step;
        p += v * step;
        remaining -= step;
    }

    (p, v)
}

#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub struct BubbleSpringState {
    pub progress: f32,
    pub velocity: f32,
    pub hovered: bool,
}

impl Default for BubbleSpringState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
impl BubbleSpringState {
    pub const fn new() -> Self {
        Self {
            progress: 0.0,
            velocity: 0.0,
            hovered: false,
        }
    }

    pub fn set_hovered(&mut self, hovered: bool) {
        self.hovered = hovered;
    }

    pub fn is_settled(&self) -> bool {
        let target = if self.hovered { 1.0 } else { 0.0 };
        (self.progress - target).abs() < 0.001 && self.velocity.abs() < 0.005
    }

    pub fn step(&mut self, dt_sec: f32) -> f32 {
        let target = if self.hovered { 1.0 } else { 0.0 };
        let (next_pos, next_vel) = spring_step(self.progress, self.velocity, target, dt_sec);
        if (next_pos - target).abs() < 0.001 && next_vel.abs() < 0.005 {
            self.progress = target;
            self.velocity = 0.0;
        } else {
            self.progress = next_pos.clamp(0.0, 1.0);
            self.velocity = next_vel;
        }
        self.progress
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub struct DeckCardLayout {
    pub index: usize,
    pub scale: f32,
    pub y_offset: f32,
    pub alpha: f32,
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn compute_deck_card_layouts(count: usize, expand_progress: f32) -> Vec<DeckCardLayout> {
    let visible = count.min(DECK_MAX_VISIBLE_CARDS);
    let t = expand_progress.clamp(0.0, 1.0);
    let mut layouts = Vec::with_capacity(visible);

    for index in 0..visible {
        let (collapsed_scale, collapsed_y, collapsed_alpha) = match index {
            0 => (1.0_f32, 0.0_f32, 1.0_f32),
            1 => (0.94_f32, -9.0_f32, 0.90_f32),
            2 => (0.88_f32, -17.0_f32, 0.74_f32),
            _ => (0.82_f32, -22.0_f32, 0.0_f32),
        };
        let expanded_scale = 1.0_f32;
        let expanded_y = -(index as f32) * DECK_EXPANDED_STEP;
        let expanded_alpha = 1.0_f32;

        layouts.push(DeckCardLayout {
            index,
            scale: collapsed_scale + (expanded_scale - collapsed_scale) * t,
            y_offset: collapsed_y + (expanded_y - collapsed_y) * t,
            alpha: collapsed_alpha + (expanded_alpha - collapsed_alpha) * t,
        });
    }

    layouts
}

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

    pub fn vec_from_active_bubbles(bubbles: &[BubbleEntry]) -> Vec<Self> {
        let total = bubbles.len();
        bubbles
            .iter()
            .enumerate()
            .map(|(idx, entry)| {
                let agent_name = entry.agent.spec().display_name.to_string();
                let trimmed = entry.summary.trim();
                let summary = if trimmed.is_empty() {
                    default_summary_for(entry.status).to_string()
                } else {
                    trimmed.to_string()
                };
                Self {
                    agent_name,
                    status: entry.status,
                    summary,
                    extra_count: if idx == 0 {
                        total.saturating_sub(1)
                    } else {
                        0
                    },
                }
            })
            .collect()
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

#[allow(dead_code)]
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

#[inline]
fn status_dot_rgb(status: SessionStatus) -> (u8, u8, u8) {
    match status {
        SessionStatus::NeedsInput => (245, 196, 48),
        SessionStatus::Failed => (224, 72, 88),
        SessionStatus::Running => (59, 89, 242),
        SessionStatus::Completed => (44, 176, 128),
        SessionStatus::Idle => (132, 148, 184),
    }
}

#[inline]
fn rounded_rect_sdf(px: f32, py: f32, cx: f32, cy: f32, half_w: f32, half_h: f32, radius: f32) -> f32 {
    let r = radius.min(half_w).min(half_h);
    let qx = (px - cx).abs() - (half_w - r);
    let qy = (py - cy).abs() - (half_h - r);
    let ox = qx.max(0.0);
    let oy = qy.max(0.0);
    (ox * ox + oy * oy).sqrt() + qx.max(qy).min(0.0) - r
}

#[inline]
fn blend_over_premul_bgra(dst: &mut [u8], r: u8, g: u8, b: u8, alpha: f32) {
    let a = alpha.clamp(0.0, 1.0);
    if a <= 0.0 {
        return;
    }
    let src_b = (b as f32) * a;
    let src_g = (g as f32) * a;
    let src_r = (r as f32) * a;
    let src_a = 255.0 * a;
    let inv_a = 1.0 - a;

    dst[0] = (src_b + (dst[0] as f32) * inv_a).clamp(0.0, 255.0) as u8;
    dst[1] = (src_g + (dst[1] as f32) * inv_a).clamp(0.0, 255.0) as u8;
    dst[2] = (src_r + (dst[2] as f32) * inv_a).clamp(0.0, 255.0) as u8;
    dst[3] = (src_a + (dst[3] as f32) * inv_a).clamp(0.0, 255.0) as u8;
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn render_pearl_bubble_deck_frame(
    bubbles: &[BubbleContent],
    expand_progress: f32,
) -> DecodedFrame {
    let t = expand_progress.clamp(0.0, 1.0);
    let canvas_w = (DECK_CARD_WIDTH + DECK_MARGIN_X * 2.0).round() as u32;

    if bubbles.is_empty() {
        let canvas_h = (DECK_MARGIN_TOP + DECK_CARD_HEIGHT + DECK_TAIL_HEIGHT + DECK_MARGIN_BOTTOM)
            .round() as u32;
        return DecodedFrame {
            width: canvas_w,
            height: canvas_h,
            bgra: vec![0u8; (canvas_w as usize) * (canvas_h as usize) * 4],
        };
    }

    let layouts = compute_deck_card_layouts(bubbles.len(), t);
    let min_y_offset = layouts
        .iter()
        .filter(|layout| layout.alpha > 0.005)
        .map(|layout| layout.y_offset)
        .fold(0.0_f32, f32::min);

    let canvas_h = (DECK_MARGIN_TOP
        + (-min_y_offset)
        + DECK_CARD_HEIGHT
        + DECK_TAIL_HEIGHT
        + DECK_MARGIN_BOTTOM)
        .ceil() as u32;

    let mut bgra = vec![0u8; (canvas_w as usize) * (canvas_h as usize) * 4];
    let center_x = (canvas_w as f32) * 0.5;
    let front_top_y = (canvas_h as f32) - DECK_MARGIN_BOTTOM - DECK_TAIL_HEIGHT - DECK_CARD_HEIGHT;

    for layout in layouts.iter().rev() {
        if layout.alpha <= 0.005 {
            continue;
        }

        let is_front = layout.index == 0;
        let card_w = DECK_CARD_WIDTH * layout.scale;
        let card_h = DECK_CARD_HEIGHT * layout.scale;
        let half_w = card_w * 0.5;
        let half_h = card_h * 0.5;
        let card_top = front_top_y + layout.y_offset;
        let card_cy = card_top + half_h;
        let radius = DECK_CARD_RADIUS * layout.scale;
        let lip_offset = DECK_LIP_OFFSET * layout.scale;

        let shadow_offset_y = if is_front { 4.0 } else { 2.0 };
        let shadow_radius = if is_front { 9.0 } else { 6.0 };
        let shadow_peak_alpha = (if is_front { 0.14 } else { 0.08 }) * layout.alpha;

        let min_px = ((center_x - half_w - shadow_radius - 2.0).floor().max(1.0)) as u32;
        let max_px = ((center_x + half_w + shadow_radius + 2.0)
            .ceil()
            .min((canvas_w - 1) as f32)) as u32;
        let min_py = ((card_top - shadow_radius - 2.0).floor().max(1.0)) as u32;
        let max_py = ((card_top + card_h + lip_offset + shadow_offset_y + shadow_radius + 2.0)
            .ceil()
            .min((canvas_h - 1) as f32)) as u32;

        // 1. Soft drop shadow (navy ink, never clips outer margin).
        for py in min_py..max_py {
            let yf = py as f32 + 0.5;
            for px in min_px..max_px {
                let xf = px as f32 + 0.5;
                let sd = rounded_rect_sdf(
                    xf,
                    yf,
                    center_x,
                    card_cy + shadow_offset_y,
                    half_w,
                    half_h,
                    radius,
                );
                if sd < shadow_radius {
                    let norm = (sd.max(0.0) / shadow_radius).clamp(0.0, 1.0);
                    let falloff = (1.0 - norm) * (1.0 - norm);
                    let idx = ((py as usize) * (canvas_w as usize) + (px as usize)) * 4;
                    blend_over_premul_bgra(
                        &mut bgra[idx..idx + 4],
                        21,
                        30,
                        71,
                        shadow_peak_alpha * falloff,
                    );
                }
            }
        }

        // 2. Slim 2px bottom lip + glossy pearl body + rim border + status dot.
        let (dot_r, dot_g, dot_b) = status_dot_rgb(bubbles[layout.index].status);
        let dot_cx = (center_x - half_w) + 16.0 * layout.scale;
        let dot_cy = card_top + 16.0 * layout.scale;
        let dot_rad = 4.0 * layout.scale;

        let show_pill = is_front && bubbles.len() > 1 && t < 0.85;
        let pill_alpha = if show_pill {
            ((0.85 - t) / 0.85).clamp(0.0, 1.0) * layout.alpha
        } else {
            0.0
        };
        let pill_half_w = 13.0 * layout.scale;
        let pill_half_h = 7.5 * layout.scale;
        let pill_cx = (center_x + half_w) - 24.0 * layout.scale;
        let pill_cy = card_top + 16.0 * layout.scale;

        for py in min_py..max_py {
            let yf = py as f32 + 0.5;
            let grad_t = ((yf - card_top) / card_h).clamp(0.0, 1.0);
            let fill_r = (255.0 - grad_t * 10.0) as u8;
            let fill_g = (255.0 - grad_t * 7.0) as u8;
            let fill_b = 255u8;

            for px in min_px..max_px {
                let xf = px as f32 + 0.5;
                let idx = ((py as usize) * (canvas_w as usize) + (px as usize)) * 4;

                let lip_sd = rounded_rect_sdf(
                    xf,
                    yf,
                    center_x,
                    card_cy + lip_offset,
                    half_w,
                    half_h,
                    radius,
                );
                let body_sd = rounded_rect_sdf(xf, yf, center_x, card_cy, half_w, half_h, radius);

                if lip_sd <= 0.5 && body_sd > -0.2 {
                    let cov = (0.5 - lip_sd).clamp(0.0, 1.0);
                    blend_over_premul_bgra(
                        &mut bgra[idx..idx + 4],
                        213,
                        221,
                        245,
                        cov * layout.alpha,
                    );
                }

                if body_sd <= 0.5 {
                    let cov = (0.5 - body_sd).clamp(0.0, 1.0);
                    let mut r = fill_r;
                    let mut g = fill_g;
                    let mut b = fill_b;

                    // Subtle glossy rim stroke along card perimeter.
                    if body_sd > -1.3 {
                        let rim_t = grad_t;
                        r = (255.0 * (1.0 - rim_t * 0.22) + 59.0 * (rim_t * 0.22)) as u8;
                        g = (255.0 * (1.0 - rim_t * 0.22) + 89.0 * (rim_t * 0.22)) as u8;
                        b = (255.0 * (1.0 - rim_t * 0.22) + 242.0 * (rim_t * 0.22)) as u8;
                    } else if grad_t < 0.18 {
                        // Subtle top specular pearl gloss.
                        let gloss = (1.0 - grad_t / 0.18) * 0.25;
                        r = (r as f32 + (255.0 - r as f32) * gloss).min(255.0) as u8;
                        g = (g as f32 + (255.0 - g as f32) * gloss).min(255.0) as u8;
                        b = 255;
                    }

                    // Status dot in header.
                    let ddx = xf - dot_cx;
                    let ddy = yf - dot_cy;
                    if ddx * ddx + ddy * ddy <= dot_rad * dot_rad {
                        r = dot_r;
                        g = dot_g;
                        b = dot_b;
                    }

                    blend_over_premul_bgra(
                        &mut bgra[idx..idx + 4],
                        r,
                        g,
                        b,
                        cov * layout.alpha,
                    );

                    // Cobalt +N pill on front card when collapsed with multiple bubbles.
                    if pill_alpha > 0.01 {
                        let pill_sd = rounded_rect_sdf(
                            xf,
                            yf,
                            pill_cx,
                            pill_cy,
                            pill_half_w,
                            pill_half_h,
                            pill_half_h,
                        );
                        if pill_sd <= 0.5 {
                            let pill_cov = (0.5 - pill_sd).clamp(0.0, 1.0);
                            blend_over_premul_bgra(
                                &mut bgra[idx..idx + 4],
                                59,
                                89,
                                242,
                                pill_cov * pill_alpha,
                            );
                        }
                    }
                }
            }
        }

        // 3. Bottom speech tail on front card (2px lip + pearl fill).
        if is_front {
            let tail_top = card_top + card_h - 1.0;
            let tail_bottom = tail_top + DECK_TAIL_HEIGHT + 2.0;
            let tail_min_y = (tail_top.floor().max(1.0)) as u32;
            let tail_max_y = (tail_bottom.ceil().min((canvas_h - 1) as f32)) as u32;
            let tail_min_x = ((center_x - 10.0).floor().max(1.0)) as u32;
            let tail_max_x = ((center_x + 10.0).ceil().min((canvas_w - 1) as f32)) as u32;

            for py in tail_min_y..tail_max_y {
                let yf = py as f32 + 0.5;
                let ty = yf - tail_top;
                let lip_ty = yf - (tail_top + 1.5);
                for px in tail_min_x..tail_max_x {
                    let xf = px as f32 + 0.5;
                    let dx = (xf - center_x).abs();
                    let idx = ((py as usize) * (canvas_w as usize) + (px as usize)) * 4;

                    if (0.0..=DECK_TAIL_HEIGHT).contains(&lip_ty) {
                        let half_span = ((DECK_TAIL_HEIGHT - lip_ty) / DECK_TAIL_HEIGHT) * 7.0;
                        if dx <= half_span {
                            let cov = (half_span - dx + 0.5).clamp(0.0, 1.0);
                            blend_over_premul_bgra(
                                &mut bgra[idx..idx + 4],
                                213,
                                221,
                                245,
                                cov * layout.alpha,
                            );
                        }
                    }

                    if (0.0..=DECK_TAIL_HEIGHT).contains(&ty) {
                        let half_span = ((DECK_TAIL_HEIGHT - ty) / DECK_TAIL_HEIGHT) * 7.0;
                        if dx <= half_span {
                            let cov = (half_span - dx + 0.5).clamp(0.0, 1.0);
                            blend_over_premul_bgra(
                                &mut bgra[idx..idx + 4],
                                245,
                                248,
                                255,
                                cov * layout.alpha,
                            );
                        }
                    }
                }
            }
        }
    }

    DecodedFrame {
        width: canvas_w,
        height: canvas_h,
        bgra,
    }
}

#[cfg(target_os = "windows")]
pub struct BubbleWindow {
    hwnd: *mut std::ffi::c_void,
    h_instance: *mut std::ffi::c_void,
    class_registered: bool,
    visible: bool,
    spring: BubbleSpringState,
    last_bubbles: Vec<BubbleContent>,
    last_progress_milli: i32,
    last_placement: Option<WindowPlacement>,
}

#[cfg(target_os = "windows")]
mod platform {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use std::ptr::{copy_nonoverlapping, null, null_mut};

    use super::{
        compute_bubble_placement, compute_deck_card_layouts, render_pearl_bubble_deck_frame,
        BubbleContent, BubbleSpringState, BubbleWindow, BUBBLE_EX_STYLE, DECK_CARD_HEIGHT,
        DECK_CARD_WIDTH, DECK_MARGIN_BOTTOM, DECK_TAIL_HEIGHT, DEFAULT_BUBBLE_GAP,
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
    const DT_CENTER: u32 = 0x0000_0001;
    const DT_VCENTER: u32 = 0x0000_0004;
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
        fn GetWindowRect(hwnd: Hwnd, lp_rect: *mut Rect) -> i32;
        fn GetCursorPos(lp_point: *mut Point) -> i32;
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

    unsafe fn cursor_inside_hwnd(hwnd: Hwnd) -> bool {
        if hwnd.is_null() {
            return false;
        }
        let mut pt = Point { x: 0, y: 0 };
        let mut rect = Rect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if GetCursorPos(&mut pt) == 0 || GetWindowRect(hwnd, &mut rect) == 0 {
            return false;
        }
        pt.x >= rect.left && pt.x < rect.right && pt.y >= rect.top && pt.y < rect.bottom
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
                spring: BubbleSpringState::new(),
                last_bubbles: Vec::new(),
                last_progress_milli: -1,
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

        pub fn sync_deck(
            &mut self,
            pet_placement: WindowPlacement,
            work_area: WorkArea,
            bubbles: &[BubbleContent],
            topmost: bool,
            dt_sec: f32,
        ) {
            if bubbles.is_empty() {
                if self.visible && !self.hwnd.is_null() {
                    unsafe {
                        ShowWindow(self.hwnd, SW_HIDE);
                    }
                    self.visible = false;
                }
                self.spring = BubbleSpringState::new();
                self.last_bubbles.clear();
                self.last_progress_milli = -1;
                return;
            }

            let hovered = if self.visible && bubbles.len() > 1 {
                unsafe { cursor_inside_hwnd(self.hwnd) }
            } else {
                false
            };
            self.spring.set_hovered(hovered);
            let progress = self.spring.step(dt_sec);
            let progress_milli = (progress * 1000.0).round() as i32;

            let frame = render_pearl_bubble_deck_frame(bubbles, progress);
            let placement = compute_bubble_placement(
                pet_placement,
                work_area,
                frame.width as i32,
                frame.height as i32,
                DEFAULT_BUBBLE_GAP,
            );

            if !self.ensure_created(placement) {
                return;
            }

            let needs_redraw = self.last_bubbles.as_slice() != bubbles
                || self.last_progress_milli != progress_milli
                || self.last_placement != Some(placement)
                || !self.visible;

            if needs_redraw {
                unsafe {
                    self.render_layered_deck(placement, bubbles, progress, &frame);
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
                self.last_bubbles = bubbles.to_vec();
                self.last_progress_milli = progress_milli;
                self.last_placement = Some(placement);
            }
        }

        unsafe fn render_layered_deck(
            &self,
            placement: WindowPlacement,
            bubbles: &[BubbleContent],
            expand_progress: f32,
            frame: &crate::sprite_loader::DecodedFrame,
        ) {
            let w = frame.width;
            let h = frame.height;
            if w == 0 || h == 0 {
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
            let pill_font = CreateFontW(
                -11,
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

            let layouts = compute_deck_card_layouts(bubbles.len(), expand_progress);
            let center_x = (w as f32) * 0.5;
            let front_top_y = (h as f32) - DECK_MARGIN_BOTTOM - DECK_TAIL_HEIGHT - DECK_CARD_HEIGHT;
            let t = expand_progress.clamp(0.0, 1.0);
            let pixels = std::slice::from_raw_parts_mut(bits.cast::<u8>(), frame.bgra.len());

            for layout in layouts.iter().rev() {
                if layout.alpha < 0.45 {
                    continue;
                }
                let Some(card) = bubbles.get(layout.index) else {
                    continue;
                };
                let is_front = layout.index == 0;
                let card_w = DECK_CARD_WIDTH * layout.scale;
                let card_h = DECK_CARD_HEIGHT * layout.scale;
                let card_left = (center_x - card_w * 0.5).round() as i32;
                let card_right = (center_x + card_w * 0.5).round() as i32;
                let card_top = (front_top_y + layout.y_offset).round() as i32;
                let card_bottom = (card_top as f32 + card_h).round() as i32;

                let show_pill = is_front && bubbles.len() > 1 && t < 0.85;
                let header_right = if show_pill {
                    card_right - 44
                } else {
                    card_right - 12
                };

                let header = wide_null(&card.header_line());
                let mut header_rect = Rect {
                    left: card_left + 26,
                    top: card_top + 8,
                    right: header_right.max(card_left + 32),
                    bottom: card_top + 26,
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

                let summary = wide_null(&card.summary);
                let mut body_rect = Rect {
                    left: card_left + 14,
                    top: card_top + 29,
                    right: (card_right - 12).max(card_left + 24),
                    bottom: (card_bottom - 8).max(card_top + 44),
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

                if show_pill {
                    let pill_text = wide_null(&format!("+{}", bubbles.len().saturating_sub(1)));
                    let mut pill_rect = Rect {
                        left: card_right - 38,
                        top: card_top + 8,
                        right: card_right - 10,
                        bottom: card_top + 24,
                    };
                    if !pill_font.is_null() {
                        SelectObject(mem_dc, pill_font);
                    }
                    SetTextColor(mem_dc, 0x00FF_FFFF);
                    DrawTextW(
                        mem_dc,
                        pill_text.as_ptr(),
                        (pill_text.len().saturating_sub(1)) as i32,
                        &mut pill_rect,
                        DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX,
                    );
                }

                if !old_font.is_null() {
                    SelectObject(mem_dc, old_font);
                }

                // Restore opaque alpha inside the interior card text region after GDI DrawTextW.
                let alpha_byte = (layout.alpha.clamp(0.0, 1.0) * 255.0).round() as u8;
                let min_x = (card_left + 10).clamp(0, w as i32) as usize;
                let max_x = (card_right - 10).clamp(0, w as i32) as usize;
                let min_y = (card_top + 6).clamp(0, h as i32) as usize;
                let max_y = (card_bottom - 6).clamp(0, h as i32) as usize;
                for py in min_y..max_y {
                    for px in min_x..max_x {
                        let idx = (py * (w as usize) + px) * 4;
                        if pixels[idx + 3] < alpha_byte {
                            pixels[idx + 3] = alpha_byte;
                        }
                    }
                }
            }

            if !header_font.is_null() {
                DeleteObject(header_font);
            }
            if !body_font.is_null() {
                DeleteObject(body_font);
            }
            if !pill_font.is_null() {
                DeleteObject(pill_font);
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
    spring: BubbleSpringState,
    last_bubbles: Vec<BubbleContent>,
    last_placement: Option<WindowPlacement>,
}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
impl BubbleWindow {
    pub fn new() -> Self {
        Self {
            visible: false,
            spring: BubbleSpringState::new(),
            last_bubbles: Vec::new(),
            last_placement: None,
        }
    }

    pub fn sync_deck(
        &mut self,
        pet_placement: WindowPlacement,
        work_area: WorkArea,
        bubbles: &[BubbleContent],
        _topmost: bool,
        dt_sec: f32,
    ) {
        if bubbles.is_empty() {
            self.visible = false;
            self.spring = BubbleSpringState::new();
            self.last_bubbles.clear();
            return;
        }
        let progress = self.spring.step(dt_sec);
        let frame = render_pearl_bubble_deck_frame(bubbles, progress);
        self.visible = true;
        self.last_bubbles = bubbles.to_vec();
        self.last_placement = Some(compute_bubble_placement(
            pet_placement,
            work_area,
            frame.width as i32,
            frame.height as i32,
            DEFAULT_BUBBLE_GAP,
        ));
    }

    pub fn destroy(&mut self) {
        self.visible = false;
        self.last_bubbles.clear();
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

    fn make_bubble_content(name: &str, status: SessionStatus, summary: &str) -> BubbleContent {
        BubbleContent {
            agent_name: name.to_string(),
            status,
            summary: summary.to_string(),
            extra_count: 0,
        }
    }

    #[test]
    fn collapsed_pearl_deck_renders_peeking_cards_cobalt_pill_and_unclipped_margins() {
        let bubbles = vec![
            make_bubble_content("Claude Code", SessionStatus::NeedsInput, "Approve command"),
            make_bubble_content("Codex", SessionStatus::Running, "Building"),
            make_bubble_content("Gemini", SessionStatus::Completed, "Done"),
        ];

        let layouts = compute_deck_card_layouts(bubbles.len(), 0.0);
        assert_eq!(layouts.len(), 3);
        assert!((layouts[0].scale - 1.0).abs() < 1e-6);
        assert!((layouts[1].scale - 0.94).abs() < 1e-6);
        assert!((layouts[1].y_offset + 9.0).abs() < 1e-6);
        assert!((layouts[2].scale - 0.88).abs() < 1e-6);
        assert!((layouts[2].y_offset + 17.0).abs() < 1e-6);

        let single = render_pearl_bubble_deck_frame(&bubbles[..1], 0.0);
        let deck = render_pearl_bubble_deck_frame(&bubbles, 0.0);
        assert_eq!(deck.width, single.width);
        assert!(
            deck.height > single.height,
            "3-card collapsed deck ({}) should be taller than 1-card ({}) to fit peeking cards",
            deck.height,
            single.height
        );

        let w = deck.width as usize;
        let h = deck.height as usize;

        // Outer 1px border must be completely transparent so shadows never clip.
        for x in 0..w {
            assert_eq!(deck.bgra[x * 4 + 3], 0, "top edge clipped at x={x}");
            assert_eq!(
                deck.bgra[((h - 1) * w + x) * 4 + 3],
                0,
                "bottom edge clipped at x={x}"
            );
        }
        for y in 0..h {
            assert_eq!(deck.bgra[(y * w) * 4 + 3], 0, "left edge clipped at y={y}");
            assert_eq!(
                deck.bgra[(y * w + (w - 1)) * 4 + 3],
                0,
                "right edge clipped at y={y}"
            );
        }

        // Peeking back card region above front card has visible non-zero alpha.
        let front_top_y = h - (DECK_MARGIN_BOTTOM + DECK_TAIL_HEIGHT + DECK_CARD_HEIGHT) as usize;
        let peek_y = front_top_y - 12;
        let peek_idx = (peek_y * w + w / 2) * 4;
        assert!(
            deck.bgra[peek_idx + 3] > 150,
            "expected visible peeking card pixel at y={peek_y}"
        );

        // Cobalt +N pill on front card top-right has strong blue channel.
        let pill_x = (w / 2) + (DECK_CARD_WIDTH as usize / 2) - 24;
        let pill_y = front_top_y + 16;
        let pill_idx = (pill_y * w + pill_x) * 4;
        let pill_px = &deck.bgra[pill_idx..pill_idx + 4];
        assert_eq!(pill_px[3], 255);
        assert!(pill_px[0] > 200 && pill_px[2] < 100, "expected cobalt pill pixel, got {pill_px:?}");
    }

    #[test]
    fn expanded_pearl_deck_grows_height_for_up_to_four_cards() {
        let bubbles = vec![
            make_bubble_content("Claude Code", SessionStatus::NeedsInput, "1"),
            make_bubble_content("Codex", SessionStatus::Running, "2"),
            make_bubble_content("Gemini", SessionStatus::Completed, "3"),
            make_bubble_content("OpenCode", SessionStatus::Failed, "4"),
            make_bubble_content("Extra", SessionStatus::Idle, "5"),
        ];

        let collapsed = render_pearl_bubble_deck_frame(&bubbles, 0.0);
        let mid = render_pearl_bubble_deck_frame(&bubbles, 0.5);
        let expanded = render_pearl_bubble_deck_frame(&bubbles, 1.0);

        assert!(mid.height > collapsed.height);
        assert!(expanded.height > mid.height);

        let layouts = compute_deck_card_layouts(bubbles.len(), 1.0);
        assert_eq!(layouts.len(), 4);
        for (i, layout) in layouts.iter().enumerate() {
            assert!((layout.scale - 1.0).abs() < 1e-6);
            assert!((layout.alpha - 1.0).abs() < 1e-6);
            assert!((layout.y_offset + (i as f32) * DECK_EXPANDED_STEP).abs() < 1e-5);
        }
    }

    #[test]
    fn bubble_spring_state_converges_on_hover_and_collapse() {
        let mut spring = BubbleSpringState::new();
        assert_eq!(spring.progress, 0.0);
        assert!(spring.is_settled());

        spring.set_hovered(true);
        assert!(!spring.is_settled());

        let first = spring.step(1.0 / 60.0);
        assert!(first > 0.0 && first < 1.0);

        for _ in 0..120 {
            spring.step(1.0 / 60.0);
        }
        assert!(spring.is_settled());
        assert_eq!(spring.progress, 1.0);
        assert_eq!(spring.velocity, 0.0);

        spring.set_hovered(false);
        for _ in 0..120 {
            spring.step(1.0 / 60.0);
        }
        assert!(spring.is_settled());
        assert_eq!(spring.progress, 0.0);
        assert_eq!(spring.velocity, 0.0);
    }
}
