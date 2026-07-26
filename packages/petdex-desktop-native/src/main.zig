//! Petdex on Native SDK, slice 1: a runtime-loaded pet animating its real
//! atlas in a chromeless window. No WebView, no Node sidecar.
//!
//! The atlas decodes app-side and each state's frames register into
//! slots 1..8, replaced in place on state switch (see Sheet for why
//! the full texture cannot ride registerImageBytes). The state table
//! is the canonical map ported from the WebView renderer
//! (petdex-desktop/src/main.zig STATES): 9 states, 8 columns,
//! per-frame durations with idle's irregular blink timing.
//!
//! V1 demo affordance: Space cycles states (replaced by the :7777 hook
//! server in V2).

const std = @import("std");
const builtin = @import("builtin");
const runner = @import("runner");

extern "c" fn system(command: [*:0]const u8) c_int;
const native_sdk = @import("native_sdk");
const hook_server = @import("hook_server.zig");
const hook_runner = @import("hook_runner.zig");
const agent_hooks = @import("agent_hooks.zig");
const plat = @import("plat.zig");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

const canvas = native_sdk.canvas;
const geometry = native_sdk.geometry;

const canvas_label = "pet-canvas";
const frame_w: f32 = 192;
const frame_h: f32 = 208;
const max_scale: f32 = 1.2;
const win_w: f32 = frame_w * max_scale;
const win_h: f32 = frame_h * max_scale;
const cols: u64 = 8;
const sheet_image_id: u64 = 1;

const app_permissions = [_][]const u8{ native_sdk.security.permission_command, native_sdk.security.permission_view };
const shell_views = [_]native_sdk.ShellView{
    .{ .label = canvas_label, .kind = .gpu_surface, .fill = true, .role = "Pet canvas", .accessibility_label = "Petdex pet", .gpu_backend = .metal, .gpu_pixel_format = .bgra8_unorm, .gpu_present_mode = .timer, .gpu_alpha_mode = .@"opaque", .gpu_color_space = .srgb, .gpu_vsync = true },
};
const shell_windows = [_]native_sdk.ShellWindow{.{
    .label = "main",
    .title = "Petdex",
    .width = win_w,
    .height = win_h,
    .resizable = false,
    .restore_state = false,
    .titlebar = .chromeless,
    .floating = true,
    .transparent = true,
    .views = &shell_views,
}};
const shell_scene: native_sdk.ShellConfig = .{ .windows = &shell_windows };

// ----------------------------------------------------------------- states

pub const State = enum(u8) {
    idle,
    @"running-right",
    @"running-left",
    waving,
    jumping,
    failed,
    waiting,
    running,
    review,

    pub fn next(self: State) State {
        const n = (@intFromEnum(self) + 1) % 9;
        return @enumFromInt(n);
    }
};

const FrameSpec = struct { col: u64, dur_ms: u32 };

fn uniform(comptime count: u64, comptime dur: u32, comptime last: u32) [count]FrameSpec {
    var frames: [count]FrameSpec = undefined;
    for (&frames, 0..) |*f, i| {
        f.* = .{ .col = i, .dur_ms = if (i == count - 1) last else dur };
    }
    return frames;
}

const idle_frames = [_]FrameSpec{
    .{ .col = 0, .dur_ms = 280 }, .{ .col = 1, .dur_ms = 110 },
    .{ .col = 2, .dur_ms = 110 }, .{ .col = 3, .dur_ms = 140 },
    .{ .col = 4, .dur_ms = 140 }, .{ .col = 5, .dur_ms = 320 },
};
const running_right_frames = uniform(8, 120, 220);
const running_left_frames = uniform(8, 120, 220);
const waving_frames = uniform(4, 140, 280);
const jumping_frames = uniform(5, 140, 280);
const failed_frames = uniform(8, 140, 240);
const waiting_frames = uniform(6, 150, 260);
const running_frames = uniform(6, 120, 220);
const review_frames = uniform(6, 150, 280);

const StateDef = struct { row: u64, frames: []const FrameSpec };

fn stateDef(state: State) StateDef {
    return switch (state) {
        .idle => .{ .row = 0, .frames = &idle_frames },
        .@"running-right" => .{ .row = 1, .frames = &running_right_frames },
        .@"running-left" => .{ .row = 2, .frames = &running_left_frames },
        .waving => .{ .row = 3, .frames = &waving_frames },
        .jumping => .{ .row = 4, .frames = &jumping_frames },
        .failed => .{ .row = 5, .frames = &failed_frames },
        .waiting => .{ .row = 6, .frames = &waiting_frames },
        .running => .{ .row = 7, .frames = &running_frames },
        .review => .{ .row = 8, .frames = &review_frames },
    };
}

// ------------------------------------------------------------------ model

pub const Msg = union(enum) {
    frame_tick: native_sdk.EffectTimer,
    poll_tick: native_sdk.EffectTimer,
    physics_tick: native_sdk.EffectTimer,
    frame_clock,
    cycle_state,
    open_settings,
    settings_closed,
    close_pet,
    select_pet: u32,
    set_scale: f32,
    open_pets_folder,
    open_pet_page: u32,
    appearance: native_sdk.platform.Appearance,
    toggle_bubbles,
    install_agent: u32,
    uninstall_agent: u32,
    pet_filter: canvas.TextInputEvent,
    toggle_pets_expanded,
    noop,

    pub const view_unbound = .{ "frame_tick", "poll_tick", "physics_tick", "frame_clock", "cycle_state" };
};

pub const Model = struct {
    sheet_loaded: bool = false,
    pet_name: [64]u8 = @splat(0),
    pet_name_len: usize = 0,
    state: State = .idle,
    frame_index: usize = 0,
    // Sidecar dwell semantics (state-queue.ts): the displayed state
    // holds for its dwell before the next queued event applies, so
    // running/idle pinball under heavy tool calls never thrashes.
    shown_at_ms: i64 = 0,
    shown_dwell_ms: u32 = 0,
    bubble: hook_server.Bubble = .{},
    // Drag + momentum, the old desktop's "Codex parity" physics: the
    // frame clock samples the window origin and the primary button
    // through fx.moveWindow(0,0); a down->up edge computes the release
    // velocity from the last 100ms of samples and the physics timer
    // throws the window with friction until it slows or hits an edge.
    samples: [16]PosSample = @splat(.{}),
    sample_len: usize = 0,
    primary_was_down: bool = false,
    throwing: bool = false,
    vx: f64 = 0,
    vy: f64 = 0,
    throw_elapsed_ms: u32 = 0,
    last_physics_ms: i64 = 0,
    // App-owned drag (the old renderer's model, over the moveWindow
    // verb): grab offset from the window origin to the cursor at
    // press, followed every frame while the button holds. Native
    // performWindowDrag is deliberately not used: it swallows the
    // gesture where neither velocity nor tests can see it.
    dragging: bool = false,
    grab_dx: f64 = 0,
    grab_dy: f64 = 0,
    settings_open: bool = false,
    /// Sprite scale, persisted. Codex parity: the settings slider maps
    /// 0.4..1.2 over this.
    scale: f32 = 0.7,
    active_pet: u32 = 0,
    window_fitted: bool = false,
    bubbles_enabled: bool = true,
    pet_x: f64 = 0,
    pet_y: f64 = 0,
    agents: [agent_hooks.agent_count]agent_hooks.AgentInfo = .{
        .{ .kind = .claude_code },
        .{ .kind = .codex },
        .{ .kind = .gemini },
        .{ .kind = .opencode },
    },
    agents_prompted: bool = false,
    codex_trust_note: bool = false,
    pet_filter: [48]u8 = @splat(0),
    pet_filter_len: usize = 0,
    pets_expanded: bool = false,
    dark: bool = true,
    high_contrast: bool = false,
    reduce_motion: bool = false,
};

/// Petdex web tokens (globals.css) translated from OKLCH: brand purple
/// #5266ea family, cool-tinted near-white light surfaces, stone-900
/// dark cards. High contrast keeps the stock loud register untouched.
fn petdexTokens(model: *const Model) canvas.DesignTokens {
    const scheme: canvas.ColorScheme = if (model.dark) .dark else .light;
    var tokens = canvas.DesignTokens.theme(.{
        .color_scheme = scheme,
        .contrast = if (model.high_contrast) .high else .standard,
        .reduce_motion = model.reduce_motion,
    });
    if (model.high_contrast) return tokens;
    const c = &tokens.colors;
    if (model.dark) {
        c.background = canvas.Color.rgb8(12, 12, 15);
        c.surface = canvas.Color.rgb8(25, 25, 28);
        c.surface_subtle = canvas.Color.rgb8(45, 45, 48);
        c.surface_pressed = canvas.Color.rgb8(22, 27, 67);
        c.text = canvas.Color.rgb8(237, 237, 238);
        c.text_muted = canvas.Color.rgb8(156, 158, 168);
        c.accent = canvas.Color.rgb8(137, 163, 255);
        c.destructive = canvas.Color.rgb8(250, 105, 94);
    } else {
        c.background = canvas.Color.rgb8(247, 250, 255);
        c.surface = canvas.Color.rgb8(255, 255, 255);
        c.surface_subtle = canvas.Color.rgb8(236, 238, 244);
        c.surface_pressed = canvas.Color.rgb8(233, 238, 251);
        c.text = canvas.Color.rgb8(9, 9, 9);
        c.text_muted = canvas.Color.rgb8(88, 92, 106);
        c.accent = canvas.Color.rgb8(78, 98, 235);
        c.destructive = canvas.Color.rgb8(212, 12, 26);
    }
    return tokens.withOverrides(canvas.accentOverrides(c.accent, scheme));
}

fn onAppearance(appearance: native_sdk.platform.Appearance) ?Msg {
    return .{ .appearance = appearance };
}

pub const max_catalog = 32;
pub const CatalogEntry = struct {
    name: [64]u8 = @splat(0),
    len: usize = 0,
    root: [160]u8 = @splat(0),
    root_len: usize = 0,

    pub fn slice(self: *const CatalogEntry) []const u8 {
        return self.name[0..self.len];
    }
    pub fn rootSlice(self: *const CatalogEntry) []const u8 {
        return self.root[0..self.root_len];
    }
};
pub var catalog: [max_catalog]CatalogEntry = @splat(.{});
pub var catalog_len: usize = 0;

pub const PosSample = struct { x: f64 = 0, y: f64 = 0, t_ms: i64 = 0 };

const physics_timer_key: u64 = 3;
const physics_tick_ms: u32 = 16;
const physics_friction: f64 = 0.88;
const physics_min_vel: f64 = 65;
const physics_max_duration_ms: u32 = 900;
const sample_window_ms: i64 = 100;

pub const Effects = native_sdk.Effects(Msg);

const frame_timer_key: u64 = 1;

fn armFrameTimer(model: *const Model, fx: *Effects) void {
    const def = stateDef(model.state);
    const spec = def.frames[model.frame_index % def.frames.len];
    fx.startTimer(.{
        .key = frame_timer_key,
        .interval_ms = spec.dur_ms,
        .mode = .one_shot,
        .on_fire = Effects.timerMsg(.frame_tick),
    });
}

// ------------------------------------------------------------- pet loading

const PetFile = struct {
    name: []const u8,
    sheet_path: []const u8,
};

/// Decoded atlas kept app-side: the runtime's image registry caps one
/// image at 1MB of pixels and the platform decode scratch at 1.25MB,
/// so a full sheet (11.5MB RGBA) can never ride registerImageBytes.
/// We decode the sheet ourselves and register one 192x208 frame per
/// slot (160KB, 16 slots available), replacing in place per state.
/// The decode goes through `PlatformServices.decodeImage` with our own
/// buffer (see `decodeSheet`), so webp and png both ride the platform
/// codec on macOS, Linux and Windows with nothing vendored. Raising the
/// registry caps is on the upstream PR list.
const Sheet = struct {
    pixels: []u8 = &.{},
    width: usize = 0,
    height: usize = 0,
    rows: usize = 9,
};
var sheet: Sheet = .{};


/// Scan the petdex pet roots for the first usable pet, honoring
/// PETDEX_PET as a directory-name override. Returns the sheet bytes
/// (caller frees) and the display name.
/// Env snapshot taken in main() from init.environ_map (Zig 0.16 has no
/// global getenv; env rides std.process.Init).
var env_home: ?[]const u8 = null;
var env_wanted_pet: ?[]const u8 = null;

fn readFileAbsolute(io: std.Io, allocator: std.mem.Allocator, path: []const u8, max: usize) ![]u8 {
    var file = try std.Io.Dir.openFileAbsolute(io, path, .{});
    defer file.close(io);
    const stat = try file.stat(io);
    const size: usize = @intCast(stat.size);
    if (size == 0 or size > max) return error.FileTooLarge;
    const buf = try allocator.alloc(u8, size);
    errdefer allocator.free(buf);
    const read = try file.readPositionalAll(io, buf, 0);
    if (read != size) return error.ShortRead;
    return buf;
}

fn petNameOk(name: []const u8) bool {
    if (name.len == 0 or name.len > 63) return false;
    for (name) |c| {
        if (!(std.ascii.isAlphanumeric(c) or c == '-' or c == '_' or c == '.')) return false;
    }
    return true;
}

/// Scan both pet roots into the catalog (name + which root), sorted by
/// scan order. Runs once in main() with the io handle.
fn scanCatalog(io: std.Io, allocator: std.mem.Allocator) void {
    const home = env_home orelse return;
    const roots = [_][]const u8{ ".petdex/pets", ".codex/pets" };
    for (roots) |root| {
        const root_path = std.fs.path.join(allocator, &.{ home, root }) catch continue;
        defer allocator.free(root_path);
        var dir = std.Io.Dir.openDirAbsolute(io, root_path, .{ .iterate = true }) catch continue;
        defer dir.close(io);
        var it = dir.iterate();
        while (it.next(io) catch null) |entry| {
            if (entry.kind != .directory) continue;
            if (!petNameOk(entry.name)) continue;
            if (catalog_len >= max_catalog) return;
            var duplicate = false;
            for (catalog[0..catalog_len]) |*existing| {
                if (std.mem.eql(u8, existing.slice(), entry.name)) duplicate = true;
            }
            if (duplicate) continue;
            var e = &catalog[catalog_len];
            @memcpy(e.name[0..entry.name.len], entry.name);
            e.len = entry.name.len;
            @memcpy(e.root[0..root.len], root);
            e.root_len = root.len;
            catalog_len += 1;
        }
    }
}

var boot_allocator: std.mem.Allocator = std.heap.page_allocator;
var boot_io: ?std.Io = null;
var pet_display_name: []const u8 = "";

fn settingsPath(buf: []u8) ?[]const u8 {
    const home = env_home orelse return null;
    return std.fmt.bufPrint(buf, "{s}/.petdex/desktop-native-settings.json", .{home}) catch null;
}

/// Tiny file helpers usable from the runtime thread. They carry their
/// own Io (see plat.zig), so the main thread's never leaks off-thread;
/// the invariant is enforced by the type now, not by this comment.
const cReadFile = plat.readFile;

fn cWriteFile(path: []const u8, bytes: []const u8) void {
    _ = plat.writeFile(path, bytes);
}

fn saveSettings(model: *const Model) void {
    var path_buf: [512]u8 = undefined;
    const path = settingsPath(&path_buf) orelse return;
    var buf: [256]u8 = undefined;
    const active = if (model.active_pet < catalog_len) catalog[model.active_pet].slice() else "";
    const json = std.fmt.bufPrint(&buf, "{{\"active_pet\":\"{s}\",\"scale\":{d:.2},\"bubbles\":{},\"agents_prompted\":{}}}", .{ active, model.scale, model.bubbles_enabled, model.agents_prompted }) catch return;
    cWriteFile(path, json);
}

/// Read a pet's encoded sheet bytes into `buf`. Prefers pet.json's
/// spritesheetPath, then the standard names.
fn readPetSheetBytes(entry: *const CatalogEntry, buf: []u8) ?[]const u8 {
    const home = env_home orelse return null;

    var candidates_buf: [3][64]u8 = undefined;
    var candidates: [3][]const u8 = undefined;
    var candidate_count: usize = 0;
    var json_buf: [1024]u8 = undefined;
    var pj_path: [512]u8 = undefined;
    if (std.fmt.bufPrint(&pj_path, "{s}/{s}/{s}/pet.json", .{ home, entry.rootSlice(), entry.slice() })) |pjp| {
        if (cReadFile(pjp, &json_buf)) |json| {
            if (hook_server.jsonStringPub(json, "spritesheetPath")) |sp| {
                if (petNameOk(sp) and sp.len < 64) {
                    @memcpy(candidates_buf[candidate_count][0..sp.len], sp);
                    candidates[candidate_count] = candidates_buf[candidate_count][0..sp.len];
                    candidate_count += 1;
                }
            }
        }
    } else |_| {}
    candidates[candidate_count] = "spritesheet.webp";
    candidate_count += 1;
    candidates[candidate_count] = "spritesheet.png";
    candidate_count += 1;

    var path_buf: [512]u8 = undefined;
    for (candidates[0..candidate_count]) |name| {
        const path = std.fmt.bufPrint(&path_buf, "{s}/{s}/{s}/{s}", .{ home, entry.rootSlice(), entry.slice(), name }) catch continue;
        if (cReadFile(path, buf)) |bytes| return bytes;
    }
    return null;
}

/// Encoded sheets are well under a megabyte; the decoded RGBA is the
/// big side (1536x2288x4 = 13.4MB), so the decode buffer is sized for
/// the largest sheet the platform codecs accept at our aspect.
const max_sheet_file_bytes: usize = 4 * 1024 * 1024;
const max_sheet_pixel_bytes: usize = 16 * 1024 * 1024;

/// Decode a pet sheet through the platform image codec (CGImageSource
/// on macOS, gdk-pixbuf on Linux, WIC on Windows), the same seam
/// `fx.registerImageBytes` uses. We call `services.decodeImage` with our
/// own 16MB buffer instead of registering: the registry caps one image
/// at 1MB of pixels and its decode scratch at 1.25MB, but that bound
/// lives in the runtime's registry, not in the decoder, which honors
/// whatever buffer the caller hands it. Loop-thread only, per the
/// `PlatformServices.decodeImage` contract.
fn decodeSheet(fx: *Effects, entry: *const CatalogEntry) ?Sheet {
    const services = fx.services orelse return null;
    const file_buf = boot_allocator.alloc(u8, max_sheet_file_bytes) catch return null;
    defer boot_allocator.free(file_buf);
    const encoded = readPetSheetBytes(entry, file_buf) orelse return null;

    const pixel_buf = boot_allocator.alloc(u8, max_sheet_pixel_bytes) catch return null;
    var keep_pixels = false;
    defer if (!keep_pixels) boot_allocator.free(pixel_buf);

    const decoded = services.decodeImage(encoded, pixel_buf) catch return null;
    if (decoded.width == 0 or decoded.height == 0) return null;
    // The decoder slices the caller's buffer, so the pixels are already
    // at the front: keep the allocation and record the used length.
    keep_pixels = true;
    var out: Sheet = .{
        .pixels = pixel_buf[0 .. decoded.width * decoded.height * 4],
        .width = decoded.width,
        .height = decoded.height,
    };
    out.rows = if (out.height * 1536 >= out.width * 2288) 11 else 9;
    return out;
}

/// Swap the live sheet for `entry`'s. Runs on the loop thread (boot and
/// the pet-switch Msg), which is where `decodeImage` is legal.
fn loadSheetForPet(fx: *Effects, entry: *const CatalogEntry) bool {
    const decoded = decodeSheet(fx, entry) orelse return false;
    if (sheet.pixels.len > 0) freeSheet(&sheet);
    sheet = decoded;
    return true;
}

/// Sheet pixels are a slice into a `max_sheet_pixel_bytes` allocation,
/// so the free has to restore the original length.
fn freeSheet(s: *Sheet) void {
    if (s.pixels.len == 0) return;
    const base: []u8 = s.pixels.ptr[0..max_sheet_pixel_bytes];
    boot_allocator.free(base);
    s.* = .{};
}

var initial_scale: f32 = 0.7;
var initial_pet: u32 = 0;
var initial_bubbles: bool = true;
var initial_agents_prompted: bool = false;

// ------------------------------------------------------------- avatars
// One slot for the CURRENT bubble's agent avatar (claude-code, codex,
// gemini, opencode, antigravity), 40x40 PNGs committed under
// assets/agents/, re-registered only when the agent changes.
const avatar_image_id: u64 = 13;
const tail_image_id: u64 = 14;
const agent_icon_ids = [agent_hooks.agent_count]u64{ 9, 10, 11, 15 };
const agent_icon_px: usize = 40;
var agents_icons_ready: bool = false;
var agents_icons_dark: bool = false;

/// Agent logo bytes, compiled in. The runtime decodes them through the
/// platform codec (CGImageSource, gdk-pixbuf, WIC), so these need no
/// file lookup and no macOS-only `sips` shim — which also means they
/// cannot go missing from a bundle or resolve against the wrong cwd.
/// opencode ships light and dark glyphs; the rest read on both.
const AgentArt = struct { light: []const u8, dark: []const u8 };
const agent_art = [agent_hooks.agent_count]AgentArt{
    .{ .light = @embedFile("assets/agents/claude-code.png"), .dark = @embedFile("assets/agents/claude-code.png") },
    .{ .light = @embedFile("assets/agents/codex.png"), .dark = @embedFile("assets/agents/codex.png") },
    .{ .light = @embedFile("assets/agents/gemini.png"), .dark = @embedFile("assets/agents/gemini.png") },
    .{ .light = @embedFile("assets/agents/opencode-light.png"), .dark = @embedFile("assets/agents/opencode-dark.png") },
};
const agent_fallback_art: []const u8 = @embedFile("assets/agents/fallback.png");

/// Register the four settings agent logos, one registry slot each,
/// themed like the bubble avatar and refreshed on appearance flips.
fn loadAgentsAtlas(dark: bool, fx: *Effects) void {
    if (agents_icons_ready and agents_icons_dark == dark) return;
    for (agent_art, 0..) |art, cell| {
        _ = fx.registerImageBytes(agent_icon_ids[cell], if (dark) art.dark else art.light) catch continue;
    }
    agents_icons_dark = dark;
    agents_icons_ready = true;
}
const tail_w: usize = 18;
const tail_h: usize = 9;
var tail_dark: bool = false;
var tail_ready: bool = false;

/// Register the speech-bubble tail: a filled triangle pointing down,
/// generated in code and colored like the card for the active theme.
fn registerTail(dark: bool, fx: *Effects) void {
    if (tail_ready and tail_dark == dark) return;
    var pixels: [tail_w * tail_h * 4]u8 = @splat(0);
    const cr: u8 = if (dark) 25 else 255;
    const cg: u8 = if (dark) 25 else 255;
    const cb: u8 = if (dark) 28 else 255;
    for (0..tail_h) |y| {
        const inset = y;
        for (0..tail_w) |x| {
            if (x >= inset and x < tail_w - inset) {
                const i = (y * tail_w + x) * 4;
                pixels[i] = cr;
                pixels[i + 1] = cg;
                pixels[i + 2] = cb;
                pixels[i + 3] = 255;
                // The card carries a hairline in dark mode: the tail's
                // diagonal edges continue it so the join reads as one
                // outlined shape (the top row stays plain - it tucks
                // under the card).
                if (dark and y > 0 and (x == inset or x == tail_w - inset - 1)) {
                    pixels[i] = 48;
                    pixels[i + 1] = 48;
                    pixels[i + 2] = 53;
                }
            }
        }
    }
    fx.registerImage(tail_image_id, tail_w, tail_h, &pixels) catch return;
    tail_dark = dark;
    tail_ready = true;
}
var avatar_agent: [24]u8 = @splat(0);
var avatar_agent_len: usize = 0;
var avatar_ready: bool = false;
var avatar_theme_dark: bool = false;

/// The bubble names its agent at runtime (a hook payload), so the art
/// is looked up by name rather than by enum. An unknown name is the
/// normal case for an agent we do not ship a glyph for, not an error.
fn agentArtBytes(agent: []const u8, dark: bool) []const u8 {
    for (std.enums.values(agent_hooks.AgentKind)) |kind| {
        if (std.mem.eql(u8, kind.hookAgentName(), agent)) {
            const art = agent_art[@intFromEnum(kind)];
            return if (dark) art.dark else art.light;
        }
    }
    return agent_fallback_art;
}

fn loadAgentAvatar(agent: []const u8, dark: bool, fx: *Effects) void {
    if (avatar_ready and avatar_theme_dark == dark and std.mem.eql(u8, avatar_agent[0..avatar_agent_len], agent)) return;
    if (agent.len > avatar_agent.len) return;
    _ = fx.registerImageBytes(avatar_image_id, agentArtBytes(agent, dark)) catch return;
    @memcpy(avatar_agent[0..agent.len], agent);
    avatar_agent_len = agent.len;
    avatar_theme_dark = dark;
    avatar_ready = true;
}

// ------------------------------------------------------------- thumbnails
// One atlas texture for every catalog thumbnail: the image registry
// caps at 16 slots, so 28+ per-pet images can never each own one. A
// 32-cell strip of 48x52 nearest-scaled idle frames is ~320KB, well
// inside the 1MB slot bound, and rows draw their cell via image_src.
const thumb_w: usize = 48;
const thumb_h: usize = 52;
const thumb_atlas_id: u64 = 12;
var thumbs_pixels: []u8 = &.{};
var thumbs_ready: [max_catalog]bool = @splat(false);
var thumbs_built: usize = 0;

/// Decode one pet's sheet without touching the live global (the pet
/// keeps animating from its own frames). Same platform-codec path.
fn decodeSheetForThumb(fx: *Effects, entry: *const CatalogEntry) ?Sheet {
    return decodeSheet(fx, entry);
}

/// Build one thumbnail into the atlas and re-register it. Incremental:
/// the poll timer builds one per tick while settings is open, so the
/// pet never freezes behind a 28-conversion batch.
fn buildNextThumb(fx: *Effects) void {
    if (thumbs_built >= catalog_len) return;
    const index = thumbs_built;
    thumbs_built += 1;
    if (thumbs_pixels.len == 0) {
        thumbs_pixels = boot_allocator.alloc(u8, max_catalog * thumb_w * thumb_h * 4) catch return;
        @memset(thumbs_pixels, 0);
    }
    var decoded = decodeSheetForThumb(fx, &catalog[index]) orelse return;
    defer freeSheet(&decoded);
    const rows: usize = if (decoded.height * 1536 >= decoded.width * 2288) 11 else 9;
    const fw = decoded.width / cols;
    const fh = decoded.height / rows;
    const atlas_row_len = max_catalog * thumb_w * 4;
    for (0..thumb_h) |y| {
        const src_y = y * fh / thumb_h;
        for (0..thumb_w) |x| {
            const src_x = x * fw / thumb_w;
            const src_off = (src_y * decoded.width + src_x) * 4;
            const dst_off = y * atlas_row_len + (index * thumb_w + x) * 4;
            @memcpy(thumbs_pixels[dst_off..][0..4], decoded.pixels[src_off..][0..4]);
        }
    }
    thumbs_ready[index] = true;
    fx.registerImage(thumb_atlas_id, max_catalog * thumb_w, thumb_h, thumbs_pixels) catch {};
}

/// Boot-time resolve: scan the catalog and pick the initial pet
/// (PETDEX_PET env > persisted settings > first found). The sheet
/// decode itself waits for `boot`: `decodeImage` is a platform service
/// bound onto `fx` when the loop thread runs `init_fx`, and it is
/// loop-thread only, so main() has nothing to decode with yet.
fn resolveInitialPet(io: std.Io, allocator: std.mem.Allocator, environ_map: *std.process.Environ.Map) !void {
    _ = environ_map;
    scanCatalog(io, allocator);
    if (catalog_len == 0) return error.NoPetInstalled;

    var wanted: []const u8 = "";
    var settings_buf: [512]u8 = undefined;
    var path_buf: [512]u8 = undefined;
    if (env_wanted_pet) |w| {
        wanted = w;
    } else if (settingsPath(&path_buf)) |path| {
        if (cReadFile(path, &settings_buf)) |json| {
            if (hook_server.jsonStringPub(json, "active_pet")) |v| wanted = v;
            if (hook_server.jsonNumberPub(json, "scale")) |v| {
                if (v >= 0.3 and v <= 1.5) initial_scale = @floatCast(v);
            }
            if (hook_server.jsonStringPub(json, "bubbles")) |_| {} else if (std.mem.indexOf(u8, json, "\"bubbles\":false") != null) {
                initial_bubbles = false;
            }
            if (std.mem.indexOf(u8, json, "\"agents_prompted\":true") != null) {
                initial_agents_prompted = true;
            }
        }
    }
    var index: usize = 0;
    if (wanted.len > 0) {
        for (catalog[0..catalog_len], 0..) |*entry, i| {
            if (std.mem.eql(u8, entry.slice(), wanted)) index = i;
        }
    }
    initial_pet = @intCast(index);
    pet_display_name = catalog[index].slice();
}

/// Register the active state's frames into slots 1..count (replace in
/// place: the registry caps at 16 slots of 1MB, one 192x208 frame is
/// 160KB, and no state has more than 8 frames).
fn registerStateFrames(state: State, fx: *Effects) void {
    if (sheet.pixels.len == 0) return;
    const def = stateDef(state);
    const fw = sheet.width / cols;
    const fh = sheet.height / sheet.rows;
    var scratch = boot_allocator.alloc(u8, fw * fh * 4) catch return;
    defer boot_allocator.free(scratch);
    for (def.frames, 0..) |spec, i| {
        const src_x = spec.col * fw;
        const src_y = def.row * fh;
        for (0..fh) |y| {
            const src_off = ((src_y + y) * sheet.width + src_x) * 4;
            @memcpy(scratch[y * fw * 4 ..][0 .. fw * 4], sheet.pixels[src_off..][0 .. fw * 4]);
        }
        fx.registerImage(i + 1, fw, fh, scratch) catch |err| {
            std.debug.print("petdex: frame register failed ({s})\n", .{@errorName(err)});
            return;
        };
    }
}

const poll_timer_key: u64 = 2;
const poll_interval_ms: u32 = 100;
const min_dwell_ms: u32 = 250;

/// Transient states whose duration is intrinsic to the animation;
/// they revert to idle when their dwell expires and nothing is queued
/// (steady states persist until the hooks send the next event).
fn isDurationState(state: State) bool {
    return switch (state) {
        .waving, .failed, .review, .jumping => true,
        else => false,
    };
}

/// Port of state-queue.ts dwellFor.
fn dwellFor(state: State, duration_ms: u32) u32 {
    if (isDurationState(state) and duration_ms > 0) return @max(duration_ms, min_dwell_ms);
    if (duration_ms > min_dwell_ms) return duration_ms;
    return min_dwell_ms;
}

fn applyState(model: *Model, state: State, duration_ms: u32, fx: *Effects) void {
    model.state = state;
    model.frame_index = 0;
    model.shown_at_ms = fx.wallMs();
    model.shown_dwell_ms = dwellFor(state, duration_ms);
    registerStateFrames(state, fx);
    armFrameTimer(model, fx);
}

pub fn boot(model: *Model, fx: *Effects) void {
    if (env_home) |home| {
        hook_server.start(boot_allocator, home) catch |err| {
            std.debug.print("petdex: hook server failed to start ({s})\n", .{@errorName(err)});
        };
    }
    fx.startTimer(.{
        .key = poll_timer_key,
        .interval_ms = poll_interval_ms,
        .mode = .repeating,
        .on_fire = Effects.timerMsg(.poll_tick),
    });
    // Settings and agent state are independent of whether any sheet
    // decodes, so they land before the catalog work: a corrupt pet must
    // not cost the user their scale, their bubble preference, or the
    // Agents section.
    model.scale = initial_scale;
    model.bubbles_enabled = initial_bubbles;
    model.agents_prompted = initial_agents_prompted;
    if (env_home) |home| model.agents = agent_hooks.scan(boot_allocator, home);

    // First point where the platform codec is reachable: `init_fx` runs
    // on the loop thread right after the runtime binds services onto fx.
    if (catalog_len == 0) return;
    // A single unreadable sheet used to leave an empty window even with
    // a full catalog behind it (one shipped pet is a 3-byte stub), so
    // the chosen pet is a preference here, not a requirement.
    var chosen: ?usize = null;
    for (0..catalog_len) |offset| {
        const index = (initial_pet + offset) % catalog_len;
        if (loadSheetForPet(fx, &catalog[index])) {
            chosen = index;
            break;
        }
    }
    const active = chosen orelse {
        // Distinguish an empty catalog from a catalog the platform codec
        // cannot read: on Linux gdk-pixbuf needs a loader plugin per
        // format, and Ubuntu ships none for webp, so every pet decodes
        // to nothing while sitting right there on disk. Telling that
        // user to install a pet sends them in the wrong direction.
        if (builtin.os.tag == .linux) {
            std.debug.print("petdex: {d} pet(s) installed but none decoded; on Linux webp needs the gdk-pixbuf loader (apt install webp-pixbuf-loader)\n", .{catalog_len});
        } else {
            std.debug.print("petdex: {d} pet(s) installed but none decoded; the sheet may be corrupt\n", .{catalog_len});
        }
        return;
    };
    if (active != initial_pet) {
        std.debug.print("petdex: pet {s} failed to decode, fell back to {s}\n", .{ catalog[initial_pet].slice(), catalog[active].slice() });
    }
    model.active_pet = @intCast(active);
    // The name was resolved alongside the preferred pet, so a fallback
    // has to re-point it or the window would label the pet it could not
    // draw.
    pet_display_name = catalog[active].slice();
    registerStateFrames(model.state, fx);
    model.sheet_loaded = true;
    const n = @min(pet_display_name.len, model.pet_name.len);
    @memcpy(model.pet_name[0..n], pet_display_name[0..n]);
    model.pet_name_len = n;
    armFrameTimer(model, fx);
}

fn pushSample(model: *Model, x: f64, y: f64, now: i64) void {
    // Keep only samples inside the window, then append.
    var kept: usize = 0;
    for (model.samples[0..model.sample_len]) |sample| {
        if (now - sample.t_ms <= sample_window_ms) {
            model.samples[kept] = sample;
            kept += 1;
        }
    }
    if (kept == model.samples.len) {
        std.mem.copyForwards(PosSample, model.samples[0 .. kept - 1], model.samples[1..kept]);
        kept -= 1;
    }
    model.samples[kept] = .{ .x = x, .y = y, .t_ms = now };
    model.sample_len = kept + 1;
}

/// The old renderer's computeVelocity: last sample against the newest
/// one older than 16ms, in points per second.
fn releaseVelocity(model: *const Model) ?struct { x: f64, y: f64 } {
    if (model.sample_len < 2) return null;
    const last = model.samples[model.sample_len - 1];
    // Oldest sample in the window older than one tick, the old
    // renderer's anchor: velocity averages the whole 100ms gesture
    // tail instead of chasing the last two frames.
    var first: ?PosSample = null;
    for (model.samples[0..model.sample_len]) |sample| {
        if (last.t_ms - sample.t_ms > 16) {
            first = sample;
            break;
        }
    }
    const anchor = first orelse return null;
    const dt_sec = @as(f64, @floatFromInt(last.t_ms - anchor.t_ms)) / 1000.0;
    if (dt_sec <= 0) return null;
    return .{ .x = (last.x - anchor.x) / dt_sec, .y = (last.y - anchor.y) / dt_sec };
}

fn setThrowState(model: *Model, state: State, fx: *Effects) void {
    if (model.state == state) return;
    model.state = state;
    model.frame_index = 0;
    registerStateFrames(state, fx);
    armFrameTimer(model, fx);
}

pub fn update(model: *Model, msg: Msg, fx: *Effects) void {
    switch (msg) {
        .frame_tick => |timer| {
            if (timer.outcome != .fired) return;
            if (!model.sheet_loaded) return;
            const def = stateDef(model.state);
            model.frame_index = (model.frame_index + 1) % def.frames.len;
            armFrameTimer(model, fx);
        },
        .cycle_state => {
            applyState(model, model.state.next(), 0, fx);
        },
        .toggle_pets_expanded => model.pets_expanded = !model.pets_expanded,
        .pet_filter => |edit| {
            switch (edit) {
                .insert_text => |txt| {
                    const room = model.pet_filter.len - model.pet_filter_len;
                    const n = @min(txt.len, room);
                    @memcpy(model.pet_filter[model.pet_filter_len..][0..n], txt[0..n]);
                    model.pet_filter_len += n;
                },
                .delete_backward, .delete_word_backward => {
                    while (model.pet_filter_len > 0) {
                        model.pet_filter_len -= 1;
                        if ((model.pet_filter[model.pet_filter_len] & 0xC0) != 0x80) break;
                    }
                },
                .clear => model.pet_filter_len = 0,
                else => {},
            }
        },
        .uninstall_agent => |index| {
            if (index >= agent_hooks.agent_count) return;
            const home = env_home orelse return;
            _ = agent_hooks.uninstall(boot_allocator, home, model.agents[index].kind);
            if (model.agents[index].kind == .codex) model.codex_trust_note = false;
            model.agents = agent_hooks.scan(boot_allocator, home);
        },
        .install_agent => |index| {
            if (index >= agent_hooks.agent_count) return;
            const kind = model.agents[index].kind;
            const home = env_home orelse return;
            const ok = switch (kind) {
                .claude_code => agent_hooks.installClaude(boot_allocator, home),
                .codex => agent_hooks.installCodex(boot_allocator, home),
                .gemini => agent_hooks.installGemini(boot_allocator, home),
                .opencode => agent_hooks.installOpencode(boot_allocator, home),
            };
            if (ok and kind == .codex) model.codex_trust_note = true;
            model.agents = agent_hooks.scan(boot_allocator, home);
        },
        .open_settings => {
            if (env_home) |home| model.agents = agent_hooks.scan(boot_allocator, home);
            loadAgentsAtlas(model.dark, fx);
            if (model.settings_open) {
                // Already open, likely buried behind other windows:
                // raise it instead of rebuilding an identical
                // descriptor (a no-op).
                fx.focusWindow(settings_window_label);
                return;
            }
            model.settings_open = true;
        },
        .settings_closed => model.settings_open = false,
        .close_pet => fx.closeWindow("main"),
        .select_pet => |index| {
            if (index >= catalog_len or index == model.active_pet) return;
            if (!loadSheetForPet(fx, &catalog[index])) return;
            model.active_pet = index;
            model.frame_index = 0;
            registerStateFrames(model.state, fx);
            armFrameTimer(model, fx);
            saveSettings(model);
        },
        .toggle_bubbles => {
            model.bubbles_enabled = !model.bubbles_enabled;
            saveSettings(model);
        },
        .set_scale => |fraction| {
            model.scale = 0.4 + fraction * 0.8;
            _ = fitWindow(model, fx);
            saveSettings(model);
        },
        .open_pet_page => |index| {
            if (index >= catalog_len) return;
            var buf: [256]u8 = undefined;
            const url = std.fmt.bufPrint(&buf, "https://petdex.dev/pets/{s}", .{catalog[index].slice()}) catch return;
            plat.openExternal(url);
        },
        .appearance => |a| {
            model.dark = a.color_scheme == .dark;
            if (model.bubble.text_len > 0) {
                registerTail(model.dark, fx);
                loadAgentAvatar(model.bubble.agent[0..model.bubble.agent_len], model.dark, fx);
            }
            if (model.settings_open) loadAgentsAtlas(model.dark, fx);
            model.high_contrast = a.high_contrast;
            model.reduce_motion = a.reduce_motion;
        },
        .noop => {},
        .open_pets_folder => {
            if (env_home) |home| {
                var buf: [512]u8 = undefined;
                const dir = std.fmt.bufPrint(&buf, "{s}/.petdex/pets", .{home}) catch return;
                plat.openExternal(dir);
            }
        },
        .frame_clock => {
            if (!model.sheet_loaded) return;
            if (!model.window_fitted) {
                // First-run onboarding: open settings ONCE when no
                // agent carries petdex hooks. Installing one - or just
                // closing the window - both mean never auto-opening
                // again (agents_prompted persists).
                if (!model.agents_prompted) {
                    var any_hooked = false;
                    for (model.agents) |info| {
                        if (info.status == .node or info.status == .current) any_hooked = true;
                    }
                    if (!any_hooked) model.settings_open = true;
                    model.agents_prompted = true;
                    saveSettings(model);
                }
                // The shell window boots at the slider's max extent;
                // fit it to the drawn sprite so the whole window IS the
                // pet — no invisible band above it eating clicks.
                model.window_fitted = fitWindow(model, fx);
            }
            const now = fx.wallMs();
            if (model.throwing) {
                // Momentum rides the frame clock with the real elapsed
                // time: no timer jitter, friction scaled per frame.
                var dt_ms = now - model.last_physics_ms;
                if (dt_ms <= 0) return;
                if (dt_ms > 50) dt_ms = 50;
                model.last_physics_ms = now;
                model.throw_elapsed_ms += @intCast(dt_ms);
                const dt: f64 = @as(f64, @floatFromInt(dt_ms)) / 1000.0;
                const moved = fx.moveWindow("main", model.vx * dt, model.vy * dt, true);
                if (moved) |result| {
                    if (result.hit_x) model.vx = 0;
                    if (result.hit_y) model.vy = 0;
                    model.pet_x = result.x;
                    model.pet_y = result.y;
                }
                syncBubbleWindow(model, fx);
                if (model.vx >= physics_min_vel) {
                    setThrowState(model, .@"running-right", fx);
                } else if (model.vx <= -physics_min_vel) {
                    setThrowState(model, .@"running-left", fx);
                }
                const decay = std.math.pow(f64, physics_friction, dt * 1000.0 / @as(f64, physics_tick_ms));
                model.vx *= decay;
                model.vy *= decay;
                const speed = @sqrt(model.vx * model.vx + model.vy * model.vy);
                if (model.throw_elapsed_ms >= physics_max_duration_ms or speed < physics_min_vel) {
                    model.throwing = false;
                    applyState(model, .waving, 1200, fx);
                }
                return;
            }
            const read = fx.moveWindow("main", 0, 0, false) orelse return;
            model.pet_x = read.x;
            model.pet_y = read.y;
            syncBubbleWindow(model, fx);
            if (model.dragging) {
                if (read.primary_down) {
                    // Follow the cursor keeping the grab offset, and
                    // record OUR OWN applied positions: the app drives
                    // the drag, so it has perfect knowledge of the
                    // gesture, no host telemetry involved.
                    const dx = (read.cursor_x - model.grab_dx) - read.x;
                    const dy = (read.cursor_y - model.grab_dy) - read.y;
                    if (dx != 0 or dy != 0) {
                        if (fx.moveWindow("main", dx, dy, false)) |moved| {
                            pushSample(model, moved.x, moved.y, now);
                        }
                    } else {
                        pushSample(model, read.x, read.y, now);
                    }
                    // Mid-drag animation: the pet runs toward where it
                    // is being pulled, from the same 100ms velocity
                    // tail the release uses (per-frame dx flaps).
                    if (releaseVelocity(model)) |vel| {
                        if (vel.x >= physics_min_vel) {
                            setThrowState(model, .@"running-right", fx);
                        } else if (vel.x <= -physics_min_vel) {
                            setThrowState(model, .@"running-left", fx);
                        } else if (@abs(vel.x) < 20 and @abs(vel.y) < 20) {
                            setThrowState(model, .idle, fx);
                        }
                    }
                    return;
                }
                // Release: velocity from our own 100ms sample tail,
                // the WebView renderer's computeVelocity semantics.
                model.dragging = false;
                const velocity = releaseVelocity(model) orelse {
                    model.sample_len = 0;
                    return;
                };
                model.sample_len = 0;
                if (@abs(velocity.x) < 1 and @abs(velocity.y) < 1) return;
                model.throwing = true;
                model.vx = velocity.x;
                model.vy = velocity.y;
                model.throw_elapsed_ms = 0;
                model.last_physics_ms = now;
                return;
            }
            const pet_w = frame_w * model.scale;
            const pet_h = frame_h * model.scale;
            // The window is fitted to the sprite, so the pet rect IS
            // the window rect.
            const inside = read.cursor_x >= read.x and read.cursor_x <= read.x + pet_w and
                read.cursor_y >= read.y and read.cursor_y <= read.y + pet_h;
            if (read.primary_down and !model.primary_was_down and inside) {
                model.dragging = true;
                model.grab_dx = read.cursor_x - read.x;
                model.grab_dy = read.cursor_y - read.y;
                model.sample_len = 0;
                pushSample(model, read.x, read.y, now);
            }
            model.primary_was_down = read.primary_down;
        },
        .physics_tick => |timer| {
            _ = timer;
        },
        .poll_tick => |timer| {
            if (timer.outcome != .fired) return;
            if (!model.sheet_loaded) return;
            if (model.settings_open and thumbs_built < catalog_len) buildNextThumb(fx);
            if (hook_server.mailbox.takeBubble(&model.bubble)) {
                if (model.bubble.text_len > 0) {
                    loadAgentAvatar(model.bubble.agent[0..model.bubble.agent_len], model.dark, fx);
                    registerTail(model.dark, fx);
                }
            }
            const now = fx.wallMs();
            const dwell_over = now - model.shown_at_ms >= model.shown_dwell_ms;
            if (!dwell_over) return;
            if (hook_server.mailbox.pop()) |event| {
                const next_state = std.meta.stringToEnum(State, event.slice()) orelse return;
                if (next_state != model.state or isDurationState(next_state)) {
                    applyState(model, next_state, event.duration_ms, fx);
                } else {
                    model.shown_at_ms = now;
                    model.shown_dwell_ms = dwellFor(next_state, event.duration_ms);
                }
            } else if (isDurationState(model.state)) {
                applyState(model, .idle, 0, fx);
            }
        },
    }
}

pub fn onKey(keyboard: canvas.WidgetKeyboardEvent) ?Msg {
    if (keyboard.modifiers.hasNavigationModifier() or keyboard.modifiers.shift) return null;
    if (std.ascii.eqlIgnoreCase(keyboard.key, "space")) return .cycle_state;
    return null;
}

pub fn onFrame(model: *const Model, frame: native_sdk.platform.GpuFrame) ?Msg {
    _ = model;
    _ = frame;
    return .frame_clock;
}

pub fn onCommand(name: []const u8) ?Msg {
    if (std.mem.eql(u8, name, "petdex.cycle")) return .cycle_state;
    if (std.mem.eql(u8, name, "petdex.settings")) return .open_settings;
    if (std.mem.eql(u8, name, "petdex.close")) return .close_pet;
    return null;
}

// ------------------------------------------------------------------- view

pub const AppUi = canvas.Ui(Msg);



const pet_menu = [_]AppUi.ContextMenuItem{
    .{ .label = "Open Settings", .msg = .open_settings },
    .{ .label = "Close Pet", .msg = .close_pet },
};

// The bubble lives in its OWN fixed-size window: floating,
// transparent, click-through. Nothing is estimated — the window is a
// constant, the card inside is intrinsic, and the surplus space is
// crossable by clicks, so a misfit costs nothing anywhere.
const bubble_window_w: f32 = 340;
const bubble_window_h: f32 = 150;
const bubble_text_w: f32 = 250;
const bubble_chars_per_line: usize = 26;
const bubble_max_lines: usize = 2;
const bubble_display_chars: usize = bubble_chars_per_line * bubble_max_lines;
const bubble_card_pad: f32 = 12;

/// Count display characters (UTF-8 sequences, not bytes).
fn charCount(text: []const u8) usize {
    var n: usize = 0;
    for (text) |b| {
        if ((b & 0xC0) != 0x80) n += 1;
    }
    return n;
}

var bubble_title_scratch: [280]u8 = undefined;
var bubble_text_scratch: [280]u8 = undefined;

/// Clip to `max_chars` on a safe boundary: never mid UTF-8 sequence,
/// never splitting a JSON escape, preferring the last word boundary
/// within reach, with an ellipsis appended into `scratch` (globals:
/// the view's byte slices must outlive the frame build).
fn clipDisplay(text: []const u8, max_chars: usize, scratch: []u8) []const u8 {
    if (charCount(text) <= max_chars) return text;
    var n: usize = 0;
    var cut: usize = text.len;
    for (text, 0..) |b, i| {
        if ((b & 0xC0) != 0x80) {
            if (n == max_chars) {
                cut = i;
                break;
            }
            n += 1;
        }
    }
    if (std.mem.lastIndexOfScalar(u8, text[0..cut], ' ')) |sp| {
        if (cut - sp <= 10) cut = sp;
    }
    var backslashes: usize = 0;
    while (cut > backslashes and text[cut - 1 - backslashes] == '\\') backslashes += 1;
    if (backslashes % 2 == 1) cut -= 1;
    const ell = "\u{2026}";
    const total = @min(cut, scratch.len - ell.len);
    @memcpy(scratch[0..total], text[0..total]);
    @memcpy(scratch[total .. total + ell.len], ell);
    return scratch[0 .. total + ell.len];
}

/// Split into at most two explicit lines at a word boundary near the
/// char budget. Each line renders as an HONEST single-line node, so
/// measure equals paint by construction — no engine wrap involved,
/// nothing to under-measure, nothing to clip.
fn splitLines(text: []const u8, max_chars: usize) [2][]const u8 {
    if (charCount(text) <= max_chars) return .{ text, "" };
    var n: usize = 0;
    var hard_cut: usize = text.len;
    for (text, 0..) |b, i| {
        if ((b & 0xC0) != 0x80) {
            if (n == max_chars) {
                hard_cut = i;
                break;
            }
            n += 1;
        }
    }
    var cut = hard_cut;
    if (std.mem.lastIndexOfScalar(u8, text[0..hard_cut], ' ')) |sp| {
        if (hard_cut - sp <= 14) cut = sp;
    }
    const first = std.mem.trim(u8, text[0..cut], " ");
    const second = std.mem.trim(u8, text[cut..], " ");
    return .{ first, second };
}
const tail_h_f: f32 = 9;

fn bubbleActive(model: *const Model) bool {
    return model.bubbles_enabled and model.bubble.text_len > 0;
}

/// The window tracks exactly what is drawn: the sprite, plus a band
/// above it while a bubble is showing (kept at least bubble-wide so
/// the text can wrap like the old 190px-capped tooltip).
fn fitWindow(model: *const Model, fx: *Effects) bool {
    return fx.resizeWindow("main", frame_w * model.scale, frame_h * model.scale, .bottom_center);
}

/// Keep the bubble window glued above the pet: read both origins and
/// close the gap. Self-correcting, so drags, throws, and scale changes
/// all need no special-casing.
fn syncBubbleWindow(model: *const Model, fx: *Effects) void {
    if (!bubbleActive(model)) return;
    const cur = fx.moveWindow("bubble", 0, 0, false) orelse return;
    const pet_w = frame_w * model.scale;
    const want_x = model.pet_x + pet_w / 2.0 - bubble_window_w / 2.0;
    const want_y = model.pet_y - bubble_window_h + 2.0;
    const dx = want_x - cur.x;
    const dy = want_y - cur.y;
    if (@abs(dx) > 0.5 or @abs(dy) > 0.5) {
        _ = fx.moveWindow("bubble", dx, dy, false);
    }
}

pub fn rootView(ui: *AppUi, model: *const Model) AppUi.Node {
    if (!model.sheet_loaded) {
        return ui.panel(.{ .width = frame_w, .height = frame_h, .semantics = .{ .label = "No pet installed" } }, .{});
    }
    const w = frame_w * model.scale;
    const h = frame_h * model.scale;
    var node = ui.image(.{
        .width = w,
        .height = h,
        .image = @intCast(model.frame_index + 1),
        .semantics = .{ .label = "Petdex pet" },
    });
    node.widget.image_fit = .stretch;
    node.widget.image_sampling = .nearest;
    // Bottom-center anchored: a smaller pet still stands on the same
    // ground line instead of floating at the window's top-left. The
    // context menu rides the root container: the image widget is
    // display-only for hit testing, the column owns the right-click.
    // on_press makes the container a press claimer so the right-click
    // fall-through resolves here and the context menu shows; the drag
    // never rides widget presses (cursor polling), so a claimed press
    // costs nothing.
    return ui.column(.{ .grow = 1, .main = .end, .cross = .center, .on_press = .noop, .context_menu = &pet_menu }, .{node});
}

// ----------------------------------------------------------- bubble window

fn bubbleView(ui: *AppUi, model: *const Model) AppUi.Node {
    const title_raw = model.bubble.title[0..model.bubble.title_len];
    const text_raw = model.bubble.text[0..model.bubble.text_len];
    const title_clipped = clipDisplay(title_raw, bubble_display_chars, &bubble_title_scratch);
    const text_clipped = clipDisplay(text_raw, bubble_display_chars, &bubble_text_scratch);
    const title_lines = splitLines(title_clipped, bubble_chars_per_line);
    const text_lines = splitLines(text_clipped, bubble_chars_per_line + 2);

    const title_fg = if (model.dark) canvas.Color.rgb8(237, 237, 238) else canvas.Color.rgb8(17, 17, 17);
    const muted_fg = if (model.dark) canvas.Color.rgb8(156, 158, 168) else canvas.Color.rgb8(88, 92, 106);
    const text_fg = if (title_clipped.len > 0) muted_fg else title_fg;

    // Up to four honest single-line nodes; empty lines render nothing.
    var rows: [4]AppUi.Node = undefined;
    var row_count: usize = 0;
    for (title_lines) |line| {
        if (line.len == 0) continue;
        var node2 = ui.paragraph(.{ .size = .sm }, &.{.{ .text = line, .weight = .bold }});
        node2.widget.style.foreground = title_fg;
        rows[row_count] = node2;
        row_count += 1;
    }
    for (text_lines) |line| {
        if (line.len == 0) continue;
        var node2 = ui.text(.{ .size = .sm }, line);
        node2.widget.style.foreground = text_fg;
        rows[row_count] = node2;
        row_count += 1;
    }

    var avatar = ui.image(.{
        .width = 20,
        .height = 20,
        .image = if (avatar_ready) avatar_image_id else 0,
        .semantics = .{ .label = "Agent avatar" },
    });
    avatar.widget.image_fit = .contain;
    const spinner_slot = if (model.bubble.busy)
        ui.el(.spinner, .{ .width = 16, .height = 16, .semantics = .{ .label = "Working" } }, .{})
    else
        ui.el(.stack, .{ .width = 16, .height = 16 }, .{});

    var card = ui.el(.panel, .{
        .padding = bubble_card_pad,
    }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            avatar,
            ui.column(.{ .gap = 2, .cross = .start }, @as([]const AppUi.Node, rows[0..row_count])),
            spinner_slot,
        }),
    });
    card.widget.style.radius = 18;
    if (model.dark) {
        card.widget.style.background = canvas.Color.rgb8(25, 25, 28);
        card.widget.style.border = canvas.Color.rgba8(255, 255, 255, 26);
        card.widget.style.stroke_width = 1;
    } else {
        card.widget.style.background = canvas.Color.rgb8(255, 255, 255);
    }
    var tail = ui.image(.{
        .width = tail_w,
        .height = tail_h,
        .image = if (tail_ready) tail_image_id else 0,
    });
    tail.widget.image_fit = .contain;
    // Pure translation (no rotation, so no canvas-origin surprises):
    // the tail rides up over the card's bottom hairline, hiding the
    // border segment behind it so bubble and arrow read as one shape.
    tail.widget.transform = canvas.Affine.translate(0, -1.5);
    return ui.column(.{ .grow = 1, .main = .end, .cross = .center }, .{ card, tail });
}

// --------------------------------------------------------- settings window

const settings_window_label = "settings";
const settings_canvas_label = "settings-canvas";

fn petdexWindows(model: *const Model, scratch: *PetdexApp.WindowsScratch) []const PetdexApp.WindowDescriptor {
    var count: usize = 0;
    if (bubbleActive(model)) {
        scratch.windows[count] = .{
            .label = "bubble",
            .canvas_label = "bubble-canvas",
            .title = "",
            .width = bubble_window_w,
            .height = bubble_window_h,
            .x = @floatCast(model.pet_x + (frame_w * model.scale) / 2.0 - bubble_window_w / 2.0),
            .y = @floatCast(model.pet_y - bubble_window_h + 2.0),
            .resizable = false,
            .titlebar = .chromeless,
            .floating = true,
            .transparent = true,
            .click_through = true,
        };
        count += 1;
    }
    if (model.settings_open) {
        scratch.windows[count] = .{
            .label = settings_window_label,
            .canvas_label = settings_canvas_label,
            .title = "Petdex Settings",
            .width = 420,
            .height = 680,
            .resizable = false,
            .on_close = .settings_closed,
        };
        count += 1;
    }
    return scratch.windows[0..count];
}

fn petdexWindowView(ui: *PetdexApp.Ui, model: *const Model, window_label: []const u8) PetdexApp.Ui.Node {
    if (std.mem.eql(u8, window_label, "bubble")) return bubbleView(ui, model);
    std.debug.assert(std.mem.eql(u8, window_label, settings_window_label));
    return settingsView(ui, model);
}

fn agentStatusCaption(info: agent_hooks.AgentInfo, codex_note: bool) []const u8 {
    if (info.kind == .codex and codex_note) return "Installed - restart Codex and approve its hooks once";
    if (info.kind == .opencode) {
        return switch (info.status) {
            .absent => "Not detected",
            .none => "Plugin not installed",
            .node => "Plugin outdated",
            .current => "Connected",
        };
    }
    return switch (info.status) {
        .absent => "Not detected",
        .none => "Hooks not installed",
        .node => "Hooks outdated (CLI runner)",
        .current => "Connected",
    };
}

fn agentsSection(ui: *AppUi, model: *const Model) AppUi.Node {
    var rows: [agent_hooks.agent_count]AppUi.Node = undefined;
    var count: usize = 0;
    for (model.agents, 0..) |info, i| {
        if (info.status == .absent) continue;
        const trailing = if (info.status == .current)
            ui.button(.{
                .size = .sm,
                .variant = .secondary,
                .on_press = Msg{ .uninstall_agent = @intCast(i) },
            }, "Disconnect")
        else
            ui.button(.{
                .size = .sm,
                .variant = .primary,
                .on_press = Msg{ .install_agent = @intCast(i) },
            }, if (info.status == .node) "Update" else "Install");
        var logo = ui.image(.{
            .width = 24,
            .height = 24,
            .image = if (agents_icons_ready) agent_icon_ids[@intFromEnum(info.kind)] else 0,
            .semantics = .{ .label = info.kind.displayName() },
        });
        logo.widget.image_fit = .contain;
        rows[count] = ui.el(.panel, .{
            .padding = 12,
            .gap = 12,
            .cross = .center,
            .style_tokens = .{ .background = .surface, .radius = .md },
            .semantics = .{ .label = info.kind.displayName() },
        }, .{
            ui.row(.{ .gap = 12, .cross = .center }, .{
            logo,
            ui.column(.{ .grow = 1, .main = .center }, .{
                ui.text(.{}, info.kind.displayName()),
                ui.text(.{ .size = .sm, .style_tokens = .{ .foreground = .text_muted } }, agentStatusCaption(info, model.codex_trust_note)),
            }),
            trailing,
            }),
        });
        count += 1;
    }
    if (count == 0) {
        return ui.el(.panel, .{ .padding = 12, .style_tokens = .{ .background = .surface, .radius = .md } }, .{
            ui.text(.{ .size = .sm, .style_tokens = .{ .foreground = .text_muted } }, "No coding agents detected on this machine"),
        });
    }
    return ui.column(.{ .gap = 12 }, @as([]const AppUi.Node, rows[0..count]));
}

var more_label_buf: [48]u8 = undefined;

fn moreLabel(total: usize) []const u8 {
    return std.fmt.bufPrint(&more_label_buf, "Show all ({d})", .{total}) catch "Show all";
}

fn petMatchesFilter(name: []const u8, filter: []const u8) bool {
    if (filter.len == 0) return true;
    if (name.len < filter.len) return false;
    var i: usize = 0;
    while (i + filter.len <= name.len) : (i += 1) {
        var match = true;
        for (filter, 0..) |c, j| {
            if (std.ascii.toLower(name[i + j]) != std.ascii.toLower(c)) {
                match = false;
                break;
            }
        }
        if (match) return true;
    }
    return false;
}

fn settingsView(ui: *AppUi, model: *const Model) AppUi.Node {
    var rows: [max_catalog]AppUi.Node = undefined;
    var shown: usize = 0;
    var matches: usize = 0;
    const max_visible: usize = if (model.pets_expanded) max_catalog else 6;
    const filter = model.pet_filter[0..model.pet_filter_len];
    for (catalog[0..@min(catalog_len, max_catalog)], 0..) |*entry, i| {
        if (!petMatchesFilter(entry.slice(), filter)) continue;
        matches += 1;
        if (shown >= max_visible) continue;
        const active = i == model.active_pet;
        var thumb = ui.image(.{
            .width = 40,
            .height = 44,
            .image = if (thumbs_ready[i]) thumb_atlas_id else 0,
            .semantics = .{ .label = entry.slice() },
        });
        thumb.widget.image_src = geometry.RectF.init(
            @as(f32, @floatFromInt(i * thumb_w)),
            0,
            @as(f32, @floatFromInt(thumb_w)),
            @as(f32, @floatFromInt(thumb_h)),
        );
        thumb.widget.image_fit = .contain;
        thumb.widget.image_sampling = .nearest;
        rows[shown] = ui.el(.list_item, .{
            .height = 56,
            .padding = 8,
            .gap = 12,
            .cross = .center,
            .on_press = Msg{ .select_pet = @intCast(i) },
            .selected = active,
            .style_tokens = .{ .background = .surface, .radius = .md },
            .semantics = .{ .label = entry.slice() },
        }, .{
            thumb,
            ui.column(.{ .grow = 1, .main = .center }, .{
                ui.text(.{}, entry.slice()),
                ui.text(.{ .size = .sm, .style_tokens = .{ .foreground = .text_muted } }, entry.rootSlice()),
            }),
            if (active)
                ui.button(.{ .size = .sm, .width = 64, .variant = .primary, .disabled = true }, "Active")
            else
                ui.button(.{ .size = .sm, .width = 64, .variant = .primary, .on_press = Msg{ .select_pet = @intCast(i) } }, "Select"),
            ui.button(.{ .size = .sm, .variant = .secondary, .on_press = Msg{ .open_pet_page = @intCast(i) } }, "Open"),
        });
        shown += 1;
    }
    const scale_fraction: f32 = (model.scale - 0.4) / 0.8;
    // One scrollable page: the root scroll takes the window frame and
    // everything - full pet catalog included - flows inside it. No
    // more per-section band budgets.
    return ui.scroll(.{ .grow = 1 }, .{ui.column(.{ .padding = 16, .gap = 12 }, .{
        ui.text(.{ .size = .lg }, "Pets"),
        ui.el(.search_field, .{
            .height = 34,
            .text = filter,
            .on_input = AppUi.inputMsg(.pet_filter),
            .placeholder = "Search pets",
            .semantics = .{ .label = "Search pets" },
        }, .{}),
        // Search-first catalog: six rows collapsed, the whole catalog
        // expanded - the page itself scrolls, so no nested scroll and
        // the extent stays exact.
        ui.column(.{ .gap = 6 }, @as([]const AppUi.Node, rows[0..shown])),
        if (matches > shown)
            ui.button(.{ .size = .sm, .variant = .secondary, .on_press = .toggle_pets_expanded }, moreLabel(matches))
        else if (model.pets_expanded and matches > 6)
            ui.button(.{ .size = .sm, .variant = .secondary, .on_press = .toggle_pets_expanded }, "Show less")
        else if (matches == 0)
            ui.text(.{ .size = .sm, .style_tokens = .{ .foreground = .text_muted } }, "No pets match your search")
        else
            ui.el(.stack, .{}, .{}),
        ui.el(.stack, .{ .height = 10 }, .{}),
        ui.text(.{ .size = .lg }, "Agents"),
        agentsSection(ui, model),
        ui.el(.stack, .{ .height = 10 }, .{}),
        ui.text(.{ .size = .lg }, "Appearance"),
        ui.el(.panel, .{ .style_tokens = .{ .background = .surface, .radius = .md } }, .{
            ui.row(.{ .padding = 12, .cross = .center, .gap = 12 }, .{
                ui.column(.{ .grow = 1 }, .{
                    ui.text(.{}, "Pet size"),
                    ui.text(.{ .size = .sm, .style_tokens = .{ .foreground = .text_muted } }, "Adjust the size of your pet"),
                }),
                ui.el(.slider, .{ .width = 150, .value = scale_fraction, .on_value = AppUi.valueMsg(.set_scale), .semantics = .{ .label = "Pet size" } }, .{}),
            }),
        }),
        ui.el(.panel, .{ .style_tokens = .{ .background = .surface, .radius = .md } }, .{
            ui.row(.{ .padding = 12, .cross = .center, .gap = 12 }, .{
                ui.column(.{ .grow = 1 }, .{
                    ui.text(.{}, "Show messages"),
                    ui.text(.{ .size = .sm, .style_tokens = .{ .foreground = .text_muted } }, "Agent activity bubbles over the pet"),
                }),
                ui.el(.switch_control, .{
                    .selected = model.bubbles_enabled,
                    .on_toggle = .toggle_bubbles,
                    .semantics = .{ .label = "Show messages" },
                }, .{}),
            }),
        }),
        ui.el(.panel, .{ .style_tokens = .{ .background = .surface, .radius = .md } }, .{
            ui.row(.{ .padding = 12, .cross = .center, .gap = 12 }, .{
                ui.column(.{ .grow = 1 }, .{
                    ui.text(.{}, "Custom pets"),
                    ui.text(.{ .size = .sm, .style_tokens = .{ .foreground = .text_muted } }, "~/.petdex/pets"),
                }),
                ui.button(.{ .on_press = .open_pets_folder }, "Open folder"),
            }),
        }),
        // Trailing spacer: the column's own bottom padding is not part
        // of the scroll extent, so the last card needs explicit air.
        ui.el(.stack, .{ .height = 8 }, .{}),
    })});
}

/// Keep `~/.petdex/bin/petdex-hook` pointing at the running binary so
/// agent hooks survive app updates: the hooks reference the stable
/// symlink, the app re-aims it every boot.
fn refreshHookSymlink(argv0: []const u8) void {
    _ = argv0;
    const home = env_home orelse return;
    var self_buf: [1024]u8 = undefined;
    const rp = plat.executablePath(&self_buf) orelse return;
    var dir_buf: [512]u8 = undefined;
    const bin = std.fmt.bufPrint(&dir_buf, "{s}/.petdex/bin", .{home}) catch return;
    plat.makeDir(bin);
    var link_buf: [512]u8 = undefined;
    const link = std.fmt.bufPrint(&link_buf, "{s}/.petdex/bin/petdex-hook", .{home}) catch return;
    _ = plat.replaceSymlink(rp, link);
}

// -------------------------------------------------------------------- app

const app_menus = [_]native_sdk.platform.Menu{.{
    .title = "Pet",
    .items = &.{
        .{ .label = "Settings...", .command = "petdex.settings", .key = ",", .modifiers = .{ .primary = true } },
        .{ .separator = true },
        .{ .label = "Close Pet", .command = "petdex.close", .key = "w", .modifiers = .{ .primary = true } },
    },
}};

const PetdexApp = native_sdk.UiApp(Model, Msg);

pub fn main(init: std.process.Init) !void {
    // Windows has no HOME. Everything the app keeps per-user hangs off
    // this one lookup (the pet catalog, ~/.petdex/runtime, the settings
    // file), so reading only HOME made a Windows build behave like a
    // machine with nothing installed even with pets sitting in
    // %USERPROFILE%\.petdex\pets. HOME still wins where it exists, so a
    // POSIX user pointing it elsewhere keeps that.
    env_home = init.environ_map.get("HOME") orelse init.environ_map.get("USERPROFILE");
    // Claude Code reads its config from CLAUDE_CONFIG_DIR when set;
    // hooks written to the default ~/.claude would never be seen.
    agent_hooks.claude_config_dir = init.environ_map.get("CLAUDE_CONFIG_DIR");
    // Hook hot path: `<binary> bubble <phase> [agent]` runs the
    // in-binary runner and exits before any UI machinery spins up.
    // initAllocator, not init: on Windows the command line arrives as
    // one UTF-16 string that has to be split and transcoded, so the
    // iterator needs an allocator there. It is a no-op elsewhere.
    var args_it = std.process.Args.Iterator.initAllocator(init.minimal.args, boot_allocator) catch return;
    defer args_it.deinit();
    const argv0: ?[]const u8 = args_it.next();
    if (args_it.next()) |cmd| {
        if (std.mem.eql(u8, cmd, "bubble")) {
            const phase = args_it.next() orelse return;
            const agent: ?[]const u8 = args_it.next();
            hook_runner.run(phase, agent, env_home orelse return);
            return;
        }
    }
    if (argv0) |a0| refreshHookSymlink(a0);
    env_wanted_pet = init.environ_map.get("PETDEX_PET");
    boot_io = init.io;
    resolveInitialPet(init.io, boot_allocator, init.environ_map) catch |err| {
        std.debug.print("petdex: no pet found ({s}); install one with `petdex install <pet>`\n", .{@errorName(err)});
    };
    const app_state = try PetdexApp.create(std.heap.page_allocator, .{
        .name = "petdex-desktop-native",
        .scene = shell_scene,
        .canvas_label = canvas_label,
        .update_fx = update,
        .init_fx = boot,
        .view = rootView,
        .on_key = onKey,
        .on_command = onCommand,
        .on_frame = onFrame,
        .windows_fn = petdexWindows,
        .window_view = petdexWindowView,
        .tokens_fn = petdexTokens,
        .on_appearance = onAppearance,
    });
    defer app_state.destroy();
    app_state.model = .{};

    try runner.runWithOptions(app_state.app(), .{
        .app_name = "petdex-desktop-native",
        .window_title = "Petdex",
        .bundle_id = "dev.petdex.desktop-native",
        .icon_path = "assets/icon.png",
        .default_frame = geometry.RectF.init(0, 0, win_w, win_h),
        .restore_state = false,
        .js_window_api = false,
        .menus = &app_menus,
        .security = .{
            .permissions = &app_permissions,
            .navigation = .{ .allowed_origins = &.{ "zero://inline", "zero://app" } },
        },
    }, init);
}
