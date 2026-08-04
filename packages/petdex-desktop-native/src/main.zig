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
const installer = @import("installer.zig");

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
/// What a first run offers to download. Small, friendly, and already in
/// the public catalog, so the empty state resolves through the ordinary
/// install path rather than shipping ~2MB of sprite sheet inside every
/// binary on every platform.
const default_pet_slug = "boba";

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

// Sprite tables live in sprite.zig (#613). Re-exported so the many
// `State` and `stateDef` references below read unchanged.
const sprite = @import("sprite.zig");
pub const State = sprite.State;
const FrameSpec = sprite.FrameSpec;
const StateDef = sprite.StateDef;
const stateDef = sprite.stateDef;

// ------------------------------------------------------------------ model

pub const Msg = union(enum) {
    frame_tick: native_sdk.EffectTimer,
    poll_tick: native_sdk.EffectTimer,
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
    toggle_waiting_sound,
    chime_done: native_sdk.EffectExit,
    set_bubble_text_size: f32,
    bubble_lifetime_input: canvas.TextInputEvent,
    bubble_columns_input: canvas.TextInputEvent,
    bubble_answer_lines_input: canvas.TextInputEvent,
    font_path_input: canvas.TextInputEvent,
    toggle_hide_dock,
    toggle_launch_at_login,
    toggle_focus_mode,
    toggle_rotate_pets,
    shuffle_pet,
    quit_app,
    install_agent: u32,
    uninstall_agent: u32,
    pet_filter: canvas.TextInputEvent,
    toggle_pets_expanded,
    manifest_done: native_sdk.EffectExit,
    pet_json_done: native_sdk.EffectExit,
    spritesheet_done: native_sdk.EffectExit,
    dismiss_install_error,
    install_first_pet,
    noop,

    pub const view_unbound = .{ "frame_tick", "poll_tick", "physics_tick", "frame_clock", "cycle_state", "chime_done", "quit_app", "toggle_focus_mode", "shuffle_pet" };
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
    /// One bubble per live conversation, mirrored from the mailbox and
    /// ordered oldest first: the view stacks them in this order, so the
    /// most recently updated sits at the bottom, next to the tail.
    bubbles: [hook_server.max_bubbles]hook_server.Bubble = @splat(.{}),
    bubbles_len: usize = 0,
    /// Per-bubble deadlines, parallel to `bubbles`. Kept alongside
    /// rather than inside hook_server.Bubble because expiry is a display
    /// decision the app owns; the server has no clock for it.
    bubble_expires_at_ms: [hook_server.max_bubbles]i64 = @splat(-1),
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
    // Where and when the current grab began, for tap detection on
    // release; pat_flip alternates the reaction between two states.
    press_x: f64 = 0,
    press_y: f64 = 0,
    press_ms: i64 = 0,
    pat_flip: bool = false,
    settings_open: bool = false,
    /// Sprite scale, persisted. Codex parity: the settings slider maps
    /// 0.4..1.2 over this.
    scale: f32 = 0.7,
    active_pet: u32 = 0,
    window_fitted: bool = false,
    bubbles_enabled: bool = true,
    /// Opt-in chime on the transition into `waiting`. Off by default,
    /// unlike the toggles around it: sound is intrusive in a way
    /// passive UI never is, so it has to be an explicit opt-in.
    waiting_sound: bool = false,
    /// When the current waiting spell began, and whether its single
    /// follow-up ping already fired (see waiting_escalation_ms).
    waiting_since_ms: i64 = 0,
    waiting_escalated: bool = false,
    /// Bubble text size in points, persisted. The bubble rendered at a
    /// fixed 13 (the `.sm` rung); this keeps 13 as the floor and lets
    /// the settings slider raise it to 20.
    bubble_text_px: f32 = bubble_text_default_px,
    /// Seconds a completed (non-busy) bubble remains visible. Zero
    /// disables automatic expiry.
    bubble_lifetime_secs: f32 = bubble_lifetime_default_secs,
    bubble_lifetime_text: [2]u8 = .{ '0', 0 },
    bubble_lifetime_text_len: usize = 1,
    /// Bubble layout is user-controlled on every platform: one title line
    /// plus this many answer lines, each with the configured column budget.
    bubble_columns: u16 = bubble_columns_default,
    bubble_answer_lines: u8 = bubble_answer_lines_default,
    bubble_columns_text: [4]u8 = .{ '4', '0', 0, 0 },
    bubble_columns_text_len: usize = 2,
    bubble_answer_lines_text: [2]u8 = .{ '2', 0 },
    bubble_answer_lines_text_len: usize = 1,
    font_path: [512]u8 = @splat(0),
    font_path_len: usize = 0,
    font_path_dirty: bool = false,
    font_load_failed: bool = false,
    /// macOS: run as a menu-bar app — no Dock icon, no app switcher
    /// entry. The status item stays either way, so Settings and Quit
    /// never lose their handle. Off by default.
    hide_dock: bool = false,
    /// Mirror of SMAppService's status, never a stored wish: boot and
    /// every toggle re-query, so a rejected registration (unbundled
    /// dev binary, user-declined approval) snaps visibly back.
    launch_at_login: bool = false,
    /// Session-only mute for the bubble (tray toggle): the sprite
    /// keeps reacting, the narration pauses. Deliberately not
    /// persisted — focus ends when the app restarts.
    focus_mode: bool = false,
    /// Daily pet rotation: when on, the pet advances round-robin
    /// through the catalog once per day (UTC epoch-day). Off by
    /// default; enabling never swaps on the spot — the current pet
    /// becomes today's, rotation starts tomorrow.
    rotate_pets: bool = false,
    /// The epoch-day the current pet was chosen for. A manual pick
    /// stamps today, pinning it until tomorrow.
    rotation_day: u32 = 0,
    /// Whether the persisted pet position was applied after the first
    /// window fit (it must land after the fit's bottom_center anchor).
    pos_restored: bool = false,
    pet_x: f64 = 0,
    pet_y: f64 = 0,
    agents: [agent_hooks.agent_count]agent_hooks.AgentInfo = .{
        .{ .kind = .claude_code },
        .{ .kind = .codex },
        .{ .kind = .gemini },
        .{ .kind = .opencode },
        .{ .kind = .qoder },
        .{ .kind = .kimi_code },
        .{ .kind = .codebuddy },
        .{ .kind = .omp },
    },
    agents_prompted: bool = false,
    codex_trust_note: bool = false,
    pet_filter: [48]u8 = @splat(0),
    pet_filter_len: usize = 0,
    pets_expanded: bool = false,
    install: InstallState = .{},
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
    // The `.heading` typography rung is unused anywhere in this app
    // (section titles sit on `.lg`), so it is repurposed as THE bubble
    // text size: per-widget sizes only step ±1pt around the body base,
    // and scaling the body base itself would drag the whole settings
    // window along. Aiming the free rung at the persisted preference
    // gives the bubble a real 13..20pt range while every other window
    // keeps stock type.
    tokens.typography.heading_size = model.bubble_text_px;
    if (custom_font_active) tokens.typography.font_id = custom_font_id;
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

// Catalog table and slug lookup live in catalog.zig (#613).
const catalog_mod = @import("catalog.zig");
const settings_view = @import("settings_view.zig");
pub const max_catalog = catalog_mod.max_catalog;
pub const CatalogEntry = catalog_mod.CatalogEntry;
const catalogIndexOf = catalog_mod.catalogIndexOf;
// Aliases, not copies: `catalog` and `catalog_mod.catalog_len` are mutable state the
// install queue and the settings view both write, so they have to stay
// one storage location.
const catalog = &catalog_mod.catalog;

// ---------------------------------------------------------------- install
// `petdex://<slug>` for a pet that is not on disk downloads it first.
// The bytes ride `fx.spawn` (curl/wget), never `fx.fetch`: a buffered
// fetch caps at 256 KB and a streamed one frames by lines, while real
// spritesheets are 1 to 3 MB. See installer.zig.

/// Slugs waiting to be installed. A deep link can name several, and the
/// URL slices it arrives on are borrowed for the dispatch only, so each
/// slug is COPIED here before anything asynchronous starts.
const max_install_queue = 8;

const InstallPhase = enum { idle, manifest, pet_json, spritesheet };

pub const InstallState = struct {
    phase: InstallPhase = .idle,
    queue: [max_install_queue][64]u8 = @splat(@splat(0)),
    queue_len: [max_install_queue]usize = @splat(0),
    queued: usize = 0,
    /// Index into `queue` of the pet being downloaded right now.
    current: usize = 0,
    /// Set when the deep link was `petdex://<slug>` rather than
    /// `petdex://install?…`: that form means "use this pet", so the
    /// install activates it on completion.
    activate_when_done: bool = false,
    /// Chosen once per install so pet.json and the spritesheet land
    /// under matching names (`spritesheet.png` vs `.webp`).
    ext_png: bool = false,
    /// Last failure, shown in Settings until dismissed. Empty means the
    /// install either succeeded or never ran.
    error_text: [96]u8 = @splat(0),
    error_len: usize = 0,
    installed_ok: usize = 0,

    pub fn currentSlug(self: *const InstallState) []const u8 {
        if (self.current >= self.queued) return "";
        return self.queue[self.current][0..self.queue_len[self.current]];
    }

    pub fn errorSlice(self: *const InstallState) []const u8 {
        return self.error_text[0..self.error_len];
    }

    pub fn busy(self: *const InstallState) bool {
        return self.phase != .idle;
    }

    /// Copy a slug off a borrowed URL slice. Rejected slugs never enter
    /// the queue, so nothing downstream has to re-validate a path.
    pub fn enqueue(self: *InstallState, slug: []const u8) bool {
        if (self.queued >= max_install_queue) return false;
        if (!installer.slugOk(slug)) return false;
        for (0..self.queued) |i| {
            if (std.mem.eql(u8, self.queue[i][0..self.queue_len[i]], slug)) return false;
        }
        @memcpy(self.queue[self.queued][0..slug.len], slug);
        self.queue_len[self.queued] = slug.len;
        self.queued += 1;
        return true;
    }

    pub fn setError(self: *InstallState, comptime fmt: []const u8, args: anytype) void {
        const written = std.fmt.bufPrint(&self.error_text, fmt, args) catch {
            self.error_len = 0;
            return;
        };
        self.error_len = written.len;
    }
};

const manifest_key: u64 = 20;
const pet_json_key: u64 = 21;
const spritesheet_key: u64 = 22;

/// Where the manifest lands while a slug is resolved. It is 1.4 MB of
/// JSON for 4145 pets, so it is never held in the model — curl writes
/// it here, one pet's URLs are read out, and the file is deleted.
fn manifestTmpPath(buf: []u8) ?[]const u8 {
    const home = env_home orelse return null;
    return std.fmt.bufPrint(buf, "{s}/.petdex/manifest-download.json", .{home}) catch null;
}

/// Manifest read bound. The live manifest is 1.4 MB and grows with the
/// catalog, so this leaves headroom rather than tracking it exactly; a
/// manifest past the cap is read truncated and the slug simply is not
/// found, which surfaces as a normal "not in the manifest" error.
const max_manifest_bytes: usize = 8 * 1024 * 1024;

fn petdexDirsFor(slug: []const u8) void {
    const home = env_home orelse return;
    var buf: [512]u8 = undefined;
    for (installer.install_roots) |root| {
        const dir = installer.petDir(&buf, home, root, slug) orelse continue;
        plat.makeDir(dir);
    }
}

/// Start (or continue) the queue: fetch the manifest once, then walk the
/// pets. The manifest is re-fetched per install run rather than cached,
/// so a pet approved after the app launched is still installable.
fn startInstallQueue(model: *Model, fx: *Effects) void {
    if (model.install.busy() or model.install.queued == 0) return;
    if (installer.detect() == null) {
        std.debug.print("{s}", .{installer.missing_downloader_note});
        model.install.setError("No downloader: install curl", .{});
        model.install.queued = 0;
        return;
    }
    const home = env_home orelse return;
    _ = home;
    var path_buf: [512]u8 = undefined;
    const dest = manifestTmpPath(&path_buf) orelse return;
    const which = installer.detect() orelse return;
    var argv_buf: [installer.max_argv][]const u8 = undefined;
    model.install.phase = .manifest;
    model.install.current = 0;
    model.install.installed_ok = 0;
    model.install.error_len = 0;
    fx.spawn(.{
        .key = manifest_key,
        .argv = installer.downloadArgv(which, &argv_buf, installer.manifest_url, dest),
        .output = .collect,
        .on_exit = Effects.exitMsg(.manifest_done),
    });
}

/// Resolve the current slug against the downloaded manifest and start
/// its pet.json. Returns false when the pet cannot be installed, which
/// advances the queue rather than stalling it.
fn beginCurrentPet(model: *Model, fx: *Effects) bool {
    const home = env_home orelse return false;
    const slug = model.install.currentSlug();
    if (slug.len == 0) return false;

    var path_buf: [512]u8 = undefined;
    const manifest_path = manifestTmpPath(&path_buf) orelse return false;
    const manifest = plat.readFileAlloc(boot_allocator, manifest_path, max_manifest_bytes) orelse {
        model.install.setError("Manifest download failed", .{});
        return false;
    };
    defer boot_allocator.free(manifest);

    const urls = installer.findPetUrls(manifest, slug) orelse {
        model.install.setError("{s} is not in the catalog", .{slug});
        return false;
    };
    // The host check happens before a single byte is requested: an
    // approved-but-stale row could carry a URL off the asset origin,
    // and the app must not write those bytes to a pet directory.
    if (!installer.isTrustedAssetUrl(urls.pet_json) or !installer.isTrustedAssetUrl(urls.spritesheet)) {
        model.install.setError("{s} has an untrusted asset host", .{slug});
        return false;
    }
    model.install.ext_png = std.mem.eql(u8, urls.spritesheetExt(), "png");
    petdexDirsFor(slug);

    var dest_buf: [512]u8 = undefined;
    const dest = installer.petFile(&dest_buf, home, installer.install_roots[0], slug, "pet.json") orelse return false;
    const which = installer.detect() orelse return false;
    var argv_buf: [installer.max_argv][]const u8 = undefined;
    model.install.phase = .pet_json;
    fx.spawn(.{
        .key = pet_json_key,
        .argv = installer.downloadArgv(which, &argv_buf, urls.pet_json, dest),
        .output = .collect,
        .on_exit = Effects.exitMsg(.pet_json_done),
    });
    return true;
}

/// pet.json is down; pull the spritesheet into the same directory.
fn beginSpritesheet(model: *Model, fx: *Effects) bool {
    const home = env_home orelse return false;
    const slug = model.install.currentSlug();
    if (slug.len == 0) return false;

    var path_buf: [512]u8 = undefined;
    const manifest_path = manifestTmpPath(&path_buf) orelse return false;
    const manifest = plat.readFileAlloc(boot_allocator, manifest_path, max_manifest_bytes) orelse return false;
    defer boot_allocator.free(manifest);
    const urls = installer.findPetUrls(manifest, slug) orelse return false;
    if (!installer.isTrustedAssetUrl(urls.spritesheet)) return false;

    var name_buf: [32]u8 = undefined;
    const name = std.fmt.bufPrint(&name_buf, "spritesheet.{s}", .{urls.spritesheetExt()}) catch return false;
    var dest_buf: [512]u8 = undefined;
    const dest = installer.petFile(&dest_buf, home, installer.install_roots[0], slug, name) orelse return false;
    const which = installer.detect() orelse return false;
    var argv_buf: [installer.max_argv][]const u8 = undefined;
    model.install.phase = .spritesheet;
    fx.spawn(.{
        .key = spritesheet_key,
        .argv = installer.downloadArgv(which, &argv_buf, urls.spritesheet, dest),
        .output = .collect,
        .on_exit = Effects.exitMsg(.spritesheet_done),
    });
    return true;
}

/// Copy the finished pet into the second root. The CLI downloads each
/// asset twice; copying the bytes already on disk costs one read
/// instead of a second round trip over the network.
fn mirrorToCodexRoot(slug: []const u8, ext_png: bool) void {
    const home = env_home orelse return;
    var name_buf: [32]u8 = undefined;
    const sheet_name = std.fmt.bufPrint(&name_buf, "spritesheet.{s}", .{if (ext_png) "png" else "webp"}) catch return;
    for ([_][]const u8{ "pet.json", sheet_name }) |name| {
        var src_buf: [512]u8 = undefined;
        var dst_buf: [512]u8 = undefined;
        const src = installer.petFile(&src_buf, home, installer.install_roots[0], slug, name) orelse continue;
        const dst = installer.petFile(&dst_buf, home, installer.install_roots[1], slug, name) orelse continue;
        const bytes = plat.readFileAlloc(boot_allocator, src, max_sheet_file_bytes) orelse continue;
        defer boot_allocator.free(bytes);
        _ = plat.writeFile(dst, bytes);
    }
}

/// Add a freshly installed pet to the in-memory catalog. A rescan would
/// need a `std.Io`, and the only one the app holds belongs to the main
/// thread, so the entry is appended directly — same shape `scanCatalog`
/// writes.
///
/// The catalog holds `max_catalog` entries and `scanCatalog` fills it
/// from both roots at boot, so on a machine with more pets than slots
/// (49 here against 32) it is already full before any install runs.
/// Dropping the new pet would install it to disk and leave it
/// unselectable, so a full catalog evicts instead: the pet the user just
/// asked for by name outranks whichever one the boot scan happened to
/// land on last. The evicted entry is only a listing — its files stay on
/// disk and the next boot rescans them.
fn catalogAppend(slug: []const u8, active: usize) ?usize {
    if (catalogIndexOf(slug)) |existing| return existing;
    const root = installer.install_roots[0];
    const slot = if (catalog_mod.catalog_len < max_catalog) blk: {
        catalog_mod.catalog_len += 1;
        break :blk catalog_mod.catalog_len - 1;
    } else evict: {
        // Never evict the pet currently on screen: its decoded sheet is
        // live and the entry backs the name the window is showing.
        var victim: usize = max_catalog - 1;
        if (victim == active and max_catalog > 1) victim -= 1;
        break :evict victim;
    };
    var e = &catalog[slot];
    e.* = .{};
    @memcpy(e.name[0..slug.len], slug);
    e.len = slug.len;
    @memcpy(e.root[0..root.len], root);
    e.root_len = root.len;
    // A reused slot may still carry the evicted pet's thumbnail, so the
    // atlas cell has to be rebuilt before the row draws it.
    thumbs_ready[slot] = false;
    return slot;
}

/// Move to the next queued pet, or finish the run. Finishing deletes
/// the manifest scratch file: 1.4 MB is not worth keeping around, and a
/// stale copy would resolve slugs against an old catalog.
fn advanceInstallQueue(model: *Model, fx: *Effects) void {
    model.install.current += 1;
    while (model.install.current < model.install.queued) {
        if (beginCurrentPet(model, fx)) return;
        model.install.current += 1;
    }
    model.install.phase = .idle;
    model.install.queued = 0;
    var path_buf: [512]u8 = undefined;
    if (manifestTmpPath(&path_buf)) |path| plat.deleteFile(path);
}

const url_scheme_prefix = "petdex://";

/// Slugs a deep link asked for, staged for `update`.
///
/// `on_urls_opened` maps a URL to one Msg and gets no `fx`, but an
/// install needs to spawn effects, so the work cannot happen in the
/// callback. The URL slices are borrowed for the dispatch only — they
/// are dead by the time any download starts — so the slugs are copied
/// here and the returned Msg is only a signal to drain this.
var pending_install: InstallState = .{};
var pending_ready: bool = false;

/// `petdex://<slug>` selects a pet, installing it first when it is not
/// on disk; `petdex://install?slug=a&slug=b` installs without
/// selecting (petdex-desktop-link.ts builds both forms).
///
/// An already-installed pet still resolves to `select_pet` inside the
/// callback, so the common case keeps its immediate swap and never
/// touches the network.
fn onUrlsOpened(urls: []const []const u8) ?Msg {
    for (urls) |url| {
        if (!std.mem.startsWith(u8, url, url_scheme_prefix)) continue;
        const rest = url[url_scheme_prefix.len..];
        const host = rest[0 .. std.mem.indexOfAny(u8, rest, "/?#") orelse rest.len];

        if (std.mem.eql(u8, host, "install")) {
            const query = std.mem.indexOfScalar(u8, rest, '?') orelse continue;
            pending_install = .{};
            var it = std.mem.splitScalar(u8, rest[query + 1 ..], '&');
            while (it.next()) |pair| {
                if (!std.mem.startsWith(u8, pair, "slug=")) continue;
                var value = pair["slug=".len..];
                if (std.mem.indexOfScalar(u8, value, '#')) |cut| value = value[0..cut];
                _ = pending_install.enqueue(value);
            }
            if (pending_install.queued == 0) continue;
            pending_install.activate_when_done = false;
            pending_ready = true;
            return .noop;
        }

        // NSURL hands back the absoluteString, and a bare host round
        // trips as `petdex://slug/`.
        if (catalogIndexOf(host)) |index| return .{ .select_pet = @intCast(index) };
        pending_install = .{};
        if (!pending_install.enqueue(host)) continue;
        pending_install.activate_when_done = true;
        pending_ready = true;
        return .noop;
    }
    return null;
}

/// Move a staged deep link into the model and start it. Called from
/// `update`, the first place with an `fx` to spawn on.
fn drainPendingInstall(model: *Model, fx: *Effects) void {
    if (!pending_ready) return;
    pending_ready = false;
    if (model.install.busy()) return;
    const activate = pending_install.activate_when_done;
    model.install.queued = 0;
    for (0..pending_install.queued) |i| {
        _ = model.install.enqueue(pending_install.queue[i][0..pending_install.queue_len[i]]);
    }
    model.install.activate_when_done = activate;
    startInstallQueue(model, fx);
    // A deep-link install arrives from the browser with no Petdex window
    // in front of the user, so the progress banner would render into a
    // closed Settings page. Opening it is the whole feedback channel.
    if (model.install.busy() or model.install.error_len > 0) {
        if (!model.settings_open) {
            model.settings_open = true;
            loadAgentsAtlas(model.dark, fx);
        } else {
            fx.focusWindow(settings_window_label);
        }
    }
}

pub const PosSample = struct { x: f64 = 0, y: f64 = 0, t_ms: i64 = 0 };

// ---------------------------------------------------------------- petting

/// Tap tolerances: the window may jitter a device pixel under a
/// too-quick grab, and 400ms is the classic click ceiling — anything
/// longer reads as a held grab, not a pat.
const tap_max_ms: i64 = 400;
const tap_slop_px: f64 = 3;
/// How long the reaction plays before the dwell hands back to idle
/// (the throw-end waving uses the same figure).
const pat_react_ms: u32 = 1200;

fn isTap(held_ms: i64, dx: f64, dy: f64) bool {
    return held_ms <= tap_max_ms and @abs(dx) < tap_slop_px and @abs(dy) < tap_slop_px;
}

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
            if (catalog_mod.catalog_len >= max_catalog) return;
            var duplicate = false;
            for (catalog[0..catalog_mod.catalog_len]) |*existing| {
                if (std.mem.eql(u8, existing.slice(), entry.name)) duplicate = true;
            }
            if (duplicate) continue;
            var e = &catalog[catalog_mod.catalog_len];
            @memcpy(e.name[0..entry.name.len], entry.name);
            e.len = entry.name.len;
            @memcpy(e.root[0..root.len], root);
            e.root_len = root.len;
            catalog_mod.catalog_len += 1;
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

const custom_font_id: canvas.FontId = canvas.min_registered_font_id;
const max_custom_font_bytes: usize = 24 * 1024 * 1024;
var initial_font_path: [512]u8 = @splat(0);
var initial_font_path_len: usize = 0;
var initial_font_load_failed: bool = false;
pub var custom_font_active: bool = false;

/// Tiny file helpers usable from the runtime thread. They carry their
/// own Io (see plat.zig), so the main thread's never leaks off-thread;
/// the invariant is enforced by the type now, not by this comment.
const cReadFile = plat.readFile;

fn cWriteFile(path: []const u8, bytes: []const u8) void {
    _ = plat.writeFile(path, bytes);
}

fn jsonEscapeString(value: []const u8, output: []u8) ?[]const u8 {
    var len: usize = 0;
    for (value) |byte| {
        const escape: ?u8 = switch (byte) {
            '"' => '"',
            '\\' => '\\',
            '\n' => 'n',
            '\r' => 'r',
            '\t' => 't',
            else => null,
        };
        if (escape) |escaped| {
            if (len + 2 > output.len) return null;
            output[len] = '\\';
            output[len + 1] = escaped;
            len += 2;
        } else {
            if (len >= output.len) return null;
            output[len] = byte;
            len += 1;
        }
    }
    return output[0..len];
}

fn jsonUnescapeString(value: []const u8, output: []u8) ?[]const u8 {
    var input_index: usize = 0;
    var len: usize = 0;
    while (input_index < value.len) {
        var byte = value[input_index];
        input_index += 1;
        if (byte == '\\') {
            if (input_index >= value.len) return null;
            byte = switch (value[input_index]) {
                '"' => '"',
                '\\' => '\\',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                else => return null,
            };
            input_index += 1;
        }
        if (len >= output.len) return null;
        output[len] = byte;
        len += 1;
    }
    return output[0..len];
}

fn saveSettings(model: *const Model) void {
    var path_buf: [512]u8 = undefined;
    const path = settingsPath(&path_buf) orelse return;
    // Headroom check (a bufPrint overflow here fails silently and
    // drops the whole save): keep room for the configurable bubble
    // fields, rotation state, a long slug, and negative coordinates.
    var buf: [1536]u8 = undefined;
    const active = if (model.active_pet < catalog_mod.catalog_len) catalog[model.active_pet].slice() else "";
    // The position keys only exist once the window has been fitted and
    // read: a save fired on the very first frame would otherwise
    // persist the (0,0) the model boots with and pin the pet to the
    // top-left corner on every launch after.
    var pos_buf: [64]u8 = undefined;
    const pos = if (model.window_fitted)
        std.fmt.bufPrint(&pos_buf, ",\"pet_x\":{d:.0},\"pet_y\":{d:.0}", .{ model.pet_x, model.pet_y }) catch ""
    else
        "";
    var escaped_font_buf: [1024]u8 = undefined;
    const font_path = std.mem.trim(u8, model.font_path[0..model.font_path_len], " \t\r\n");
    const escaped_font = jsonEscapeString(font_path, &escaped_font_buf) orelse return;
    const json = std.fmt.bufPrint(&buf, "{{\"active_pet\":\"{s}\",\"scale\":{d:.2},\"bubbles\":{},\"waiting_sound\":{},\"bubble_text\":{d:.1},\"bubble_lifetime\":{d:.0},\"bubble_columns\":{},\"bubble_answer_lines\":{},\"font_path\":\"{s}\",\"hide_dock\":{},\"rotate_pets\":{},\"rotation_day\":{d}{s},\"agents_prompted\":{}}}", .{ active, model.scale, model.bubbles_enabled, model.waiting_sound, model.bubble_text_px, model.bubble_lifetime_secs, model.bubble_columns, model.bubble_answer_lines, escaped_font, model.hide_dock, model.rotate_pets, model.rotation_day, pos, model.agents_prompted }) catch return;
    cWriteFile(path, json);
}

fn setUnsignedText(buffer: []u8, length: *usize, value: u16) void {
    const text = std.fmt.bufPrint(buffer, "{}", .{value}) catch return;
    length.* = text.len;
}

fn editUnsignedText(buffer: []u8, length: *usize, edit: canvas.TextInputEvent, min_value: u16, max_value: u16) ?u16 {
    switch (edit) {
        .insert_text => |text| {
            for (text) |byte| {
                if (!std.ascii.isDigit(byte) or length.* >= buffer.len) continue;
                buffer[length.*] = byte;
                length.* += 1;
            }
        },
        .delete_backward, .delete_word_backward => {
            if (length.* > 0) length.* -= 1;
        },
        .clear => length.* = 0,
        else => {},
    }
    if (length.* == 0) return null;
    const value = std.fmt.parseInt(u16, buffer[0..length.*], 10) catch return null;
    if (value < min_value or value > max_value) return null;
    return value;
}

fn editPathText(buffer: []u8, length: *usize, edit: canvas.TextInputEvent) void {
    switch (edit) {
        .insert_text => |text| {
            const available = buffer.len - length.*;
            const count = @min(available, text.len);
            @memcpy(buffer[length.* .. length.* + count], text[0..count]);
            length.* += count;
        },
        .delete_backward, .delete_word_backward => {
            if (length.* > 0) length.* -= 1;
            while (length.* > 0 and (buffer[length.*] & 0xC0) == 0x80) length.* -= 1;
        },
        .clear => length.* = 0,
        else => {},
    }
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
var initial_waiting_sound: bool = false;
var initial_bubble_text_px: f32 = bubble_text_default_px;
var initial_bubble_lifetime_secs: f32 = bubble_lifetime_default_secs;
var initial_bubble_columns: u16 = bubble_columns_default;
var initial_bubble_answer_lines: u8 = bubble_answer_lines_default;
var initial_hide_dock: bool = false;
var initial_rotate_pets: bool = false;
var initial_rotation_day: u32 = 0;
var initial_agents_prompted: bool = false;
/// Persisted pet window origin; null on first run (or a settings file
/// from before positions were saved), which keeps the platform's
/// default placement. Off-screen values from an unplugged monitor are
/// left to the platform's own clamping (the same edge handling the
/// throw physics rides).
var initial_pet_x: ?f64 = null;
var initial_pet_y: ?f64 = null;

// ------------------------------------------------------------- avatars
// One slot for the CURRENT bubble's agent avatar (claude-code, codex,
// gemini, opencode, antigravity), 40x40 PNGs committed under
// assets/agents/, re-registered only when the agent changes.
const avatar_image_id: u64 = 13;
const tail_image_id: u64 = 14;
// One slot for every agent logo, packed side by side and read back with
// `image_src` (the thumbnail atlas above does the same). Previously each
// agent held its own registry id, which ran the app into the SDK's
// 16-slot ceiling (canvas_limits.max_registered_canvas_images): ids
// 1/9/10/11/13/14/15/16 were spoken for and Qoder took the last one, so
// a sixth agent had nowhere to register. Packing removes the ceiling
// instead of raising it — sixteen 40px logos are a 640x40 strip, far
// inside the 512x512 and 1MiB per-image bounds.
const agent_icon_atlas_id: u64 = 9;
const agent_icon_px: usize = 40;
var agents_icons_ready: bool = false;
var agents_icons_dark: bool = false;
var agent_icon_pixels: []u8 = &.{};

/// Where agent `index`'s logo sits in the packed strip.
fn agentIconRect(index: usize) geometry.RectF {
    return geometry.RectF.init(
        @as(f32, @floatFromInt(index * agent_icon_px)),
        0,
        @as(f32, @floatFromInt(agent_icon_px)),
        @as(f32, @floatFromInt(agent_icon_px)),
    );
}

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
    .{ .light = @embedFile("assets/agents/qoder.png"), .dark = @embedFile("assets/agents/qoder.png") },
    .{ .light = @embedFile("assets/agents/kimi-code.png"), .dark = @embedFile("assets/agents/kimi-code.png") },
    .{ .light = @embedFile("assets/agents/codebuddy.png"), .dark = @embedFile("assets/agents/codebuddy.png") },
    .{ .light = @embedFile("assets/agents/omp.png"), .dark = @embedFile("assets/agents/omp.png") },
};
const agent_fallback_art: []const u8 = @embedFile("assets/agents/fallback.png");

/// Pack every settings agent logo into one registry slot, themed like the
/// bubble avatar and rebuilt on appearance flips. Each logo decodes
/// through the platform codec (the same path `registerImageBytes` takes
/// internally) and is copied into its own cell of the strip.
///
/// A logo that fails to decode leaves its cell transparent rather than
/// aborting the strip, so one bad asset costs one icon instead of all of
/// them. The row is only registered if at least one cell landed.
fn loadAgentsAtlas(dark: bool, fx: *Effects) void {
    if (agents_icons_ready and agents_icons_dark == dark) return;
    const services = fx.services orelse return;

    const atlas_w = agent_art.len * agent_icon_px;
    if (agent_icon_pixels.len == 0) {
        agent_icon_pixels = boot_allocator.alloc(u8, atlas_w * agent_icon_px * 4) catch return;
    }
    @memset(agent_icon_pixels, 0);

    // Decoding happens into a scratch buffer sized for one logo at the
    // per-image ceiling, reused across cells so the pack costs one
    // allocation rather than one per agent.
    const scratch = boot_allocator.alloc(u8, 512 * 512 * 4) catch return;
    defer boot_allocator.free(scratch);

    const atlas_row_len = atlas_w * 4;
    var packed_any = false;
    for (agent_art, 0..) |art, cell| {
        const decoded = services.decodeImage(if (dark) art.dark else art.light, scratch) catch continue;
        if (decoded.width == 0 or decoded.height == 0) continue;
        // Nearest-neighbour into the cell: the logos ship at 40px and the
        // view draws them at 24, so the scale here is identity in practice
        // and the sampling only matters if an asset is authored off-size.
        for (0..agent_icon_px) |y| {
            const src_y = y * decoded.height / agent_icon_px;
            for (0..agent_icon_px) |x| {
                const src_x = x * decoded.width / agent_icon_px;
                const src_off = (src_y * decoded.width + src_x) * 4;
                const dst_off = y * atlas_row_len + (cell * agent_icon_px + x) * 4;
                @memcpy(agent_icon_pixels[dst_off..][0..4], decoded.rgba8[src_off..][0..4]);
            }
        }
        packed_any = true;
    }
    if (!packed_any) return;

    fx.registerImage(agent_icon_atlas_id, atlas_w, agent_icon_px, agent_icon_pixels) catch return;
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
                // Hairline along the tail's diagonal edges so the join
                // reads as one outlined shape (the top row stays plain,
                // it tucks under the card). Both themes need it: a white
                // tail on a light desktop background has no silhouette
                // at all, which is the same reason the card is outlined.
                if (y > 0 and (x == inset or x == tail_w - inset - 1)) {
                    const er: u8 = if (dark) 48 else 214;
                    const eg: u8 = if (dark) 48 else 214;
                    const eb: u8 = if (dark) 53 else 220;
                    pixels[i] = er;
                    pixels[i + 1] = eg;
                    pixels[i + 2] = eb;
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

/// Which cell of the packed logo strip belongs to this agent, or null
/// for a name we ship no glyph for. The strip has exactly one cell per
/// AgentKind and none for the fallback art, so an unknown agent has no
/// tile to point at and the caller has to draw nothing.
fn agentIconIndex(agent: []const u8) ?usize {
    for (std.enums.values(agent_hooks.AgentKind)) |kind| {
        if (std.mem.eql(u8, kind.hookAgentName(), agent)) return @intFromEnum(kind);
    }
    return null;
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
    if (thumbs_built >= catalog_mod.catalog_len) return;
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
    if (catalog_mod.catalog_len == 0) return error.NoPetInstalled;

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
            if (hook_server.jsonNumberPub(json, "bubble_text")) |v| {
                if (v >= bubble_text_min_px and v <= bubble_text_max_px) initial_bubble_text_px = @floatCast(v);
            }
            if (hook_server.jsonNumberPub(json, "bubble_lifetime")) |v| {
                initial_bubble_lifetime_secs = clampBubbleLifetime(@floatCast(v));
            }
            if (hook_server.jsonNumberPub(json, "bubble_columns")) |v| {
                if (v >= bubble_columns_min and v <= bubble_columns_max) initial_bubble_columns = @intFromFloat(v);
            }
            if (hook_server.jsonNumberPub(json, "bubble_answer_lines")) |v| {
                if (v >= bubble_answer_lines_min and v <= bubble_answer_lines_max) initial_bubble_answer_lines = @intFromFloat(v);
            }
            if (hook_server.jsonStringPub(json, "font_path")) |encoded| {
                if (jsonUnescapeString(encoded, &initial_font_path)) |value| {
                    initial_font_path_len = value.len;
                }
            }
            if (hook_server.jsonStringPub(json, "bubbles")) |_| {} else if (std.mem.indexOf(u8, json, "\"bubbles\":false") != null) {
                initial_bubbles = false;
            }
            if (std.mem.indexOf(u8, json, "\"agents_prompted\":true") != null) {
                initial_agents_prompted = true;
            }
            // Opposite default from bubbles: the chime is opt-in, so
            // only an explicit true (never a missing key) enables it.
            if (std.mem.indexOf(u8, json, "\"waiting_sound\":true") != null) {
                initial_waiting_sound = true;
            }
            // Opt-in like the sound: only an explicit true hides the
            // Dock icon, a missing key keeps the stock behavior.
            if (std.mem.indexOf(u8, json, "\"hide_dock\":true") != null) {
                initial_hide_dock = true;
            }
            if (hook_server.jsonNumberPub(json, "pet_x")) |x| {
                if (hook_server.jsonNumberPub(json, "pet_y")) |y| {
                    initial_pet_x = x;
                    initial_pet_y = y;
                }
            }
            // Opt-in like the sound and the Dock toggle.
            if (std.mem.indexOf(u8, json, "\"rotate_pets\":true") != null) {
                initial_rotate_pets = true;
            }
            if (hook_server.jsonNumberPub(json, "rotation_day")) |v| {
                if (v >= 0) initial_rotation_day = @intFromFloat(v);
            }
        }
    }
    const index = catalogIndexOf(wanted) orelse 0;
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

// ---------------------------------------------------------------- rotation

/// UTC epoch-day: the rotation only needs "did the calendar day
/// change", and epoch-day flips at UTC midnight — night hours for most
/// timezones — without dragging timezone math into the app.
fn dayFromWallMs(wall_ms: i64) u32 {
    return @intCast(@divTrunc(wall_ms, std.time.ms_per_day));
}

/// Advance to the next loadable pet, round-robin by catalog order:
/// deterministic (no repeats until the catalog wraps) and skipping
/// sheets the codec refuses, at most one full loop. Rides the same
/// select_pet Msg the settings list dispatches, so activation cannot
/// drift between a click, a rotation, and a shuffle.
fn advancePet(model: *Model, fx: *Effects) void {
    if (catalog_mod.catalog_len < 2) return;
    var offset: u32 = 1;
    while (offset < catalog_mod.catalog_len) : (offset += 1) {
        const idx: u32 = (model.active_pet + offset) % @as(u32, @intCast(catalog_mod.catalog_len));
        update(model, .{ .select_pet = idx }, fx);
        // select_pet only commits after a successful sheet load.
        if (model.active_pet == idx) return;
    }
}

/// Port of state-queue.ts dwellFor.
fn dwellFor(state: State, duration_ms: u32) u32 {
    if (isDurationState(state) and duration_ms > 0) return @max(duration_ms, min_dwell_ms);
    if (duration_ms > min_dwell_ms) return duration_ms;
    return min_dwell_ms;
}

const chime_key: u64 = 23;

/// Optional audible ping when the pet enters `waiting` (permission
/// prompts, idle alerts: the agent is blocked on the user). Playback
/// rides the platform's stock event sound through `fx.spawn` — no
/// bundled asset, no new dependency, and the exit Msg means the child
/// is always reaped. A machine without the player binary gets a
/// rejected exit on `chime_done` and quietly stays silent, as does a
/// chime posted while the previous one is still playing (same key,
/// spawn rejects the overlap).
fn playWaitingChime(fx: *Effects) void {
    const argv: []const []const u8 = switch (builtin.os.tag) {
        .macos => &.{ "/usr/bin/afplay", "/System/Library/Sounds/Glass.aiff" },
        .windows => &.{ "rundll32", "user32.dll,MessageBeep" },
        // The freedesktop `complete` event sound; canberra ships with
        // GNOME/KDE and this no-ops where it does not.
        else => &.{ "canberra-gtk-play", "--id", "complete" },
    };
    fx.spawn(.{
        .key = chime_key,
        .argv = argv,
        .output = .collect,
        .on_exit = Effects.exitMsg(.chime_done),
    });
}

/// Chime on the edge, not the level: `waiting` is often re-posted (one
/// Notification hook per permission prompt while the same prompt sits
/// unanswered, multiple agents), and a ping per re-post would train
/// users to turn the feature straight back off. The poll_tick dwell
/// path refreshes an already-waiting state without calling applyState,
/// so this sees real transitions only; once the user responds the
/// state leaves `waiting`, and the next prompt is a fresh edge that
/// chimes again.
fn shouldChime(previous: State, next: State) bool {
    return next == .waiting and previous != .waiting;
}

/// One follow-up ping when a prompt has sat unanswered this long: the
/// first chime is easy to miss mid-flow, and a prompt still up two
/// minutes later means it really was missed. Exactly one escalation
/// per waiting spell — a repeating ping is an alarm clock, not a pet.
const waiting_escalation_ms: i64 = 120_000;

fn shouldEscalate(state: State, waiting_since_ms: i64, escalated: bool, now: i64) bool {
    return state == .waiting and !escalated and now - waiting_since_ms >= waiting_escalation_ms;
}

fn applyState(model: *Model, state: State, duration_ms: u32, fx: *Effects) void {
    if (shouldChime(model.state, state)) {
        model.waiting_since_ms = fx.wallMs();
        model.waiting_escalated = false;
        if (model.waiting_sound) playWaitingChime(fx);
    }
    model.state = state;
    model.frame_index = 0;
    model.shown_at_ms = fx.wallMs();
    model.shown_dwell_ms = dwellFor(state, duration_ms);
    registerStateFrames(state, fx);
    armFrameTimer(model, fx);
}

pub fn boot(model: *Model, fx: *Effects) void {
    if (env_home) |home| {
        // Upgrade old CLI-written hooks before any agent starts another
        // session. The migration recognizes only Petdex-owned legacy
        // commands and leaves malformed or foreign configs untouched.
        const migration = agent_hooks.migrateLegacyHooks(boot_allocator, home);
        if (migration.failed > 0) {
            std.debug.print("petdex: {d} legacy hook configuration(s) could not be migrated; repair the config and update the affected agent in Settings\n", .{migration.failed});
        }
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
    model.waiting_sound = initial_waiting_sound;
    model.bubble_text_px = initial_bubble_text_px;
    model.bubble_lifetime_secs = initial_bubble_lifetime_secs;
    setUnsignedText(model.bubble_lifetime_text[0..], &model.bubble_lifetime_text_len, @intFromFloat(model.bubble_lifetime_secs));
    model.bubble_columns = initial_bubble_columns;
    model.bubble_answer_lines = initial_bubble_answer_lines;
    setUnsignedText(model.bubble_columns_text[0..], &model.bubble_columns_text_len, model.bubble_columns);
    setUnsignedText(model.bubble_answer_lines_text[0..], &model.bubble_answer_lines_text_len, model.bubble_answer_lines);
    @memcpy(model.font_path[0..initial_font_path_len], initial_font_path[0..initial_font_path_len]);
    model.font_path_len = initial_font_path_len;
    model.font_load_failed = initial_font_load_failed;
    model.agents_prompted = initial_agents_prompted;
    model.hide_dock = initial_hide_dock;
    model.rotate_pets = initial_rotate_pets;
    model.rotation_day = initial_rotation_day;
    model.launch_at_login = plat.launchAtLoginEnabled();
    // Applied via the main queue, so the flip lands as soon as the
    // host's runloop spins up; a Regular-policy Dock icon may blink in
    // for the first frames of a hidden-dock boot, which beats holding
    // the setting hostage to an SDK boot hook that does not exist yet.
    if (model.hide_dock) plat.setDockIconHidden(true);
    if (env_home) |home| model.agents = agent_hooks.scan(boot_allocator, home);

    // First point where the platform codec is reachable: `init_fx` runs
    // on the loop thread right after the runtime binds services onto fx.
    if (catalog_mod.catalog_len == 0) return;
    // A single unreadable sheet used to leave an empty window even with
    // a full catalog behind it (one shipped pet is a 3-byte stub), so
    // the chosen pet is a preference here, not a requirement.
    var chosen: ?usize = null;
    for (0..catalog_mod.catalog_len) |offset| {
        const index = (initial_pet + offset) % catalog_mod.catalog_len;
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
            std.debug.print("petdex: {d} pet(s) installed but none decoded; on Linux webp needs the gdk-pixbuf loader (apt install webp-pixbuf-loader)\n", .{catalog_mod.catalog_len});
        } else {
            std.debug.print("petdex: {d} pet(s) installed but none decoded; the sheet may be corrupt\n", .{catalog_mod.catalog_len});
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
        .dismiss_install_error => model.install.error_len = 0,
        .install_first_pet => {
            // A fresh install has no pets, so the pet window renders an
            // empty panel: a grey rectangle with nothing in it and no way
            // to tell whether Petdex is broken or just unfurnished. This
            // is the one-click way out, riding the same queue a
            // `petdex://` deep link uses, so activation after download
            // takes the identical path.
            if (model.install.busy()) return;
            model.install.error_len = 0;
            _ = model.install.enqueue(default_pet_slug);
            model.install.activate_when_done = true;
            startInstallQueue(model, fx);
        },
        .manifest_done => |exit| {
            if (model.install.phase != .manifest) return;
            // A nonzero curl exit means no usable manifest on disk, so
            // there is nothing to resolve any slug against: the whole
            // queue ends here rather than failing pet by pet.
            if (exit.reason != .exited or exit.code != 0) {
                model.install.setError("Could not reach petdex.dev", .{});
                model.install.phase = .idle;
                model.install.queued = 0;
                return;
            }
            model.install.current = 0;
            if (!beginCurrentPet(model, fx)) advanceInstallQueue(model, fx);
        },
        .pet_json_done => |exit| {
            if (model.install.phase != .pet_json) return;
            if (exit.reason != .exited or exit.code != 0) {
                model.install.setError("{s}: pet.json download failed", .{model.install.currentSlug()});
                advanceInstallQueue(model, fx);
                return;
            }
            if (!beginSpritesheet(model, fx)) {
                model.install.setError("{s}: spritesheet unavailable", .{model.install.currentSlug()});
                advanceInstallQueue(model, fx);
            }
        },
        .spritesheet_done => |exit| {
            if (model.install.phase != .spritesheet) return;
            const slug = model.install.currentSlug();
            if (exit.reason != .exited or exit.code != 0) {
                model.install.setError("{s}: spritesheet download failed", .{slug});
                advanceInstallQueue(model, fx);
                return;
            }
            mirrorToCodexRoot(slug, model.install.ext_png);
            model.install.installed_ok += 1;
            // The pet is only usable once the catalog knows it; a fresh
            // thumbnail pass picks it up the next time settings is open.
            const index = catalogAppend(slug, model.active_pet);
            thumbs_built = @min(thumbs_built, catalog_mod.catalog_len);
            if (model.install.activate_when_done) {
                if (index) |i| {
                    // Deliberately routed through the same Msg the
                    // settings list uses, so activation after an install
                    // cannot drift from activation by click.
                    update(model, .{ .select_pet = @intCast(i) }, fx);
                }
            }
            advanceInstallQueue(model, fx);
        },
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
                .qoder => agent_hooks.installQoder(boot_allocator, home),
                .kimi_code => agent_hooks.installKimiCode(boot_allocator, home),
                .codebuddy => agent_hooks.installCodeBuddy(boot_allocator, home),
                .omp => agent_hooks.installOmp(boot_allocator, home),
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
            if (index >= catalog_mod.catalog_len) return;
            // `index == active_pet` is a no-op only once a sheet is up.
            // On a first run active_pet is 0 and the pet just downloaded
            // lands at 0 too, so the early return skipped the very
            // activation the empty state exists to perform.
            if (index == model.active_pet and model.sheet_loaded) return;
            if (!loadSheetForPet(fx, &catalog[index])) return;
            model.active_pet = index;
            model.frame_index = 0;
            // First pet on a fresh install: the window was drawing the
            // empty state, and nothing else flips this back.
            if (!model.sheet_loaded) {
                model.sheet_loaded = true;
                pet_display_name = catalog[index].slice();
                const n = @min(pet_display_name.len, model.pet_name.len);
                @memcpy(model.pet_name[0..n], pet_display_name[0..n]);
                model.pet_name_len = n;
            }
            // A pick — manual or rotation, same Msg on purpose — is
            // today's pet: the daily rotation leaves it alone until
            // the next day.
            model.rotation_day = dayFromWallMs(fx.wallMs());
            registerStateFrames(model.state, fx);
            armFrameTimer(model, fx);
            saveSettings(model);
        },
        .toggle_bubbles => {
            model.bubbles_enabled = !model.bubbles_enabled;
            if (!model.bubbles_enabled) clearBubble(model);
            saveSettings(model);
        },
        .toggle_waiting_sound => {
            model.waiting_sound = !model.waiting_sound;
            saveSettings(model);
            // Flipping it on plays the chime once: the only way to
            // judge a sound is to hear it, and hunting for a permission
            // prompt just to preview a volume level is busywork.
            if (model.waiting_sound) playWaitingChime(fx);
        },
        .chime_done => {},
        .set_bubble_text_size => |fraction| {
            model.bubble_text_px = bubble_text_min_px + fraction * (bubble_text_max_px - bubble_text_min_px);
            _ = fitWindow(model, fx);
            syncBubbleWindow(model, fx);
            saveSettings(model);
        },
        .bubble_lifetime_input => |edit| {
            if (editUnsignedText(model.bubble_lifetime_text[0..], &model.bubble_lifetime_text_len, edit, 0, 60)) |value| {
                model.bubble_lifetime_secs = @floatFromInt(value);
                // Every settled bubble restarts on the new lifetime; a
                // busy one still has no deadline to move.
                const now = fx.wallMs();
                for (0..model.bubbles_len) |i| {
                    if (model.bubbles[i].busy) continue;
                    model.bubble_expires_at_ms[i] = bubbleDeadlineMs(now, model.bubble_lifetime_secs);
                }
                saveSettings(model);
            }
        },
        .bubble_columns_input => |edit| {
            if (editUnsignedText(model.bubble_columns_text[0..], &model.bubble_columns_text_len, edit, bubble_columns_min, bubble_columns_max)) |value| {
                model.bubble_columns = value;
                _ = fitWindow(model, fx);
                syncBubbleWindow(model, fx);
                saveSettings(model);
            }
        },
        .bubble_answer_lines_input => |edit| {
            if (editUnsignedText(model.bubble_answer_lines_text[0..], &model.bubble_answer_lines_text_len, edit, bubble_answer_lines_min, bubble_answer_lines_max)) |value| {
                model.bubble_answer_lines = @intCast(value);
                _ = fitWindow(model, fx);
                syncBubbleWindow(model, fx);
                saveSettings(model);
            }
        },
        .font_path_input => |edit| {
            editPathText(model.font_path[0..], &model.font_path_len, edit);
            model.font_path_dirty = true;
            model.font_load_failed = false;
            saveSettings(model);
        },
        .toggle_hide_dock => {
            model.hide_dock = !model.hide_dock;
            plat.setDockIconHidden(model.hide_dock);
            saveSettings(model);
        },
        .toggle_launch_at_login => {
            _ = plat.setLaunchAtLogin(!model.launch_at_login);
            // SMAppService is the source of truth (see the model
            // field): reflect the status query, not the wish.
            model.launch_at_login = plat.launchAtLoginEnabled();
        },
        .toggle_focus_mode => {
            model.focus_mode = !model.focus_mode;
            if (model.focus_mode) clearBubble(model);
        },
        .toggle_rotate_pets => {
            model.rotate_pets = !model.rotate_pets;
            // Enabling never swaps on the spot: the pet on screen
            // becomes today's, and rotation starts tomorrow.
            model.rotation_day = dayFromWallMs(fx.wallMs());
            saveSettings(model);
        },
        .shuffle_pet => advancePet(model, fx),
        .quit_app => plat.requestQuit(),
        .set_scale => |fraction| {
            model.scale = 0.4 + fraction * 0.8;
            _ = fitWindow(model, fx);
            saveSettings(model);
        },
        .open_pet_page => |index| {
            if (index >= catalog_mod.catalog_len) return;
            var buf: [256]u8 = undefined;
            const url = std.fmt.bufPrint(&buf, "https://petdex.dev/pets/{s}", .{catalog[index].slice()}) catch return;
            plat.openExternal(url);
        },
        .appearance => |a| {
            model.dark = a.color_scheme == .dark;
            if (newestBubble(model)) |newest| {
                registerTail(model.dark, fx);
                loadAgentAvatar(newest.agent[0..newest.agent_len], model.dark, fx);
            }
            // The strip is themed, so a stack drawing from it has to
            // re-pack on an appearance flip exactly like settings does.
            if (model.settings_open or model.bubbles_len > 1) loadAgentsAtlas(model.dark, fx);
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
                // Restore the persisted position once, right after the
                // first fit: the fit re-anchors bottom_center, so a
                // move applied before it would be anchored away.
                if (model.window_fitted and !model.pos_restored) {
                    model.pos_restored = true;
                    if (initial_pet_x) |x| {
                        if (initial_pet_y) |y| {
                            if (fx.moveWindow("main", 0, 0, false)) |cur| {
                                _ = fx.moveWindow("main", x - cur.x, y - cur.y, false);
                            }
                        }
                    }
                }
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
                    // The throw settled: this is where the pet will sit
                    // until the next gesture, so persist it here rather
                    // than on every physics frame.
                    saveSettings(model);
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
                // A tap, not a drag: the window never left the press
                // point and the button came back up quickly. Until now
                // a plain left-click did nothing at all — the pet gets
                // patted and reacts, alternating so it doesn't feel
                // canned (#557's "pet" interaction).
                if (isTap(now - model.press_ms, read.x - model.press_x, read.y - model.press_y)) {
                    model.sample_len = 0;
                    model.pat_flip = !model.pat_flip;
                    applyState(model, if (model.pat_flip) .jumping else .waving, pat_react_ms, fx);
                    return;
                }
                const velocity = releaseVelocity(model) orelse {
                    model.sample_len = 0;
                    saveSettings(model);
                    return;
                };
                model.sample_len = 0;
                if (@abs(velocity.x) < 1 and @abs(velocity.y) < 1) {
                    // A plain drop (no throw): the pet rests here.
                    saveSettings(model);
                    return;
                }
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
                model.press_x = read.x;
                model.press_y = read.y;
                model.press_ms = now;
                model.sample_len = 0;
                pushSample(model, read.x, read.y, now);
            }
            model.primary_was_down = read.primary_down;
        },
        .poll_tick => |timer| {
            if (timer.outcome != .fired) return;
            // Ahead of the sheet guard on purpose: a machine with no pet
            // installed has no sheet, and that is precisely when a
            // `petdex://<slug>` link has work to do.
            drainPendingInstall(model, fx);
            if (!model.sheet_loaded) return;
            if (model.settings_open and thumbs_built < catalog_mod.catalog_len) buildNextThumb(fx);
            const now = fx.wallMs();
            var drained: [hook_server.max_bubbles]hook_server.Bubble = undefined;
            if (hook_server.mailbox.takeBubbles(&drained)) |count| {
                if (!model.bubbles_enabled or model.focus_mode) {
                    clearBubble(model);
                } else {
                    // Deadlines are matched against the outgoing stack,
                    // so the copy has to happen before it is overwritten.
                    const previous = model.bubbles;
                    const previous_deadlines = model.bubble_expires_at_ms;
                    const previous_len = model.bubbles_len;
                    @memcpy(model.bubbles[0..count], drained[0..count]);
                    for (count..hook_server.max_bubbles) |i| model.bubbles[i] = .{};
                    model.bubbles_len = count;
                    syncBubbleDeadlines(model, previous[0..previous_len], previous_deadlines[0..previous_len], now);
                    if (newestBubble(model)) |newest| {
                        loadAgentAvatar(newest.agent[0..newest.agent_len], model.dark, fx);
                        registerTail(model.dark, fx);
                    }
                    // The stacked cards read their logos out of the
                    // shared strip, which until now only settings ever
                    // loaded. A second conversation must not have to
                    // wait for the settings window to get its avatar.
                    if (model.bubbles_len > 1) loadAgentsAtlas(model.dark, fx);
                }
            }
            _ = expireBubbles(model, now);
            if (model.waiting_sound and shouldEscalate(model.state, model.waiting_since_ms, model.waiting_escalated, now)) {
                model.waiting_escalated = true;
                playWaitingChime(fx);
            }
            // Daily rotation: fires on the first tick of a new
            // epoch-day (boot included, so an app that slept through
            // midnight — or was closed — still rotates when it next
            // runs). select_pet inside advancePet stamps today and
            // persists, closing the loop.
            if (model.rotate_pets and model.rotation_day != dayFromWallMs(now)) {
                model.rotation_day = dayFromWallMs(now);
                advancePet(model, fx);
            }
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
    if (std.mem.eql(u8, name, "petdex.quit")) return .quit_app;
    if (std.mem.eql(u8, name, "petdex.focus")) return .toggle_focus_mode;
    if (std.mem.eql(u8, name, "petdex.shuffle")) return .shuffle_pet;
    return null;
}

// ------------------------------------------------------------------- view

pub const AppUi = canvas.Ui(Msg);

const pet_menu = [_]AppUi.ContextMenuItem{
    .{ .label = "Open Settings", .msg = .open_settings },
    .{ .label = "Close Pet", .msg = .close_pet },
};

// The visible card remains intrinsic and grows only with the text it actually
// contains. These values size the surrounding transparent canvas generously
// enough for the configured maximum; one full em per character also covers
// CJK glyphs, unlike the previous 0.62 Latin-average estimate.
const bubble_columns_default: u16 = 40;
pub const bubble_columns_min: u16 = 8;
pub const bubble_columns_max: u16 = 120;
const bubble_answer_lines_default: u8 = 2;
pub const bubble_answer_lines_min: u8 = 1;
pub const bubble_answer_lines_max: u8 = 8;
const bubble_avatar_width: f32 = 20;
const bubble_busy_width: f32 = 16;
const bubble_content_gap: f32 = 8;
const bubble_card_padding: f32 = 12;
const bubble_head_gap: f32 = 12;
const bubble_line_gap: f32 = 2;
/// Vertical breathing room between stacked conversation cards.
const bubble_stack_gap: f32 = 6;
const bubble_canvas_margin: f32 = 16;

const bubble_lifetime_default_secs: f32 = 0;
const bubble_lifetime_min_secs: f32 = 0;
const bubble_lifetime_max_secs: f32 = 60;

fn clampBubbleLifetime(value: f32) f32 {
    if (!std.math.isFinite(value)) return bubble_lifetime_default_secs;
    return std.math.clamp(@round(value), bubble_lifetime_min_secs, bubble_lifetime_max_secs);
}

fn bubbleDeadlineMs(now_ms: i64, lifetime_secs: f32) i64 {
    const seconds = clampBubbleLifetime(lifetime_secs);
    return if (seconds == 0) -1 else now_ms + @as(i64, @intFromFloat(seconds * 1000));
}

fn bubbleExpiryMs(now_ms: i64, lifetime_secs: f32, busy: bool) i64 {
    return if (busy) -1 else bubbleDeadlineMs(now_ms, lifetime_secs);
}

fn bubbleLifetimeExpired(deadline_ms: i64, now_ms: i64, state: State) bool {
    return state != .waiting and deadline_ms >= 0 and now_ms >= deadline_ms;
}

fn bubbleMaxCardWidth(model: *const Model) f32 {
    const text_capacity = @as(f32, @floatFromInt(model.bubble_columns)) * bubbleFontSize(model);
    return @ceil(text_capacity + bubble_avatar_width + bubble_busy_width + bubble_content_gap * 2 + bubble_card_padding * 2);
}

fn bubbleMaxCardHeight(model: *const Model) f32 {
    const rows = @as(f32, @floatFromInt(@as(u16, model.bubble_answer_lines) + 1));
    const line_height = bubbleFontSize(model) * 1.35;
    return @ceil(rows * line_height + (rows - 1) * bubble_line_gap + bubble_card_padding * 2);
}

/// Widest line a card actually holds, in characters: the title and the
/// wrapped answer lines are already what the view paints, so measuring
/// them is measuring the card. Same char-count-times-font-size metric
/// bubbleMaxCardWidth uses for the column budget, just applied to the
/// real content instead of the worst case.
fn bubbleContentChars(model: *const Model, slot: usize) usize {
    const bubble = &model.bubbles[slot];
    const chars_per_line: usize = model.bubble_columns;
    const answer_lines: usize = model.bubble_answer_lines;
    var widest = charCount(clipDisplay(bubble.title[0..bubble.title_len], chars_per_line, &bubble_title_scratch[slot], false));
    const text_clipped = clipDisplay(bubble.text[0..bubble.text_len], chars_per_line * answer_lines, &bubble_text_scratch[slot], true);
    for (splitLines(text_clipped, chars_per_line, answer_lines)) |line| {
        widest = @max(widest, charCount(line));
    }
    return widest;
}

/// A card hugs its content, capped by the column budget: short bubbles
/// stop reserving a full-width card, long ones wrap exactly as before.
fn bubbleCardWidth(model: *const Model, slot: usize) f32 {
    const text_w = @as(f32, @floatFromInt(bubbleContentChars(model, slot))) * bubbleFontSize(model);
    const natural = @ceil(text_w + bubble_avatar_width + bubble_busy_width + bubble_content_gap * 2 + bubble_card_padding * 2);
    return @min(natural, bubbleMaxCardWidth(model));
}

/// The window fits the widest card in the stack, so narrow cards can
/// center under it and the tail keeps pointing at the pet.
fn bubbleStackWidth(model: *const Model) f32 {
    var widest: f32 = 0;
    for (0..model.bubbles_len) |i| widest = @max(widest, bubbleCardWidth(model, i));
    return widest;
}

fn bubbleWindowWidth(model: *const Model) f32 {
    const content = if (model.bubbles_len == 0) bubbleMaxCardWidth(model) else bubbleStackWidth(model);
    return content + bubble_canvas_margin * 2;
}

/// The window is sized off the worst case, not the text actually in the
/// cards, so a stack of N reserves N max-height cards and the gaps
/// between them. At least one: the window exists a frame before the
/// first bubble lands and must not be born zero-height.
fn bubbleWindowHeight(model: *const Model) f32 {
    const count: f32 = @floatFromInt(@max(model.bubbles_len, 1));
    const cards = bubbleMaxCardHeight(model) * count + bubble_stack_gap * (count - 1);
    return cards + @as(f32, @floatFromInt(tail_h)) + bubble_head_gap + bubble_canvas_margin * 2;
}

fn bubbleFontSize(model: *const Model) f32 {
    // Font size is an explicit user preference. The pet scale still controls
    // the bubble geometry, but must not silently override this setting.
    return std.math.clamp(model.bubble_text_px, bubble_text_min_px, bubble_text_max_px);
}

/// Bubble text size bounds shared by all desktop platforms.
pub const bubble_text_min_px: f32 = 8;
pub const bubble_text_max_px: f32 = 20;
/// The size the bubble shipped at before the slider existed, and the
/// floor the range used to have. #625 lowered the minimum to 8 for people
/// who want a denser bubble, but left the default pinned to the minimum,
/// so every install silently shrank to 8 and the slider sat hard left.
/// The default is its own value now: widening the range must not move
/// what a fresh install looks like.
pub const bubble_text_default_px: f32 = 13;

/// Count display characters (UTF-8 sequences, not bytes).
fn charCount(text: []const u8) usize {
    var n: usize = 0;
    for (text) |b| {
        if ((b & 0xC0) != 0x80) n += 1;
    }
    return n;
}

// One scratch pair PER stacked card: the view's byte slices must
// outlive the frame build, so cards cannot share a buffer the way a
// single bubble could.
var bubble_title_scratch: [hook_server.max_bubbles][280]u8 = undefined;
var bubble_text_scratch: [hook_server.max_bubbles][280]u8 = undefined;

/// Clip to `max_chars` on a safe boundary: never mid UTF-8 sequence,
/// never splitting a JSON escape, preferring the last word boundary
/// within reach, optionally appending an ellipsis into `scratch` (globals:
/// the view's byte slices must outlive the frame build).
fn clipDisplay(text: []const u8, max_chars: usize, scratch: []u8, append_ellipsis: bool) []const u8 {
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
    const ell = if (append_ellipsis) "\u{2026}" else "";
    const total = @min(cut, scratch.len - ell.len);
    @memcpy(scratch[0..total], text[0..total]);
    @memcpy(scratch[total .. total + ell.len], ell);
    return scratch[0 .. total + ell.len];
}

/// Split into explicit single-line nodes, so measure equals paint and the
/// configured answer-line count is an actual layout contract.
fn splitLines(text: []const u8, max_chars: usize, max_lines: usize) [bubble_answer_lines_max][]const u8 {
    var lines: [bubble_answer_lines_max][]const u8 = @splat("");
    var remaining = std.mem.trim(u8, text, " ");
    var line_index: usize = 0;
    while (remaining.len > 0 and line_index < @min(max_lines, bubble_answer_lines_max)) : (line_index += 1) {
        if (charCount(remaining) <= max_chars) {
            lines[line_index] = remaining;
            break;
        }
        var chars: usize = 0;
        var hard_cut: usize = remaining.len;
        for (remaining, 0..) |b, i| {
            if ((b & 0xC0) != 0x80) {
                if (chars == max_chars) {
                    hard_cut = i;
                    break;
                }
                chars += 1;
            }
        }
        var cut = hard_cut;
        if (std.mem.lastIndexOfScalar(u8, remaining[0..hard_cut], ' ')) |sp| {
            if (hard_cut - sp <= 14) cut = sp;
        }
        lines[line_index] = std.mem.trim(u8, remaining[0..cut], " ");
        remaining = std.mem.trim(u8, remaining[cut..], " ");
    }
    return lines;
}
fn bubbleActive(model: *const Model) bool {
    return model.bubbles_enabled and !model.focus_mode and model.bubbles_len > 0;
}

/// The bubble drawn closest to the pet, i.e. the one the tail points at
/// and the only one the single avatar slot can serve. Null when the
/// stack is empty.
fn newestBubble(model: *const Model) ?*const hook_server.Bubble {
    if (model.bubbles_len == 0) return null;
    return &model.bubbles[model.bubbles_len - 1];
}

fn clearBubble(model: *Model) void {
    model.bubbles = @splat(.{});
    model.bubbles_len = 0;
    model.bubble_expires_at_ms = @splat(-1);
    hook_server.mailbox.clearBubbles();
}

/// Drop every bubble whose deadline has passed, compacting the stack so
/// the survivors stay dense and ordered. Returns whether anything went,
/// since an emptied stack has to tear its window down.
fn expireBubbles(model: *Model, now_ms: i64) bool {
    var kept: usize = 0;
    var dropped = false;
    for (0..model.bubbles_len) |i| {
        if (bubbleLifetimeExpired(model.bubble_expires_at_ms[i], now_ms, model.state)) {
            // Tell the server too: a slot the app stopped drawing must
            // not keep a session alive against the eviction policy.
            hook_server.mailbox.dropBubble(model.bubbles[i].sessionSlice());
            dropped = true;
            continue;
        }
        model.bubbles[kept] = model.bubbles[i];
        model.bubble_expires_at_ms[kept] = model.bubble_expires_at_ms[i];
        kept += 1;
    }
    for (kept..model.bubbles_len) |i| {
        model.bubbles[i] = .{};
        model.bubble_expires_at_ms[i] = -1;
    }
    model.bubbles_len = kept;
    return dropped;
}

/// Re-key the deadlines onto a freshly drained stack. The mailbox owns
/// membership and order, so a bubble that was already on screen keeps
/// the deadline it had (re-stamping it on every unrelated update would
/// make a quiet session immortal), and only new or changed entries get
/// a fresh one.
fn syncBubbleDeadlines(model: *Model, previous: []const hook_server.Bubble, previous_deadlines: []const i64, now_ms: i64) void {
    for (0..model.bubbles_len) |i| {
        const fresh = bubbleExpiryMs(now_ms, model.bubble_lifetime_secs, model.bubbles[i].busy);
        model.bubble_expires_at_ms[i] = fresh;
        for (previous, previous_deadlines) |old, deadline| {
            if (!std.mem.eql(u8, old.sessionSlice(), model.bubbles[i].sessionSlice())) continue;
            if (old.counter == model.bubbles[i].counter) model.bubble_expires_at_ms[i] = deadline;
            break;
        }
    }
    for (model.bubbles_len..hook_server.max_bubbles) |i| model.bubble_expires_at_ms[i] = -1;
}

/// The window tracks exactly what is drawn: the sprite, plus a band
/// above it while a bubble is showing (kept at least bubble-wide so
/// the text can wrap like the old 190px-capped tooltip).
fn fitWindow(model: *const Model, fx: *Effects) bool {
    return fx.resizeWindow("main", frame_w * model.scale, frame_h * model.scale, .bottom_center);
}

/// Track the bubble window's last known size so a settings change that
/// grows the card can grow the window with it. The window is created
/// once at its then-current size; without this it keeps that size
/// forever and a larger card renders off its right edge while the tail
/// points at nothing.
var bubble_window_w: f32 = 0;
var bubble_window_h: f32 = 0;

/// Keep the bubble window glued above the pet and sized to its content:
/// read both origins and close the gap. Self-correcting, so drags,
/// throws, scale changes, and text-size changes all need no
/// special-casing.
fn syncBubbleWindow(model: *const Model, fx: *Effects) void {
    if (!bubbleActive(model)) return;
    const bubble_w = bubbleWindowWidth(model);
    const bubble_h = bubbleWindowHeight(model);
    // Resize before moving: the move centers on the new width, so doing
    // it the other way round centers on the old one and leaves the
    // bubble offset by half the delta.
    if (@abs(bubble_w - bubble_window_w) > 0.5 or @abs(bubble_h - bubble_window_h) > 0.5) {
        _ = fx.resizeWindow("bubble", bubble_w, bubble_h, .top_left);
        bubble_window_w = bubble_w;
        bubble_window_h = bubble_h;
    }
    const cur = fx.moveWindow("bubble", 0, 0, false) orelse return;
    const pet_w = frame_w * model.scale;
    const want_x = model.pet_x + pet_w / 2.0 - bubble_w / 2.0;
    const want_y = model.pet_y - bubble_h + 2.0;
    const dx = want_x - cur.x;
    const dy = want_y - cur.y;
    if (@abs(dx) > 0.5 or @abs(dy) > 0.5) {
        _ = fx.moveWindow("bubble", dx, dy, false);
    }
}

/// What the pet window shows before there is a pet to draw.
///
/// This used to be a bare panel: a grey rectangle with no text and no
/// action, which reads as a broken app rather than an empty one. The two
/// ways to get here need different answers, and the code already knew
/// the difference — it just said so in a debug print nobody sees.
///
/// Nothing installed is the first-run case, and it gets a button. The
/// download rides the same queue a `petdex://` link uses instead of
/// bundling a sheet into every binary: boba is ~2MB against a 4.5MB
/// executable, which is a permanent 43% for a state that ends the moment
/// someone picks a pet.
///
/// Pets installed but none decoded is the other case, and on Linux it is
/// the common one: gdk-pixbuf needs a loader plugin per format and
/// Ubuntu ships none for webp, so every pet fails while sitting right
/// there on disk. Offering that user a download sends them in exactly
/// the wrong direction.
fn emptyStateView(ui: *AppUi, model: *const Model) AppUi.Node {
    const has_pets = catalog_mod.catalog_len > 0;
    // The pet window is 192pt wide, so these have to fit a narrow column
    // rather than a sentence's worth of room: the first attempt read
    // "Pets found, none could be drawn. Linux needs webp-pixbuf-loader."
    // and rendered as an ellipsis. Newlines rather than one long line,
    // since the label truncates instead of wrapping.
    const body = if (!has_pets)
        "No pet yet"
    else if (builtin.os.tag == .linux)
        "Pets found,\nnone could\nbe drawn.\n\nLinux needs\nwebp-pixbuf-\nloader."
    else
        "Pets found,\nnone could\nbe drawn.\n\nThe sheet may\nbe corrupt.";

    // style_tokens rather than a literal colour: the muted token already
    // tracks the theme, which is the same reason the settings rows use it.
    const label = ui.text(.{
        .size = .sm,
        .text_alignment = .center,
        .style_tokens = .{ .foreground = .text_muted },
    }, body);

    var children: [3]AppUi.Node = undefined;
    var count: usize = 0;
    children[count] = label;
    count += 1;
    if (!has_pets) {
        children[count] = ui.button(.{
            .size = .sm,
            .variant = .primary,
            .on_press = Msg.install_first_pet,
        }, if (model.install.busy()) "Downloading..." else "Get a pet");
        count += 1;
    }
    if (model.install.error_len > 0) {
        // Same literal the settings banner uses: the token set has no
        // error colour, so matching it keeps the two error surfaces
        // reading as one thing.
        var err = ui.text(.{ .size = .sm, .text_alignment = .center }, model.install.errorSlice());
        err.widget.style.foreground = canvas.Color.rgb8(250, 105, 94);
        children[count] = err;
        count += 1;
    }

    return ui.panel(.{
        .width = frame_w,
        .height = frame_h,
        .padding = 16,
        .semantics = .{ .label = "No pet installed" },
    }, .{ui.column(.{ .grow = 1, .main = .center, .cross = .center, .gap = 10 }, children[0..count])});
}

pub fn rootView(ui: *AppUi, model: *const Model) AppUi.Node {
    if (!model.sheet_loaded) return emptyStateView(ui, model);
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

/// One conversation's card. `slot` indexes the per-card clip scratch and
/// decides whether this is the newest bubble, which is the only one the
/// single avatar registry slot can speak for.
fn bubbleCard(ui: *AppUi, model: *const Model, slot: usize) AppUi.Node {
    const bubble = &model.bubbles[slot];
    const newest = slot + 1 == model.bubbles_len;
    const chars_per_line: usize = model.bubble_columns;
    const answer_lines: usize = model.bubble_answer_lines;
    const title_raw = bubble.title[0..bubble.title_len];
    const text_raw = bubble.text[0..bubble.text_len];
    const title_clipped = clipDisplay(title_raw, chars_per_line, &bubble_title_scratch[slot], false);
    const text_clipped = clipDisplay(text_raw, chars_per_line * answer_lines, &bubble_text_scratch[slot], true);
    const text_lines = splitLines(text_clipped, chars_per_line, answer_lines);

    const title_fg = if (model.dark) canvas.Color.rgb8(237, 237, 238) else canvas.Color.rgb8(17, 17, 17);
    const muted_fg = if (model.dark) canvas.Color.rgb8(156, 158, 168) else canvas.Color.rgb8(88, 92, 106);
    const text_fg = if (title_clipped.len > 0) muted_fg else title_fg;

    // One question/title line plus the configured number of answer lines.
    var rows: [1 + bubble_answer_lines_max]AppUi.Node = undefined;
    var row_count: usize = 0;
    if (title_clipped.len > 0) {
        var node2 = ui.paragraph(.{ .size = .heading }, &.{.{ .text = title_clipped, .weight = .bold }});
        node2.widget.style.foreground = title_fg;
        rows[row_count] = node2;
        row_count += 1;
    }
    for (text_lines) |line| {
        if (line.len == 0) continue;
        var node2 = ui.text(.{ .size = .heading }, line);
        node2.widget.style.foreground = text_fg;
        rows[row_count] = node2;
        row_count += 1;
    }

    // The newest card keeps the dedicated registry slot: it is a
    // full-resolution decode of the agent's own PNG (fallback art
    // included), which is strictly better than a strip cell, so the card
    // Hunter looks at most never degrades. Older cards read their logo
    // out of the shared strip via image_src, the same addressing
    // settings_view uses for its rows. An agent with no cell in the
    // strip draws an empty box of the same width, so the column still
    // lines up.
    const agent_name = bubble.agent[0..bubble.agent_len];
    const avatar = if (newest) blk: {
        var img = ui.image(.{
            .width = bubble_avatar_width,
            .height = bubble_avatar_width,
            .image = if (avatar_ready) avatar_image_id else 0,
            .semantics = .{ .label = "Agent avatar" },
        });
        img.widget.image_fit = .contain;
        break :blk img;
    } else if (agents_icons_ready and agentIconIndex(agent_name) != null) blk: {
        var img = ui.image(.{
            .width = bubble_avatar_width,
            .height = bubble_avatar_width,
            .image = agent_icon_atlas_id,
            .semantics = .{ .label = "Agent avatar" },
        });
        img.widget.image_src = agentIconRect(agentIconIndex(agent_name).?);
        img.widget.image_fit = .contain;
        break :blk img;
    } else ui.el(.stack, .{ .width = bubble_avatar_width, .height = bubble_avatar_width }, .{});
    // Keep a stable trailing slot: active work animates the original
    // spinner, while a waiting permission/input request shows a static
    // marker without waking the frame loop or shifting the bubble text.
    var waiting_marker = ui.text(.{ .size = .heading }, "!");
    waiting_marker.widget.style.foreground = canvas.Color.rgb8(250, 170, 48);
    // Busy is per-conversation, but the pet's `waiting` state is global:
    // it belongs to the newest card only, or every settled card in the
    // stack would grow a marker for one session's prompt.
    const spinner_slot = if (bubble.busy)
        ui.el(.spinner, .{ .width = bubble_busy_width, .height = bubble_busy_width, .semantics = .{ .label = "Working" } }, .{})
    else if (newest and model.state == .waiting)
        ui.el(.stack, .{
            .width = 16,
            .height = 16,
            .main = .center,
            .cross = .center,
            .semantics = .{ .label = "Approval or input required" },
        }, .{waiting_marker})
    else
        ui.el(.stack, .{ .width = bubble_busy_width, .height = bubble_busy_width }, .{});

    // Explicit width instead of letting the row size itself: the window
    // is sized off bubbleCardWidth, so the card has to agree with that
    // number or a stack of mixed lengths drifts against its own window.
    // The outer column centers whatever is narrower than the widest.
    var card = ui.el(.panel, .{
        .padding = bubble_card_padding,
        .width = bubbleCardWidth(model, slot),
    }, .{
        ui.row(.{ .gap = bubble_content_gap, .cross = .center }, .{
            avatar,
            ui.column(.{ .grow = 1, .gap = bubble_line_gap, .cross = .start }, @as([]const AppUi.Node, rows[0..row_count])),
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
        // Light mode needs the outline more than dark does, not less: a
        // white card floats over a white editor with no silhouette, and
        // the tail is the first part to disappear because it is the
        // narrowest. Matches the tail hairline in registerTail.
        card.widget.style.border = canvas.Color.rgb8(214, 214, 220);
        card.widget.style.stroke_width = 1;
    }
    return card;
}

/// The stack: one card per live conversation, oldest at the top, the
/// most recently updated at the bottom where the tail is. Only the
/// bottom card gets a tail, so the group reads as one speech bubble
/// coming from the pet rather than N arrows fighting for the same spot.
fn bubbleView(ui: *AppUi, model: *const Model) AppUi.Node {
    var cards: [1 + hook_server.max_bubbles * 2]AppUi.Node = undefined;
    var count: usize = 0;
    for (0..model.bubbles_len) |i| {
        if (i > 0) {
            cards[count] = ui.el(.stack, .{ .width = 1, .height = bubble_stack_gap }, .{});
            count += 1;
        }
        cards[count] = bubbleCard(ui, model, i);
        count += 1;
    }

    var tail = ui.image(.{
        .width = @floatFromInt(tail_w),
        .height = @floatFromInt(tail_h),
        .image = if (tail_ready) tail_image_id else 0,
    });
    tail.widget.image_fit = .contain;
    // Pure translation (no rotation, so no canvas-origin surprises):
    // the tail rides up over the card's bottom hairline, hiding the
    // border segment behind it so bubble and arrow read as one shape.
    tail.widget.transform = canvas.Affine.translate(0, -1.5);
    cards[count] = tail;
    count += 1;

    // The bottom spacer is an explicit head gap. Keeping the group
    // bottom-aligned avoids turning unused band height into a large,
    // theme- or text-dependent distance from the pet.
    return ui.column(.{ .grow = 1, .main = .end, .cross = .center }, .{
        ui.column(.{ .cross = .center }, @as([]const AppUi.Node, cards[0..count])),
        ui.el(.stack, .{ .width = 1, .height = bubble_head_gap }, .{}),
    });
}

// --------------------------------------------------------- settings window

const settings_window_label = "settings";
const settings_canvas_label = "settings-canvas";

fn petdexWindows(model: *const Model, scratch: *PetdexApp.WindowsScratch) []const PetdexApp.WindowDescriptor {
    var count: usize = 0;
    if (bubbleActive(model)) {
        const bubble_w = bubbleWindowWidth(model);
        const bubble_h = bubbleWindowHeight(model);
        scratch.windows[count] = .{
            .label = "bubble",
            .canvas_label = "bubble-canvas",
            .title = "",
            .width = bubble_w,
            .height = bubble_h,
            .x = @floatCast(model.pet_x + (frame_w * model.scale) / 2.0 - bubble_w / 2.0),
            .y = @floatCast(model.pet_y - bubble_h + 2.0),
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
    return settings_view.settingsView(ui, model, .{
        .ready = agents_icons_ready,
        .image = agent_icon_atlas_id,
        .rect = &agentIconRect,
    }, .{
        .image = thumb_atlas_id,
        .ready = &thumbs_ready,
        .cell_w = @floatFromInt(thumb_w),
        .cell_h = @floatFromInt(thumb_h),
    });
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

/// Menu-bar extra: Petdex's persistent handle. With the Dock icon
/// hidden the app has no menu bar of its own, so this is the only
/// always-reachable way to Settings and Quit; it is installed
/// unconditionally so the hide-Dock toggle can never strand the user.
/// Model-derived (the `status_item_fn` shape) so Focus Mode can show
/// its state in the label; the static options keep icon and tooltip.
fn petdexStatusItem(model: *const Model, scratch: *PetdexApp.StatusItemScratch) PetdexApp.StatusItemState {
    scratch.items[0] = .{ .id = 1, .label = "Open Settings", .command = "petdex.settings" };
    scratch.items[1] = .{
        .id = 2,
        .label = if (model.focus_mode) "Focus Mode: On" else "Focus Mode: Off",
        .command = "petdex.focus",
    };
    scratch.items[2] = .{ .id = 3, .label = "Shuffle Pet", .command = "petdex.shuffle" };
    scratch.items[3] = .{ .id = 4, .separator = true };
    scratch.items[4] = .{ .id = 5, .label = "Quit Petdex", .command = "petdex.quit" };
    return .{ .items = scratch.items[0..5] };
}

/// The menu-bar button icon: the brand mark's silhouette with the face
/// punched out (the host loads it as a template image, so only alpha
/// survives). The platform gets a PATH, not bytes, and a relative path
/// dies the moment Finder launches the bundle with cwd=/ — so the
/// embedded PNG is materialized into the runtime dir at boot and the
/// tray points at that absolute path. Missing HOME or a failed write
/// degrade to the host's title fallback ("P"), never a broken item.
const tray_icon_png = @embedFile("assets/tray-icon.png");
var tray_icon_path_buf: [512]u8 = undefined;
var tray_icon_path: []const u8 = "";

fn materializeTrayIcon() void {
    const home = env_home orelse return;
    var dir_buf: [512]u8 = undefined;
    const dir = std.fmt.bufPrint(&dir_buf, "{s}/.petdex/runtime", .{home}) catch return;
    plat.makeDir(dir);
    const path = std.fmt.bufPrint(&tray_icon_path_buf, "{s}/.petdex/runtime/tray-icon.png", .{home}) catch return;
    if (plat.writeFile(path, tray_icon_png)) tray_icon_path = path;
}

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
    // Claude Code honors CLAUDE_CONFIG_DIR for fully isolated installs;
    // wiring hooks into ~/.claude for those users writes a settings.json
    // their Claude Code never reads, and detection shows them as
    // disconnected after a successful connect (#601).
    agent_hooks.env_claude_config_dir = init.environ_map.get("CLAUDE_CONFIG_DIR");
    // Kimi Code relocates its whole config with KIMI_CODE_HOME, so the
    // same blind spot #601 described applies: hooks written to the
    // default dir would land somewhere it never reads.
    agent_hooks.env_kimi_code_home = init.environ_map.get("KIMI_CODE_HOME");
    agent_hooks.env_pi_coding_agent_dir = init.environ_map.get("PI_CODING_AGENT_DIR");
    // Qoder's two builds each resolve their root through two variables, and the
    // prefix differs per build (QODER_* vs QODERCN_*). Unlike every other
    // touchpoint for these agents, nothing here is compiler-enforced: omit a
    // line and the app still builds, the tests still pass (they set the globals
    // directly), and the only symptom is hooks written to a root that install
    // never reads.
    agent_hooks.env_qoder_config_dir = init.environ_map.get("QODER_CONFIG_DIR");
    agent_hooks.env_qoder_cn_config_dir = init.environ_map.get("QODERCN_CONFIG_DIR");
    agent_hooks.env_qoder_cli_home = init.environ_map.get("QODER_CLI_HOME");
    agent_hooks.env_qoder_cn_cli_home = init.environ_map.get("QODERCN_CLI_HOME");
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
    materializeTrayIcon();
    env_wanted_pet = init.environ_map.get("PETDEX_PET");
    boot_io = init.io;
    resolveInitialPet(init.io, boot_allocator, init.environ_map) catch |err| {
        std.debug.print("petdex: no pet found ({s}); install one with `petdex install <pet>`\n", .{@errorName(err)});
    };
    var custom_font_bytes: ?[]u8 = null;
    defer if (custom_font_bytes) |bytes| boot_allocator.free(bytes);
    var font_registrations: [1]PetdexApp.FontRegistration = undefined;
    var app_fonts: []const PetdexApp.FontRegistration = &.{};
    if (initial_font_path_len > 0) {
        const path = initial_font_path[0..initial_font_path_len];
        if (plat.readFileAlloc(boot_allocator, path, max_custom_font_bytes)) |bytes| {
            if (canvas.font_ttf.parseFailureReason(bytes) == null) {
                custom_font_bytes = bytes;
                custom_font_active = true;
                font_registrations[0] = .{
                    .id = custom_font_id,
                    .name = path,
                    .ttf = bytes,
                };
                app_fonts = font_registrations[0..];
            } else {
                boot_allocator.free(bytes);
                initial_font_load_failed = true;
            }
        } else {
            initial_font_load_failed = true;
        }
    }
    const app_state = try PetdexApp.create(std.heap.page_allocator, .{
        .name = "petdex-desktop-native",
        .scene = shell_scene,
        .canvas_label = canvas_label,
        .update_fx = update,
        .init_fx = boot,
        .view = rootView,
        .on_key = onKey,
        .on_command = onCommand,
        .status_item = .{
            .icon_path = tray_icon_path,
            .tooltip = "Petdex",
        },
        .status_item_fn = petdexStatusItem,
        .on_frame = onFrame,
        .on_urls_opened = onUrlsOpened,
        .windows_fn = petdexWindows,
        .window_view = petdexWindowView,
        .tokens_fn = petdexTokens,
        .fonts = app_fonts,
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

test "every agent gets its own cell in the icon strip" {
    // One slot holds them all, so a wrong offset silently draws the
    // neighbouring agent's logo rather than failing to register.
    for (0..agent_hooks.agent_count) |i| {
        const rect = agentIconRect(i);
        try std.testing.expectEqual(@as(f32, @floatFromInt(i * agent_icon_px)), rect.x);
        try std.testing.expectEqual(@as(f32, 0), rect.y);
        try std.testing.expectEqual(@as(f32, agent_icon_px), rect.width);
        try std.testing.expectEqual(@as(f32, agent_icon_px), rect.height);
    }
    // Cells abut with no overlap: agent N ends exactly where N+1 begins.
    if (agent_hooks.agent_count >= 2) {
        const first = agentIconRect(0);
        const second = agentIconRect(1);
        try std.testing.expectEqual(first.x + first.width, second.x);
    }
    // The packed strip stays inside the SDK's per-image bounds, which is
    // the ceiling this atlas exists to avoid running into again.
    const atlas_w = agent_hooks.agent_count * agent_icon_px;
    try std.testing.expect(atlas_w * agent_icon_px * 4 <= 1024 * 1024);
    try std.testing.expect(atlas_w <= 512 * 512);
}

test "one image slot covers every agent" {
    // agent_art is what loadAgentsAtlas walks, so a new AgentKind without
    // artwork would pack short and leave the last agent blank.
    try std.testing.expectEqual(agent_hooks.agent_count, agent_art.len);
}

test "activating index 0 works before any sheet is loaded" {
    // Two bugs met here on a first run. `active_pet` starts at 0 and the
    // first downloaded pet lands at index 0, so an `index == active_pet`
    // early return skipped the activation the empty state exists to
    // perform, and `sheet_loaded` never flipped because select_pet
    // assumed a sheet was already up. Both failed silently: the pet
    // downloaded to disk and the window kept drawing the empty state.
    const fresh: Model = .{};
    try std.testing.expectEqual(@as(u32, 0), fresh.active_pet);
    try std.testing.expect(!fresh.sheet_loaded);
    // The guard has to consider both, not just the index.
    const would_skip_before = 0 == fresh.active_pet;
    const would_skip_now = 0 == fresh.active_pet and fresh.sheet_loaded;
    try std.testing.expect(would_skip_before);
    try std.testing.expect(!would_skip_now);
}

test "empty-state copy fits the pet window" {
    // The label truncates rather than wrapping, and the window is 192pt,
    // so a sentence renders as an ellipsis (which is how the first
    // attempt shipped). Every line has to stand alone.
    const longest = "Pets found,\nnone could\nbe drawn.\n\nLinux needs\nwebp-pixbuf-\nloader.";
    var it = std.mem.splitScalar(u8, longest, '\n');
    while (it.next()) |line| {
        try std.testing.expect(line.len <= 14);
    }
}

test "bubble text default is its own value, not the range floor" {
    // #625 widened the range down to 8 while the default still read
    // `min`, so every install shrank and the slider sat hard left. The
    // default must survive the next range change too.
    try std.testing.expectEqual(@as(f32, 13), bubble_text_default_px);
    try std.testing.expect(bubble_text_default_px > bubble_text_min_px);
    try std.testing.expect(bubble_text_default_px < bubble_text_max_px);
    // A fresh model renders at the default, and the slider reflects it
    // somewhere in the middle rather than at either end.
    const fresh: Model = .{};
    try std.testing.expectEqual(bubble_text_default_px, fresh.bubble_text_px);
    const fraction = (fresh.bubble_text_px - bubble_text_min_px) / (bubble_text_max_px - bubble_text_min_px);
    try std.testing.expect(fraction > 0.2 and fraction < 0.8);
}

test "waiting escalation pings once, only while still waiting" {
    // Not yet due.
    try std.testing.expect(!shouldEscalate(.waiting, 0, false, waiting_escalation_ms - 1));
    // Due, not yet fired.
    try std.testing.expect(shouldEscalate(.waiting, 0, false, waiting_escalation_ms));
    // Already fired: never again this spell.
    try std.testing.expect(!shouldEscalate(.waiting, 0, true, waiting_escalation_ms * 2));
    // The user answered; the spell is over.
    try std.testing.expect(!shouldEscalate(.idle, 0, false, waiting_escalation_ms));
}

test "waiting chime fires only on the transition into waiting" {
    try std.testing.expect(shouldChime(.running, .waiting));
    try std.testing.expect(shouldChime(.idle, .waiting));
    // Re-posted waiting while the prompt is still up: stay quiet.
    try std.testing.expect(!shouldChime(.waiting, .waiting));
    // Leaving waiting never chimes.
    try std.testing.expect(!shouldChime(.waiting, .idle));
    try std.testing.expect(!shouldChime(.running, .idle));
}

test {
    // `zig build test` only collects tests from the root module FILE,
    // and imports are analyzed lazily — so without these references
    // every test in the imported files (18 today, across agent_hooks,
    // hook_runner and installer) compiled green and never ran. This
    // block is the standard aggregator: referencing the imports forces
    // their semantic analysis, which is what registers their tests.
    _ = agent_hooks;
    _ = hook_runner;
    _ = hook_server;
    _ = installer;
    _ = plat;
}

test "bubble geometry follows columns lines and font size" {
    var model: Model = .{};
    try std.testing.expectEqual(bubble_columns_default, model.bubble_columns);
    try std.testing.expectEqual(bubble_answer_lines_default, model.bubble_answer_lines);
    const default_width = bubbleWindowWidth(&model);
    const default_height = bubbleWindowHeight(&model);
    model.bubble_columns = 60;
    try std.testing.expect(bubbleWindowWidth(&model) > default_width);
    model.bubble_answer_lines = 4;
    try std.testing.expect(bubbleWindowHeight(&model) > default_height);
    model.bubble_text_px = bubble_text_max_px;
    try std.testing.expect(bubbleWindowWidth(&model) > default_width);
    try std.testing.expect(bubbleWindowHeight(&model) > default_height);
}

test "custom font path round-trips through settings JSON escaping" {
    const path = "C:\\Users\\名字\\Font \"Regular\".ttf";
    var escaped_buf: [256]u8 = undefined;
    const escaped = jsonEscapeString(path, &escaped_buf).?;
    try std.testing.expectEqualStrings("C:\\\\Users\\\\名字\\\\Font \\\"Regular\\\".ttf", escaped);
    var decoded_buf: [256]u8 = undefined;
    try std.testing.expectEqualStrings(path, jsonUnescapeString(escaped, &decoded_buf).?);
}

test "tap detection separates pats from drags" {
    // Clean click: quick, still.
    try std.testing.expect(isTap(120, 0, 0));
    // Device-pixel jitter under a fast grab still counts.
    try std.testing.expect(isTap(300, 2, -2));
    // Held too long: a grab, not a pat.
    try std.testing.expect(!isTap(tap_max_ms + 1, 0, 0));
    // Moved: a drag, not a pat.
    try std.testing.expect(!isTap(120, tap_slop_px, 0));
    try std.testing.expect(!isTap(120, 0, -tap_slop_px));
}

test "epoch-day flips exactly at UTC midnight" {
    try std.testing.expectEqual(@as(u32, 0), dayFromWallMs(0));
    try std.testing.expectEqual(@as(u32, 0), dayFromWallMs(std.time.ms_per_day - 1));
    try std.testing.expectEqual(@as(u32, 1), dayFromWallMs(std.time.ms_per_day));
    // A real date (2026-07-29T12:00Z), so a unit slip cannot pass.
    try std.testing.expectEqual(@as(u32, 20663), dayFromWallMs(1785326400000));
}

test "bubble lifetime validates and produces a deadline" {
    try std.testing.expectEqual(@as(f32, 0), clampBubbleLifetime(std.math.nan(f32)));
    try std.testing.expectEqual(@as(f32, 0), clampBubbleLifetime(0));
    try std.testing.expectEqual(@as(f32, 60), clampBubbleLifetime(90));
    try std.testing.expectEqual(@as(f32, 6), clampBubbleLifetime(5.6));
    try std.testing.expectEqual(@as(i64, -1), bubbleDeadlineMs(2000, 0));
    try std.testing.expectEqual(@as(i64, 7000), bubbleDeadlineMs(2000, 5));
    try std.testing.expectEqual(@as(i64, -1), bubbleExpiryMs(2000, 0, false));
    try std.testing.expectEqual(@as(i64, -1), bubbleExpiryMs(2000, 5, true));
    try std.testing.expectEqual(@as(i64, 7000), bubbleExpiryMs(2000, 5, false));
    try std.testing.expect(!bubbleLifetimeExpired(7000, 8000, .waiting));
    try std.testing.expect(bubbleLifetimeExpired(7000, 8000, .idle));
}

/// Seed the model's stack directly, the shape the poll tick would leave.
fn testPushBubble(model: *Model, session: []const u8, text: []const u8, busy: bool, deadline: i64) void {
    const i = model.bubbles_len;
    var b: hook_server.Bubble = .{ .busy = busy, .counter = @intCast(i + 1) };
    @memcpy(b.session[0..session.len], session);
    b.session_len = session.len;
    @memcpy(b.text[0..text.len], text);
    b.text_len = text.len;
    model.bubbles[i] = b;
    model.bubble_expires_at_ms[i] = deadline;
    model.bubbles_len = i + 1;
}

test "a card hugs its content instead of always taking the column budget" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "hi", false, -1);
    const short = bubbleCardWidth(&model, 0);
    try std.testing.expect(short < bubbleMaxCardWidth(&model));

    // Longer content widens the card, and the column budget is still the
    // ceiling: text past it wraps rather than growing the card forever.
    var long: Model = .{};
    testPushBubble(&long, "beta", "a much longer line of bubble text", false, -1);
    try std.testing.expect(bubbleCardWidth(&long, 0) > short);

    var overflow: Model = .{};
    testPushBubble(&overflow, "gamma", "x" ** 199, false, -1);
    try std.testing.expectEqual(bubbleMaxCardWidth(&overflow), bubbleCardWidth(&overflow, 0));
}

test "the window takes the widest card in the stack" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "hi", false, -1);
    const solo = bubbleWindowWidth(&model);
    testPushBubble(&model, "beta", "a much longer line of bubble text", false, -1);
    const widest = bubbleCardWidth(&model, 1);
    try std.testing.expect(bubbleWindowWidth(&model) > solo);
    try std.testing.expectEqual(widest + bubble_canvas_margin * 2, bubbleWindowWidth(&model));
    // The narrow card keeps its own width and gets centered by the view;
    // it must not be stretched to the window.
    try std.testing.expect(bubbleCardWidth(&model, 0) < widest);
}

test "an agent with no strip cell falls back to no tile" {
    // Every shipped AgentKind has a cell, the fallback art does not: the
    // strip is packed from agent_art alone.
    try std.testing.expect(agentIconIndex("claude-code") != null);
    try std.testing.expect(agentIconIndex("codex") != null);
    try std.testing.expectEqual(@as(?usize, null), agentIconIndex("some-unknown-agent"));
    try std.testing.expectEqual(@as(?usize, null), agentIconIndex(""));
}

test "clearing a bubble also cancels its lifetime" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "x", true, 1234);
    clearBubble(&model);
    try std.testing.expectEqual(@as(usize, 0), model.bubbles_len);
    try std.testing.expect(!bubbleActive(&model));
    try std.testing.expectEqual(@as(i64, -1), model.bubble_expires_at_ms[0]);
}

test "two conversations stack and grow the window vertically" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "reading", true, -1);
    const one_high = bubbleWindowHeight(&model);
    const one_wide = bubbleWindowWidth(&model);
    testPushBubble(&model, "beta", "testing", true, -1);
    try std.testing.expect(bubbleWindowHeight(&model) > one_high);
    // Only the vertical axis grows: cards keep the configured column
    // budget, they do not sit side by side.
    try std.testing.expectEqual(one_wide, bubbleWindowWidth(&model));
    try std.testing.expectEqualStrings("beta", newestBubble(&model).?.sessionSlice());
}

test "an empty stack still reserves one card of window height" {
    var model: Model = .{};
    const empty = bubbleWindowHeight(&model);
    testPushBubble(&model, "alpha", "reading", true, -1);
    try std.testing.expectEqual(empty, bubbleWindowHeight(&model));
}

test "expiry drops only the bubbles past their deadline" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "settled", false, 5000);
    testPushBubble(&model, "beta", "busy", true, -1);
    testPushBubble(&model, "gamma", "settled later", false, 9000);

    try std.testing.expect(expireBubbles(&model, 6000));
    try std.testing.expectEqual(@as(usize, 2), model.bubbles_len);
    // The survivors stay dense and keep their own deadlines: a compaction
    // that shifted bubbles without their deadline would expire the wrong
    // conversation on the next tick.
    try std.testing.expectEqualStrings("beta", model.bubbles[0].sessionSlice());
    try std.testing.expectEqual(@as(i64, -1), model.bubble_expires_at_ms[0]);
    try std.testing.expectEqualStrings("gamma", model.bubbles[1].sessionSlice());
    try std.testing.expectEqual(@as(i64, 9000), model.bubble_expires_at_ms[1]);
    try std.testing.expect(!expireBubbles(&model, 6000));
}

test "an unchanged bubble keeps its deadline when another one updates" {
    var model: Model = .{};
    model.bubble_lifetime_secs = 5;
    testPushBubble(&model, "alpha", "settled", false, 4000);
    testPushBubble(&model, "beta", "settled too", false, 4000);
    const previous = model.bubbles;
    const previous_deadlines = model.bubble_expires_at_ms;

    // beta gets a new payload (higher counter), alpha is untouched.
    model.bubbles[1].counter = 99;
    syncBubbleDeadlines(&model, previous[0..2], previous_deadlines[0..2], 10_000);
    try std.testing.expectEqual(@as(i64, 4000), model.bubble_expires_at_ms[0]);
    try std.testing.expectEqual(@as(i64, 15_000), model.bubble_expires_at_ms[1]);
}
