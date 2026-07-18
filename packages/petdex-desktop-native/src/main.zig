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
const runner = @import("runner");
const native_sdk = @import("native_sdk");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

const canvas = native_sdk.canvas;
const geometry = native_sdk.geometry;

const canvas_label = "pet-canvas";
const frame_w: f32 = 192;
const frame_h: f32 = 208;
const cols: u64 = 8;
const sheet_image_id: u64 = 1;

const app_permissions = [_][]const u8{ native_sdk.security.permission_command, native_sdk.security.permission_view };
const shell_views = [_]native_sdk.ShellView{
    .{ .label = canvas_label, .kind = .gpu_surface, .fill = true, .role = "Pet canvas", .accessibility_label = "Petdex pet", .gpu_backend = .metal, .gpu_pixel_format = .bgra8_unorm, .gpu_present_mode = .timer, .gpu_alpha_mode = .@"opaque", .gpu_color_space = .srgb, .gpu_vsync = true },
};
const shell_windows = [_]native_sdk.ShellWindow{.{
    .label = "main",
    .title = "Petdex",
    .width = frame_w,
    .height = frame_h,
    .resizable = false,
    .restore_state = false,
    .titlebar = .chromeless,
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
    cycle_state,

    pub const view_unbound = .{ "frame_tick", "cycle_state" };
};

pub const Model = struct {
    sheet_loaded: bool = false,
    pet_name: [64]u8 = @splat(0),
    pet_name_len: usize = 0,
    state: State = .idle,
    frame_index: usize = 0,
};

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
/// V1 macOS dev shim: `sips` converts webp->TGA and we parse TGA
/// (RLE + raw); V5 swaps the shim for vendored libwebp on all
/// platforms. Raising the registry caps is on the upstream PR list.
const Sheet = struct {
    pixels: []u8 = &.{},
    width: usize = 0,
    height: usize = 0,
    rows: usize = 9,
};
var sheet: Sheet = .{};

fn parseTga(allocator: std.mem.Allocator, bytes: []const u8) !Sheet {
    if (bytes.len < 18) return error.BadTga;
    if (bytes[1] != 0) return error.UnsupportedTga;
    const image_type = bytes[2];
    if (image_type != 2 and image_type != 10) return error.UnsupportedTga;
    const id_len: usize = bytes[0];
    const width: usize = @as(usize, bytes[12]) | (@as(usize, bytes[13]) << 8);
    const height: usize = @as(usize, bytes[14]) | (@as(usize, bytes[15]) << 8);
    const bpp = bytes[16];
    if (bpp != 32 and bpp != 24) return error.UnsupportedTga;
    const bytes_per_pixel: usize = bpp / 8;
    const top_left = (bytes[17] & 0x20) != 0;
    if (width == 0 or height == 0 or width > 8192 or height > 8192) return error.BadTga;

    const out = try allocator.alloc(u8, width * height * 4);
    errdefer allocator.free(out);
    var src: usize = 18 + id_len;
    var px: usize = 0;
    const total = width * height;
    while (px < total) {
        if (image_type == 2) {
            if (src + bytes_per_pixel > bytes.len) return error.BadTga;
            writeTgaPixel(out, px, bytes[src..], bytes_per_pixel);
            src += bytes_per_pixel;
            px += 1;
        } else {
            if (src >= bytes.len) return error.BadTga;
            const packet = bytes[src];
            src += 1;
            const count: usize = @as(usize, packet & 0x7f) + 1;
            if (packet & 0x80 != 0) {
                if (src + bytes_per_pixel > bytes.len) return error.BadTga;
                for (0..count) |_| {
                    if (px >= total) return error.BadTga;
                    writeTgaPixel(out, px, bytes[src..], bytes_per_pixel);
                    px += 1;
                }
                src += bytes_per_pixel;
            } else {
                for (0..count) |_| {
                    if (px >= total or src + bytes_per_pixel > bytes.len) return error.BadTga;
                    writeTgaPixel(out, px, bytes[src..], bytes_per_pixel);
                    src += bytes_per_pixel;
                    px += 1;
                }
            }
        }
    }
    if (!top_left) {
        const row_len = width * 4;
        var top: usize = 0;
        var bottom: usize = height - 1;
        while (top < bottom) : ({
            top += 1;
            bottom -= 1;
        }) {
            const a = out[top * row_len ..][0..row_len];
            const b = out[bottom * row_len ..][0..row_len];
            for (a, b) |*x, *y| std.mem.swap(u8, x, y);
        }
    }
    return .{ .pixels = out, .width = width, .height = height };
}

fn writeTgaPixel(out: []u8, px: usize, src: []const u8, bytes_per_pixel: usize) void {
    const o = px * 4;
    out[o + 0] = src[2];
    out[o + 1] = src[1];
    out[o + 2] = src[0];
    out[o + 3] = if (bytes_per_pixel == 4) src[3] else 0xff;
}

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

fn loadFirstPet(io: std.Io, allocator: std.mem.Allocator) !PetFile {
    const home = env_home orelse return error.NoHome;
    const wanted = env_wanted_pet;
    const roots = [_][]const u8{ ".petdex/pets", ".codex/pets" };
    const exts = [_][]const u8{ "spritesheet.webp", "spritesheet.png" };
    for (roots) |root| {
        const root_path = try std.fs.path.join(allocator, &.{ home, root });
        defer allocator.free(root_path);
        var dir = std.Io.Dir.openDirAbsolute(io, root_path, .{ .iterate = true }) catch continue;
        defer dir.close(io);
        var it = dir.iterate();
        while (try it.next(io)) |entry| {
            if (entry.kind != .directory) continue;
            if (wanted) |w| {
                if (!std.mem.eql(u8, entry.name, w)) continue;
            }
            for (exts) |ext| {
                const sheet_path = std.fs.path.join(allocator, &.{ root_path, entry.name, ext }) catch continue;
                var probe = std.Io.Dir.openFileAbsolute(io, sheet_path, .{}) catch {
                    allocator.free(sheet_path);
                    continue;
                };
                probe.close(io);
                const name = try allocator.dupe(u8, entry.name);
                return .{ .name = name, .sheet_path = sheet_path };
            }
        }
    }
    return error.NoPetInstalled;
}

var boot_allocator: std.mem.Allocator = std.heap.page_allocator;
var boot_io: ?std.Io = null;
var pet_display_name: []const u8 = "";

/// Convert the sheet to TGA via sips (macOS dev shim, see Sheet) and
/// decode it into the global `sheet`. Runs in main() before the app
/// loop; V5 replaces the sips step with vendored libwebp.
fn loadSheetPixels(io: std.Io, allocator: std.mem.Allocator, environ_map: *std.process.Environ.Map) !void {
    const pet = try loadFirstPet(io, allocator);
    pet_display_name = pet.name;
    defer allocator.free(pet.sheet_path);

    const tmp = environ_map.get("TMPDIR") orelse "/tmp";
    // Pet-scoped temp name so two instances (or two pets) never race
    // on the same conversion output.
    const tga_name = try std.fmt.allocPrint(allocator, "petdex-native-{s}.tga", .{pet.name});
    defer allocator.free(tga_name);
    const tga_path = try std.fs.path.join(allocator, &.{ tmp, tga_name });
    defer allocator.free(tga_path);

    const argv = [_][]const u8{ "/usr/bin/sips", "-s", "format", "tga", pet.sheet_path, "--out", tga_path };
    var child = try std.process.spawn(io, .{
        .argv = &argv,
        .environ_map = environ_map,
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
    });
    const term = try child.wait(io);
    if (term != .exited or term.exited != 0) return error.SheetConvertFailed;

    const tga_bytes = try readFileAbsolute(io, allocator, tga_path, 64 * 1024 * 1024);
    defer allocator.free(tga_bytes);
    sheet = try parseTga(allocator, tga_bytes);
    // v2 atlases (8x11, look rows below the states) are taller: same
    // 192x208 frame, more rows. Detect by aspect.
    sheet.rows = if (sheet.height * 1536 >= sheet.width * 2288) 11 else 9;
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

pub fn boot(model: *Model, fx: *Effects) void {
    if (sheet.pixels.len == 0) return;
    registerStateFrames(model.state, fx);
    model.sheet_loaded = true;
    const n = @min(pet_display_name.len, model.pet_name.len);
    @memcpy(model.pet_name[0..n], pet_display_name[0..n]);
    model.pet_name_len = n;
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
            model.state = model.state.next();
            model.frame_index = 0;
            registerStateFrames(model.state, fx);
            armFrameTimer(model, fx);
        },
    }
}

pub fn onKey(keyboard: canvas.WidgetKeyboardEvent) ?Msg {
    if (keyboard.modifiers.hasNavigationModifier() or keyboard.modifiers.shift) return null;
    if (std.ascii.eqlIgnoreCase(keyboard.key, "space")) return .cycle_state;
    return null;
}

pub fn onCommand(name: []const u8) ?Msg {
    if (std.mem.eql(u8, name, "petdex.cycle")) return .cycle_state;
    return null;
}

// ------------------------------------------------------------------- view

pub const AppUi = canvas.Ui(Msg);

pub fn rootView(ui: *AppUi, model: *const Model) AppUi.Node {
    if (!model.sheet_loaded) {
        return ui.panel(.{ .width = frame_w, .height = frame_h, .semantics = .{ .label = "No pet installed" } }, .{});
    }
    var node = ui.image(.{
        .width = frame_w,
        .height = frame_h,
        .image = @intCast(model.frame_index + 1),
        .semantics = .{ .label = "Petdex pet" },
    });
    node.widget.image_fit = .stretch;
    node.widget.image_sampling = .nearest;
    return node;
}

// -------------------------------------------------------------------- app

const PetdexApp = native_sdk.UiApp(Model, Msg);

pub fn main(init: std.process.Init) !void {
    env_home = init.environ_map.get("HOME");
    env_wanted_pet = init.environ_map.get("PETDEX_PET");
    boot_io = init.io;
    loadSheetPixels(init.io, boot_allocator, init.environ_map) catch |err| {
        std.debug.print("petdex: sheet load failed ({s}); install a pet with `petdex install <pet>`\n", .{@errorName(err)});
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
    });
    defer app_state.destroy();
    app_state.model = .{};

    try runner.runWithOptions(app_state.app(), .{
        .app_name = "petdex-desktop-native",
        .window_title = "Petdex",
        .bundle_id = "dev.petdex.desktop-native",
        .icon_path = "assets/icon.png",
        .default_frame = geometry.RectF.init(0, 0, frame_w, frame_h),
        .restore_state = false,
        .js_window_api = false,
        .security = .{
            .permissions = &app_permissions,
            .navigation = .{ .allowed_origins = &.{ "zero://inline", "zero://app" } },
        },
    }, init);
}
