use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use petdex_core::PetState;

pub const DEFAULT_SPRITE_COLS: u32 = 8;
pub const DEFAULT_SPRITE_ROWS: u32 = 9;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledWindowsPet {
    pub id: String,
    pub display_name: String,
    pub directory: PathBuf,
    pub spritesheet_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedFrame {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

#[inline]
pub fn premultiply_rgba_pixel(r: u8, g: u8, b: u8, a: u8) -> [u8; 4] {
    let alpha = u16::from(a);
    let pb = ((u16::from(b) * alpha) / 255) as u8;
    let pg = ((u16::from(g) * alpha) / 255) as u8;
    let pr = ((u16::from(r) * alpha) / 255) as u8;
    [pb, pg, pr, a]
}

#[allow(dead_code)]
pub fn rgba_to_premultiplied_bgra(rgba: &[u8]) -> Vec<u8> {
    let mut bgra = Vec::with_capacity(rgba.len());
    for chunk in rgba.chunks_exact(4) {
        bgra.extend_from_slice(&premultiply_rgba_pixel(
            chunk[0], chunk[1], chunk[2], chunk[3],
        ));
    }
    bgra
}

pub fn default_pet_search_roots() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
    else {
        return Vec::new();
    };
    vec![
        home.join(".petdex").join("pets"),
        home.join(".codex").join("pets"),
    ]
}

pub fn discover_pets() -> Vec<InstalledWindowsPet> {
    let override_value = std::env::var("PETDEX_PET").ok();
    discover_pets_with_override(&default_pet_search_roots(), override_value.as_deref())
}

pub fn discover_pets_with_override(
    roots: &[PathBuf],
    pet_override: Option<&str>,
) -> Vec<InstalledWindowsPet> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut discovered: Vec<InstalledWindowsPet> = Vec::new();

    for root in roots {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };

        let mut dirs: Vec<PathBuf> = entries
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .filter(|path| path.is_dir())
            .collect();
        dirs.sort_by(|a, b| {
            let a_name = a
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let b_name = b
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            a_name.cmp(&b_name)
        });

        for dir in dirs {
            let Some(id) = dir.file_name().and_then(|n| n.to_str()).map(String::from) else {
                continue;
            };
            if id.starts_with('.') {
                continue;
            }
            let dedupe_key = id.to_ascii_lowercase();
            if seen.contains(&dedupe_key) {
                continue;
            }

            let spritesheet_path = dir.join("spritesheet.webp");
            if !spritesheet_path.is_file() {
                continue;
            }

            seen.insert(dedupe_key);
            let display_name = read_pet_display_name(&dir).unwrap_or_else(|| id.clone());
            discovered.push(InstalledWindowsPet {
                id,
                display_name,
                directory: dir,
                spritesheet_path,
            });
        }
    }

    if let Some(raw_override) = pet_override.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(pos) = discovered
            .iter()
            .position(|pet| pet.id.eq_ignore_ascii_case(raw_override))
        {
            if pos > 0 {
                let selected = discovered.remove(pos);
                discovered.insert(0, selected);
            }
        } else if let Some(custom) = resolve_override_path(Path::new(raw_override)) {
            let dedupe_key = custom.id.to_ascii_lowercase();
            if !seen.contains(&dedupe_key) {
                discovered.insert(0, custom);
            }
        }
    }

    discovered
}

fn resolve_override_path(path: &Path) -> Option<InstalledWindowsPet> {
    if path.is_file() {
        let dir = path.parent()?.to_path_buf();
        let id = dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("custom-pet")
            .to_string();
        let display_name = read_pet_display_name(&dir).unwrap_or_else(|| id.clone());
        return Some(InstalledWindowsPet {
            id,
            display_name,
            directory: dir,
            spritesheet_path: path.to_path_buf(),
        });
    }

    if path.is_dir() {
        let spritesheet_path = path.join("spritesheet.webp");
        if spritesheet_path.is_file() {
            let id = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("custom-pet")
                .to_string();
            let display_name = read_pet_display_name(path).unwrap_or_else(|| id.clone());
            return Some(InstalledWindowsPet {
                id,
                display_name,
                directory: path.to_path_buf(),
                spritesheet_path,
            });
        }
    }

    None
}

fn read_pet_display_name(dir: &Path) -> Option<String> {
    for candidate in ["pet.json", "metadata.json"] {
        let path = dir.join(candidate);
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        if let Some(name) = extract_json_string_field(&content, "name") {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn extract_json_string_field(content: &str, field: &str) -> Option<String> {
    let needle = format!("\"{field}\"");
    let start = content.find(&needle)?;
    let rest = &content[start + needle.len()..];
    let colon = rest.find(':')?;
    let after_colon = rest[colon + 1..].trim_start();
    let after_quote = after_colon.strip_prefix('"')?;
    let mut out = String::new();
    let mut escaped = false;
    for ch in after_quote.chars() {
        if escaped {
            out.push(ch);
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            return Some(out);
        } else {
            out.push(ch);
        }
    }
    None
}

pub struct SpriteAtlas {
    sheet_rgba: Vec<u8>,
    sheet_width: u32,
    sheet_height: u32,
    cols: u32,
    rows: u32,
    cache: HashMap<(u32, u32, u32, u32), DecodedFrame>,
}

impl SpriteAtlas {
    pub fn from_file(path: &Path) -> Result<Self, String> {
        let decoded = image::open(path)
            .map_err(|err| format!("failed to decode {}: {err}", path.display()))?
            .to_rgba8();
        let (width, height) = decoded.dimensions();
        Self::from_rgba(
            decoded.into_raw(),
            width,
            height,
            DEFAULT_SPRITE_COLS,
            DEFAULT_SPRITE_ROWS,
        )
    }

    pub fn from_rgba(
        sheet_rgba: Vec<u8>,
        sheet_width: u32,
        sheet_height: u32,
        cols: u32,
        rows: u32,
    ) -> Result<Self, String> {
        if cols == 0 || rows == 0 {
            return Err("atlas cols and rows must be non-zero".to_string());
        }
        let expected_len = (sheet_width as usize)
            .saturating_mul(sheet_height as usize)
            .saturating_mul(4);
        if sheet_rgba.len() != expected_len {
            return Err(format!(
                "invalid rgba buffer length: got {}, expected {}",
                sheet_rgba.len(),
                expected_len
            ));
        }
        if sheet_width < cols || sheet_height < rows {
            return Err(format!(
                "spritesheet {}x{} is smaller than {}x{} grid",
                sheet_width, sheet_height, cols, rows
            ));
        }

        Ok(Self {
            sheet_rgba,
            sheet_width,
            sheet_height,
            cols,
            rows,
            cache: HashMap::new(),
        })
    }

    pub fn sheet_dimensions(&self) -> (u32, u32) {
        (self.sheet_width, self.sheet_height)
    }

    pub fn cell_width(&self) -> u32 {
        self.sheet_width / self.cols
    }

    pub fn cell_height(&self) -> u32 {
        self.sheet_height / self.rows
    }

    pub fn frame_scaled(
        &mut self,
        row: u64,
        col: u64,
        target_width: u32,
        target_height: u32,
    ) -> DecodedFrame {
        let clamped_row = (row.min((self.rows - 1) as u64)) as u32;
        let clamped_col = (col.min((self.cols - 1) as u64)) as u32;
        let out_w = target_width.max(1);
        let out_h = target_height.max(1);
        let key = (clamped_row, clamped_col, out_w, out_h);

        if let Some(cached) = self.cache.get(&key) {
            return cached.clone();
        }

        let cell_w = self.cell_width();
        let cell_h = self.cell_height();
        let src_x0 = clamped_col * cell_w;
        let src_y0 = clamped_row * cell_h;

        let mut bgra = Vec::with_capacity((out_w as usize) * (out_h as usize) * 4);
        for dy in 0..out_h {
            let sy = src_y0 + (dy * cell_h) / out_h;
            let row_offset = (sy as usize) * (self.sheet_width as usize) * 4;
            for dx in 0..out_w {
                let sx = src_x0 + (dx * cell_w) / out_w;
                let idx = row_offset + (sx as usize) * 4;
                let px = premultiply_rgba_pixel(
                    self.sheet_rgba[idx],
                    self.sheet_rgba[idx + 1],
                    self.sheet_rgba[idx + 2],
                    self.sheet_rgba[idx + 3],
                );
                bgra.extend_from_slice(&px);
            }
        }

        let frame = DecodedFrame {
            width: out_w,
            height: out_h,
            bgra,
        };
        self.cache.insert(key, frame.clone());
        frame
    }

    pub fn cobalt_squircle_fallback(
        width: u32,
        height: u32,
        state: PetState,
        frame_index: u32,
    ) -> DecodedFrame {
        let w = width.max(1);
        let h = height.max(1);
        let mut bgra = vec![0u8; (w as usize) * (h as usize) * 4];

        let cx = (w as f32) * 0.5;
        let cy = (h as f32) * 0.5;
        let rx = (w as f32) * 0.38;
        let ry = (h as f32) * 0.38;

        let (base_r, base_g, base_b) = match state {
            PetState::Waiting => (70.0_f32, 108.0_f32, 248.0_f32),
            PetState::Failed => (218.0_f32, 68.0_f32, 83.0_f32),
            PetState::Review => (46.0_f32, 160.0_f32, 128.0_f32),
            _ => (59.0_f32, 89.0_f32, 242.0_f32),
        };
        let blink = (frame_index % 6) == 5;
        let bob = if (frame_index % 2) == 1 { -1.5_f32 } else { 0.0_f32 };

        for y in 0..h {
            let dy = ((y as f32) + 0.5 - (cy + bob)) / ry;
            for x in 0..w {
                let dx = ((x as f32) + 0.5 - cx) / rx;
                let dist = dx.abs().powf(4.0) + dy.abs().powf(4.0);
                let idx = ((y as usize) * (w as usize) + (x as usize)) * 4;

                if dist > 1.06 {
                    continue;
                }

                let alpha = if dist <= 0.94 {
                    255u8
                } else {
                    let t = ((1.06 - dist) / 0.12).clamp(0.0, 1.0);
                    (t * 255.0).round() as u8
                };

                let shade = 1.0 - (dy * 0.14);
                let mut r = (base_r * shade).clamp(0.0, 255.0) as u8;
                let mut g = (base_g * shade).clamp(0.0, 255.0) as u8;
                let mut b = (base_b * shade).clamp(0.0, 255.0) as u8;

                if dist > 0.78 && dist <= 0.94 {
                    r = r.saturating_add(24);
                    g = g.saturating_add(28);
                    b = b.saturating_add(13);
                }

                let eye_y = -0.10_f32;
                let left_eye = (dx + 0.28).powi(2) + (dy - eye_y).powi(2);
                let right_eye = (dx - 0.28).powi(2) + (dy - eye_y).powi(2);
                let in_eye = if blink {
                    ((dx + 0.28).abs() < 0.12 || (dx - 0.28).abs() < 0.12)
                        && (dy - eye_y).abs() < 0.03
                } else {
                    left_eye < 0.016 || right_eye < 0.016
                };

                if in_eye && dist < 0.85 {
                    r = 250;
                    g = 252;
                    b = 255;
                }

                let px = premultiply_rgba_pixel(r, g, b, alpha);
                bgra[idx..idx + 4].copy_from_slice(&px);
            }
        }

        DecodedFrame {
            width: w,
            height: h,
            bgra,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn premultiplied_bgra_math_matches_win32_ulw_alpha() {
        assert_eq!(premultiply_rgba_pixel(255, 128, 64, 255), [64, 128, 255, 255]);
        assert_eq!(premultiply_rgba_pixel(200, 100, 50, 128), [25, 50, 100, 128]);
        assert_eq!(premultiply_rgba_pixel(255, 255, 255, 51), [51, 51, 51, 51]);

        let converted = rgba_to_premultiplied_bgra(&[200, 100, 50, 128, 10, 20, 30, 255]);
        assert_eq!(converted, vec![25, 50, 100, 128, 30, 20, 10, 255]);
    }

    #[test]
    fn alpha_zero_pixels_become_zero_premultiplied_bgra() {
        assert_eq!(premultiply_rgba_pixel(255, 200, 150, 0), [0, 0, 0, 0]);
        let converted = rgba_to_premultiplied_bgra(&[255, 128, 64, 0, 12, 34, 56, 0]);
        assert_eq!(converted, vec![0, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn cobalt_squircle_fallback_generates_valid_premultiplied_bgra() {
        let frame = SpriteAtlas::cobalt_squircle_fallback(64, 64, PetState::Idle, 0);
        assert_eq!(frame.width, 64);
        assert_eq!(frame.height, 64);
        assert_eq!(frame.bgra.len(), 64 * 64 * 4);

        // Top-left corner must be fully transparent.
        assert_eq!(&frame.bgra[0..4], &[0, 0, 0, 0]);

        // Center pixel must be opaque cobalt blue (B > R).
        let center_idx = (32 * 64 + 32) * 4;
        let center = &frame.bgra[center_idx..center_idx + 4];
        assert_eq!(center[3], 255);
        assert!(center[0] > center[2], "expected cobalt blue B > R, got {center:?}");

        // Every pixel must obey the premultiplied alpha invariant.
        for px in frame.bgra.chunks_exact(4) {
            assert!(px[0] <= px[3], "B {} > A {}", px[0], px[3]);
            assert!(px[1] <= px[3], "G {} > A {}", px[1], px[3]);
            assert!(px[2] <= px[3], "R {} > A {}", px[2], px[3]);
        }
    }

    #[test]
    fn sprite_atlas_slices_8x9_grid_with_nearest_neighbor_scaling() {
        let cols = 8u32;
        let rows = 9u32;
        let cell_w = 2u32;
        let cell_h = 2u32;
        let sheet_w = cols * cell_w;
        let sheet_h = rows * cell_h;
        let mut rgba = vec![0u8; (sheet_w * sheet_h * 4) as usize];

        // Fill cell (row=6, col=3) with semi-transparent red (R=200, G=40, B=20, A=128).
        let target_row = 6u32;
        let target_col = 3u32;
        for y in (target_row * cell_h)..((target_row + 1) * cell_h) {
            for x in (target_col * cell_w)..((target_col + 1) * cell_w) {
                let idx = ((y * sheet_w + x) * 4) as usize;
                rgba[idx] = 200;
                rgba[idx + 1] = 40;
                rgba[idx + 2] = 20;
                rgba[idx + 3] = 128;
            }
        }

        let mut atlas = SpriteAtlas::from_rgba(rgba, sheet_w, sheet_h, cols, rows)
            .expect("build synthetic 8x9 atlas");
        let scaled = atlas.frame_scaled(6, 3, 4, 4);
        assert_eq!(scaled.width, 4);
        assert_eq!(scaled.height, 4);
        assert_eq!(scaled.bgra.len(), 4 * 4 * 4);

        let expected = premultiply_rgba_pixel(200, 40, 20, 128);
        for px in scaled.bgra.chunks_exact(4) {
            assert_eq!(px, expected);
        }
    }

    #[test]
    fn discover_pets_scans_roots_and_respects_override() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!(
            "petdex-win-pets-{}-{nonce}",
            std::process::id()
        ));
        let alpha_dir = root.join("alpha");
        let beta_dir = root.join("beta");
        fs::create_dir_all(&alpha_dir).expect("create alpha dir");
        fs::create_dir_all(&beta_dir).expect("create beta dir");
        fs::write(alpha_dir.join("spritesheet.webp"), b"RIFF").expect("write alpha webp");
        fs::write(beta_dir.join("spritesheet.webp"), b"RIFF").expect("write beta webp");
        fs::write(beta_dir.join("pet.json"), r#"{"name": "Beta Cat"}"#).expect("write beta json");

        let pets = discover_pets_with_override(&[root.clone()], Some("beta"));
        assert_eq!(pets.len(), 2);
        assert_eq!(pets[0].id, "beta");
        assert_eq!(pets[0].display_name, "Beta Cat");
        assert_eq!(pets[1].id, "alpha");
        assert_eq!(pets[1].display_name, "alpha");

        let _ = fs::remove_dir_all(&root);
    }
}
