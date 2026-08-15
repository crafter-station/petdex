const std = @import("std");
const builtin = @import("builtin");

pub const Origin = enum(u8) { none, terminal, vscode, default_browser, codex };

const availability_cache_ms: i64 = 500;
const CacheEntry = struct { checked_ms: i64 = 0, available: bool = false };
var cache: [5]CacheEntry = @splat(.{});
var cache_lock: std.atomic.Mutex = .unlocked;

fn lockCache() void {
    while (!cache_lock.tryLock()) std.atomic.spinLoopHint();
}

fn monotonicMs() i64 {
    var threaded = std.Io.Threaded.init(std.heap.page_allocator, .{});
    defer threaded.deinit();
    const ns = std.Io.Timestamp.now(threaded.io(), .boot).nanoseconds;
    return @intCast(@divTrunc(ns, std.time.ns_per_ms));
}

pub fn x11SessionFromValues(session_type: ?[]const u8, wayland_display: ?[]const u8, gdk_backend: ?[]const u8, display: ?[]const u8) bool {
    if (session_type) |value| if (std.ascii.eqlIgnoreCase(value, "wayland")) return false;
    if (wayland_display) |value| if (value.len > 0) return false;
    if (gdk_backend) |value| if (std.ascii.indexOfIgnoreCase(value, "wayland") != null) return false;
    const x_display = display orelse return false;
    return x_display.len > 0;
}

fn isX11Session() bool {
    if (!builtin.link_libc or std.process.Environ.Block != std.process.Environ.PosixBlock) return false;
    const envp = std.c.environ;
    var count: usize = 0;
    while (envp[count] != null) : (count += 1) {}
    const source = std.process.Environ{ .block = .{ .slice = envp[0..count :null] } };
    var environ = std.process.Environ.createMap(source, std.heap.page_allocator) catch return false;
    defer environ.deinit();
    return x11SessionFromValues(
        environ.get("XDG_SESSION_TYPE"),
        environ.get("WAYLAND_DISPLAY"),
        environ.get("GDK_BACKEND"),
        environ.get("DISPLAY"),
    );
}

pub fn executableAllowed(origin: Origin, path: []const u8) bool {
    const slash = std.mem.lastIndexOfScalar(u8, path, '/');
    const basename = if (slash) |index| path[index + 1 ..] else path;
    const allowed = switch (origin) {
        .none => &[_][]const u8{},
        .terminal => &[_][]const u8{
            "gnome-terminal-server", "gnome-console", "kgx", "konsole", "kitty", "alacritty", "wezterm-gui", "xterm", "tilix", "foot",
        },
        .vscode => &[_][]const u8{ "code", "code-insiders", "codium" },
        // A generic browser allowlist can focus the wrong running browser.
        // Keep this capability hidden until the registered desktop handler is
        // resolved to one exact executable/StartupWMClass pair.
        .default_browser => &[_][]const u8{},
        .codex => &[_][]const u8{ "codex", "chatgpt" },
    };
    for (allowed) |candidate| if (std.mem.eql(u8, basename, candidate)) return true;
    return false;
}

const Linux = struct {
    const Display = anyopaque;
    const Window = c_ulong;
    const Atom = c_ulong;
    const success = 0;
    const client_message = 33;
    const substructure_notify_mask: c_long = 1 << 19;
    const substructure_redirect_mask: c_long = 1 << 20;
    const max_clients: c_long = 4096;

    const ClientMessageData = extern union {
        b: [20]u8,
        s: [10]c_short,
        l: [5]c_long,
    };
    const ClientMessageEvent = extern struct {
        type: c_int,
        serial: c_ulong,
        send_event: c_int,
        display: ?*Display,
        window: Window,
        message_type: Atom,
        format: c_int,
        data: ClientMessageData,
    };
    const Event = extern union {
        client: ClientMessageEvent,
        pad: [24]c_long,
    };

    const Api = struct {
        lib: std.DynLib,
        open_display: *const fn (?[*:0]const u8) callconv(.c) ?*Display,
        close_display: *const fn (?*Display) callconv(.c) c_int,
        default_root_window: *const fn (?*Display) callconv(.c) Window,
        intern_atom: *const fn (?*Display, [*:0]const u8, c_int) callconv(.c) Atom,
        get_window_property: *const fn (?*Display, Window, Atom, c_long, c_long, c_int, Atom, *Atom, *c_int, *c_ulong, *c_ulong, *?[*]u8) callconv(.c) c_int,
        fetch_name: *const fn (?*Display, Window, *?[*:0]u8) callconv(.c) c_int,
        send_event: *const fn (?*Display, Window, c_int, c_long, *Event) callconv(.c) c_int,
        flush: *const fn (?*Display) callconv(.c) c_int,
        free: *const fn (?*anyopaque) callconv(.c) c_int,

        fn load() ?Api {
            var lib = std.DynLib.open("libX11.so.6") catch return null;
            errdefer lib.close();
            return .{
                .lib = lib,
                .open_display = lib.lookup(@TypeOf(@as(Api, undefined).open_display), "XOpenDisplay") orelse return null,
                .close_display = lib.lookup(@TypeOf(@as(Api, undefined).close_display), "XCloseDisplay") orelse return null,
                .default_root_window = lib.lookup(@TypeOf(@as(Api, undefined).default_root_window), "XDefaultRootWindow") orelse return null,
                .intern_atom = lib.lookup(@TypeOf(@as(Api, undefined).intern_atom), "XInternAtom") orelse return null,
                .get_window_property = lib.lookup(@TypeOf(@as(Api, undefined).get_window_property), "XGetWindowProperty") orelse return null,
                .fetch_name = lib.lookup(@TypeOf(@as(Api, undefined).fetch_name), "XFetchName") orelse return null,
                .send_event = lib.lookup(@TypeOf(@as(Api, undefined).send_event), "XSendEvent") orelse return null,
                .flush = lib.lookup(@TypeOf(@as(Api, undefined).flush), "XFlush") orelse return null,
                .free = lib.lookup(@TypeOf(@as(Api, undefined).free), "XFree") orelse return null,
            };
        }
    };

    fn property(api: *const Api, display: *Display, window: Window, atom: Atom, length: c_long) ?struct { data: [*]u8, count: usize, format: c_int } {
        var actual_type: Atom = 0;
        var format: c_int = 0;
        var count: c_ulong = 0;
        var remaining: c_ulong = 0;
        var data: ?[*]u8 = null;
        if (api.get_window_property(display, window, atom, 0, length, 0, 0, &actual_type, &format, &count, &remaining, &data) != success) return null;
        return .{ .data = data orelse return null, .count = @intCast(count), .format = format };
    }

    fn processExecutable(pid: c_ulong, buffer: []u8) ?[]const u8 {
        var path_buf: [64]u8 = undefined;
        const path = std.fmt.bufPrint(&path_buf, "/proc/{d}/exe", .{pid}) catch return null;
        var threaded = std.Io.Threaded.init(std.heap.page_allocator, .{});
        defer threaded.deinit();
        const length = std.Io.Dir.readLinkAbsolute(threaded.io(), path, buffer) catch return null;
        return buffer[0..length];
    }

    fn projectName(cwd: []const u8) []const u8 {
        const trimmed = std.mem.trimEnd(u8, cwd, "/");
        const slash = std.mem.lastIndexOfScalar(u8, trimmed, '/');
        return if (slash) |index| trimmed[index + 1 ..] else trimmed;
    }

    fn titleMatches(api: *const Api, display: *Display, window: Window, cwd: []const u8) bool {
        const project = projectName(cwd);
        if (project.len == 0) return false;
        var title: ?[*:0]u8 = null;
        if (api.fetch_name(display, window, &title) == 0) return false;
        const value = title orelse return false;
        defer _ = api.free(@ptrCast(value));
        return std.ascii.indexOfIgnoreCase(std.mem.span(value), project) != null;
    }

    fn findWindow(api: *const Api, display: *Display, origin: Origin, cwd: []const u8) ?Window {
        const root = api.default_root_window(display);
        if (root == 0) return null;
        const clients_atom = api.intern_atom(display, "_NET_CLIENT_LIST_STACKING", 1);
        const fallback_atom = api.intern_atom(display, "_NET_CLIENT_LIST", 1);
        const list_atom = if (clients_atom != 0) clients_atom else fallback_atom;
        const pid_atom = api.intern_atom(display, "_NET_WM_PID", 1);
        if (list_atom == 0 or pid_atom == 0) return null;
        const clients = property(api, display, root, list_atom, max_clients) orelse return null;
        defer _ = api.free(@ptrCast(clients.data));
        if (clients.format != 32) return null;
        const windows: [*]align(@alignOf(c_ulong)) c_ulong = @ptrCast(@alignCast(clients.data));
        var fallback: ?Window = null;
        for (windows[0..@min(clients.count, @as(usize, @intCast(max_clients)))]) |window| {
            const pid_data = property(api, display, window, pid_atom, 1) orelse continue;
            defer _ = api.free(@ptrCast(pid_data.data));
            if (pid_data.format != 32 or pid_data.count == 0) continue;
            const values: [*]align(@alignOf(c_ulong)) c_ulong = @ptrCast(@alignCast(pid_data.data));
            var exe_buf: [1024]u8 = undefined;
            const exe = processExecutable(values[0], &exe_buf) orelse continue;
            if (!executableAllowed(origin, exe)) continue;
            if (fallback == null) fallback = window;
            if (titleMatches(api, display, window, cwd)) return window;
        }
        return fallback;
    }

    fn probe(origin: Origin, cwd: []const u8) ?struct { api: Api, display: *Display, window: Window } {
        if (origin == .none or !isX11Session()) return null;
        var api = Api.load() orelse return null;
        errdefer api.lib.close();
        const display = api.open_display(null) orelse return null;
        errdefer _ = api.close_display(display);
        const window = findWindow(&api, display, origin, cwd) orelse return null;
        return .{ .api = api, .display = display, .window = window };
    }

    fn available(origin: Origin, cwd: []const u8) bool {
        var result = probe(origin, cwd) orelse return false;
        defer result.api.lib.close();
        defer _ = result.api.close_display(result.display);
        return true;
    }

    fn activate(origin: Origin, cwd: []const u8) bool {
        var result = probe(origin, cwd) orelse return false;
        defer result.api.lib.close();
        defer _ = result.api.close_display(result.display);
        const root = result.api.default_root_window(result.display);
        const active_atom = result.api.intern_atom(result.display, "_NET_ACTIVE_WINDOW", 1);
        if (root == 0 or active_atom == 0) return false;
        var event: Event = .{
            .client = .{
                .type = client_message,
                .serial = 0,
                .send_event = 1,
                .display = result.display,
                .window = result.window,
                .message_type = active_atom,
                .format = 32,
                .data = .{ .l = .{ 1, 0, 0, 0, 0 } },
            },
        };
        if (result.api.send_event(result.display, root, 0, substructure_redirect_mask | substructure_notify_mask, &event) == 0) return false;
        return result.api.flush(result.display) == success;
    }
};

pub fn available(origin: Origin, cwd: []const u8) bool {
    if (builtin.target.os.tag != .linux or origin == .none) return false;
    const now = monotonicMs();
    lockCache();
    const entry = &cache[@intFromEnum(origin)];
    if (entry.checked_ms > 0 and now - entry.checked_ms <= availability_cache_ms) {
        const cached = entry.available;
        cache_lock.unlock();
        return cached;
    }
    cache_lock.unlock();
    const result = Linux.available(origin, cwd);
    lockCache();
    entry.available = result;
    entry.checked_ms = now;
    cache_lock.unlock();
    return result;
}

pub fn activate(origin: Origin, cwd: []const u8) bool {
    if (builtin.target.os.tag != .linux or origin == .none) return false;
    // Invocation deliberately bypasses the availability cache: the selected
    // PID/executable/window tuple is re-read immediately before EWMH dispatch.
    return Linux.activate(origin, cwd);
}

test "Wayland is rejected even when XWayland exposes DISPLAY" {
    try std.testing.expect(!x11SessionFromValues("wayland", "wayland-0", null, ":0"));
    try std.testing.expect(!x11SessionFromValues(null, "wayland-0", null, ":0"));
    try std.testing.expect(!x11SessionFromValues(null, null, "wayland,x11", ":0"));
    try std.testing.expect(x11SessionFromValues("x11", null, null, ":0"));
    try std.testing.expect(!x11SessionFromValues("x11", null, null, null));
}

test "Linux origin process allowlist matches exact executable basenames" {
    try std.testing.expect(executableAllowed(.terminal, "/usr/libexec/gnome-terminal-server"));
    try std.testing.expect(executableAllowed(.vscode, "/usr/share/code/code"));
    try std.testing.expect(!executableAllowed(.default_browser, "/usr/lib/firefox/firefox"));
    try std.testing.expect(!executableAllowed(.terminal, "/tmp/gnome-terminal-server-helper"));
    try std.testing.expect(!executableAllowed(.vscode, "/tmp/code-malicious"));
    try std.testing.expect(!executableAllowed(.none, "/usr/bin/code"));
}

test "Linux backend probe is fail-closed when no eligible X11 window exists" {
    if (builtin.target.os.tag == .linux) {
        _ = available(.terminal, "");
    }
}
