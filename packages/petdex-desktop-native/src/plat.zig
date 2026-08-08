//! Portable file/socket/clock primitives for the off-main-thread code.
//!
//! The hook server thread, the hook runner process, and agent-hook
//! detection all need small blocking IO, and none of them can borrow
//! `init.io`: that Io belongs to the main thread and the runtime
//! thread must not touch it. The previous answer was raw `std.c`,
//! which pinned the whole app to POSIX and broke the Windows target
//! (`std.c.open`'s variadic `mode_t` is not expressible in the
//! x86_64_win calling convention).
//!
//! The answer here is the shape the SDK itself uses for exactly this
//! situation (`src/embed/host.zig`, `src/platform/macos/root.zig`):
//! a caller-owned `std.Io.Threaded`. Each thread builds its own Io, so
//! the main-thread invariant holds by construction rather than by
//! comment, and every operation below is `std.Io.Dir`/`std.Io.net`,
//! which already carry the Windows implementations.
//!
//! `std.posix` is deliberately not used: in Zig 0.16 it kept only
//! `read`/`openat` plus mmap and signal bits, and even `posix.read` is
//! `@compileError("unsupported OS")` on Windows, so it is a POSIX
//! escape hatch, not a portability layer.

const std = @import("std");
const builtin = @import("builtin");

/// One Io per calling thread. Cheap to build (no worker threads spin
/// up until an async call asks for them) and never shared, so the
/// blocking helpers below are safe from any thread.
pub const Scope = struct {
    threaded: std.Io.Threaded,

    pub fn init() Scope {
        // Allocator.failing is what the SDK passes when a scope only
        // does blocking calls: it is consulted solely by the async
        // vtable entries, which nothing here reaches.
        return .{ .threaded = std.Io.Threaded.init(std.heap.page_allocator, .{}) };
    }

    pub fn io(self: *Scope) std.Io {
        return self.threaded.io();
    }

    pub fn deinit(self: *Scope) void {
        self.threaded.deinit();
    }
};

/// Read a whole file into a caller buffer. Null on any failure or an
/// empty file, matching the std.c helpers this replaces (callers treat
/// "no bytes" and "no file" identically).
pub fn readFile(path: []const u8, buf: []u8) ?[]const u8 {
    var scope = Scope.init();
    defer scope.deinit();
    return readFileIo(scope.io(), path, buf);
}

pub fn readFileIo(io: std.Io, path: []const u8, buf: []u8) ?[]const u8 {
    var file = std.Io.Dir.cwd().openFile(io, path, .{}) catch return null;
    defer file.close(io);
    var read_buf: [4096]u8 = undefined;
    var reader = file.reader(io, &read_buf);
    var total: usize = 0;
    while (total < buf.len) {
        const n = reader.interface.readSliceShort(buf[total..]) catch break;
        if (n == 0) break;
        total += n;
    }
    if (total == 0) return null;
    return buf[0..total];
}

/// Last `buf.len` bytes of a file. Used for transcript tails, where
/// the head is uninteresting and the file can be many megabytes.
pub fn readFileTail(path: []const u8, buf: []u8) ?[]const u8 {
    var scope = Scope.init();
    defer scope.deinit();
    const io = scope.io();
    var file = std.Io.Dir.cwd().openFile(io, path, .{}) catch return null;
    defer file.close(io);
    var read_buf: [4096]u8 = undefined;
    var reader = file.reader(io, &read_buf);
    const size = reader.getSize() catch return null;
    if (size == 0) return null;
    const want: u64 = @min(size, buf.len);
    reader.seekTo(size - want) catch return null;
    var total: usize = 0;
    while (total < want) {
        const n = reader.interface.readSliceShort(buf[total..@intCast(want)]) catch break;
        if (n == 0) break;
        total += n;
    }
    if (total == 0) return null;
    return buf[0..total];
}

/// Allocate-and-read, capped at `max`. Returns a slice sized to the
/// bytes actually read so the caller's free matches the allocation.
pub fn readFileAlloc(allocator: std.mem.Allocator, path: []const u8, max: usize) ?[]u8 {
    const buf = allocator.alloc(u8, max) catch return null;
    var scope = Scope.init();
    defer scope.deinit();
    const got = readFileIo(scope.io(), path, buf) orelse {
        allocator.free(buf);
        return null;
    };
    return allocator.realloc(buf, got.len) catch buf[0..got.len];
}

pub fn writeFile(path: []const u8, bytes: []const u8) bool {
    var scope = Scope.init();
    defer scope.deinit();
    return writeFileIo(scope.io(), path, bytes, null);
}

/// `mode` is the POSIX permission bits and is honored only there; on
/// Windows the ACL inherited from the parent directory governs, which
/// is why the token file's 0600 cannot be reproduced (see hook_server).
pub fn writeFileMode(path: []const u8, bytes: []const u8, mode: u16) bool {
    var scope = Scope.init();
    defer scope.deinit();
    return writeFileIo(scope.io(), path, bytes, mode);
}

fn writeFileIo(io: std.Io, path: []const u8, bytes: []const u8, mode: ?u16) bool {
    // Replacing a symlink path atomically replaces the link itself. Runtime
    // files are user-managed, and a symlink is a supported way to relocate
    // them, so resolve an existing link before creating the replacement.
    // A dangling link is left untouched and reported as a write failure.
    var resolved_path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    var target_path = path;
    if (std.Io.Dir.cwd().statFile(io, path, .{ .follow_symlinks = false })) |stat| {
        if (stat.kind == .sym_link) {
            const resolved_len = std.Io.Dir.cwd().realPathFile(io, path, &resolved_path_buf) catch return false;
            target_path = resolved_path_buf[0..resolved_len];
        }
    } else |_| {}

    var atomic_file = std.Io.Dir.cwd().createFileAtomic(io, target_path, .{
        .permissions = permissionsFromMode(mode),
        .replace = true,
    }) catch return false;
    defer atomic_file.deinit(io);

    var write_buf: [4096]u8 = undefined;
    var writer = atomic_file.file.writer(io, &write_buf);
    writer.interface.writeAll(bytes) catch return false;
    writer.interface.flush() catch return false;
    atomic_file.replace(io) catch return false;
    return true;
}

/// On Windows `Permissions` is a readonly-attribute enum with no mode
/// bits, so a requested POSIX mode degrades to the inherited ACL.
fn permissionsFromMode(mode: ?u16) std.Io.File.Permissions {
    const m = mode orelse return .default_file;
    if (builtin.os.tag == .windows) return .default_file;
    return @enumFromInt(m);
}

pub fn makeDir(path: []const u8) void {
    var scope = Scope.init();
    defer scope.deinit();
    // Already-exists is the common case at every call site, so the
    // error is swallowed exactly like the old `_ = std.c.mkdir(...)`.
    std.Io.Dir.cwd().createDirPath(scope.io(), path) catch {};
}

pub fn deleteFile(path: []const u8) void {
    var scope = Scope.init();
    defer scope.deinit();
    std.Io.Dir.cwd().deleteFile(scope.io(), path) catch {};
}

pub fn fileExists(path: []const u8) bool {
    var scope = Scope.init();
    defer scope.deinit();
    const io = scope.io();
    var file = std.Io.Dir.cwd().openFile(io, path, .{}) catch return false;
    file.close(io);
    return true;
}

pub fn dirExists(path: []const u8) bool {
    var scope = Scope.init();
    defer scope.deinit();
    const io = scope.io();
    var dir = std.Io.Dir.cwd().openDir(io, path, .{}) catch return false;
    dir.close(io);
    return true;
}

/// Iterate `dir`, calling `visit` with each entry basename. The
/// callback shape avoids handing an iterator (and its Io lifetime)
/// back to the caller.
pub fn forEachEntry(
    path: []const u8,
    context: anytype,
    comptime visit: fn (@TypeOf(context), []const u8) void,
) void {
    var scope = Scope.init();
    defer scope.deinit();
    const io = scope.io();
    var dir = std.Io.Dir.cwd().openDir(io, path, .{ .iterate = true }) catch return;
    defer dir.close(io);
    var it = dir.iterate();
    while (it.next(io) catch return) |entry| visit(context, entry.name);
}

pub fn readStdin(buf: []u8) []const u8 {
    var scope = Scope.init();
    defer scope.deinit();
    const io = scope.io();
    var read_buf: [4096]u8 = undefined;
    var reader = std.Io.File.stdin().reader(io, &read_buf);
    return readCappedAndDrain(&reader.interface, buf);
}

/// Keep the first `buf.len` bytes but drain the rest of the pipe. Hook
/// hosts can still be writing a large payload after the useful prefix; an
/// early close makes their writer see EPIPE/Broken pipe.
fn readCappedAndDrain(reader: anytype, buf: []u8) []const u8 {
    var total: usize = 0;
    var discard: [4096]u8 = undefined;
    while (true) {
        const target = if (total < buf.len) buf[total..] else &discard;
        const n = reader.readSliceShort(target) catch break;
        if (n == 0) break;
        if (total < buf.len) total += n;
    }
    return buf[0..total];
}

test "readCappedAndDrain keeps the cap and consumes the source" {
    const Source = struct {
        bytes: []const u8,
        offset: usize = 0,

        fn readSliceShort(self: *@This(), out: []u8) !usize {
            if (self.offset >= self.bytes.len) return 0;
            const n = @min(out.len, self.bytes.len - self.offset);
            @memcpy(out[0..n], self.bytes[self.offset .. self.offset + n]);
            self.offset += n;
            return n;
        }
    };

    var source = Source{ .bytes = "0123456789" };
    var kept: [4]u8 = undefined;
    const captured = readCappedAndDrain(&source, &kept);
    try std.testing.expectEqualStrings("0123", captured);
    try std.testing.expectEqual(source.bytes.len, source.offset);
}

// ------------------------------------------------------------------ clock

pub fn nowMs() i64 {
    var scope = Scope.init();
    defer scope.deinit();
    const ns = std.Io.Timestamp.now(scope.io(), .real).nanoseconds;
    return @intCast(@divTrunc(ns, std.time.ns_per_ms));
}

pub fn nowSeconds() i64 {
    return @divTrunc(nowMs(), 1000);
}

// ----------------------------------------------------------------- random

/// Session token entropy. `std.crypto.random` is gone in 0.16 and
/// reading /dev/urandom by hand was the POSIX-only stand-in; this is
/// the OS CSPRNG through Io, which already picks getrandom on Linux,
/// getentropy on Darwin, and RtlGenRandom on Windows.
pub fn fillRandom(out: []u8) !void {
    var scope = Scope.init();
    defer scope.deinit();
    try std.Io.randomSecure(scope.io(), out);
}

// ---------------------------------------------------------------- process

/// Absolute path of the running binary. Replaces realpath(argv0),
/// which lied whenever argv0 was a bare name found on PATH.
pub fn executablePath(buf: []u8) ?[]const u8 {
    var scope = Scope.init();
    defer scope.deinit();
    const len = std.process.executablePath(scope.io(), buf) catch return null;
    return buf[0..len];
}

/// Point `link` at `target`, replacing any existing link.
///
/// Windows caveat: creating a symlink needs either Developer Mode or
/// SeCreateSymbolicLinkPrivilege, so this can fail on a default
/// install. The caller treats failure as "hooks not wired" rather than
/// crashing, and the hook command already exits 0 when the link is
/// missing, so the app degrades to no bubbles instead of breaking.
pub fn replaceSymlink(target: []const u8, link: []const u8) bool {
    var scope = Scope.init();
    defer scope.deinit();
    const io = scope.io();
    const cwd = std.Io.Dir.cwd();
    cwd.deleteFile(io, link) catch {};
    cwd.symLink(io, target, link, .{}) catch return false;
    return true;
}

/// Build the Windows launcher that keeps the hook path stable across app
/// updates without requiring symbolic-link privileges. Percent signs in the
/// target are doubled because cmd.exe expands them in batch files.
pub fn windowsHookLauncher(buf: []u8, target: []const u8) ?[]const u8 {
    const prefix = "@echo off\r\n\"";
    const suffix = "\" %*\r\n";
    if (buf.len < prefix.len + suffix.len) return null;

    var at: usize = 0;
    @memcpy(buf[at .. at + prefix.len], prefix);
    at += prefix.len;
    for (target) |byte| {
        if (byte == '%') {
            if (at + 2 > buf.len - suffix.len) return null;
            buf[at] = '%';
            at += 1;
        }
        if (at + 1 > buf.len - suffix.len) return null;
        buf[at] = byte;
        at += 1;
    }
    if (at + suffix.len > buf.len) return null;
    @memcpy(buf[at .. at + suffix.len], suffix);
    at += suffix.len;
    return buf[0..at];
}

test "Windows hook launcher forwards stdin and arguments" {
    var buf: [256]u8 = undefined;
    const launcher = windowsHookLauncher(&buf, "C:\\Program Files\\Petdex\\petdex%dev.exe").?;
    try std.testing.expectEqualStrings(
        "@echo off\r\n\"C:\\Program Files\\Petdex\\petdex%%dev.exe\" %*\r\n",
        launcher,
    );
}

/// Own pid, for the /whoami endpoint. std has no portable accessor in
/// 0.16, so this is the one genuine per-platform branch in this file.
///
/// Linux goes through the raw syscall rather than libc: `std.c.getpid`
/// is an `extern "c"` declaration, and Linux refuses to compile one
/// unless the build links libc explicitly. The app binary does, but
/// `native test` also builds an analysis object that does not, so the
/// libc path failed the Linux leg of CI while compiling fine on macOS
/// and Windows. The syscall needs no linkage and returns the same pid.
pub fn processId() u32 {
    return switch (builtin.os.tag) {
        .windows => std.os.windows.GetCurrentProcessId(),
        .linux => @intCast(std.os.linux.getpid()),
        else => @intCast(std.c.getpid()),
    };
}

/// GUI application that owns the terminal hosting the latest agent event.
/// Hook metadata is allowlisted and never becomes an arbitrary bundle id.
pub const OriginApplication = enum(u8) {
    none,
    terminal,
    vscode,

    pub fn fromTermProgram(value: ?[]const u8) OriginApplication {
        const name = value orelse return .none;
        if (std.mem.eql(u8, name, "Apple_Terminal")) return .terminal;
        if (std.mem.eql(u8, name, "vscode")) return .vscode;
        return .none;
    }

    pub fn wireName(self: OriginApplication) []const u8 {
        return switch (self) {
            .none => "",
            .terminal => "Apple_Terminal",
            .vscode => "vscode",
        };
    }

    fn bundleIdentifier(self: OriginApplication) ?[]const u8 {
        return switch (self) {
            .none => null,
            .terminal => "com.apple.Terminal",
            .vscode => "com.microsoft.VSCode",
        };
    }
};

const terminal_focus_script =
    \\on run argv
    \\  set targetTTY to item 1 of argv
    \\  tell application "Terminal"
    \\    repeat with targetWindow in every window
    \\      repeat with targetTab in tabs of targetWindow
    \\        if (tty of targetTab) is targetTTY then
    \\          set selected of targetTab to true
    \\          set index of targetWindow to 1
    \\          activate
    \\          return
    \\        end if
    \\      end repeat
    \\    end repeat
    \\  end tell
    \\  error "Petdex could not find the source TTY" number 1
    \\end run
;

const mac_c = struct {
    extern "c" fn open(path: [*:0]const u8, flags: c_int, ...) c_int;
    extern "c" fn close(fd: c_int) c_int;
    extern "c" fn ttyname_r(fd: c_int, buf: [*]u8, len: usize) c_int;
};

pub fn controllingTty(buf: []u8) ?[]const u8 {
    if (comptime builtin.os.tag != .macos) return null;
    const fd = mac_c.open("/dev/tty", 0);
    if (fd < 0) return null;
    defer _ = mac_c.close(fd);
    if (mac_c.ttyname_r(fd, buf.ptr, buf.len) != 0) return null;
    const end = std.mem.indexOfScalar(u8, buf, 0) orelse return null;
    return safeSourceTty(buf[0..end]);
}

pub fn safeSourceTty(value: ?[]const u8) ?[]const u8 {
    const tty = value orelse return null;
    if (tty.len <= "/dev/tty".len or tty.len > 63) return null;
    if (!std.mem.startsWith(u8, tty, "/dev/tty")) return null;
    for (tty["/dev/tty".len..]) |ch| {
        if (!std.ascii.isAlphanumeric(ch)) return null;
    }
    return tty;
}

pub fn safeSourceCwd(value: ?[]const u8) ?[]const u8 {
    const cwd = value orelse return null;
    if (cwd.len == 0 or cwd.len > 511 or cwd[0] != '/') return null;
    if (!std.unicode.utf8ValidateSlice(cwd)) return null;
    for (cwd) |ch| {
        if (ch < 0x20 or ch == '"' or ch == '\\') return null;
    }
    return cwd;
}

fn spawnAndWait(argv: []const []const u8) bool {
    var scope = Scope.init();
    defer scope.deinit();
    const io = scope.io();
    var child = std.process.spawn(io, .{ .argv = argv, .stdin = .ignore, .stdout = .ignore, .stderr = .ignore }) catch return false;
    return switch (child.wait(io) catch return false) {
        .exited => |code| code == 0,
        else => false,
    };
}

pub fn activateOriginApplication(origin: OriginApplication, source_tty: []const u8, source_cwd: []const u8) bool {
    if (builtin.os.tag != .macos) return false;
    _ = source_cwd;
    if (origin == .terminal) {
        if (safeSourceTty(source_tty)) |tty| {
            if (spawnAndWait(&.{ "/usr/bin/osascript", "-e", terminal_focus_script, tty })) return true;
        }
    }
    const bundle_id = origin.bundleIdentifier() orelse return false;
    return spawnAndWait(&.{ "/usr/bin/open", "-b", bundle_id });
}

// ------------------------------------------------------- app presence

/// The objc-runtime and libdispatch surface needed to flip the Dock
/// icon at runtime. The SDK host pins the activation policy to Regular
/// at boot and exposes no channel for it, so this reaches AppKit
/// through the objc runtime directly. Compiled on macOS only: the
/// externs do not exist elsewhere.
const AppleApp = if (builtin.os.tag == .macos) struct {
    extern fn objc_getClass(name: [*:0]const u8) ?*anyopaque;
    extern fn sel_registerName(name: [*:0]const u8) ?*anyopaque;
    extern fn objc_msgSend() void;
    extern var _dispatch_main_q: anyopaque;
    extern fn dispatch_async_f(queue: *anyopaque, context: ?*anyopaque, work: *const fn (?*anyopaque) callconv(.c) void) void;
    extern fn dlopen(path: [*:0]const u8, mode: c_int) ?*anyopaque;

    /// `SMAppService.mainAppService` — the macOS 13+ login-item API.
    /// ServiceManagement is not among the frameworks the SDK links, so
    /// it is dlopen'd on first use (idempotent; RTLD_NOW). Null on
    /// macOS < 13, where objc_getClass finds no such class.
    fn smAppService() ?*anyopaque {
        _ = dlopen("/System/Library/Frameworks/ServiceManagement.framework/ServiceManagement", 2);
        const cls = objc_getClass("SMAppService") orelse return null;
        const sel = sel_registerName("mainAppService") orelse return null;
        const MsgSendObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        return @as(MsgSendObj, @ptrCast(&objc_msgSend))(cls, sel);
    }

    /// Runs on the main queue: NSApplication is main-thread-only and
    /// every caller sits on the runtime loop thread.
    fn applyPolicy(context: ?*anyopaque) callconv(.c) void {
        // NSApplicationActivationPolicyRegular = 0, Accessory = 1;
        // encoded in the context pointer (null = regular).
        const policy: isize = if (context == null) 0 else 1;
        const NSApplication = objc_getClass("NSApplication") orelse return;
        const shared_sel = sel_registerName("sharedApplication") orelse return;
        const MsgSendObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const app = @as(MsgSendObj, @ptrCast(&objc_msgSend))(NSApplication, shared_sel) orelse return;
        const set_sel = sel_registerName("setActivationPolicy:") orelse return;
        const MsgSendPolicy = *const fn (?*anyopaque, ?*anyopaque, isize) callconv(.c) bool;
        _ = @as(MsgSendPolicy, @ptrCast(&objc_msgSend))(app, set_sel, policy);
    }
} else struct {};

/// Hide or show the app's Dock icon (macOS activation policy
/// `.accessory` vs `.regular`). Windows still open and focus in
/// accessory mode; the app just leaves the Dock and app switcher.
/// No-op on other platforms.
pub fn setDockIconHidden(hidden: bool) void {
    if (builtin.os.tag != .macos) return;
    const ctx: ?*anyopaque = if (hidden) @ptrFromInt(1) else null;
    AppleApp.dispatch_async_f(&AppleApp._dispatch_main_q, ctx, AppleApp.applyPolicy);
}

/// Whether the app is registered as a login item (macOS 13+;
/// SMAppServiceStatusEnabled == 1). False anywhere the API is missing.
pub fn launchAtLoginEnabled() bool {
    if (builtin.os.tag != .macos) return false;
    const svc = AppleApp.smAppService() orelse return false;
    const sel = AppleApp.sel_registerName("status") orelse return false;
    const MsgSendInt = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) isize;
    return @as(MsgSendInt, @ptrCast(&AppleApp.objc_msgSend))(svc, sel) == 1;
}

/// Register/unregister the app as a login item. Returns whether the
/// call reported success; callers should re-query
/// `launchAtLoginEnabled` rather than trust the wish — an unbundled
/// dev binary or a user-declined approval rejects the registration.
pub fn setLaunchAtLogin(enabled: bool) bool {
    if (builtin.os.tag != .macos) return false;
    const svc = AppleApp.smAppService() orelse return false;
    const sel = AppleApp.sel_registerName(if (enabled) "registerAndReturnError:" else "unregisterAndReturnError:") orelse return false;
    const MsgSendErr = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) bool;
    return @as(MsgSendErr, @ptrCast(&AppleApp.objc_msgSend))(svc, sel, null);
}

/// Quit the way a menu quit would. SIGTERM rides the hosts'
/// graceful-shutdown paths (the macOS host turns it into `NSApp
/// terminate` through a dispatch source, sealing journals on the way
/// out); Windows has no SIGTERM, so it exits directly.
///
/// `kill(getpid())`, deliberately not `raise()`: the host listens
/// through a kqueue-backed dispatch source, and EVFILT_SIGNAL only
/// sees process-directed signals — `raise()` in a multithreaded
/// process is `pthread_kill(self)`, which the source never observes
/// (verified: an external `kill -TERM` quit the app, an in-process
/// `raise` was silently dropped).
///
/// Both branches avoid libc for the same reason `processId` does: the
/// analysis object `native test` builds does not link it. Linux sends
/// the signal through the raw syscall, and Windows exits through
/// `std.process.exit` (`RtlExitUserProcess` underneath) since
/// `kernel32.ExitProcess` is not declared in Zig 0.16's std.
pub fn requestQuit() void {
    switch (builtin.os.tag) {
        .windows => std.process.exit(0),
        .linux => _ = std.os.linux.kill(@intCast(processId()), .TERM),
        else => _ = std.c.kill(@intCast(processId()), .TERM),
    }
}

/// Open a URL or a folder in the desktop's default handler. One
/// spawn, no shell, so a path with quotes cannot become an argument
/// injection the way the old `system()` string could.
pub fn openExternal(target: []const u8) void {
    var scope = Scope.init();
    defer scope.deinit();
    const io = scope.io();
    const argv: []const []const u8 = switch (builtin.os.tag) {
        .windows => &.{ "cmd", "/c", "start", "", target },
        .macos => &.{ "/usr/bin/open", target },
        else => &.{ "xdg-open", target },
    };
    var child = std.process.spawn(io, .{
        .argv = argv,
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
    }) catch return;
    _ = child.wait(io) catch {};
}
