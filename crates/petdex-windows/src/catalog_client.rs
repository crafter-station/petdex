#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

use std::collections::HashSet;
use std::path::PathBuf;

pub const CATALOG_BASE_URL: &str = "https://petdex.dev";
pub const CATALOG_ASSETS_BASE_URL: &str = "https://assets.petdex.dev";
pub const DEFAULT_SEARCH_LIMIT: usize = 12;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemotePetEntry {
    pub slug: String,
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallMetadata {
    pub slug: String,
    pub display_name: String,
    pub spritesheet_url: Option<String>,
    pub pet_json_url: Option<String>,
}

pub fn sanitize_slug(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().to_ascii_lowercase();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return Err(format!("invalid pet slug: '{raw}'"));
    }
    if trimmed.starts_with('-') || trimmed.ends_with('-') {
        return Err(format!("invalid pet slug: '{raw}'"));
    }
    if !trimmed
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(format!("invalid pet slug: '{raw}'"));
    }
    Ok(trimmed)
}

pub fn percent_encode_query(input: &str) -> String {
    let mut encoded = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    encoded
}

pub fn build_search_url(query: &str, limit: usize) -> String {
    let encoded_query = percent_encode_query(query.trim());
    let clamped_limit = limit.clamp(1, 60);
    format!("{CATALOG_BASE_URL}/api/pets/search?q={encoded_query}&limit={clamped_limit}")
}

pub fn build_install_metadata_url(slug: &str) -> Result<String, String> {
    let clean = sanitize_slug(slug)?;
    Ok(format!("{CATALOG_BASE_URL}/api/install-pet/{clean}"))
}

pub fn build_fallback_asset_urls(slug: &str) -> Result<(String, String), String> {
    let clean = sanitize_slug(slug)?;
    Ok((
        format!("{CATALOG_ASSETS_BASE_URL}/pets/{clean}/spritesheet.webp"),
        format!("{CATALOG_ASSETS_BASE_URL}/pets/{clean}/pet.json"),
    ))
}

pub fn resolve_asset_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("https://") || trimmed.starts_with("http://") {
        return Some(trimmed.to_string());
    }
    if trimmed.starts_with('/') {
        return Some(format!("{CATALOG_BASE_URL}{trimmed}"));
    }
    Some(format!("{CATALOG_BASE_URL}/{trimmed}"))
}

pub fn pet_install_dir(slug: &str) -> Result<PathBuf, String> {
    let clean = sanitize_slug(slug)?;
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "unable to locate USERPROFILE/HOME directory".to_string())?;
    Ok(home.join(".petdex").join("pets").join(clean))
}

pub fn parse_search_response(json: &str) -> Vec<RemotePetEntry> {
    let array_slice = extract_named_array_slice(json, "pets")
        .or_else(|| {
            let trimmed = json.trim();
            if trimmed.starts_with('[') && trimmed.ends_with(']') {
                Some(&trimmed[1..trimmed.len() - 1])
            } else {
                None
            }
        });

    let Some(array_body) = array_slice else {
        return Vec::new();
    };

    let mut seen = HashSet::new();
    let mut entries = Vec::new();

    for object_body in iter_top_level_objects(array_body) {
        let Some(raw_slug) = extract_object_string_field(object_body, "slug") else {
            continue;
        };
        let slug = raw_slug.trim().to_string();
        if slug.is_empty() {
            continue;
        }

        if let Some(status) = extract_object_string_field(object_body, "status") {
            let lowered = status.trim().to_ascii_lowercase();
            if lowered == "rejected" || lowered == "pending" {
                continue;
            }
        }

        let key = slug.to_ascii_lowercase();
        if !seen.insert(key) {
            continue;
        }

        let display_name = extract_object_string_field(object_body, "displayName")
            .or_else(|| extract_object_string_field(object_body, "display_name"))
            .or_else(|| extract_object_string_field(object_body, "name"))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| slug.clone());

        entries.push(RemotePetEntry { slug, display_name });
    }

    entries
}

pub fn parse_install_metadata_response(json: &str) -> Option<InstallMetadata> {
    let pet_body = extract_named_object_slice(json, "pet")?;
    let slug = extract_object_string_field(pet_body, "slug")?
        .trim()
        .to_string();
    if slug.is_empty() {
        return None;
    }
    let display_name = extract_object_string_field(pet_body, "displayName")
        .or_else(|| extract_object_string_field(pet_body, "name"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| slug.clone());
    let spritesheet_url = extract_object_string_field(pet_body, "spritesheetUrl")
        .or_else(|| extract_object_string_field(pet_body, "spritesheetPath"))
        .and_then(|u| resolve_asset_url(&u));
    let pet_json_url = extract_object_string_field(pet_body, "petJsonUrl")
        .and_then(|u| resolve_asset_url(&u));

    Some(InstallMetadata {
        slug,
        display_name,
        spritesheet_url,
        pet_json_url,
    })
}

fn parse_json_string_at(input: &str, start: usize) -> Option<(String, usize)> {
    let bytes = input.as_bytes();
    if bytes.get(start).copied() != Some(b'"') {
        return None;
    }
    let mut pos = start + 1;
    let mut out = String::new();
    while pos < bytes.len() {
        let b = bytes[pos];
        if b == b'"' {
            return Some((out, pos + 1));
        }
        if b == b'\\' {
            pos += 1;
            let esc = *bytes.get(pos)?;
            pos += 1;
            match esc {
                b'"' => out.push('"'),
                b'\\' => out.push('\\'),
                b'/' => out.push('/'),
                b'b' => out.push('\u{0008}'),
                b'f' => out.push('\u{000C}'),
                b'n' => out.push('\n'),
                b'r' => out.push('\r'),
                b't' => out.push('\t'),
                b'u' => {
                    if pos + 4 > bytes.len() {
                        return None;
                    }
                    let hex = &input[pos..pos + 4];
                    let code = u32::from_str_radix(hex, 16).ok()?;
                    pos += 4;
                    if let Some(ch) = char::from_u32(code) {
                        out.push(ch);
                    }
                }
                _ => out.push(esc as char),
            }
            continue;
        }
        let ch = input[pos..].chars().next()?;
        out.push(ch);
        pos += ch.len_utf8();
    }
    None
}

fn skip_ws(input: &str, mut pos: usize) -> usize {
    let bytes = input.as_bytes();
    while pos < bytes.len() && matches!(bytes[pos], b' ' | b'\t' | b'\r' | b'\n') {
        pos += 1;
    }
    pos
}

fn find_matching_delimiter(input: &str, open_pos: usize, open: u8, close: u8) -> Option<usize> {
    let bytes = input.as_bytes();
    if bytes.get(open_pos).copied() != Some(open) {
        return None;
    }
    let mut pos = open_pos + 1;
    let mut depth = 1usize;
    let mut in_string = false;
    let mut escaped = false;

    while pos < bytes.len() {
        let b = bytes[pos];
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
        } else if b == b'"' {
            in_string = true;
        } else if b == open {
            depth += 1;
        } else if b == close {
            depth -= 1;
            if depth == 0 {
                return Some(pos);
            }
        }
        pos += 1;
    }
    None
}

fn skip_json_value(input: &str, start: usize) -> Option<usize> {
    let pos = skip_ws(input, start);
    let b = *input.as_bytes().get(pos)?;
    match b {
        b'"' => parse_json_string_at(input, pos).map(|(_, end)| end),
        b'{' => find_matching_delimiter(input, pos, b'{', b'}').map(|end| end + 1),
        b'[' => find_matching_delimiter(input, pos, b'[', b']').map(|end| end + 1),
        _ => {
            let bytes = input.as_bytes();
            let mut end = pos;
            while end < bytes.len() && !matches!(bytes[end], b',' | b'}' | b']' | b' ' | b'\t' | b'\r' | b'\n') {
                end += 1;
            }
            Some(end)
        }
    }
}

fn extract_named_array_slice<'a>(input: &'a str, key: &str) -> Option<&'a str> {
    let trimmed = input.trim();
    let body = trimmed.strip_prefix('{')?.strip_suffix('}')?;
    let mut pos = 0;
    let bytes = body.as_bytes();

    while pos < bytes.len() {
        pos = skip_ws(body, pos);
        if pos >= bytes.len() {
            break;
        }
        if bytes[pos] == b',' {
            pos += 1;
            continue;
        }
        let (field_name, after_key) = parse_json_string_at(body, pos)?;
        let colon = skip_ws(body, after_key);
        if bytes.get(colon).copied() != Some(b':') {
            return None;
        }
        let val_start = skip_ws(body, colon + 1);
        if field_name == key && bytes.get(val_start).copied() == Some(b'[') {
            let end = find_matching_delimiter(body, val_start, b'[', b']')?;
            return Some(&body[val_start + 1..end]);
        }
        pos = skip_json_value(body, val_start)?;
    }
    None
}

fn extract_named_object_slice<'a>(input: &'a str, key: &str) -> Option<&'a str> {
    let trimmed = input.trim();
    let body = trimmed.strip_prefix('{')?.strip_suffix('}')?;
    let mut pos = 0;
    let bytes = body.as_bytes();

    while pos < bytes.len() {
        pos = skip_ws(body, pos);
        if pos >= bytes.len() {
            break;
        }
        if bytes[pos] == b',' {
            pos += 1;
            continue;
        }
        let (field_name, after_key) = parse_json_string_at(body, pos)?;
        let colon = skip_ws(body, after_key);
        if bytes.get(colon).copied() != Some(b':') {
            return None;
        }
        let val_start = skip_ws(body, colon + 1);
        if field_name == key && bytes.get(val_start).copied() == Some(b'{') {
            let end = find_matching_delimiter(body, val_start, b'{', b'}')?;
            return Some(&body[val_start + 1..end]);
        }
        pos = skip_json_value(body, val_start)?;
    }
    None
}

fn iter_top_level_objects<'a>(array_body: &'a str) -> Vec<&'a str> {
    let mut objects = Vec::new();
    let bytes = array_body.as_bytes();
    let mut pos = 0;

    while pos < bytes.len() {
        pos = skip_ws(array_body, pos);
        if pos >= bytes.len() {
            break;
        }
        if bytes[pos] == b',' {
            pos += 1;
            continue;
        }
        if bytes[pos] == b'{' {
            if let Some(end) = find_matching_delimiter(array_body, pos, b'{', b'}') {
                objects.push(&array_body[pos + 1..end]);
                pos = end + 1;
                continue;
            }
            break;
        }
        match skip_json_value(array_body, pos) {
            Some(next) if next > pos => pos = next,
            _ => break,
        }
    }

    objects
}

fn extract_object_string_field(object_body: &str, key: &str) -> Option<String> {
    let bytes = object_body.as_bytes();
    let mut pos = 0;

    while pos < bytes.len() {
        pos = skip_ws(object_body, pos);
        if pos >= bytes.len() {
            break;
        }
        if bytes[pos] == b',' {
            pos += 1;
            continue;
        }
        let (field_name, after_key) = parse_json_string_at(object_body, pos)?;
        let colon = skip_ws(object_body, after_key);
        if bytes.get(colon).copied() != Some(b':') {
            return None;
        }
        let val_start = skip_ws(object_body, colon + 1);
        if field_name == key {
            if bytes.get(val_start).copied() == Some(b'"') {
                return parse_json_string_at(object_body, val_start).map(|(s, _)| s);
            }
            return None;
        }
        pos = skip_json_value(object_body, val_start)?;
    }
    None
}

#[cfg(target_os = "windows")]
mod platform {
    use std::fs;
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use super::{
        build_fallback_asset_urls, build_install_metadata_url, build_search_url,
        parse_install_metadata_response, parse_search_response, pet_install_dir, sanitize_slug,
        RemotePetEntry, DEFAULT_SEARCH_LIMIT,
    };

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn ps_single_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "''"))
    }

    fn run_powershell(script: &str) -> Result<String, String> {
        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|err| format!("failed to launch powershell.exe: {err}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                format!("powershell exited with status {}", output.status)
            } else {
                stderr
            });
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    fn fetch_json_text(url: &str) -> Result<String, String> {
        let quoted_url = ps_single_quote(url);
        let script = format!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
             $ProgressPreference = 'SilentlyContinue'; \
             $resp = Invoke-WebRequest -UseBasicParsing -Uri {quoted_url} -Headers @{{ Accept = 'application/json' }} -TimeoutSec 20; \
             Write-Output $resp.Content"
        );
        run_powershell(&script)
    }

    fn download_file(url: &str, dest: &Path) -> Result<(), String> {
        let quoted_url = ps_single_quote(url);
        let quoted_dest = ps_single_quote(&dest.to_string_lossy());
        let script = format!(
            "$ProgressPreference = 'SilentlyContinue'; \
             Invoke-WebRequest -UseBasicParsing -Uri {quoted_url} -OutFile {quoted_dest} -TimeoutSec 30"
        );
        run_powershell(&script)?;
        let meta = fs::metadata(dest)
            .map_err(|err| format!("downloaded file missing at {}: {err}", dest.display()))?;
        if meta.len() == 0 {
            let _ = fs::remove_file(dest);
            return Err(format!("downloaded file was empty: {}", dest.display()));
        }
        Ok(())
    }

    fn escape_json_value(input: &str) -> String {
        let mut out = String::with_capacity(input.len() + 2);
        out.push('"');
        for ch in input.chars() {
            match ch {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                _ => out.push(ch),
            }
        }
        out.push('"');
        out
    }

    pub fn search_catalog(query: &str) -> Result<Vec<RemotePetEntry>, String> {
        let url = build_search_url(query, DEFAULT_SEARCH_LIMIT);
        let body = fetch_json_text(&url)?;
        Ok(parse_search_response(&body))
    }

    pub fn install_pet(slug: &str) -> Result<PathBuf, String> {
        let clean_slug = sanitize_slug(slug)?;
        let install_dir = pet_install_dir(&clean_slug)?;
        fs::create_dir_all(&install_dir)
            .map_err(|err| format!("failed to create {}: {err}", install_dir.display()))?;

        let (fallback_sheet_url, fallback_json_url) = build_fallback_asset_urls(&clean_slug)?;
        let mut display_name = clean_slug.clone();
        let mut spritesheet_url = fallback_sheet_url;
        let mut pet_json_url = fallback_json_url;

        if let Ok(meta_url) = build_install_metadata_url(&clean_slug) {
            if let Ok(meta_body) = fetch_json_text(&meta_url) {
                if let Some(meta) = parse_install_metadata_response(&meta_body) {
                    display_name = meta.display_name;
                    if let Some(url) = meta.spritesheet_url {
                        spritesheet_url = url;
                    }
                    if let Some(url) = meta.pet_json_url {
                        pet_json_url = url;
                    }
                }
            }
        }

        let spritesheet_dest = install_dir.join("spritesheet.webp");
        download_file(&spritesheet_url, &spritesheet_dest)?;

        let pet_json_dest = install_dir.join("pet.json");
        if download_file(&pet_json_url, &pet_json_dest).is_err() {
            let fallback_json = format!("{{\"name\":{}}}\n", escape_json_value(&display_name));
            let _ = fs::write(&pet_json_dest, fallback_json);
        }

        Ok(install_dir)
    }
}

#[cfg(target_os = "windows")]
pub use platform::{install_pet, search_catalog};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_search_response_extracts_entries_and_filters_invalid_records() {
        let payload = r#"{
            "pets": [
                {
                    "slug": "cozy-cat",
                    "displayName": "Cozy Cat",
                    "status": "approved",
                    "tags": ["cute", "cat"],
                    "stats": { "likes": 42, "slug": "nested-ignored" }
                },
                {
                    "slug": "pixel-fox",
                    "displayName": "Pixel \"Fox\" \u0026 Friends",
                    "status": "approved"
                },
                {
                    "slug": "pending-pet",
                    "displayName": "Pending Pet",
                    "status": "pending"
                },
                {
                    "slug": "rejected-pet",
                    "displayName": "Rejected Pet",
                    "status": "rejected"
                },
                {
                    "slug": "cozy-cat",
                    "displayName": "Duplicate Cat"
                },
                {
                    "slug": "minimal-bot"
                }
            ],
            "nextCursor": null
        }"#;

        let entries = parse_search_response(payload);
        assert_eq!(
            entries,
            vec![
                RemotePetEntry {
                    slug: "cozy-cat".to_string(),
                    display_name: "Cozy Cat".to_string(),
                },
                RemotePetEntry {
                    slug: "pixel-fox".to_string(),
                    display_name: "Pixel \"Fox\" & Friends".to_string(),
                },
                RemotePetEntry {
                    slug: "minimal-bot".to_string(),
                    display_name: "minimal-bot".to_string(),
                },
            ]
        );
    }

    #[test]
    fn parse_search_response_supports_top_level_array_and_handles_empty_json() {
        let array_json = r#"[{"slug":"shiba","name":"Shiba Inu"}]"#;
        assert_eq!(
            parse_search_response(array_json),
            vec![RemotePetEntry {
                slug: "shiba".to_string(),
                display_name: "Shiba Inu".to_string(),
            }]
        );
        assert!(parse_search_response("").is_empty());
        assert!(parse_search_response("{}").is_empty());
    }

    #[test]
    fn url_builders_encode_queries_and_validate_slugs() {
        assert_eq!(
            build_search_url("cozy cat!", 12),
            "https://petdex.dev/api/pets/search?q=cozy%20cat%21&limit=12"
        );
        assert_eq!(
            build_search_url("   ", 12),
            "https://petdex.dev/api/pets/search?q=&limit=12"
        );
        assert_eq!(
            build_install_metadata_url("Cozy-Cat").unwrap(),
            "https://petdex.dev/api/install-pet/cozy-cat"
        );
        let (sheet, meta) = build_fallback_asset_urls("cozy-cat").unwrap();
        assert_eq!(sheet, "https://assets.petdex.dev/pets/cozy-cat/spritesheet.webp");
        assert_eq!(meta, "https://assets.petdex.dev/pets/cozy-cat/pet.json");

        assert!(sanitize_slug("../evil").is_err());
        assert!(sanitize_slug("-bad").is_err());
        assert!(sanitize_slug("bad-").is_err());
        assert!(sanitize_slug("has space").is_err());
        assert!(sanitize_slug("").is_err());
    }

    #[test]
    fn parse_install_metadata_resolves_relative_and_absolute_urls() {
        let payload = r#"{
            "ok": true,
            "pet": {
                "slug": "cozy-cat",
                "displayName": "Cozy Cat",
                "spritesheetUrl": "https://assets.petdex.dev/pets/cozy-cat/spritesheet.webp",
                "petJsonUrl": "/pets/cozy-cat/pet.json"
            }
        }"#;
        let meta = parse_install_metadata_response(payload).expect("metadata");
        assert_eq!(meta.slug, "cozy-cat");
        assert_eq!(meta.display_name, "Cozy Cat");
        assert_eq!(
            meta.spritesheet_url.as_deref(),
            Some("https://assets.petdex.dev/pets/cozy-cat/spritesheet.webp")
        );
        assert_eq!(
            meta.pet_json_url.as_deref(),
            Some("https://petdex.dev/pets/cozy-cat/pet.json")
        );
    }
}
