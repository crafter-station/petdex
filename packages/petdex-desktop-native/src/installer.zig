//! Installing a pet the app does not have yet, for `petdex://<slug>`
//! and `petdex://install?slug=…`.
//!
//! The bytes are pulled by the OS downloader through `fx.spawn`, not by
//! `fx.fetch`: a buffered fetch delivers at most
//! `max_effect_body_bytes` (256 KB, effects.zig) and a streamed one
//! frames stdout by LINES, which is meaningless for a webp. Real
//! spritesheets run 983 KB to 2.7 MB and the manifest itself is 1.4 MB,
//! so every single asset would arrive truncated. curl writes straight to
//! disk, where no such bound exists.
//!
//! This module owns only the pure parts — argv construction, manifest
//! parsing, path building, validation. The effect sequencing lives in
//! main.zig, so everything here is callable from a test without a
//! runtime.

const std = @import("std");
const builtin = @import("builtin");
const plat = @import("plat.zig");

/// Mirrors packages/petdex-cli/src/asset-hosts.ts. Server-side
/// validation already gates submissions, but a legacy or compromised
/// approved row could still land a foreign URL in /api/manifest, and by
/// then the app is about to write those bytes to disk. If this drifts
/// from the CLI list, one of the two starts refusing legitimate pets.
const trusted_asset_host = "assets.petdex.dev";

/// The compact manifest is the production catalog contract. Keep the
/// legacy URL as a bounded fallback for older deployments and mirrors.
pub const manifest_url = "https://petdex.dev/api/manifest/v2";
pub const legacy_manifest_url = "https://petdex.dev/api/manifest";

/// Sent on asset requests exactly like the CLI's PETDEX_REFERER: the
/// asset host answers on it, and dropping it here would make the app's
/// downloads look unlike every other client.
pub const referer_header = "Referer: https://petdex.dev/";

/// `https://assets.petdex.dev/…` and nothing else. Checked before the
/// URL is ever handed to curl, so an untrusted host costs zero bytes.
pub fn isTrustedAssetUrl(url: []const u8) bool {
    const scheme = "https://";
    if (!std.mem.startsWith(u8, url, scheme)) return false;
    const rest = url[scheme.len..];
    if (!std.mem.startsWith(u8, rest, trusted_asset_host)) return false;
    // Anchor the host: without this, `assets.petdex.dev.evil.com` passes
    // a prefix test. The host ends at the path separator, and a `@`
    // anywhere before it means the "host" was really userinfo.
    const after = rest[trusted_asset_host.len..];
    if (after.len != 0 and after[0] != '/') return false;
    const host_end = std.mem.indexOfScalar(u8, rest, '/') orelse rest.len;
    if (std.mem.indexOfScalar(u8, rest[0..host_end], '@') != null) return false;
    return true;
}

/// A slug becomes a directory name under `~/.petdex/pets`, so anything
/// outside `[a-z0-9-]` is refused rather than sanitized: the slug
/// arrives from a URL any website can emit, and `../../` would place
/// the write wherever the attacker likes. Leading and trailing dashes
/// are rejected too, so a slug can never read as a curl flag.
pub fn slugOk(slug: []const u8) bool {
    if (slug.len == 0 or slug.len > 64) return false;
    if (slug[0] == '-' or slug[slug.len - 1] == '-') return false;
    for (slug) |c| {
        if (!(std.ascii.isLower(c) or std.ascii.isDigit(c) or c == '-')) return false;
    }
    return true;
}

/// The pet's two install roots, the CLI's multi-target behavior: Petdex
/// Desktop reads the first and Codex Desktop the second, so writing one
/// only would leave the pet invisible to whichever app the user opens.
pub const install_roots = [_][]const u8{ ".petdex/pets", ".codex/pets" };

pub const Urls = struct {
    pet_json: []const u8,
    spritesheet: []const u8,
    /// Empty for the legacy object manifest. Compact v2 rows store asset
    /// keys relative to this trusted base instead of repeating full URLs.
    asset_base: []const u8 = "",

    /// `spritesheet.png` only when the URL says png, else webp — the
    /// CLI's rule. The extension has to match the bytes, since the
    /// loader picks the file by name and the platform codec sniffs
    /// content, not suffix.
    pub fn spritesheetExt(self: Urls) []const u8 {
        return if (std.mem.endsWith(u8, self.spritesheet, ".png")) "png" else "webp";
    }

    fn resolve(self: Urls, raw: []const u8, buf: []u8) ?[]const u8 {
        if (std.mem.startsWith(u8, raw, "https://")) {
            return if (isTrustedAssetUrl(raw)) raw else null;
        }
        // Never reinterpret another absolute URL (including http:// and
        // protocol-relative //host paths) as a relative asset key under the
        // trusted base. The manifest is untrusted input at this boundary.
        if (std.mem.startsWith(u8, raw, "//") or std.mem.indexOf(u8, raw, "://") != null) return null;
        if (self.asset_base.len == 0 or !isTrustedAssetUrl(self.asset_base)) return null;
        if (raw.len == 0 or raw[0] == '/' or std.mem.indexOf(u8, raw, "..") != null) return null;
        var base_len = self.asset_base.len;
        while (base_len > 0 and self.asset_base[base_len - 1] == '/') : (base_len -= 1) {}
        const base = self.asset_base[0..base_len];
        return std.fmt.bufPrint(buf, "{s}/{s}", .{ base, raw }) catch null;
    }

    pub fn resolvePetJson(self: Urls, buf: []u8) ?[]const u8 {
        return self.resolve(self.pet_json, buf);
    }

    pub fn resolveSpritesheet(self: Urls, buf: []u8) ?[]const u8 {
        return self.resolve(self.spritesheet, buf);
    }
};

/// Pull one pet's asset URLs out of the manifest.
///
/// The manifest is one minified line of 4145 objects, so a plain search
/// for a key would find whichever pet happens to come first. The scan
/// anchors on the exact `"slug":"<slug>"` token — `homelander` and
/// `homelander-2` both exist, and a prefix match would install the
/// wrong pet — then reads only forward to that object's closing brace.
pub fn findPetUrls(manifest: []const u8, slug: []const u8) ?Urls {
    if (isCompactManifest(manifest)) return findCompactPetUrls(manifest, slug);
    return findLegacyPetUrls(manifest, slug);
}

fn isCompactManifest(manifest: []const u8) bool {
    // Do not classify a legacy object manifest because a pet's display name
    // happens to contain the words `assetBase` and `fields`. The compact
    // contract has an explicit version marker and a fixed field declaration;
    // both are checked before any tuple positions are interpreted.
    const head = manifest[0..@min(manifest.len, 4096)];
    const compact_fields =
        "\"fields\":[\"slug\",\"displayName\",\"kind\",\"submittedBy\",\"spritesheet\",\"petJson\",\"zip\",\"spriteVersionNumber\"]";
    return std.mem.indexOf(u8, head, "\"v\":2") != null and
        std.mem.indexOf(u8, head, "\"assetBase\"") != null and
        std.mem.indexOf(u8, head, compact_fields) != null;
}

fn findLegacyPetUrls(manifest: []const u8, slug: []const u8) ?Urls {
    var needle_buf: [96]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "\"slug\":\"{s}\"", .{slug}) catch return null;
    const at = std.mem.indexOf(u8, manifest, needle) orelse return null;
    const rest = manifest[at..];
    // One pet object is ~400 bytes; the bound keeps a malformed
    // manifest from dragging the scan across the whole file.
    const window = rest[0..@min(rest.len, 2048)];
    const obj = window[0 .. std.mem.indexOfScalar(u8, window, '}') orelse return null];
    return .{
        .pet_json = jsonStringField(obj, "petJsonUrl") orelse return null,
        .spritesheet = jsonStringField(obj, "spritesheetUrl") orelse return null,
    };
}

fn findCompactPetUrls(manifest: []const u8, slug: []const u8) ?Urls {
    var needle_buf: [96]u8 = undefined;
    const needle = std.fmt.bufPrint(&needle_buf, "[\"{s}\",", .{slug}) catch return null;
    const at = std.mem.indexOf(u8, manifest, needle) orelse return null;
    const row = manifest[at..@min(manifest.len, at + 2048)];
    return .{
        .pet_json = jsonArrayStringAt(row, 5) orelse return null,
        .spritesheet = jsonArrayStringAt(row, 4) orelse return null,
        .asset_base = jsonStringField(manifest, "assetBase") orelse return null,
    };
}

/// Return one string element from a compact manifest row. This small JSON
/// scanner understands escaped quotes and skips non-string values so nullable
/// credits or zip fields cannot shift the asset columns.
fn jsonArrayStringAt(array: []const u8, wanted: usize) ?[]const u8 {
    var pos: usize = 0;
    while (pos < array.len and std.ascii.isWhitespace(array[pos])) : (pos += 1) {}
    if (pos >= array.len or array[pos] != '[') return null;
    pos += 1;
    var index: usize = 0;
    while (index <= wanted) {
        while (pos < array.len and std.ascii.isWhitespace(array[pos])) : (pos += 1) {}
        if (pos >= array.len) return null;
        if (array[pos] == '"') {
            const start = pos + 1;
            const end = skipJsonString(array, pos) orelse return null;
            if (index == wanted) return array[start .. end - 1];
            pos = end;
        } else {
            if (index == wanted) return null;
            pos = skipJsonValue(array, pos) orelse return null;
        }
        while (pos < array.len and std.ascii.isWhitespace(array[pos])) : (pos += 1) {}
        if (pos >= array.len or array[pos] != ',') return null;
        pos += 1;
        index += 1;
    }
    return null;
}

fn skipJsonString(source: []const u8, start: usize) ?usize {
    if (start >= source.len or source[start] != '"') return null;
    var pos = start + 1;
    while (pos < source.len) : (pos += 1) {
        switch (source[pos]) {
            '"' => return pos + 1,
            '\\' => {
                if (pos + 1 >= source.len) return null;
                pos += 1;
            },
            0...0x1f => return null,
            else => {},
        }
    }
    return null;
}

/// Skip one JSON value without allocating. Compact manifest columns that are
/// not needed for installation may be null, numeric, boolean, or nested data;
/// only the requested asset columns are required to be strings.
fn skipJsonValue(source: []const u8, start: usize) ?usize {
    if (start >= source.len) return null;
    switch (source[start]) {
        '"' => return skipJsonString(source, start),
        'n' => return if (std.mem.startsWith(u8, source[start..], "null")) start + 4 else null,
        't' => return if (std.mem.startsWith(u8, source[start..], "true")) start + 4 else null,
        'f' => return if (std.mem.startsWith(u8, source[start..], "false")) start + 5 else null,
        '[', '{' => {
            var depth: usize = 0;
            var pos = start;
            var in_string = false;
            var escaped = false;
            while (pos < source.len) : (pos += 1) {
                const byte = source[pos];
                if (in_string) {
                    if (escaped) {
                        escaped = false;
                    } else if (byte == '\\') {
                        escaped = true;
                    } else if (byte == '"') {
                        in_string = false;
                    }
                    continue;
                }
                switch (byte) {
                    '"' => in_string = true,
                    '[', '{' => depth += 1,
                    ']', '}' => {
                        if (depth == 0) return null;
                        depth -= 1;
                        if (depth == 0) return pos + 1;
                    },
                    else => {},
                }
            }
            return null;
        },
        '-', '0'...'9' => {
            var pos = start;
            while (pos < source.len) : (pos += 1) {
                switch (source[pos]) {
                    ' ', '\t', '\r', '\n', ',', ']' => return pos,
                    else => {},
                }
            }
            return pos;
        },
        else => return null,
    }
}

/// `"key":"value"` inside one already-narrowed object. The manifest
/// emits plain URLs, so no unescaping is needed; a value carrying a
/// backslash ends the read, which can only shorten a URL into one that
/// fails the host check.
fn jsonStringField(obj: []const u8, key: []const u8) ?[]const u8 {
    var pat_buf: [32]u8 = undefined;
    const pat = std.fmt.bufPrint(&pat_buf, "\"{s}\":\"", .{key}) catch return null;
    const at = std.mem.indexOf(u8, obj, pat) orelse return null;
    const start = at + pat.len;
    const end = std.mem.indexOfAnyPos(u8, obj, start, "\"\\") orelse return null;
    if (obj[end] != '"') return null;
    return obj[start..end];
}

/// The downloader to shell out to. macOS and Windows 10+ both ship
/// curl (`curl.exe` there), but plenty of Linux images ship neither
/// curl nor wget, so the choice is probed at runtime instead of
/// assumed per-OS — the same reason the webp loader is reported by name
/// rather than presumed present.
pub const Downloader = enum { curl, wget };

/// Absolute paths first so a hijacked PATH cannot substitute the
/// downloader, then the bare name for distributions that put it
/// elsewhere.
const curl_candidates = [_][]const u8{ "/usr/bin/curl", "/bin/curl" };
const wget_candidates = [_][]const u8{ "/usr/bin/wget", "/bin/wget" };

pub fn detect() ?Downloader {
    if (builtin.os.tag == .windows) return .curl;
    for (curl_candidates) |path| {
        if (plat.fileExists(path)) return .curl;
    }
    for (wget_candidates) |path| {
        if (plat.fileExists(path)) return .wget;
    }
    return null;
}

pub fn program(which: Downloader) []const u8 {
    return switch (which) {
        .curl => if (builtin.os.tag == .windows) "curl.exe" else blk: {
            for (curl_candidates) |path| {
                if (plat.fileExists(path)) break :blk path;
            }
            break :blk "curl";
        },
        .wget => blk: {
            for (wget_candidates) |path| {
                if (plat.fileExists(path)) break :blk path;
            }
            break :blk "wget";
        },
    };
}

/// The message shown when neither downloader exists, naming the package
/// to install rather than reporting a bare failure.
pub const missing_downloader_note = "petdex: cannot download pets, neither curl nor wget is installed (apt install curl)\n";

/// argv for "download `url` to `dest`", built as an array and handed to
/// `fx.spawn` as argv — never concatenated into a shell string. The URL
/// comes from a remote manifest and the slug from any website, so a
/// shell here would be a command injection with extra steps.
///
/// `-L` is mandatory, not defensive: both public manifest routes answer
/// 307 to assets.petdex.dev, so without it curl writes an empty file and
/// the install fails with a valid-looking 0-byte pet. `--fail` turns an
/// HTTP error into a nonzero exit instead of writing the error page
/// into pet.json.
pub const max_argv = 12;

pub fn downloadArgv(
    which: Downloader,
    buf: *[max_argv][]const u8,
    url: []const u8,
    dest: []const u8,
) []const []const u8 {
    var n: usize = 0;
    switch (which) {
        .curl => {
            buf[n] = program(.curl);
            n += 1;
            for ([_][]const u8{ "-sS", "-L", "--fail", "--max-time", "120", "-H", referer_header, "-o", dest }) |arg| {
                buf[n] = arg;
                n += 1;
            }
        },
        .wget => {
            buf[n] = program(.wget);
            n += 1;
            for ([_][]const u8{ "-q", "--timeout=120", "--header", referer_header, "-O", dest }) |arg| {
                buf[n] = arg;
                n += 1;
            }
        },
    }
    // The URL goes last and behind `--`-free flags that all take their
    // value adjacently, so a hostile URL cannot be read as an option.
    buf[n] = url;
    n += 1;
    return buf[0..n];
}

/// `<home>/<root>/<slug>` — the directory one copy of the pet lands in.
pub fn petDir(buf: []u8, home: []const u8, root: []const u8, slug: []const u8) ?[]const u8 {
    return std.fmt.bufPrint(buf, "{s}/{s}/{s}", .{ home, root, slug }) catch null;
}

pub fn petFile(buf: []u8, home: []const u8, root: []const u8, slug: []const u8, name: []const u8) ?[]const u8 {
    return std.fmt.bufPrint(buf, "{s}/{s}/{s}/{s}", .{ home, root, slug, name }) catch null;
}

// ------------------------------------------------------------------ tests

test "slug validation refuses traversal and flag-shaped input" {
    try std.testing.expect(slugOk("homelander"));
    try std.testing.expect(slugOk("rx-78-2-gundam"));
    try std.testing.expect(!slugOk(""));
    try std.testing.expect(!slugOk("../../etc/passwd"));
    try std.testing.expect(!slugOk("a/b"));
    try std.testing.expect(!slugOk("Homelander"));
    try std.testing.expect(!slugOk("-oevil"));
    try std.testing.expect(!slugOk("pet."));
}

test "asset host allowlist anchors the host" {
    try std.testing.expect(isTrustedAssetUrl("https://assets.petdex.dev/pets/x/sprite.webp"));
    try std.testing.expect(!isTrustedAssetUrl("http://assets.petdex.dev/pets/x/sprite.webp"));
    try std.testing.expect(!isTrustedAssetUrl("https://assets.petdex.dev.evil.com/x.webp"));
    try std.testing.expect(!isTrustedAssetUrl("https://assets.petdex.dev@evil.com/x.webp"));
    try std.testing.expect(!isTrustedAssetUrl("https://evil.com/x.webp"));
}

test "manifest lookup picks the exact slug, not a prefix" {
    const manifest =
        \\{"generatedAt":"x","total":2,"pets":[{"slug":"homelander","displayName":"H","kind":"character","submittedBy":"S","spritesheetUrl":"https://assets.petdex.dev/pets/homelander-aaa/sprite.webp","petJsonUrl":"https://assets.petdex.dev/pets/homelander-aaa/petjson.json","zipUrl":"z"},{"slug":"homelander-2","displayName":"H2","kind":"character","submittedBy":"S","spritesheetUrl":"https://assets.petdex.dev/pets/homelander-bbb/sprite.png","petJsonUrl":"https://assets.petdex.dev/pets/homelander-bbb/petjson.json","zipUrl":"z"}]}
    ;
    const first = findPetUrls(manifest, "homelander").?;
    try std.testing.expectEqualStrings("https://assets.petdex.dev/pets/homelander-aaa/sprite.webp", first.spritesheet);
    try std.testing.expectEqualStrings("webp", first.spritesheetExt());

    // The prefix pet must resolve to its OWN object, which is the bug a
    // plain substring search would ship.
    const second = findPetUrls(manifest, "homelander-2").?;
    try std.testing.expectEqualStrings("https://assets.petdex.dev/pets/homelander-bbb/sprite.png", second.spritesheet);
    try std.testing.expectEqualStrings("png", second.spritesheetExt());

    try std.testing.expect(findPetUrls(manifest, "nonexistent") == null);
}

test "legacy manifest asset URLs stay host-bound during resolution" {
    const manifest =
        \\{"generatedAt":"x","total":1,"pets":[{"slug":"evil","displayName":"Evil","kind":"character","submittedBy":null,"spritesheetUrl":"https://evil.example/sprite.webp","petJsonUrl":"https://assets.petdex.dev/pets/evil/pet.json","zipUrl":null}]}
    ;
    const urls = findPetUrls(manifest, "evil").?;
    var buf: [512]u8 = undefined;
    try std.testing.expect(urls.resolveSpritesheet(buf[0..]) == null);
    try std.testing.expectEqualStrings(
        "https://assets.petdex.dev/pets/evil/pet.json",
        urls.resolvePetJson(buf[0..]).?,
    );
}

test "relative resolution rejects absolute non-https keys" {
    const urls = Urls{
        .pet_json = "http://evil.example/pet.json",
        .spritesheet = "//evil.example/sprite.webp",
        .asset_base = "https://assets.petdex.dev",
    };
    var buf: [512]u8 = undefined;
    try std.testing.expect(urls.resolvePetJson(buf[0..]) == null);
    try std.testing.expect(urls.resolveSpritesheet(buf[0..]) == null);
}

test "compact manifest resolves relative asset keys" {
    const manifest =
        \\{"v":2,"generatedAt":"x","total":1,"assetBase":"https://assets.petdex.dev","fields":["slug","displayName","kind","submittedBy","spritesheet","petJson","zip","spriteVersionNumber"],"pets":[["homelander","H, comma","character",null,"pets/homelander/sprite.webp","pets/homelander/pet.json",null,2]]}
    ;
    const urls = findPetUrls(manifest, "homelander").?;
    var sheet_buf: [512]u8 = undefined;
    var json_buf: [512]u8 = undefined;
    const sheet = urls.resolveSpritesheet(sheet_buf[0..]).?;
    const json = urls.resolvePetJson(json_buf[0..]).?;
    try std.testing.expectEqualStrings("https://assets.petdex.dev/pets/homelander/sprite.webp", sheet);
    try std.testing.expectEqualStrings("https://assets.petdex.dev/pets/homelander/pet.json", json);
    try std.testing.expectEqualStrings("webp", urls.spritesheetExt());
    try std.testing.expect(findPetUrls(manifest, "missing") == null);
}

test "legacy marker words do not switch the parser to compact mode" {
    const manifest =
        \\{"generatedAt":"x","total":1,"pets":[{"slug":"legacy","displayName":"assetBase fields v:2","kind":"character","submittedBy":null,"spritesheetUrl":"https://assets.petdex.dev/pets/legacy/sprite.webp","petJsonUrl":"https://assets.petdex.dev/pets/legacy/pet.json","zipUrl":null}]}
    ;
    const urls = findPetUrls(manifest, "legacy").?;
    try std.testing.expectEqualStrings("", urls.asset_base);
    try std.testing.expectEqualStrings(
        "https://assets.petdex.dev/pets/legacy/sprite.webp",
        urls.spritesheet,
    );
}

test "compact parser requires the declared v2 field contract" {
    const manifest =
        \\{"assetBase":"https://assets.petdex.dev","fields":["slug","displayName"],"pets":[["demo","Demo"]]}
    ;
    try std.testing.expect(findPetUrls(manifest, "demo") == null);
}

test "download argv passes the url as its own argument" {
    var buf: [max_argv][]const u8 = undefined;
    const argv = downloadArgv(.curl, &buf, "https://assets.petdex.dev/a.webp", "/tmp/a.webp");
    try std.testing.expectEqualStrings("https://assets.petdex.dev/a.webp", argv[argv.len - 1]);
    // -L is what makes the 307 on /api/manifest resolve at all.
    var saw_location_follow = false;
    for (argv) |arg| {
        if (std.mem.eql(u8, arg, "-L")) saw_location_follow = true;
    }
    try std.testing.expect(saw_location_follow);
    try std.testing.expect(argv.len <= max_argv);
}
