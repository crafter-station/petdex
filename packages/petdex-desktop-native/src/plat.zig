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
const macos_fsevents = @import("macos_fsevents.zig");
const linux_activation = @import("linux_activation.zig");

pub const DirectoryWatchSignal = enum { none, dirty, overflow };

/// A bounded, coalescing directory-change signal. Native backends report only
/// that reconciliation work is needed; the reconciliation layer remains the
/// source of truth and performs bounded scans. Queue overflow deliberately
/// collapses to one stronger signal instead of retaining unbounded paths.
pub const DirectoryWatch = struct {
    const max_path = 1024;
    const linux_max_dirs = 512;
    path: [max_path]u8 = @splat(0),
    path_len: usize = 0,
    dirty: std.atomic.Value(bool) = .init(false),
    overflow: std.atomic.Value(bool) = .init(false),
    cursor: std.atomic.Value(u64) = .init(0),
    failures: std.atomic.Value(u8) = .init(0),

    pub fn init(path: []const u8) ?DirectoryWatch {
        if (path.len == 0 or path.len > max_path or !std.unicode.utf8ValidateSlice(path)) return null;
        var result: DirectoryWatch = .{};
        result.path_len = path.len;
        @memcpy(result.path[0..path.len], path);
        return result;
    }

    pub fn start(self: *DirectoryWatch) bool {
        const thread = std.Thread.spawn(.{}, watchThread, .{self}) catch return false;
        thread.detach();
        return true;
    }

    pub fn root(self: *const DirectoryWatch) []const u8 {
        return self.path[0..self.path_len];
    }

    pub fn take(self: *DirectoryWatch) DirectoryWatchSignal {
        if (self.overflow.swap(false, .acq_rel)) {
            _ = self.dirty.swap(false, .acq_rel);
            return .overflow;
        }
        return if (self.dirty.swap(false, .acq_rel)) .dirty else .none;
    }

    fn publish(self: *DirectoryWatch, signal: DirectoryWatchSignal) void {
        switch (signal) {
            .none => return,
            .dirty => self.dirty.store(true, .release),
            .overflow => self.overflow.store(true, .release),
        }
        _ = self.cursor.fetchAdd(1, .acq_rel);
    }

    fn watchThread(self: *DirectoryWatch) void {
        var delay_ms: i64 = 250;
        while (true) {
            self.backendLoop() catch {
                const prior = self.failures.load(.acquire);
                const count = prior +| 1;
                self.failures.store(count, .release);
                delay_ms = directoryWatchBackoff(count);
                self.publish(.overflow);
                var scope = Scope.init();
                std.Io.sleep(scope.io(), std.Io.Duration.fromMilliseconds(delay_ms), .awake) catch {};
                scope.deinit();
                continue;
            };
            delay_ms = 250;
        }
    }

    fn backendLoop(self: *DirectoryWatch) !void {
        return switch (builtin.os.tag) {
            .windows => self.windowsLoop(),
            .linux => self.linuxLoop(),
            .macos => self.fseventsLoop(),
            else => error.UnsupportedDirectoryWatch,
        };
    }

    fn windowsLoop(self: *DirectoryWatch) !void {
        const windows = std.os.windows;
        const path_w = try std.unicode.utf8ToUtf16LeAllocZ(std.heap.page_allocator, self.path[0..self.path_len]);
        defer std.heap.page_allocator.free(path_w);
        const handle = CreateFileW(path_w.ptr, 0x0001, 0x00000001 | 0x00000002 | 0x00000004, null, 3, 0x02000000, null);
        if (handle == windows.INVALID_HANDLE_VALUE) return error.OpenDirectoryWatchFailed;
        defer windows.CloseHandle(handle);
        var buffer: [64 * 1024]u8 align(@alignOf(u32)) = undefined;
        while (true) {
            var bytes: windows.DWORD = 0;
            if (ReadDirectoryChangesW(handle, &buffer, buffer.len, windows.BOOL.TRUE, 0x00000001 | 0x00000002 | 0x00000008 | 0x00000010 | 0x00000020, &bytes, null, null) == .FALSE) return error.DirectoryWatchReadFailed;
            self.failures.store(0, .release);
            self.publish(if (bytes == 0) .overflow else .dirty);
        }
    }

    fn linuxAddTree(self: *DirectoryWatch, io: std.Io, fd: std.posix.fd_t, path: []const u8, depth: u8, count: *usize) void {
        if (depth > 12 or count.* >= linux_max_dirs) {
            self.publish(.overflow);
            return;
        }
        const path_z = std.heap.page_allocator.dupeZ(u8, path) catch {
            self.publish(.overflow);
            return;
        };
        defer std.heap.page_allocator.free(path_z);
        const mask = std.os.linux.IN.CLOSE_WRITE | std.os.linux.IN.CREATE | std.os.linux.IN.DELETE |
            std.os.linux.IN.MOVED_FROM | std.os.linux.IN.MOVED_TO | std.os.linux.IN.DELETE_SELF | std.os.linux.IN.MOVE_SELF;
        const add_result = std.os.linux.inotify_add_watch(fd, path_z, mask);
        if (std.posix.errno(add_result) != .SUCCESS) {
            self.publish(.overflow);
            return;
        }
        count.* += 1;
        var dir = std.Io.Dir.openDirAbsolute(io, path, .{ .iterate = true }) catch {
            self.publish(.overflow);
            return;
        };
        defer dir.close(io);
        var it = dir.iterate();
        while (it.next(io) catch null) |entry| {
            if (entry.kind != .directory) continue;
            if (count.* >= linux_max_dirs) {
                self.publish(.overflow);
                continue;
            }
            const child = std.fs.path.join(std.heap.page_allocator, &.{ path, entry.name }) catch {
                self.publish(.overflow);
                continue;
            };
            defer std.heap.page_allocator.free(child);
            self.linuxAddTree(io, fd, child, depth + 1, count);
        }
    }

    fn linuxLoop(self: *DirectoryWatch) !void {
        var scope = Scope.init();
        defer scope.deinit();
        const io = scope.io();
        const init_result = std.os.linux.inotify_init1(std.os.linux.IN.CLOEXEC);
        if (std.posix.errno(init_result) != .SUCCESS) return error.InotifyInitFailed;
        const fd: std.posix.fd_t = @intCast(init_result);
        defer std.Io.Threaded.closeFd(fd);
        var count: usize = 0;
        self.linuxAddTree(io, fd, self.path[0..self.path_len], 0, &count);
        if (count == 0) return error.InotifyWatchFailed;
        var buffer: [16 * 1024]u8 align(@alignOf(std.os.linux.inotify_event)) = undefined;
        while (true) {
            const used = try std.posix.read(fd, &buffer);
            var offset: usize = 0;
            var overflowed = false;
            while (offset + @sizeOf(std.os.linux.inotify_event) <= used) {
                const event: *align(1) const std.os.linux.inotify_event = @ptrCast(buffer[offset..].ptr);
                if (event.mask & std.os.linux.IN.Q_OVERFLOW != 0) overflowed = true;
                const next = @sizeOf(std.os.linux.inotify_event) + event.len;
                if (next == 0 or offset + next > used) break;
                offset += next;
            }
            self.failures.store(0, .release);
            self.publish(if (overflowed) .overflow else .dirty);
            count = 0;
            self.linuxAddTree(io, fd, self.path[0..self.path_len], 0, &count);
        }
    }

    fn fseventsPublish(raw: *anyopaque, signal: macos_fsevents.Signal) void {
        const self: *DirectoryWatch = @ptrCast(@alignCast(raw));
        self.failures.store(0, .release);
        self.publish(switch (signal) {
            .dirty => .dirty,
            .overflow => .overflow,
        });
    }

    fn fseventsLoop(self: *DirectoryWatch) !void {
        return macos_fsevents.run(self.path[0..self.path_len], .{
            .context = self,
            .publish = fseventsPublish,
        });
    }
};

fn directoryWatchBackoff(failures: u8) i64 {
    const shift: u6 = @intCast(@min(failures, 7));
    return @min(@as(i64, 30_000), @as(i64, 250) << shift);
}

test "directory watch signals coalesce overflow and bound retry backoff" {
    var watch = DirectoryWatch.init("safe-root").?;
    watch.publish(.dirty);
    watch.publish(.dirty);
    try std.testing.expectEqual(DirectoryWatchSignal.dirty, watch.take());
    try std.testing.expectEqual(DirectoryWatchSignal.none, watch.take());
    watch.publish(.dirty);
    watch.publish(.overflow);
    try std.testing.expectEqual(DirectoryWatchSignal.overflow, watch.take());
    try std.testing.expectEqual(DirectoryWatchSignal.none, watch.take());
    try std.testing.expectEqual(@as(i64, 500), directoryWatchBackoff(1));
    try std.testing.expectEqual(@as(i64, 30_000), directoryWatchBackoff(20));
}

extern "kernel32" fn CreateFileW(
    name: [*:0]const u16,
    access: std.os.windows.DWORD,
    share: std.os.windows.DWORD,
    security: ?*anyopaque,
    creation: std.os.windows.DWORD,
    flags: std.os.windows.DWORD,
    template: ?std.os.windows.HANDLE,
) callconv(.winapi) std.os.windows.HANDLE;
extern "kernel32" fn ReadDirectoryChangesW(
    directory: std.os.windows.HANDLE,
    buffer: *anyopaque,
    buffer_len: std.os.windows.DWORD,
    subtree: std.os.windows.BOOL,
    filter: std.os.windows.DWORD,
    bytes: *std.os.windows.DWORD,
    overlapped: ?*anyopaque,
    completion: ?*anyopaque,
) callconv(.winapi) std.os.windows.BOOL;

/// One Io per calling thread. Cheap to build (no worker threads spin
/// up until an async call asks for them) and never shared, so the
/// blocking helpers below are safe from any thread.
pub const Scope = struct {
    threaded: std.Io.Threaded,

    pub fn init() Scope {
        // Timed socket receives use Io.concurrent internally on Windows, so
        // this scope must provide a real threadsafe allocator for the worker
        // pool even though ordinary file operations remain blocking.
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

/// Append one bounded record without replacing the file. Runtime journals use
/// one file per provider/conversation, so normal hook delivery is serialized
/// by the provider while independent agents never contend on one handle.
/// When `rotate_at` would be exceeded, the prior generation is retained at
/// `<path>.1`; both generations remain private on POSIX and inherit the
/// user's private runtime-directory ACL on Windows.
pub fn appendFileModeRotating(path: []const u8, bytes: []const u8, mode: u16, rotate_at: u64) bool {
    if (bytes.len == 0 or @as(u64, @intCast(bytes.len)) > rotate_at) return false;
    var scope = Scope.init();
    defer scope.deinit();
    const io = scope.io();
    var cwd = std.Io.Dir.cwd();

    // Hooks are separate processes and providers may run tools concurrently.
    // Serialize the size/rotation/write transaction with a sibling advisory
    // lock; locking only the data file would leave rename races uncovered.
    var lock_path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const lock_path = std.fmt.bufPrint(&lock_path_buf, "{s}.lock", .{path}) catch return false;
    var lock_file = cwd.createFile(io, lock_path, .{
        .read = true,
        .truncate = false,
        .lock = .exclusive,
        .permissions = permissionsFromMode(mode),
    }) catch return false;
    defer lock_file.close(io);

    var current_size: u64 = 0;
    if (cwd.statFile(io, path, .{})) |stat| {
        if (stat.kind != .file) return false;
        current_size = stat.size;
    } else |_| {}

    if (current_size + @as(u64, @intCast(bytes.len)) > rotate_at) {
        var previous_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
        const previous = std.fmt.bufPrint(&previous_buf, "{s}.1", .{path}) catch return false;
        cwd.deleteFile(io, previous) catch {};
        cwd.rename(path, cwd, previous, io) catch return false;
        current_size = 0;
    }

    var file = cwd.createFile(io, path, .{
        .read = true,
        .truncate = false,
        .permissions = permissionsFromMode(mode),
    }) catch return false;
    defer file.close(io);
    file.writePositionalAll(io, bytes, current_size) catch return false;
    file.sync(io) catch return false;
    return true;
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

    // Atomic replacement creates a new inode, so using default permissions
    // here silently widens an existing private file (for example Codex's
    // 0600 config.toml) to the process default. Preserve the target's current
    // mode unless the caller explicitly requested a new one.
    var permissions = permissionsFromMode(mode);
    if (mode == null) {
        if (std.Io.Dir.cwd().statFile(io, target_path, .{})) |stat| {
            if (stat.kind == .file) permissions = stat.permissions;
        } else |_| {}
    }

    var atomic_file = std.Io.Dir.cwd().createFileAtomic(io, target_path, .{
        .permissions = permissions,
        // Callers pass user-scoped paths whose parent may not exist yet
        // (notably the Codex mirror on a first install). Keep the atomic
        // replacement semantics, but do not turn a missing parent into a
        // silently ignored write failure.
        .make_path = true,
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

test "atomic rewrite preserves private file permissions" {
    if (builtin.os.tag == .windows) return;

    const dir = ".zig-cache/petdex-plat-permissions";
    const path = dir ++ "/private-config";
    makeDir(dir);
    try std.testing.expect(writeFileMode(path, "before", 0o600));
    try std.testing.expect(writeFile(path, "after"));

    var scope = Scope.init();
    defer scope.deinit();
    const stat = try std.Io.Dir.cwd().statFile(scope.io(), path, .{});
    try std.testing.expectEqual(@as(u16, 0o600), @as(u16, @intCast(@intFromEnum(stat.permissions) & 0o777)));
}

test "rotating append retains one private previous generation" {
    const dir = ".zig-cache/petdex-plat-append";
    const path = dir ++ "/journal.jsonl";
    makeDir(dir);
    deleteFile(path);
    deleteFile(path ++ ".1");
    try std.testing.expect(appendFileModeRotating(path, "one\n", 0o600, 9));
    try std.testing.expect(appendFileModeRotating(path, "two\n", 0o600, 9));
    try std.testing.expect(appendFileModeRotating(path, "three\n", 0o600, 9));
    var current_buf: [32]u8 = undefined;
    var prior_buf: [32]u8 = undefined;
    try std.testing.expectEqualStrings("three\n", readFile(path, &current_buf).?);
    try std.testing.expectEqualStrings("one\ntwo\n", readFile(path ++ ".1", &prior_buf).?);
}

pub fn makeDir(path: []const u8) void {
    var scope = Scope.init();
    defer scope.deinit();
    // Already-exists is the common case at every call site, so the
    // error is swallowed exactly like the old `_ = std.c.mkdir(...)`.
    std.Io.Dir.cwd().createDirPath(scope.io(), path) catch {};
}

/// Create a directory tree and constrain the leaf directory's POSIX mode.
/// Windows keeps the inherited ACL, matching writeFileMode's behavior.
pub fn makeDirMode(path: []const u8, mode: u16) bool {
    var scope = Scope.init();
    defer scope.deinit();
    const io = scope.io();
    std.Io.Dir.cwd().createDirPath(io, path) catch return false;
    if (builtin.os.tag == .windows) return true;
    var dir = std.Io.Dir.cwd().openDir(io, path, .{ .iterate = true }) catch return false;
    defer dir.close(io);
    dir.setPermissions(io, @enumFromInt(mode)) catch return false;
    return true;
}

pub fn deleteFile(path: []const u8) void {
    var scope = Scope.init();
    defer scope.deinit();
    std.Io.Dir.cwd().deleteFile(scope.io(), path) catch {};
}

pub fn deleteTree(path: []const u8) bool {
    var scope = Scope.init();
    defer scope.deinit();
    std.Io.Dir.cwd().deleteTree(scope.io(), path) catch return false;
    return true;
}

pub fn fileExists(path: []const u8) bool {
    var scope = Scope.init();
    defer scope.deinit();
    const io = scope.io();
    var file = std.Io.Dir.cwd().openFile(io, path, .{}) catch return false;
    file.close(io);
    return true;
}

pub fn fileSize(path: []const u8) ?u64 {
    var scope = Scope.init();
    defer scope.deinit();
    const stat = std.Io.Dir.cwd().statFile(scope.io(), path, .{}) catch return null;
    return stat.size;
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
    if (comptime builtin.os.tag == .windows) return readStdinWindows(buf);
    return readStdinPortable(buf);
}

fn readStdinPortable(buf: []u8) []const u8 {
    var scope = Scope.init();
    defer scope.deinit();
    const io = scope.io();
    const stdin = std.Io.File.stdin();
    var storage: [1]std.Io.Operation.Storage = undefined;
    var batch = std.Io.Batch.init(&storage);
    defer batch.cancel(io);

    var discard: [4096]u8 = undefined;
    var target: [1][]u8 = undefined;
    var total: usize = 0;
    var complete = false;
    var deadline = stdinDeadline(io, stdin_read_timeout_ms);

    // One outstanding read at a time keeps the capture buffer bounded while
    // Io.Batch supplies poll/overlapped implementations for POSIX and Windows.
    while (true) {
        target[0] = if (total < buf.len) buf[total..] else discard[0..];
        batch.addAt(0, .{ .file_read_streaming = .{ .file = stdin, .data = &target } });

        batch.awaitConcurrent(io, .{ .deadline = deadline }) catch break;
        const completion = batch.next() orelse break;
        const n = completion.result.file_read_streaming catch return buf[0..total];
        if (n == 0) return buf[0..total];

        if (total < buf.len) total += n;
        if (!complete and hasCompleteJsonPayload(buf[0..total])) {
            complete = true;
            // Once the JSON value is complete, give the host a short bounded
            // drain window for trailing/oversized bytes, then let the process
            // close its read side instead of waiting for EOF forever.
            deadline = stdinDeadline(io, stdin_drain_grace_ms);
        }
    }
    return buf[0..total];
}

/// Windows' inherited stdin is a synchronous pipe. Zig 0.16's `std.Io`
/// implementation sends that handle through `NtReadFile`; when the pipe is
/// still open after a short payload, Windows returns `PENDING` and the
/// synchronous path aborts at `unreachable`. Use the Win32 synchronous
/// `ReadFile` API on a short-lived worker instead. The caller can then keep
/// the same bounded JSON/drain deadlines without ever handing a caller-owned
/// stack buffer to a potentially detached reader.
const WindowsStdinTask = if (builtin.os.tag == .windows) struct {
    handle: std.os.windows.HANDLE,
    buffer: []u8,
    written: std.atomic.Value(usize) = .init(0),
    finished: std.atomic.Value(bool) = .init(false),
} else void;

const windows_stdin_api = if (builtin.os.tag == .windows) struct {
    extern "kernel32" fn ReadFile(
        handle: std.os.windows.HANDLE,
        buffer: std.os.windows.LPVOID,
        bytes_to_read: std.os.windows.DWORD,
        bytes_read: *std.os.windows.DWORD,
        overlapped: ?*anyopaque,
    ) callconv(.winapi) std.os.windows.BOOL;
} else struct {};

fn windowsStdinWorker(task: *WindowsStdinTask) void {
    if (comptime builtin.os.tag != .windows) return;

    var offset: usize = 0;
    while (offset < task.buffer.len) {
        var bytes_read: std.os.windows.DWORD = 0;
        const ok = windows_stdin_api.ReadFile(
            task.handle,
            @ptrCast(task.buffer.ptr + offset),
            1,
            &bytes_read,
            null,
        );
        if (ok == .FALSE or bytes_read == 0) break;
        offset += @min(@as(usize, @intCast(bytes_read)), task.buffer.len - offset);
        task.written.store(offset, .release);
    }
    task.finished.store(true, .release);
}

fn readStdinWindows(buf: []u8) []const u8 {
    if (buf.len == 0) return buf[0..0];

    const allocator = std.heap.page_allocator;
    const task = allocator.create(WindowsStdinTask) catch return buf[0..0];
    task.* = .{
        .handle = std.Io.File.stdin().handle,
        .buffer = allocator.alloc(u8, buf.len) catch {
            allocator.destroy(task);
            return buf[0..0];
        },
    };

    const thread = std.Thread.spawn(.{}, windowsStdinWorker, .{task}) catch {
        allocator.free(task.buffer);
        allocator.destroy(task);
        return buf[0..0];
    };

    var scope = Scope.init();
    defer scope.deinit();
    const io = scope.io();
    const read_deadline = stdinDeadline(io, stdin_read_timeout_ms);
    var deadline = read_deadline;
    var complete = false;

    while (true) {
        const count = task.written.load(.acquire);
        if (!complete and count > 0 and hasCompleteJsonPayload(task.buffer[0..count])) {
            complete = true;
            deadline = stdinDeadline(io, stdin_drain_grace_ms);
        }

        if (task.finished.load(.acquire)) {
            thread.join();
            const final_count = @min(task.written.load(.acquire), buf.len);
            @memcpy(buf[0..final_count], task.buffer[0..final_count]);
            allocator.free(task.buffer);
            allocator.destroy(task);
            return buf[0..final_count];
        }

        if (deadline.durationFromNow(io).raw.toNanoseconds() <= 0) {
            const final_count = @min(task.written.load(.acquire), buf.len);
            @memcpy(buf[0..final_count], task.buffer[0..final_count]);
            // The worker owns only heap storage and the hook process exits
            // immediately after this function, so detaching is safe when a
            // host deliberately leaves stdin open forever.
            thread.detach();
            return buf[0..final_count];
        }

        io.sleep(.fromMilliseconds(1), .awake) catch {};
    }
}

const stdin_read_timeout_ms: u64 = 500;
const stdin_drain_grace_ms: u64 = 300;

fn stdinDeadline(io: std.Io, milliseconds: u64) std.Io.Clock.Timestamp {
    return std.Io.Clock.Timestamp.fromNow(io, .{
        .clock = .awake,
        .raw = std.Io.Duration.fromMilliseconds(@intCast(milliseconds)),
    });
}

/// Return whether a retained prefix contains one balanced JSON value. The
/// hook payload is parsed again by hook_runner; this scanner only decides when
/// it is safe to stop waiting for EOF. Strings and escaped quotes are skipped
/// so braces inside tool commands do not trigger an early return.
fn hasCompleteJsonPayload(bytes: []const u8) bool {
    var start: usize = 0;
    while (start < bytes.len and (bytes[start] == ' ' or bytes[start] == '\t' or bytes[start] == '\r' or bytes[start] == '\n')) start += 1;
    if (start == bytes.len) return false;
    const root = bytes[start];
    if (root != '{' and root != '[') return false;

    var expected: [128]u8 = undefined;
    var depth: usize = 1;
    expected[0] = if (root == '{') '}' else ']';
    var quoted = false;
    var escaped = false;

    var i = start + 1;
    while (i < bytes.len) : (i += 1) {
        const byte = bytes[i];
        if (quoted) {
            if (escaped) escaped = false else if (byte == '\\') escaped = true else if (byte == '"') quoted = false;
            continue;
        }
        if (byte == '"') {
            quoted = true;
            continue;
        }
        if (byte == '{' or byte == '[') {
            if (depth == expected.len) return false;
            expected[depth] = if (byte == '{') '}' else ']';
            depth += 1;
            continue;
        }
        if (byte != '}' and byte != ']') continue;
        if (depth == 0 or expected[depth - 1] != byte) return false;
        depth -= 1;
        if (depth != 0) continue;
        // The hook host may append whitespace; the first complete value is
        // sufficient because later bytes are drained, not parsed.
        return true;
    }
    return false;
}

test "complete JSON detection ignores braces inside strings" {
    try std.testing.expect(hasCompleteJsonPayload("{\"command\":\"echo {still-open}\\\"\"}"));
    try std.testing.expect(!hasCompleteJsonPayload("{\"command\":\"echo"));
    try std.testing.expect(!hasCompleteJsonPayload("{\"command\":["));
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

/// POSIX launcher for the stable hook entry. A regular launcher file is
/// deliberately safer than a symlink: remote executable installation can
/// atomically replace the entry without following it into the app binary.
/// Single-quote escaping keeps arbitrary executable paths literal while
/// `exec` preserves stdin, argv, signals, and the hook process exit status.
pub fn unixHookLauncher(buf: []u8, target: []const u8) ?[]const u8 {
    const prefix = "#!/bin/sh\nexec '";
    const escaped_quote = "'\\''";
    const suffix = "' \"$@\"\n";
    if (buf.len < prefix.len + suffix.len) return null;

    var at: usize = 0;
    @memcpy(buf[at .. at + prefix.len], prefix);
    at += prefix.len;
    for (target) |byte| {
        if (byte == '\'') {
            if (at + escaped_quote.len > buf.len - suffix.len) return null;
            @memcpy(buf[at .. at + escaped_quote.len], escaped_quote);
            at += escaped_quote.len;
        } else {
            if (at + 1 > buf.len - suffix.len) return null;
            buf[at] = byte;
            at += 1;
        }
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

test "DSH browser activation stays strict" {
    try std.testing.expectEqual(OriginApplication.default_browser, OriginApplication.fromTermProgram("default_browser"));
    try std.testing.expectEqualStrings("default_browser", OriginApplication.default_browser.wireName());
    try std.testing.expect(BrowserActivation.already_active.succeeded());
    try std.testing.expect(BrowserActivation.activated.succeeded());
    try std.testing.expect(!BrowserActivation.not_running.succeeded());
    try std.testing.expect(!BrowserActivation.activation_failed.succeeded());
}

test "Unix hook launcher quotes the target and forwards stdin and arguments" {
    var buf: [256]u8 = undefined;
    const launcher = unixHookLauncher(&buf, "/home/dev/it's $ready/petdex").?;
    try std.testing.expectEqualStrings(
        "#!/bin/sh\nexec '/home/dev/it'\\''s $ready/petdex' \"$@\"\n",
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

/// Short machine name for bubble provenance. The value is UI metadata, so a
/// failed or exotic platform lookup simply falls back at the caller.
pub fn hostName(buf: []u8) ?[]const u8 {
    if (comptime builtin.os.tag == .windows) {
        if (buf.len == 0 or buf.len > std.math.maxInt(u32)) return null;
        var length: u32 = @intCast(buf.len);
        if (win_activation.GetComputerNameA(buf.ptr, &length) == 0 or length == 0) return null;
        const name = buf[0..length];
        for (name) |ch| {
            if (!std.ascii.isAlphanumeric(ch) and ch != '-' and ch != '_' and ch != '.') return null;
        }
        return name;
    }
    var raw: [std.posix.HOST_NAME_MAX]u8 = undefined;
    const name = std.posix.gethostname(&raw) catch return null;
    if (name.len == 0 or name.len > buf.len) return null;
    for (name) |ch| {
        if (!std.ascii.isAlphanumeric(ch) and ch != '-' and ch != '_' and ch != '.') return null;
    }
    @memcpy(buf[0..name.len], name);
    return buf[0..name.len];
}

/// GUI application that owns the terminal hosting the latest agent event.
/// Hook metadata is allowlisted and never becomes an arbitrary bundle id.
pub const OriginApplication = enum(u8) {
    none,
    terminal,
    vscode,
    /// DSH Web owns the task UI in the user's default browser. Unlike the
    /// terminal rows this is intentionally not a bundle identifier: the
    /// active HTTP handler is resolved at click time on macOS.
    default_browser,
    codex,

    pub fn fromTermProgram(value: ?[]const u8) OriginApplication {
        const name = value orelse return .none;
        if (std.mem.eql(u8, name, "Apple_Terminal") or std.ascii.eqlIgnoreCase(name, "Windows_Terminal") or std.ascii.eqlIgnoreCase(name, "WindowsTerminal")) return .terminal;
        if (std.ascii.eqlIgnoreCase(name, "vscode") or std.ascii.eqlIgnoreCase(name, "Visual Studio Code")) return .vscode;
        if (std.ascii.eqlIgnoreCase(name, "default_browser")) return .default_browser;
        if (std.ascii.eqlIgnoreCase(name, "codex") or std.ascii.eqlIgnoreCase(name, "ChatGPT")) return .codex;
        return .none;
    }

    pub fn wireName(self: OriginApplication) []const u8 {
        return switch (self) {
            .none => "",
            .terminal => if (builtin.os.tag == .windows) "Windows_Terminal" else "Apple_Terminal",
            .vscode => "vscode",
            .default_browser => "default_browser",
            .codex => "codex",
        };
    }

    fn bundleIdentifier(self: OriginApplication) ?[]const u8 {
        return switch (self) {
            .none => null,
            .terminal => "com.apple.Terminal",
            .vscode => "com.microsoft.VSCode",
            .default_browser => null,
            // The current desktop app is displayed as “ChatGPT” but keeps
            // the Codex bundle id. `open -b` needs the identifier, not the
            // product name shown in Finder.
            .codex => "com.openai.codex",
        };
    }
};

pub const BrowserActivation = enum {
    unsupported,
    no_handler,
    not_running,
    already_active,
    activated,
    activation_failed,

    pub fn succeeded(self: BrowserActivation) bool {
        return self == .already_active or self == .activated;
    }
};

const win_activation = struct {
    const Hwnd = ?*anyopaque;
    const Handle = ?*anyopaque;
    const Context = struct {
        origin: OriginApplication,
        source_cwd: []const u8,
        registered_executable: []const u8 = "",
        found: Hwnd = null,
    };

    extern "kernel32" fn GetComputerNameA(buffer: [*]u8, size: *u32) callconv(.winapi) c_int;
    extern "kernel32" fn OpenProcess(access: u32, inherit: c_int, process_id: u32) callconv(.winapi) Handle;
    extern "kernel32" fn QueryFullProcessImageNameA(process: Handle, flags: u32, buffer: [*]u8, size: *u32) callconv(.winapi) c_int;
    extern "kernel32" fn CloseHandle(handle: Handle) callconv(.winapi) c_int;
    extern "kernel32" fn LoadLibraryA(name: [*:0]const u8) callconv(.winapi) Handle;
    extern "kernel32" fn FreeLibrary(module: Handle) callconv(.winapi) c_int;
    extern "kernel32" fn GetProcAddress(module: Handle, name: [*:0]const u8) callconv(.winapi) ?*anyopaque;
    extern "user32" fn EnumWindows(callback: *const fn (Hwnd, isize) callconv(.winapi) c_int, parameter: isize) callconv(.winapi) c_int;
    extern "user32" fn IsWindowVisible(window: Hwnd) callconv(.winapi) c_int;
    extern "user32" fn IsIconic(window: Hwnd) callconv(.winapi) c_int;
    extern "user32" fn GetWindowThreadProcessId(window: Hwnd, process_id: *u32) callconv(.winapi) u32;
    extern "user32" fn ShowWindow(window: Hwnd, command: c_int) callconv(.winapi) c_int;
    extern "user32" fn SetForegroundWindow(window: Hwnd) callconv(.winapi) c_int;
    extern "user32" fn GetWindowTextA(window: Hwnd, buffer: [*]u8, length: c_int) callconv(.winapi) c_int;

    fn registeredBrowserExecutable(buf: []u8) ?[]const u8 {
        const module = LoadLibraryA("shlwapi.dll") orelse return null;
        defer _ = FreeLibrary(module);
        const raw = GetProcAddress(module, "AssocQueryStringA") orelse return null;
        const Query = *const fn (u32, u32, [*:0]const u8, ?[*:0]const u8, [*]u8, *u32) callconv(.winapi) c_long;
        var length: u32 = @intCast(buf.len);
        // ASSOCSTR_EXECUTABLE resolves the executable registered for the
        // user's HTTP handler without launching or navigating it.
        if (@as(Query, @ptrCast(raw))(0, 2, "http", null, buf.ptr, &length) != 0 or length <= 1) return null;
        return buf[0 .. length - 1];
    }

    fn executableMatches(origin: OriginApplication, path: []const u8, registered_executable: []const u8) bool {
        if (origin == .default_browser) {
            return registered_executable.len > 0 and std.ascii.eqlIgnoreCase(path, registered_executable);
        }
        const slash = std.mem.lastIndexOfAny(u8, path, "\\/");
        const basename = if (slash) |index| path[index + 1 ..] else path;
        return switch (origin) {
            .terminal => std.ascii.eqlIgnoreCase(basename, "WindowsTerminal.exe") or std.ascii.eqlIgnoreCase(basename, "wt.exe"),
            .vscode => std.ascii.eqlIgnoreCase(basename, "Code.exe"),
            .codex => std.ascii.eqlIgnoreCase(basename, "ChatGPT.exe") or std.ascii.eqlIgnoreCase(basename, "Codex.exe"),
            .none, .default_browser => false,
        };
    }

    fn enumerate(window: Hwnd, parameter: isize) callconv(.winapi) c_int {
        const context: *Context = @ptrFromInt(@as(usize, @bitCast(parameter)));
        if (IsWindowVisible(window) == 0) return 1;
        var process_id: u32 = 0;
        _ = GetWindowThreadProcessId(window, &process_id);
        if (process_id == 0) return 1;
        const process = OpenProcess(0x1000, 0, process_id) orelse return 1;
        defer _ = CloseHandle(process);
        var buffer: [1024]u8 = undefined;
        var length: u32 = buffer.len;
        if (QueryFullProcessImageNameA(process, 0, &buffer, &length) == 0) return 1;
        if (!executableMatches(context.origin, buffer[0..length], context.registered_executable)) return 1;
        if (context.found == null) context.found = window;
        const cwd = std.mem.trimEnd(u8, context.source_cwd, "/\\");
        const slash = std.mem.lastIndexOfAny(u8, cwd, "/\\");
        const project = if (slash) |index| cwd[index + 1 ..] else cwd;
        if (project.len == 0) return 1;
        var title: [1024]u8 = undefined;
        const title_len = GetWindowTextA(window, &title, title.len);
        if (title_len <= 0) return 1;
        if (std.ascii.indexOfIgnoreCase(title[0..@intCast(title_len)], project) == null) return 1;
        context.found = window;
        return 0;
    }

    fn findWindow(origin: OriginApplication, source_cwd: []const u8) Hwnd {
        if (origin == .none) return null;
        var registered_buf: [1024]u8 = @splat(0);
        var registered_executable: []const u8 = "";
        if (origin == .default_browser) {
            registered_executable = registeredBrowserExecutable(&registered_buf) orelse return null;
        }
        var context: Context = .{
            .origin = origin,
            .source_cwd = source_cwd,
            .registered_executable = registered_executable,
        };
        _ = EnumWindows(enumerate, @bitCast(@intFromPtr(&context)));
        return context.found;
    }

    const AvailabilityCache = struct { checked_ms: i64 = 0, available: bool = false };
    var availability_cache: [5]AvailabilityCache = @splat(.{});
    const availability_cache_ms: i64 = 500;

    fn available(origin: OriginApplication, source_cwd: []const u8) bool {
        if (origin == .none) return false;
        const now = monotonicMs();
        const cache = &availability_cache[@intFromEnum(origin)];
        if (cache.checked_ms > 0 and now - cache.checked_ms <= availability_cache_ms) return cache.available;
        cache.available = findWindow(origin, source_cwd) != null;
        cache.checked_ms = now;
        return cache.available;
    }

    fn activate(origin: OriginApplication, source_cwd: []const u8) bool {
        const window = findWindow(origin, source_cwd) orelse return false;
        if (IsIconic(window) != 0) _ = ShowWindow(window, 9);
        return SetForegroundWindow(window) != 0;
    }
};

test "Codex origin resolves the installed ChatGPT desktop bundle" {
    try std.testing.expectEqualStrings("codex", OriginApplication.codex.wireName());
    try std.testing.expectEqualStrings("com.openai.codex", OriginApplication.codex.bundleIdentifier().?);
}

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
    if (cwd.len == 0 or cwd.len > 511) return null;
    const absolute = if (builtin.os.tag == .windows)
        (cwd.len >= 3 and std.ascii.isAlphabetic(cwd[0]) and cwd[1] == ':' and (cwd[2] == '/' or cwd[2] == '\\')) or
            (cwd.len >= 3 and (std.mem.startsWith(u8, cwd, "//") or std.mem.startsWith(u8, cwd, "\\\\")))
    else
        cwd[0] == '/';
    if (!absolute) return null;
    if (!std.unicode.utf8ValidateSlice(cwd)) return null;
    for (cwd) |ch| {
        if (ch < 0x20 or ch == '"' or (builtin.os.tag != .windows and ch == '\\')) return null;
    }
    return cwd;
}

test "concurrent rotating appends remain record aligned" {
    const dir = ".zig-cache/petdex-plat-concurrent-append";
    const path = dir ++ "/journal.jsonl";
    makeDir(dir);
    deleteFile(path);
    deleteFile(path ++ ".1");
    deleteFile(path ++ ".lock");
    const Worker = struct {
        fn run(writer: u8) void {
            for (0..3) |sequence| {
                var record_buf: [6]u8 = undefined;
                const record = std.fmt.bufPrint(&record_buf, "{c}:{d}xx\n", .{ writer, sequence }) catch unreachable;
                std.debug.assert(record.len == 6);
                std.debug.assert(appendFileModeRotating(path, record, 0o600, 64));
            }
        }
    };
    var threads: [4]std.Thread = undefined;
    const writers = [_]u8{ 'a', 'b', 'c', 'd' };
    for (&threads, writers) |*thread, writer| thread.* = try std.Thread.spawn(.{}, Worker.run, .{writer});
    for (&threads) |*thread| thread.join();
    var current_buf: [128]u8 = undefined;
    var previous_buf: [128]u8 = undefined;
    const generations = [2][]const u8{ readFile(path, &current_buf).?, readFile(path ++ ".1", &previous_buf).? };
    try std.testing.expectEqual(@as(usize, 72), generations[0].len + generations[1].len);
    for (generations) |bytes| {
        try std.testing.expect(bytes.len <= 64);
        var lines = std.mem.splitScalar(u8, bytes, '\n');
        while (lines.next()) |line| {
            if (line.len == 0) continue;
            try std.testing.expect(line.len == 5 and line[1] == ':');
        }
    }
    // Rotation leaves `.1` as the older prefix and the live file as the
    // newer suffix. Reconstruct that stream to verify each writer's calls
    // retained program order as well as exactly-once record membership.
    var ordered_buf: [128]u8 = undefined;
    @memcpy(ordered_buf[0..generations[1].len], generations[1]);
    @memcpy(ordered_buf[generations[1].len..][0..generations[0].len], generations[0]);
    const ordered = ordered_buf[0 .. generations[1].len + generations[0].len];
    for (writers) |writer| for (0..3) |sequence| {
        var record_buf: [6]u8 = undefined;
        const record = try std.fmt.bufPrint(&record_buf, "{c}:{d}xx\n", .{ writer, sequence });
        const count = std.mem.count(u8, generations[0], record) + std.mem.count(u8, generations[1], record);
        try std.testing.expectEqual(@as(usize, 1), count);
        if (sequence > 0) {
            var prior_buf: [6]u8 = undefined;
            const prior = try std.fmt.bufPrint(&prior_buf, "{c}:{d}xx\n", .{ writer, sequence - 1 });
            try std.testing.expect(std.mem.indexOf(u8, ordered, prior).? < std.mem.indexOf(u8, ordered, record).?);
        }
    };
}

test "source cwd accepts native absolute path separators" {
    if (builtin.os.tag == .windows) {
        try std.testing.expectEqualStrings("C:\\work\\petdex", safeSourceCwd("C:\\work\\petdex").?);
        try std.testing.expectEqualStrings("\\\\server\\share", safeSourceCwd("\\\\server\\share").?);
    } else {
        try std.testing.expectEqualStrings("/work/petdex", safeSourceCwd("/work/petdex").?);
        try std.testing.expect(safeSourceCwd("C:\\work\\petdex") == null);
    }
}

pub fn safeHerdrPaneId(value: ?[]const u8) ?[]const u8 {
    const pane = value orelse return null;
    if (pane.len == 0 or pane.len > 64) return null;
    for (pane) |ch| {
        if (!std.ascii.isAlphanumeric(ch) and ch != ':' and ch != '_' and ch != '-') return null;
    }
    return pane;
}

test "Herdr pane ids accept only bounded CLI-safe identifiers" {
    try std.testing.expectEqualStrings("w1:p5", safeHerdrPaneId("w1:p5").?);
    try std.testing.expect(safeHerdrPaneId("w1:p5;open") == null);
    try std.testing.expect(safeHerdrPaneId("") == null);
    var too_long: [65]u8 = @splat('a');
    try std.testing.expect(safeHerdrPaneId(&too_long) == null);
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

fn runHerdrPluginList(allocator: std.mem.Allocator, binary: []const u8) ?[]u8 {
    var scope = Scope.init();
    defer scope.deinit();
    const result = std.process.run(allocator, scope.io(), .{
        .argv = &.{ binary, "plugin", "list", "--plugin", "dev.petdex.bridge", "--json" },
        .stdout_limit = .limited(1024 * 1024),
        .stderr_limit = .limited(64 * 1024),
    }) catch return null;
    allocator.free(result.stderr);
    if (result.term != .exited or result.term.exited != 0) {
        allocator.free(result.stdout);
        return null;
    }
    return result.stdout;
}

pub fn herdrPluginListAlloc(allocator: std.mem.Allocator, home: []const u8) ?[]u8 {
    if (runHerdrPluginList(allocator, "herdr")) |source| return source;
    var local_buf: [768]u8 = undefined;
    const local = std.fmt.bufPrint(&local_buf, "{s}/.local/bin/herdr", .{home}) catch return null;
    if (runHerdrPluginList(allocator, local)) |source| return source;
    if (runHerdrPluginList(allocator, "/opt/homebrew/bin/herdr")) |source| return source;
    return runHerdrPluginList(allocator, "/usr/local/bin/herdr");
}

pub fn herdrAvailable(home: []const u8) bool {
    if (spawnAndWait(&.{ "herdr", "--version" })) return true;
    var local_buf: [768]u8 = undefined;
    const local = std.fmt.bufPrint(&local_buf, "{s}/.local/bin/herdr", .{home}) catch return false;
    if (spawnAndWait(&.{ local, "--version" })) return true;
    if (spawnAndWait(&.{ "/opt/homebrew/bin/herdr", "--version" })) return true;
    return spawnAndWait(&.{ "/usr/local/bin/herdr", "--version" });
}

pub fn activateHerdrPane(home: []const u8, pane_raw: []const u8) bool {
    const pane = safeHerdrPaneId(pane_raw) orelse return false;
    if (spawnAndWait(&.{ "herdr", "agent", "focus", pane })) return true;
    var local_buf: [768]u8 = undefined;
    const local = std.fmt.bufPrint(&local_buf, "{s}/.local/bin/herdr", .{home}) catch return false;
    if (spawnAndWait(&.{ local, "agent", "focus", pane })) return true;
    if (spawnAndWait(&.{ "/opt/homebrew/bin/herdr", "agent", "focus", pane })) return true;
    return spawnAndWait(&.{ "/usr/local/bin/herdr", "agent", "focus", pane });
}

pub fn canActivateOriginOn(os: std.Target.Os.Tag, origin: OriginApplication) bool {
    return switch (os) {
        .macos => origin != .none,
        .windows => origin != .none,
        else => false,
    };
}

fn linuxActivationOrigin(origin: OriginApplication) linux_activation.Origin {
    return switch (origin) {
        .none => .none,
        .terminal => .terminal,
        .vscode => .vscode,
        .default_browser => .default_browser,
        .codex => .codex,
    };
}

/// Process-local monotonic time for leases, rate limits, and deadlines. Unlike
/// `nowMs`, this clock cannot move backwards when wall time is corrected.
pub fn monotonicMs() i64 {
    var scope = Scope.init();
    defer scope.deinit();
    const ns = std.Io.Timestamp.now(scope.io(), .boot).nanoseconds;
    return @intCast(@divTrunc(ns, std.time.ns_per_ms));
}

pub fn canActivateOrigin(origin: OriginApplication, source_tty: []const u8, source_cwd: []const u8) bool {
    _ = source_tty;
    return switch (builtin.os.tag) {
        .windows => win_activation.available(origin, source_cwd),
        .linux => linux_activation.available(linuxActivationOrigin(origin), source_cwd),
        else => canActivateOriginOn(builtin.os.tag, origin),
    };
}

test "origin activation capabilities match implemented platform backends" {
    try std.testing.expect(canActivateOriginOn(.macos, .default_browser));
    try std.testing.expect(canActivateOriginOn(.windows, .terminal));
    try std.testing.expect(canActivateOriginOn(.windows, .default_browser));
    try std.testing.expect(!canActivateOriginOn(.linux, .vscode));
    try std.testing.expectEqual(linux_activation.Origin.default_browser, linuxActivationOrigin(.default_browser));
}

test "Linux origin availability uses the native X11 probe" {
    if (builtin.os.tag == .linux) {
        _ = canActivateOrigin(.terminal, "", "");
    }
}

pub fn activateOriginApplication(origin: OriginApplication, source_tty: []const u8, source_cwd: []const u8) bool {
    // The app host links AppKit/Objective-C; the standalone Zig test binary
    // intentionally does not. Capability policy remains unit-tested below.
    if (builtin.is_test) return false;
    if (builtin.os.tag == .windows) {
        return win_activation.activate(origin, source_cwd);
    }
    if (builtin.os.tag == .linux) {
        return linux_activation.activate(linuxActivationOrigin(origin), source_cwd);
    }
    if (!canActivateOrigin(origin, source_tty, source_cwd)) return false;
    if (builtin.os.tag != .macos) return false;
    if (origin == .default_browser) return activateRunningDefaultBrowser().succeeded();
    if (origin == .terminal) {
        if (safeSourceTty(source_tty)) |tty| {
            if (spawnAndWait(&.{ "/usr/bin/osascript", "-e", terminal_focus_script, tty })) return true;
        }
    }
    const bundle_id = origin.bundleIdentifier() orelse return false;
    return spawnAndWait(&.{ "/usr/bin/open", "-b", bundle_id });
}

// ------------------------------------------------------- app presence

/// Window-local, top-left-origin frame for one macOS activity card. AppKit's
/// visual-effect views are kept behind the transparent GPU surface so the OS,
/// including Reduce Transparency, owns the actual desktop-material sampling.
pub const BubbleGlassSemanticState = enum(u8) { idle, running, needs_input, completed, failed };
pub const BubbleGlassInteractionState = enum(u8) { idle, hovered, selected };
pub const BubbleGlassMaterialization = enum(u8) { hidden, materializing, visible, collapsing };
pub const BubbleGlassElementRole = enum(u8) { card, disclosure };

pub const BubbleGlassRect = struct {
    identity: u64 = 0,
    x: f32 = 0,
    y: f32 = 0,
    w: f32 = 0,
    h: f32 = 0,
    alpha: f32 = 1,
    corner_radius: f32 = 14,
    semantic_state: BubbleGlassSemanticState = .idle,
    interaction_state: BubbleGlassInteractionState = .idle,
    materialization: BubbleGlassMaterialization = .visible,
    role: BubbleGlassElementRole = .card,
    dark_appearance: bool = false,
    high_contrast: bool = false,
};

pub const BubbleNativeControlAction = enum(u8) { toggle_visibility, open, pin, subagents, dismiss };
pub const BubbleDisclosureMode = enum(u8) { all, recent, hidden };
pub const BubbleNativeAccessibilityRole = enum(u8) { group, button, toggle_button };
pub const bubble_native_accessibility_text_capacity: usize = 192;

pub const BubbleNativeAccessibilityText = struct {
    bytes: [bubble_native_accessibility_text_capacity:0]u8 = @splat(0),
    len: u8 = 0,

    pub fn set(self: *BubbleNativeAccessibilityText, value: []const u8) void {
        var count = @min(value.len, bubble_native_accessibility_text_capacity);
        while (count > 0 and !std.unicode.utf8ValidateSlice(value[0..count])) count -= 1;
        @memcpy(self.bytes[0..count], value[0..count]);
        self.bytes[count] = 0;
        self.len = @intCast(count);
    }

    pub fn slice(self: *const BubbleNativeAccessibilityText) []const u8 {
        return self.bytes[0..self.len];
    }
};

pub const BubbleNativeControl = struct {
    identity: u64 = 0,
    action: BubbleNativeControlAction = .open,
    x: f32 = 0,
    y: f32 = 0,
    w: f32 = 28,
    h: f32 = 28,
    selected: bool = false,
    badge_count: u8 = 0,
    presentation_alpha: f32 = 1,
    activation_inset: f32 = 6,
    overlay: bool = false,
    points_up: bool = false,
    disclosure_mode: BubbleDisclosureMode = .all,
    semantic_state: BubbleGlassSemanticState = .idle,
    show_status_icon: bool = false,
    accessibility_label: BubbleNativeAccessibilityText = .{},
    accessibility_value: BubbleNativeAccessibilityText = .{},
    accessibility_role: BubbleNativeAccessibilityRole = .button,
    enabled: bool = true,
    toggled: bool = false,
};

/// Card surfaces are separate from the state-specific action controls. On
/// macOS they live in tightly bounded nonactivating panels, so the card body
/// consumes clicks without making the large transparent activity window eat
/// input in the gaps between cards.
pub const BubbleNativeCardAction = enum(u8) { activate, drag_started, drag_ended };
pub const BubbleNativeCardEvent = struct {
    identity: u64,
    action: BubbleNativeCardAction,
};

pub const BubbleNativeControlEvent = struct {
    identity: u64,
    action: BubbleNativeControlAction,
};

pub const bubble_native_text_capacity: usize = 768;
pub const bubble_native_message_lines: usize = 2;
pub const bubble_native_nested_lines: usize = 3;

/// Inline, NUL-terminated text for the asynchronous AppKit handoff. The
/// presentation request is copied under a mutex, so native UI never retains a
/// slice into the renderer's frame scratch.
pub const BubbleNativeText = struct {
    bytes: [bubble_native_text_capacity:0]u8 = @splat(0),
    len: u16 = 0,

    pub fn set(self: *BubbleNativeText, value: []const u8) void {
        var count = @min(value.len, bubble_native_text_capacity);
        while (count > 0 and !std.unicode.utf8ValidateSlice(value[0..count])) count -= 1;
        @memcpy(self.bytes[0..count], value[0..count]);
        self.bytes[count] = 0;
        self.len = @intCast(count);
    }

    pub fn slice(self: *const BubbleNativeText) []const u8 {
        return self.bytes[0..self.len];
    }
};

/// Card-local, top-left-origin geometry. It uses the same coordinate space as
/// BubbleLayoutMetrics; AppKit conversion happens once on the main thread.
pub const BubbleNativeFrame = struct {
    x: f32 = 0,
    y: f32 = 0,
    w: f32 = 0,
    h: f32 = 0,
};

pub const BubbleNativeCardSnapshot = struct {
    /// Filled by `prepareBubbleNativePresentation` immediately before the
    /// asynchronous AppKit handoff. Separating glass and foreground lets a
    /// moving card avoid resetting its labels, masks, and attributed text.
    glass_digest: u64 = 0,
    content_digest: u64 = 0,
    glass: BubbleGlassRect = .{},
    content_alpha: f32 = 1,
    metadata_alpha: f32 = 0,
    nested_alpha: f32 = 0,
    agent: BubbleNativeText = .{},
    hostname: BubbleNativeText = .{},
    project: BubbleNativeText = .{},
    title: BubbleNativeText = .{},
    accessibility_label: BubbleNativeAccessibilityText = .{},
    accessibility_value: BubbleNativeAccessibilityText = .{},
    accessibility_role: BubbleNativeAccessibilityRole = .button,
    action_available: bool = false,
    message_lines: [bubble_native_message_lines]BubbleNativeText = @splat(.{}),
    message_line_count: u8 = 0,
    nested_lines: [bubble_native_nested_lines]BubbleNativeText = @splat(.{}),
    nested_line_count: u8 = 0,
    metadata_frame: BubbleNativeFrame = .{},
    metadata_left_frame: BubbleNativeFrame = .{},
    metadata_right_frame: BubbleNativeFrame = .{},
    title_frame: BubbleNativeFrame = .{},
    status_frame: BubbleNativeFrame = .{},
    message_frames: [bubble_native_message_lines]BubbleNativeFrame = @splat(.{}),
    nested_frames: [bubble_native_nested_lines]BubbleNativeFrame = @splat(.{}),
    action_fade_start: f32 = 0,
    action_fade_alpha: f32 = 0,
    metadata_font_size: f32 = 10,
    title_font_size: f32 = 16,
    message_font_size: f32 = 12,
    nested_font_size: f32 = 10,
    busy: bool = false,
    reduce_motion: bool = false,
    shimmer_phase: f32 = 0,
};

pub const BubbleNativeDisclosureSnapshot = struct {
    glass: BubbleGlassRect = .{},
    visible: bool = false,
    mode: BubbleDisclosureMode = .all,
    semantic_state: BubbleGlassSemanticState = .idle,
    session_count: u8 = 0,
    show_status_icon: bool = false,
    presentation_alpha: f32 = 1,
    accessibility_label: BubbleNativeAccessibilityText = .{},
    accessibility_value: BubbleNativeAccessibilityText = .{},
    accessibility_role: BubbleNativeAccessibilityRole = .toggle_button,
    enabled: bool = true,
    toggled: bool = false,
};

pub const max_bubble_native_cards: usize = 8;

/// One immutable frame of native bubble presentation. Glass, foreground,
/// disclosure morphing and control hit panels are all committed from this
/// snapshot in one disabled-actions AppKit transaction.
pub const BubbleNativePresentation = struct {
    digest: u64 = 0,
    controls_digest: u64 = 0,
    /// Changes when the transparent activity window itself moves. Local card
    /// geometry can remain identical, but sibling nonactivating button panels
    /// still need one bounded position update.
    placement_generation: u64 = 0,
    cards: [max_bubble_native_cards]BubbleNativeCardSnapshot = @splat(.{}),
    card_count: usize = 0,
    disclosure: BubbleNativeDisclosureSnapshot = .{},
    controls: [max_bubble_native_controls]BubbleNativeControl = @splat(.{}),
    control_count: usize = 0,
    window_height: f32 = 0,
};

/// Private Windows host contract. It is intentionally versioned and bounded:
/// this is a retained presentation snapshot, not a second public API or a
/// general native bridge. macOS consumes the struct directly and Linux keeps
/// using the portable canvas renderer.
pub const bubble_native_payload_event = "petdex.bubble.presentation.v1";
pub const max_bubble_native_payload_bytes: usize = 64 * 1024;

const BubbleWireFrame = struct { x: f32, y: f32, w: f32, h: f32 };
const BubbleWireGlass = struct {
    id: u64,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    alpha: f32,
    radius: f32,
    state: u8,
    interaction: u8,
    materialization: u8,
    dark: bool,
    high_contrast: bool,
};
const BubbleWireLine = struct { text: []const u8, frame: BubbleWireFrame };
const BubbleWireCard = struct {
    glass: BubbleWireGlass,
    content_alpha: f32,
    metadata_alpha: f32,
    nested_alpha: f32,
    agent: []const u8,
    hostname: []const u8,
    project: []const u8,
    title: []const u8,
    accessibility_label: []const u8,
    accessibility_value: []const u8,
    accessibility_role: u8,
    action_available: bool,
    messages: []const BubbleWireLine,
    nested: []const BubbleWireLine,
    metadata_frame: BubbleWireFrame,
    metadata_left_frame: BubbleWireFrame,
    metadata_right_frame: BubbleWireFrame,
    title_frame: BubbleWireFrame,
    status_frame: BubbleWireFrame,
    action_fade_start: f32,
    action_fade_alpha: f32,
    metadata_font_size: f32,
    title_font_size: f32,
    message_font_size: f32,
    nested_font_size: f32,
    busy: bool,
    reduce_motion: bool,
    shimmer_phase: f32,
};
const BubbleWireDisclosure = struct {
    glass: BubbleWireGlass,
    visible: bool,
    mode: u8,
    state: u8,
    session_count: u8,
    show_status_icon: bool,
    alpha: f32,
    accessibility_label: []const u8,
    accessibility_value: []const u8,
    accessibility_role: u8,
    enabled: bool,
    toggled: bool,
};
const BubbleWireControl = struct {
    id: u64,
    action: u8,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    selected: bool,
    badge_count: u8,
    alpha: f32,
    activation_inset: f32,
    overlay: bool,
    points_up: bool,
    mode: u8,
    state: u8,
    show_status_icon: bool,
    accessibility_label: []const u8,
    accessibility_value: []const u8,
    accessibility_role: u8,
    enabled: bool,
    toggled: bool,
};

fn bubbleWireFrame(frame: BubbleNativeFrame) BubbleWireFrame {
    return .{ .x = frame.x, .y = frame.y, .w = frame.w, .h = frame.h };
}

test "origin metadata recognizes safe Windows application hints" {
    try std.testing.expectEqual(OriginApplication.terminal, OriginApplication.fromTermProgram("Windows_Terminal"));
    try std.testing.expectEqual(OriginApplication.vscode, OriginApplication.fromTermProgram("Visual Studio Code"));
    try std.testing.expectEqual(OriginApplication.codex, OriginApplication.fromTermProgram("ChatGPT"));
    try std.testing.expectEqual(OriginApplication.none, OriginApplication.fromTermProgram("untrusted.exe"));
}

fn bubbleWireGlass(glass: BubbleGlassRect) BubbleWireGlass {
    return .{
        .id = glass.identity,
        .x = glass.x,
        .y = glass.y,
        .w = glass.w,
        .h = glass.h,
        .alpha = glass.alpha,
        .radius = glass.corner_radius,
        .state = @intFromEnum(glass.semantic_state),
        .interaction = @intFromEnum(glass.interaction_state),
        .materialization = @intFromEnum(glass.materialization),
        .dark = glass.dark_appearance,
        .high_contrast = glass.high_contrast,
    };
}

/// Serialize one immutable snapshot for the Windows platform host. The caller
/// owns the returned memory. Oversized snapshots are rejected as a unit, so a
/// truncated JSON document can never reach native code.
pub fn bubbleNativePresentationJsonAlloc(allocator: std.mem.Allocator, source: *const BubbleNativePresentation) ?[]u8 {
    var presentation = source.*;
    prepareBubbleNativePresentation(&presentation);

    var message_storage: [max_bubble_native_cards][bubble_native_message_lines]BubbleWireLine = undefined;
    var nested_storage: [max_bubble_native_cards][bubble_native_nested_lines]BubbleWireLine = undefined;
    var cards: [max_bubble_native_cards]BubbleWireCard = undefined;
    for (presentation.cards[0..presentation.card_count], 0..) |*card, card_index| {
        for (0..card.message_line_count) |row| {
            message_storage[card_index][row] = .{
                .text = card.message_lines[row].slice(),
                .frame = bubbleWireFrame(card.message_frames[row]),
            };
        }
        for (0..card.nested_line_count) |row| {
            nested_storage[card_index][row] = .{
                .text = card.nested_lines[row].slice(),
                .frame = bubbleWireFrame(card.nested_frames[row]),
            };
        }
        cards[card_index] = .{
            .glass = bubbleWireGlass(card.glass),
            .content_alpha = card.content_alpha,
            .metadata_alpha = card.metadata_alpha,
            .nested_alpha = card.nested_alpha,
            .agent = card.agent.slice(),
            .hostname = card.hostname.slice(),
            .project = card.project.slice(),
            .title = card.title.slice(),
            .accessibility_label = card.accessibility_label.slice(),
            .accessibility_value = card.accessibility_value.slice(),
            .accessibility_role = @intFromEnum(card.accessibility_role),
            .action_available = card.action_available,
            .messages = message_storage[card_index][0..card.message_line_count],
            .nested = nested_storage[card_index][0..card.nested_line_count],
            .metadata_frame = bubbleWireFrame(card.metadata_frame),
            .metadata_left_frame = bubbleWireFrame(card.metadata_left_frame),
            .metadata_right_frame = bubbleWireFrame(card.metadata_right_frame),
            .title_frame = bubbleWireFrame(card.title_frame),
            .status_frame = bubbleWireFrame(card.status_frame),
            .action_fade_start = card.action_fade_start,
            .action_fade_alpha = card.action_fade_alpha,
            .metadata_font_size = card.metadata_font_size,
            .title_font_size = card.title_font_size,
            .message_font_size = card.message_font_size,
            .nested_font_size = card.nested_font_size,
            .busy = card.busy,
            .reduce_motion = card.reduce_motion,
            .shimmer_phase = card.shimmer_phase,
        };
    }

    var controls: [max_bubble_native_controls]BubbleWireControl = undefined;
    for (presentation.controls[0..presentation.control_count], 0..) |control, index| {
        controls[index] = .{
            .id = control.identity,
            .action = @intFromEnum(control.action),
            .x = control.x,
            .y = control.y,
            .w = control.w,
            .h = control.h,
            .selected = control.selected,
            .badge_count = control.badge_count,
            .alpha = control.presentation_alpha,
            .activation_inset = control.activation_inset,
            .overlay = control.overlay,
            .points_up = control.points_up,
            .mode = @intFromEnum(control.disclosure_mode),
            .state = @intFromEnum(control.semantic_state),
            .show_status_icon = control.show_status_icon,
            .accessibility_label = control.accessibility_label.slice(),
            .accessibility_value = control.accessibility_value.slice(),
            .accessibility_role = @intFromEnum(control.accessibility_role),
            .enabled = control.enabled,
            .toggled = control.toggled,
        };
    }

    const wire = .{
        .version = @as(u8, 1),
        .digest = presentation.digest,
        .placement_generation = presentation.placement_generation,
        .window_height = presentation.window_height,
        .cards = cards[0..presentation.card_count],
        .disclosure = BubbleWireDisclosure{
            .glass = bubbleWireGlass(presentation.disclosure.glass),
            .visible = presentation.disclosure.visible,
            .mode = @intFromEnum(presentation.disclosure.mode),
            .state = @intFromEnum(presentation.disclosure.semantic_state),
            .session_count = presentation.disclosure.session_count,
            .show_status_icon = presentation.disclosure.show_status_icon,
            .alpha = presentation.disclosure.presentation_alpha,
            .accessibility_label = presentation.disclosure.accessibility_label.slice(),
            .accessibility_value = presentation.disclosure.accessibility_value.slice(),
            .accessibility_role = @intFromEnum(presentation.disclosure.accessibility_role),
            .enabled = presentation.disclosure.enabled,
            .toggled = presentation.disclosure.toggled,
        },
        .controls = controls[0..presentation.control_count],
    };
    const bytes = std.json.Stringify.valueAlloc(allocator, wire, .{}) catch return null;
    if (bytes.len > max_bubble_native_payload_bytes) {
        allocator.free(bytes);
        return null;
    }
    return bytes;
}

test "Windows native bubble payload is versioned bounded and preserves shared presentation" {
    var presentation: BubbleNativePresentation = .{};
    presentation.placement_generation = 7;
    presentation.window_height = 240;
    presentation.card_count = 1;
    presentation.cards[0].glass = .{
        .identity = 0xfedc_ba98_7654_3210,
        .x = -12.5,
        .y = 18,
        .w = 220,
        .h = 92,
        .semantic_state = .needs_input,
        .dark_appearance = true,
        .high_contrast = true,
    };
    presentation.cards[0].title.set("Provider title");
    presentation.cards[0].accessibility_label.set("Agent session: Provider title");
    presentation.cards[0].accessibility_value.set("Needs input");
    presentation.cards[0].action_available = true;
    presentation.cards[0].message_lines[0].set("Waiting for input");
    presentation.cards[0].message_line_count = 1;
    presentation.cards[0].message_frames[0] = .{ .x = 8, .y = 50, .w = 180, .h = 18 };
    presentation.cards[0].busy = true;
    presentation.cards[0].reduce_motion = false;
    presentation.controls[0] = .{ .identity = 0xfedc_ba98_7654_3210, .action = .pin, .x = 180, .y = 52, .selected = true, .toggled = true };
    presentation.controls[0].accessibility_label.set("Unpin agent session");
    presentation.controls[0].accessibility_value.set("Pinned");
    presentation.control_count = 1;
    presentation.disclosure.visible = true;
    presentation.disclosure.glass = .{ .identity = 99, .x = 2, .y = 2, .w = 30, .h = 30, .role = .disclosure };
    presentation.disclosure.accessibility_label.set("Show or hide agent sessions");
    presentation.disclosure.accessibility_value.set("All sessions shown");
    presentation.disclosure.toggled = true;

    const bytes = bubbleNativePresentationJsonAlloc(std.testing.allocator, &presentation) orelse return error.TestUnexpectedResult;
    defer std.testing.allocator.free(bytes);
    try std.testing.expect(bytes.len <= max_bubble_native_payload_bytes);
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, bytes, .{});
    defer parsed.deinit();
    const root = parsed.value.object;
    try std.testing.expectEqual(@as(i64, 1), root.get("version").?.integer);
    try std.testing.expectEqual(@as(i64, 7), root.get("placement_generation").?.integer);
    const card = root.get("cards").?.array.items[0].object;
    try std.testing.expectEqualStrings("Provider title", card.get("title").?.string);
    try std.testing.expectEqualStrings("Agent session: Provider title", card.get("accessibility_label").?.string);
    try std.testing.expectEqualStrings("Needs input", card.get("accessibility_value").?.string);
    try std.testing.expect(card.get("action_available").?.bool);
    try std.testing.expect(card.get("busy").?.bool);
    try std.testing.expect(card.get("glass").?.object.get("high_contrast").?.bool);
    try std.testing.expectEqualStrings("Waiting for input", card.get("messages").?.array.items[0].object.get("text").?.string);
    try std.testing.expectEqual(@as(i64, @intFromEnum(BubbleNativeControlAction.pin)), root.get("controls").?.array.items[0].object.get("action").?.integer);
    try std.testing.expectEqualStrings("Unpin agent session", root.get("controls").?.array.items[0].object.get("accessibility_label").?.string);
    try std.testing.expect(root.get("controls").?.array.items[0].object.get("toggled").?.bool);
    try std.testing.expectEqualStrings("All sessions shown", root.get("disclosure").?.object.get("accessibility_value").?.string);
}

test "pinned Windows SDK patch carries native overlay fallbacks and live reactions" {
    var patch_buffer: [192 * 1024]u8 = undefined;
    const patch = readFile("../../patches/native-sdk-windows-canvas-drag.patch", &patch_buffer) orelse return;
    const required = [_][]const u8{
        "petdex.bubble.presentation.v1",
        "WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW",
        "kDwmwaSystemBackdropType",
        "kDwmsbtTransientWindow",
        "DwmIsCompositionEnabled",
        "SM_REMOTESESSION",
        "SPI_GETHIGHCONTRAST",
        "ID2D1HwndRenderTarget",
        "IDWriteFactory",
        "IDCompositionVisual *shimmer_visual",
        "WM_WINDOWPOSCHANGED",
        "WM_DPICHANGED",
        "WM_DWMCOLORIZATIONCOLORCHANGED",
        "TTM_ADDTOOLW",
        "TTM_UPDATETIPTEXTW",
        "PROPID_ACC_NAME",
        "PROPID_ACC_ROLE",
        "PROPID_ACC_VALUE",
        "PROPID_ACC_STATE",
        "accessibility_label",
        "action_available",
        "WM_GETOBJECT",
        "IRawElementProviderSimple",
        "IRawElementProviderFragment",
        "IRawElementProviderFragmentRoot",
        "IInvokeProvider",
        "IToggleProvider",
        "UiaReturnRawElementProvider",
        "NavigateDirection_Parent",
        "NavigateDirection_NextSibling",
        "NavigateDirection_PreviousSibling",
        "NavigateDirection_FirstChild",
        "NavigateDirection_LastChild",
        "ElementProviderFromPoint",
        "GetRuntimeId",
        "get_BoundingRectangle",
        "bubbleUiaCanonicalOverlay",
        "bubbleUiaOrderedChildren(host, window->id)",
        "CreateRoundRectRgn",
        "applyBubbleWindowRegion",
        "card.reduce_motion",
        "placeBubbleOverlaysForWindow",
    };
    for (required) |needle| try std.testing.expect(std.mem.indexOf(u8, patch, needle) != null);
    const placement_start = std.mem.indexOf(u8, patch, "static void placeBubbleOverlay(").?;
    const placement_end_offset = std.mem.indexOf(u8, patch[placement_start..], "static void placeBubbleOverlaysForWindow(").?;
    const placement = patch[placement_start .. placement_start + placement_end_offset];
    const region_index = std.mem.indexOf(u8, placement, "applyBubbleWindowRegion(overlay, width, height, dpiForWindow(owner->hwnd))").?;
    const position_index = std.mem.indexOf(u8, placement, "SetWindowPos(overlay.hwnd, owner->floating").?;
    const resize_index = std.mem.indexOf(u8, placement, "resizeBubbleRenderTarget(overlay)").?;
    const paint_index = std.mem.indexOf(u8, placement, "RDW_INVALIDATE | RDW_UPDATENOW").?;
    const show_index = std.mem.indexOf(u8, placement, "SWP_NOACTIVATE | SWP_SHOWWINDOW").?;
    try std.testing.expect(region_index < position_index);
    try std.testing.expect(region_index < show_index);
    try std.testing.expect(resize_index < show_index);
    try std.testing.expect(paint_index < show_index);
    try std.testing.expect(std.mem.indexOf(u8, patch, "static_assert(bubbleUiaKindRank(kBubbleCardOverlay) < bubbleUiaKindRank(kBubbleDisclosureOverlay))") != null);
    try std.testing.expect(std.mem.indexOf(u8, patch, "static_assert(bubbleUiaKindRank(kBubbleDisclosureOverlay) < bubbleUiaKindRank(kBubbleControlOverlay))") != null);
    try std.testing.expect(std.mem.indexOf(u8, patch, "overlay.kind == kBubbleControlOverlay && overlay.control.action == 0") != null);
    const focus_start = std.mem.indexOf(u8, patch, "HRESULT BubbleUiaRootProvider::GetFocus(").?;
    const focus_end_offset = std.mem.indexOf(u8, patch[focus_start..], "static BubbleOverlay *bubbleUiaCanonicalOverlay(").?;
    const focus_body = patch[focus_start .. focus_start + focus_end_offset];
    try std.testing.expect(std.mem.indexOf(u8, focus_body, "child->hovered") == null);
    try std.testing.expect(std.mem.indexOf(u8, focus_body, "child->pressed") == null);
}

test "pinned Linux SDK patch carries bounded keyboard and accessibility controls" {
    var patch_buffer: [128 * 1024]u8 = undefined;
    const patch = readFile("../../patches/native-sdk-linux-popup-surface.patch", &patch_buffer) orelse return;
    const required = [_][]const u8{
        "petdex.bubble.presentation.v1",
        "petdex_bubble_payload_capacity: usize = 64 * 1024",
        "petdex_bubble_control_capacity: usize = 41",
        "std.json.parseFromSlice(PetdexBubbleWirePayload",
        "std.unicode.utf8ValidateSlice(control.accessibility_label)",
        "petdex.bubble.control.{s}.{x:0>16}",
        "petdex-bubble-a11y-control:focus-visible",
        "gtk_widget_set_can_target(view->widget, FALSE)",
        "gtk_widget_set_focusable(view->widget, TRUE)",
        "gtk_widget_set_tooltip_text(view->widget, native_sdk_native_accessibility_label(view))",
        "GTK_ACCESSIBLE_PROPERTY_DESCRIPTION",
        "native_sdk_gtk_set_view_accessibility_description",
        "native_sdk_gtk_set_view_toggle_state",
        "g_signal_handler_block(view->widget, view->action_handler)",
        "petdexBubbleControlMustRecreate",
        "native_sdk_gtk_close_view(self.host, window_id, label.ptr, label.len)",
        "linux Petdex accessibility controls recreate when slot semantics change",
    };
    for (required) |needle| try std.testing.expect(std.mem.indexOf(u8, patch, needle) != null);
}

fn bubbleDigestMix(hash: *u64, value: u64) void {
    hash.* = (hash.* ^ value) *% 1099511628211;
}

fn bubbleDigestBytes(hash: *u64, value: []const u8) void {
    for (value) |byte| bubbleDigestMix(hash, byte);
    bubbleDigestMix(hash, 0xff);
}

fn bubbleDigestF32(hash: *u64, value: f32) void {
    bubbleDigestMix(hash, @as(u64, @bitCast(@as(f64, value))));
}

/// Native geometry is expressed in points.  Keeping sub-quarter-point jitter
/// out of the immutable snapshot avoids waking AppKit for compositor-noise
/// while remaining well below a physical pixel on the supported Retina scale.
fn bubbleDigestGeometryF32(hash: *u64, value: f32) void {
    const quantized: i64 = @intFromFloat(@round(@as(f64, value) * 4));
    bubbleDigestMix(hash, @as(u64, @bitCast(quantized)));
}

fn bubbleDigestFrame(hash: *u64, frame: BubbleNativeFrame) void {
    bubbleDigestGeometryF32(hash, frame.x);
    bubbleDigestGeometryF32(hash, frame.y);
    bubbleDigestGeometryF32(hash, frame.w);
    bubbleDigestGeometryF32(hash, frame.h);
}

fn bubbleDigestGlass(hash: *u64, glass: BubbleGlassRect) void {
    bubbleDigestMix(hash, glass.identity);
    bubbleDigestGeometryF32(hash, glass.x);
    bubbleDigestGeometryF32(hash, glass.y);
    bubbleDigestGeometryF32(hash, glass.w);
    bubbleDigestGeometryF32(hash, glass.h);
    bubbleDigestF32(hash, glass.alpha);
    bubbleDigestGeometryF32(hash, glass.corner_radius);
    bubbleDigestMix(hash, @intFromEnum(glass.semantic_state));
    bubbleDigestMix(hash, @intFromEnum(glass.interaction_state));
    bubbleDigestMix(hash, @intFromEnum(glass.materialization));
    bubbleDigestMix(hash, @intFromEnum(glass.role));
    bubbleDigestMix(hash, @intFromBool(glass.dark_appearance));
    bubbleDigestMix(hash, @intFromBool(glass.high_contrast));
}

fn bubbleGlassDigestValue(glass: BubbleGlassRect) u64 {
    var hash: u64 = 1469598103934665603;
    bubbleDigestGlass(&hash, glass);
    return hash;
}

fn bubbleNativeCardDigests(card: *BubbleNativeCardSnapshot) void {
    card.glass_digest = bubbleGlassDigestValue(card.glass);

    var content_hash: u64 = 1469598103934665603;
    bubbleDigestMix(&content_hash, card.glass.identity);
    bubbleDigestF32(&content_hash, card.content_alpha);
    bubbleDigestF32(&content_hash, card.metadata_alpha);
    bubbleDigestF32(&content_hash, card.nested_alpha);
    bubbleDigestBytes(&content_hash, card.agent.slice());
    bubbleDigestBytes(&content_hash, card.hostname.slice());
    bubbleDigestBytes(&content_hash, card.project.slice());
    bubbleDigestBytes(&content_hash, card.title.slice());
    bubbleDigestBytes(&content_hash, card.accessibility_label.slice());
    bubbleDigestBytes(&content_hash, card.accessibility_value.slice());
    bubbleDigestMix(&content_hash, @intFromEnum(card.accessibility_role));
    bubbleDigestMix(&content_hash, @intFromBool(card.action_available));
    bubbleDigestMix(&content_hash, card.message_line_count);
    for (card.message_lines, card.message_frames) |line, frame| {
        bubbleDigestBytes(&content_hash, line.slice());
        bubbleDigestFrame(&content_hash, frame);
    }
    bubbleDigestMix(&content_hash, card.nested_line_count);
    for (card.nested_lines, card.nested_frames) |line, frame| {
        bubbleDigestBytes(&content_hash, line.slice());
        bubbleDigestFrame(&content_hash, frame);
    }
    bubbleDigestFrame(&content_hash, card.metadata_frame);
    bubbleDigestFrame(&content_hash, card.metadata_left_frame);
    bubbleDigestFrame(&content_hash, card.metadata_right_frame);
    bubbleDigestFrame(&content_hash, card.title_frame);
    bubbleDigestFrame(&content_hash, card.status_frame);
    bubbleDigestF32(&content_hash, card.action_fade_start);
    bubbleDigestF32(&content_hash, card.action_fade_alpha);
    bubbleDigestF32(&content_hash, card.metadata_font_size);
    bubbleDigestF32(&content_hash, card.title_font_size);
    bubbleDigestF32(&content_hash, card.message_font_size);
    bubbleDigestF32(&content_hash, card.nested_font_size);
    bubbleDigestMix(&content_hash, @intFromBool(card.busy));
    bubbleDigestMix(&content_hash, @intFromBool(card.reduce_motion));
    card.content_digest = content_hash;
}

fn bubbleDigestControl(hash: *u64, control: BubbleNativeControl) void {
    bubbleDigestMix(hash, control.identity);
    bubbleDigestMix(hash, @intFromEnum(control.action));
    bubbleDigestF32(hash, control.x);
    bubbleDigestF32(hash, control.y);
    bubbleDigestF32(hash, control.w);
    bubbleDigestF32(hash, control.h);
    bubbleDigestMix(hash, @intFromBool(control.selected));
    bubbleDigestMix(hash, control.badge_count);
    bubbleDigestF32(hash, control.presentation_alpha);
    bubbleDigestF32(hash, control.activation_inset);
    bubbleDigestMix(hash, @intFromBool(control.overlay));
    bubbleDigestMix(hash, @intFromBool(control.points_up));
    bubbleDigestMix(hash, @intFromEnum(control.disclosure_mode));
    bubbleDigestMix(hash, @intFromEnum(control.semantic_state));
    bubbleDigestMix(hash, @intFromBool(control.show_status_icon));
    bubbleDigestBytes(hash, control.accessibility_label.slice());
    bubbleDigestBytes(hash, control.accessibility_value.slice());
    bubbleDigestMix(hash, @intFromEnum(control.accessibility_role));
    bubbleDigestMix(hash, @intFromBool(control.enabled));
    bubbleDigestMix(hash, @intFromBool(control.toggled));
}

fn prepareBubbleNativePresentation(presentation: *BubbleNativePresentation) void {
    presentation.card_count = @min(presentation.card_count, max_bubble_native_cards);
    presentation.control_count = @min(presentation.control_count, max_bubble_native_controls);
    var digest: u64 = 1469598103934665603;
    bubbleDigestMix(&digest, presentation.placement_generation);
    bubbleDigestF32(&digest, presentation.window_height);
    bubbleDigestMix(&digest, presentation.card_count);
    for (presentation.cards[0..presentation.card_count]) |*card| {
        bubbleNativeCardDigests(card);
        bubbleDigestMix(&digest, card.glass_digest);
        bubbleDigestMix(&digest, card.content_digest);
    }
    bubbleDigestGlass(&digest, presentation.disclosure.glass);
    bubbleDigestMix(&digest, @intFromBool(presentation.disclosure.visible));
    bubbleDigestMix(&digest, @intFromEnum(presentation.disclosure.mode));
    bubbleDigestMix(&digest, @intFromEnum(presentation.disclosure.semantic_state));
    bubbleDigestMix(&digest, presentation.disclosure.session_count);
    bubbleDigestMix(&digest, @intFromBool(presentation.disclosure.show_status_icon));
    bubbleDigestF32(&digest, presentation.disclosure.presentation_alpha);
    bubbleDigestBytes(&digest, presentation.disclosure.accessibility_label.slice());
    bubbleDigestBytes(&digest, presentation.disclosure.accessibility_value.slice());
    bubbleDigestMix(&digest, @intFromEnum(presentation.disclosure.accessibility_role));
    bubbleDigestMix(&digest, @intFromBool(presentation.disclosure.enabled));
    bubbleDigestMix(&digest, @intFromBool(presentation.disclosure.toggled));

    var controls_digest: u64 = 1469598103934665603;
    bubbleDigestMix(&controls_digest, presentation.placement_generation);
    bubbleDigestMix(&controls_digest, presentation.control_count);
    for (presentation.controls[0..presentation.control_count]) |control| bubbleDigestControl(&controls_digest, control);
    presentation.controls_digest = controls_digest;
    bubbleDigestMix(&digest, controls_digest);
    presentation.digest = digest;
}

fn bubbleNativeCardIdentityAtPresentation(
    presentation: *const BubbleNativePresentation,
    local_x: f32,
    local_y: f32,
    slop: f32,
) u64 {
    var remaining = @min(presentation.card_count, presentation.cards.len);
    while (remaining > 0) {
        remaining -= 1;
        const glass = presentation.cards[remaining].glass;
        if (glass.materialization == .hidden or glass.alpha <= 0.001 or glass.w <= 0 or glass.h <= 0) continue;
        if (local_x >= glass.x - slop and local_x <= glass.x + glass.w + slop and
            local_y >= glass.y - slop and local_y <= glass.y + glass.h + slop)
            return glass.identity;
    }
    return 0;
}

test "native presentation hit testing uses rendered card frames" {
    var presentation: BubbleNativePresentation = .{};
    presentation.card_count = 3;
    presentation.cards[0].glass = .{ .identity = 11, .x = 10, .y = 20, .w = 100, .h = 40 };
    presentation.cards[1].glass = .{ .identity = 22, .x = 10, .y = 70, .w = 100, .h = 40 };
    presentation.cards[2].glass = .{ .identity = 33, .x = 10, .y = 20, .w = 100, .h = 40 };

    // Reverse presentation order wins when animated surfaces overlap.
    try std.testing.expectEqual(@as(u64, 33), bubbleNativeCardIdentityAtPresentation(&presentation, 50, 30, 0));
    try std.testing.expectEqual(@as(u64, 22), bubbleNativeCardIdentityAtPresentation(&presentation, 50, 68, 2));
    presentation.cards[2].glass.materialization = .hidden;
    try std.testing.expectEqual(@as(u64, 11), bubbleNativeCardIdentityAtPresentation(&presentation, 50, 30, 0));
    presentation.cards[0].glass.alpha = 0;
    try std.testing.expectEqual(@as(u64, 0), bubbleNativeCardIdentityAtPresentation(&presentation, 50, 30, 0));
}

test "native presentation digest ignores compositor-only shimmer phase" {
    var presentation: BubbleNativePresentation = .{};
    presentation.card_count = 1;
    presentation.cards[0].glass = .{ .identity = 42, .x = 10, .y = 20, .w = 180, .h = 72 };
    presentation.cards[0].busy = true;
    presentation.cards[0].message_line_count = 1;
    presentation.cards[0].message_lines[0].set("Reading project files");
    prepareBubbleNativePresentation(&presentation);
    const initial = presentation.digest;
    const initial_content = presentation.cards[0].content_digest;

    presentation.cards[0].shimmer_phase = 0.75;
    prepareBubbleNativePresentation(&presentation);
    try std.testing.expectEqual(initial, presentation.digest);
    try std.testing.expectEqual(initial_content, presentation.cards[0].content_digest);

    presentation.cards[0].title.set("New title");
    prepareBubbleNativePresentation(&presentation);
    try std.testing.expect(presentation.digest != initial);
}

test "native presentation digest quantizes sub-quarter-point geometry" {
    var presentation: BubbleNativePresentation = .{};
    presentation.card_count = 1;
    presentation.cards[0].glass = .{ .identity = 7, .x = 10, .y = 20, .w = 180, .h = 72 };
    prepareBubbleNativePresentation(&presentation);
    const initial = presentation.digest;

    presentation.cards[0].glass.x += 0.1;
    prepareBubbleNativePresentation(&presentation);
    try std.testing.expectEqual(initial, presentation.digest);

    presentation.cards[0].glass.x += 0.2;
    prepareBubbleNativePresentation(&presentation);
    try std.testing.expect(presentation.digest != initial);
}

fn bubbleCardDragThresholdExceeded(dx: f64, dy: f64) bool {
    const card_drag_threshold_points: f64 = 4;
    return dx * dx + dy * dy >= card_drag_threshold_points * card_drag_threshold_points;
}

test "bubble card drag threshold preserves clicks and starts deliberate drags" {
    try std.testing.expect(!bubbleCardDragThresholdExceeded(0, 0));
    try std.testing.expect(!bubbleCardDragThresholdExceeded(2, 3));
    try std.testing.expect(bubbleCardDragThresholdExceeded(4, 0));
    try std.testing.expect(bubbleCardDragThresholdExceeded(-3, -3));
}

const BubbleControlPanelTransition = enum { unchanged, show, hide };

fn bubbleControlPanelTransition(visible: bool, requested: bool) BubbleControlPanelTransition {
    if (visible == requested) return .unchanged;
    return if (requested) .show else .hide;
}

test "native control panels order only on visibility transitions" {
    try std.testing.expectEqual(BubbleControlPanelTransition.unchanged, bubbleControlPanelTransition(false, false));
    try std.testing.expectEqual(BubbleControlPanelTransition.show, bubbleControlPanelTransition(false, true));
    try std.testing.expectEqual(BubbleControlPanelTransition.unchanged, bubbleControlPanelTransition(true, true));
    try std.testing.expectEqual(BubbleControlPanelTransition.hide, bubbleControlPanelTransition(true, false));

    const source = @embedFile("plat.zig");
    const start = std.mem.lastIndexOf(u8, source, "fn applyBubbleControlPanels(").?;
    const end_offset = std.mem.indexOf(u8, source[start..], "fn applyBubbleGlass(").?;
    const presentation_loop = source[start .. start + end_offset];
    try std.testing.expect(std.mem.indexOf(u8, presentation_loop, "orderOut:") == null);
    try std.testing.expect(std.mem.indexOf(u8, presentation_loop, "orderFrontRegardless") == null);
}

test "macOS native card bodies consume clicks and expose drag gestures" {
    const source = @embedFile("plat.zig");
    const start = std.mem.lastIndexOf(u8, source, "fn bubbleCardHitViewClass()").?;
    const end_offset = std.mem.indexOf(u8, source[start..], "fn alwaysTrue(").?;
    const card_view = source[start .. start + end_offset];
    try std.testing.expect(std.mem.indexOf(u8, card_view, "acceptsFirstMouse:") != null);
    try std.testing.expect(std.mem.indexOf(u8, card_view, "mouseDown:") != null);
    try std.testing.expect(std.mem.indexOf(u8, card_view, "mouseDragged:") != null);
    try std.testing.expect(std.mem.indexOf(u8, card_view, "mouseUp:") != null);
    try std.testing.expect(std.mem.indexOf(u8, card_view, "accessibilityPerformPress") != null);
    try std.testing.expect(std.mem.indexOf(u8, source, "applyBubbleCardPanels(&request, window)") != null);
    try std.testing.expect(std.mem.indexOf(u8, source, "offsetPetAndBubbleWindows") != null);
    try std.testing.expect(std.mem.indexOf(u8, source, "setAccessibilityRole:") != null);
    try std.testing.expect(std.mem.indexOf(u8, source, "setAccessibilityLabel:") != null);
    try std.testing.expect(std.mem.indexOf(u8, source, "respondsToSelector(host, enabled_sel)") != null);
    try std.testing.expect(std.mem.indexOf(u8, source, "bubble_control_material_views") != null);
    try std.testing.expect(std.mem.indexOf(u8, source, "objc_getClass(\"NSGlassEffectView\") orelse objc_getClass(\"NSVisualEffectView\")") != null);
    try std.testing.expect(std.mem.indexOf(u8, source, "setMasksToBounds:") != null);
    try std.testing.expect(std.mem.indexOf(u8, source, "setBordered:") != null);
    try std.testing.expect(std.mem.indexOf(u8, source, "setAccessibilityElement:\") orelse return, false") != null);
    try std.testing.expect(std.mem.indexOf(u8, source, "setAccessibilityElement:\") orelse return, true") != null);
    try std.testing.expect(std.mem.indexOf(u8, source, "respondsToSelector(native_material, material_corner_sel)") != null);
}

test "native presentation digest includes authoritative accessibility semantics" {
    var presentation: BubbleNativePresentation = .{};
    presentation.card_count = 1;
    presentation.cards[0].glass.identity = 42;
    presentation.cards[0].accessibility_label.set("Agent session: Build");
    presentation.cards[0].accessibility_value.set("Running");
    presentation.cards[0].action_available = true;
    prepareBubbleNativePresentation(&presentation);
    const initial = presentation.digest;

    presentation.cards[0].accessibility_value.set("Needs input");
    prepareBubbleNativePresentation(&presentation);
    try std.testing.expect(presentation.digest != initial);
}

test "native shimmer mask lifetime is owned by its label layer" {
    const source = @embedFile("plat.zig");
    const legacy_cache_name = "message_" ++ "masks";
    try std.testing.expect(std.mem.indexOf(u8, source, legacy_cache_name) == null);
    const start = std.mem.lastIndexOf(u8, source, "fn applyMessageShimmer(").?;
    const end_offset = std.mem.indexOf(u8, source[start..], "fn applyNativeCardContent(").?;
    const shimmer = source[start .. start + end_offset];
    try std.testing.expect(std.mem.indexOf(u8, shimmer, "sel_registerName(\"mask\")") != null);
    try std.testing.expect(std.mem.indexOf(u8, shimmer, "sel_registerName(\"setMask:\")") != null);
    try std.testing.expect(std.mem.indexOf(u8, shimmer, "setStartPoint:") != null);
    try std.testing.expect(std.mem.indexOf(u8, shimmer, "setEndPoint:") != null);
    try std.testing.expect(std.mem.indexOf(u8, shimmer, "CABasicAnimation") != null);
    try std.testing.expect(std.mem.indexOf(u8, shimmer, "animationForKey:") != null);
    try std.testing.expect(std.mem.indexOf(u8, shimmer, "addAnimation:forKey:") != null);
}

pub const VisibleScreenFrame = struct {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
};

const BubbleGlassBounds = struct { left: f32, top: f32, right: f32, bottom: f32 };

fn bubbleGlassBounds(rect: BubbleGlassRect) BubbleGlassBounds {
    return BubbleGlassBounds{
        .left = rect.x,
        .top = rect.y,
        .right = rect.x + rect.w,
        .bottom = rect.y + rect.h,
    };
}

test "bubble glass bounds contain an intrinsic element frame" {
    const bounds = bubbleGlassBounds(.{
        .x = 20,
        .y = 10,
        .w = 100,
        .h = 50,
    });
    try std.testing.expectEqual(@as(f32, 20), bounds.left);
    try std.testing.expectEqual(@as(f32, 10), bounds.top);
    try std.testing.expectEqual(@as(f32, 120), bounds.right);
    try std.testing.expectEqual(@as(f32, 60), bounds.bottom);
}

const BubbleGlassBackend = enum { liquid, visual_effect };

fn bubbleGlassBackend(has_glass_view: bool, has_container_view: bool) BubbleGlassBackend {
    return if (has_glass_view and has_container_view) .liquid else .visual_effect;
}

test "native glass requires both macOS 26 AppKit classes" {
    try std.testing.expectEqual(BubbleGlassBackend.liquid, bubbleGlassBackend(true, true));
    try std.testing.expectEqual(BubbleGlassBackend.visual_effect, bubbleGlassBackend(true, false));
    try std.testing.expectEqual(BubbleGlassBackend.visual_effect, bubbleGlassBackend(false, true));
    try std.testing.expectEqual(BubbleGlassBackend.visual_effect, bubbleGlassBackend(false, false));
}

test "liquid glass chrome and interaction stay system owned" {
    const source = @embedFile("plat.zig");
    const start = std.mem.lastIndexOf(u8, source, "fn applyBubbleGlass").?;
    const end_offset = std.mem.indexOf(u8, source[start..], "pub fn setBubbleNativePresentation").?;
    const bridge = source[start .. start + end_offset];
    try std.testing.expect(std.mem.indexOf(u8, bridge, "setEffectIsInteractive:") != null);
    try std.testing.expect(std.mem.indexOf(u8, bridge, "bubble_glass_group") != null);
    try std.testing.expect(std.mem.indexOf(u8, bridge, "setSpacing:") != null);
    try std.testing.expect(std.mem.indexOf(u8, bridge, "setTintColor:") != null);
    try std.testing.expect(std.mem.indexOf(u8, bridge, "semanticGlassTint(rect.semantic_state, rect.dark_appearance, rect.high_contrast)") != null);
    try std.testing.expect(std.mem.indexOf(u8, bridge, "setContentView:") != null);
    try std.testing.expect(std.mem.indexOf(u8, bridge, "setIgnoresMouseEvents:") != null);
    try std.testing.expect(std.mem.indexOf(u8, bridge, "applyBubbleControlPanels") != null);
    try std.testing.expect(std.mem.indexOf(u8, source, "systemGreenColor") != null);
    try std.testing.expect(std.mem.indexOf(u8, source, "systemBlueColor") != null);
    try std.testing.expect(std.mem.indexOf(u8, source, "systemOrangeColor") != null);
    try std.testing.expect(std.mem.indexOf(u8, bridge, "setShadowOpacity:") == null);
    try std.testing.expect(std.mem.indexOf(u8, bridge, "setBorderWidth:") == null);
    try std.testing.expect(std.mem.indexOf(u8, bridge, "CGPathCreateWithRoundedRect") == null);
    // Selection and hover are data for native interaction/accessibility; they
    // never switch the base material or manufacture a different edge.
    try std.testing.expect(std.mem.indexOf(u8, bridge, "switch (r.interaction_state)") == null);
}

// Eight session cards plus one stable pet-adjacent disclosure surface.
const max_bubble_glass_rects = 9;
pub const max_bubble_native_controls = 8 * 5;
const BubbleGlassRequest = BubbleNativePresentation;

/// Debug-only render accounting.  It stays in-process (rather than becoming
/// product telemetry) so a static-card soak can prove that equal snapshots
/// are not waking the AppKit bridge.
pub const BubbleNativeRenderCounters = struct {
    submissions: u64 = 0,
    suppressed_equal_snapshots: u64 = 0,
    appkit_applies: u64 = 0,
    changed_card_applies: u64 = 0,
};

var bubble_glass_request: BubbleGlassRequest = .{};
var bubble_glass_lock: std.atomic.Mutex = .unlocked;
var bubble_glass_dispatch_scheduled: bool = false;
/// Last snapshot accepted for main-thread application. Equal immutable
/// snapshots are discarded before they allocate a dispatch or wake AppKit.
var bubble_glass_submitted_digest: u64 = 0;
var bubble_native_render_counters: BubbleNativeRenderCounters = .{};
const bubble_native_action_capacity = 32;
var bubble_native_action_ring: [bubble_native_action_capacity]BubbleNativeControlEvent = undefined;
var bubble_native_action_head: usize = 0;
var bubble_native_action_len: usize = 0;
const bubble_native_card_event_capacity = 32;
var bubble_native_card_event_ring: [bubble_native_card_event_capacity]BubbleNativeCardEvent = undefined;
var bubble_native_card_event_head: usize = 0;
var bubble_native_card_event_len: usize = 0;

fn lockBubbleGlass() void {
    while (!bubble_glass_lock.tryLock()) std.atomic.spinLoopHint();
}

fn unlockBubbleGlass() void {
    bubble_glass_lock.unlock();
}

/// The objc-runtime and libdispatch surface needed to flip the Dock
/// icon at runtime. The SDK host pins the activation policy to Regular
/// at boot and exposes no channel for it, so this reaches AppKit
/// through the objc runtime directly. Compiled on macOS only: the
/// externs do not exist elsewhere.
const AppleApp = if (builtin.os.tag == .macos) struct {
    const NSRect = extern struct { x: f64, y: f64, width: f64, height: f64 };
    const NSPoint = extern struct { x: f64, y: f64 };
    const NSRange = extern struct { location: usize, length: usize };
    extern fn objc_getClass(name: [*:0]const u8) ?*anyopaque;
    extern fn object_getClass(object: ?*anyopaque) ?*anyopaque;
    extern fn class_addMethod(class: ?*anyopaque, name: ?*anyopaque, implementation: ?*const anyopaque, types: [*:0]const u8) bool;
    extern fn objc_allocateClassPair(superclass: ?*anyopaque, name: [*:0]const u8, extra_bytes: usize) ?*anyopaque;
    extern fn objc_registerClassPair(class: ?*anyopaque) void;
    extern fn sel_registerName(name: [*:0]const u8) ?*anyopaque;
    extern fn objc_msgSend() void;
    extern var _dispatch_main_q: anyopaque;
    extern fn dispatch_async_f(queue: *anyopaque, context: ?*anyopaque, work: *const fn (?*anyopaque) callconv(.c) void) void;
    extern fn dlopen(path: [*:0]const u8, mode: c_int) ?*anyopaque;

    var bubble_glass_views: [max_bubble_glass_rects]?*anyopaque = @splat(null);
    var bubble_glass_view_identities: [max_bubble_glass_rects]u64 = @splat(0);
    var bubble_glass_root: ?*anyopaque = null;
    var bubble_glass_group: ?*anyopaque = null;
    var bubble_glass_host: ?*anyopaque = null;
    var bubble_glass_liquid: bool = false;
    const BubbleNativeAppliedCard = struct {
        identity: u64 = 0,
        glass_digest: u64 = 0,
        content_digest: u64 = 0,
        visible: bool = false,
    };
    var bubble_native_applied_cards: [max_bubble_glass_rects]BubbleNativeAppliedCard = @splat(.{});
    var bubble_control_presentation_digest: u64 = 0;
    const BubbleNativeCardViews = struct {
        content: ?*anyopaque = null,
        substrate: ?*anyopaque = null,
        foreground: ?*anyopaque = null,
        /// Owns both message labels so a busy card needs one compositor mask,
        /// not one gradient animation per rendered line.
        message_host: ?*anyopaque = null,
        metadata_left_label: ?*anyopaque = null,
        metadata_right_label: ?*anyopaque = null,
        metadata_initialized: bool = false,
        metadata_signature: u64 = 0,
        title_label: ?*anyopaque = null,
        status_icon: ?*anyopaque = null,
        message_labels: [bubble_native_message_lines]?*anyopaque = @splat(null),
        nested_labels: [bubble_native_nested_lines]?*anyopaque = @splat(null),
    };
    var bubble_native_card_views: [max_bubble_glass_rects]BubbleNativeCardViews = @splat(.{});
    var bubble_card_panels: [max_bubble_native_cards]?*anyopaque = @splat(null);
    var bubble_card_panel_hosts: [max_bubble_native_cards]?*anyopaque = @splat(null);
    var bubble_card_panel_identities: [max_bubble_native_cards]u64 = @splat(0);
    var bubble_card_panel_visible: [max_bubble_native_cards]bool = @splat(false);
    var bubble_card_panel_frames: [max_bubble_native_cards]NSRect = @splat(.{ .x = 0, .y = 0, .width = 1, .height = 1 });
    var bubble_card_panel_frame_valid: [max_bubble_native_cards]bool = @splat(false);
    var bubble_card_gesture_view: ?*anyopaque = null;
    var bubble_card_gesture_identity: u64 = 0;
    var bubble_card_gesture_start: NSPoint = .{ .x = 0, .y = 0 };
    var bubble_card_gesture_last: NSPoint = .{ .x = 0, .y = 0 };
    var bubble_card_gesture_dragged: bool = false;
    var bubble_disclosure_panel: ?*anyopaque = null;
    var bubble_disclosure_panel_host: ?*anyopaque = null;
    var bubble_action_panel: ?*anyopaque = null;
    var bubble_action_panel_host: ?*anyopaque = null;
    var bubble_disclosure_panel_visible = false;
    var bubble_action_panel_visible = false;
    var bubble_disclosure_panel_frame: NSRect = .{ .x = 0, .y = 0, .width = 1, .height = 1 };
    var bubble_action_panel_frame: NSRect = .{ .x = 0, .y = 0, .width = 1, .height = 1 };
    var bubble_disclosure_panel_frame_valid = false;
    var bubble_action_panel_frame_valid = false;
    var bubble_control_buttons: [max_bubble_native_controls]?*anyopaque = @splat(null);
    var bubble_control_material_views: [max_bubble_native_controls]?*anyopaque = @splat(null);
    var bubble_control_hit_buttons: [max_bubble_native_controls]?*anyopaque = @splat(null);
    var bubble_control_button_keys: [max_bubble_native_controls]u64 = @splat(0);
    var bubble_control_target: ?*anyopaque = null;

    fn sharedApplication() ?*anyopaque {
        const NSApplication = objc_getClass("NSApplication") orelse return null;
        const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        return @as(MsgObj, @ptrCast(&objc_msgSend))(NSApplication, sel_registerName("sharedApplication") orelse return null);
    }

    fn visibleScreenFrameAt(x: f64, y: f64) ?VisibleScreenFrame {
        const screen_class = objc_getClass("NSScreen") orelse return null;
        const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const screens = @as(MsgObj, @ptrCast(&objc_msgSend))(screen_class, sel_registerName("screens") orelse return null) orelse return null;
        const MsgCount = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) usize;
        const count = @as(MsgCount, @ptrCast(&objc_msgSend))(screens, sel_registerName("count") orelse return null);
        if (count == 0) return null;
        const MsgAt = *const fn (?*anyopaque, ?*anyopaque, usize) callconv(.c) ?*anyopaque;
        const at_sel = sel_registerName("objectAtIndex:") orelse return null;
        const first = @as(MsgAt, @ptrCast(&objc_msgSend))(screens, at_sel, 0) orelse return null;
        const MsgRect = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) NSRect;
        const frame_sel = sel_registerName("frame") orelse return null;
        const visible_sel = sel_registerName("visibleFrame") orelse return null;
        const primary = @as(MsgRect, @ptrCast(&objc_msgSend))(first, frame_sel);
        const screen_top = primary.y + primary.height;
        var fallback: ?VisibleScreenFrame = null;
        for (0..count) |index| {
            const screen = @as(MsgAt, @ptrCast(&objc_msgSend))(screens, at_sel, index) orelse continue;
            const visible = @as(MsgRect, @ptrCast(&objc_msgSend))(screen, visible_sel);
            const converted = VisibleScreenFrame{
                .x = visible.x,
                .y = screen_top - (visible.y + visible.height),
                .width = visible.width,
                .height = visible.height,
            };
            if (fallback == null) fallback = converted;
            if (x >= converted.x and x <= converted.x + converted.width and
                y >= converted.y and y <= converted.y + converted.height) return converted;
        }
        return fallback;
    }

    fn nsString(value: [*:0]const u8) ?*anyopaque {
        const cls = objc_getClass("NSString") orelse return null;
        const MsgString = *const fn (?*anyopaque, ?*anyopaque, [*:0]const u8) callconv(.c) ?*anyopaque;
        return @as(MsgString, @ptrCast(&objc_msgSend))(cls, sel_registerName("stringWithUTF8String:") orelse return null, value);
    }

    fn nsStringText(value: *const BubbleNativeText) ?*anyopaque {
        return nsString(@ptrCast(&value.bytes));
    }

    fn nsStringAccessibilityText(value: *const BubbleNativeAccessibilityText) ?*anyopaque {
        return nsString(@ptrCast(&value.bytes));
    }

    fn appKitLocalFrame(card_height: f64, frame: BubbleNativeFrame) NSRect {
        return .{
            .x = frame.x,
            .y = card_height - @as(f64, frame.y + frame.h),
            .width = @max(0, @as(f64, frame.w)),
            .height = @max(0, @as(f64, frame.h)),
        };
    }

    fn controlSymbol(control: BubbleNativeControl) [*:0]const u8 {
        return switch (control.action) {
            .toggle_visibility => switch (control.disclosure_mode) {
                .all => "rectangle.stack",
                .recent => "rectangle",
                .hidden => if (!control.show_status_icon)
                    "circle"
                else switch (control.semantic_state) {
                    .failed => "exclamationmark.triangle",
                    .needs_input => "questionmark.message",
                    .running => "waveform",
                    .completed => "checkmark.circle",
                    .idle => "circle",
                },
            },
            .open => "arrow.up.forward.app",
            .pin => if (control.selected) "pin.fill" else "pin",
            .subagents => "point.3.connected.trianglepath.dotted",
            .dismiss => "xmark",
        };
    }

    fn controlLabel(control: BubbleNativeControl) [*:0]const u8 {
        return switch (control.action) {
            .toggle_visibility => switch (control.disclosure_mode) {
                .all => "Show most recent active session only",
                .recent => "Hide session cards",
                .hidden => "Show all active sessions",
            },
            .open => "Open agent session",
            .pin => if (control.selected) "Unpin session" else "Pin session to front",
            .subagents => if (control.selected) "Collapse subagent messages" else "Keep subagent messages expanded",
            .dismiss => "Dismiss ended session",
        };
    }

    fn bubbleControlPressed(_: ?*anyopaque, _: ?*anyopaque, sender: ?*anyopaque) callconv(.c) void {
        const button = sender orelse return;
        const MsgTag = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) isize;
        const tag = @as(MsgTag, @ptrCast(&objc_msgSend))(button, sel_registerName("tag") orelse return);
        if (tag < 0) return;
        lockBubbleGlass();
        defer unlockBubbleGlass();
        const index: usize = @intCast(tag);
        if (index >= bubble_glass_request.control_count) return;
        const control = bubble_glass_request.controls[index];
        if (!control.enabled) return;
        if (bubble_native_action_len == bubble_native_action_capacity) {
            bubble_native_action_head = (bubble_native_action_head + 1) % bubble_native_action_capacity;
            bubble_native_action_len -= 1;
        }
        const write = (bubble_native_action_head + bubble_native_action_len) % bubble_native_action_capacity;
        bubble_native_action_ring[write] = .{ .identity = control.identity, .action = control.action };
        bubble_native_action_len += 1;
        if (activityWindow()) |window| {
            const MsgIsKey = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) bool;
            if (@as(MsgIsKey, @ptrCast(&objc_msgSend))(window, sel_registerName("isKeyWindow") orelse return)) {
                const MsgVoid = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) void;
                @as(MsgVoid, @ptrCast(&objc_msgSend))(window, sel_registerName("resignKeyWindow") orelse return);
            }
        }
    }

    fn registerBubbleControlAction() ?*anyopaque {
        const action = sel_registerName("petdexBubbleControl:") orelse return null;
        if (bubble_control_target == null) {
            var target_class = objc_getClass("PetdexBubbleControlTarget");
            if (target_class == null) {
                const NSObject = objc_getClass("NSObject") orelse return null;
                target_class = objc_allocateClassPair(NSObject, "PetdexBubbleControlTarget", 0) orelse return null;
                _ = class_addMethod(target_class, action, @ptrCast(&bubbleControlPressed), "v@:@");
                objc_registerClassPair(target_class);
            }
            const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
            const allocated = @as(MsgObj, @ptrCast(&objc_msgSend))(target_class, sel_registerName("alloc") orelse return null) orelse return null;
            bubble_control_target = @as(MsgObj, @ptrCast(&objc_msgSend))(allocated, sel_registerName("init") orelse return null);
        }
        return action;
    }

    fn pushBubbleNativeCardEvent(identity: u64, action: BubbleNativeCardAction) void {
        lockBubbleGlass();
        defer unlockBubbleGlass();
        if (bubble_native_card_event_len == bubble_native_card_event_capacity) {
            bubble_native_card_event_head = (bubble_native_card_event_head + 1) % bubble_native_card_event_capacity;
            bubble_native_card_event_len -= 1;
        }
        const write = (bubble_native_card_event_head + bubble_native_card_event_len) % bubble_native_card_event_capacity;
        bubble_native_card_event_ring[write] = .{ .identity = identity, .action = action };
        bubble_native_card_event_len += 1;
    }

    fn bubbleCardIdentityForView(view: ?*anyopaque) u64 {
        const candidate = view orelse return 0;
        for (bubble_card_panel_hosts, bubble_card_panel_identities) |host, identity| {
            if (host == candidate) return identity;
        }
        return 0;
    }

    fn currentMouseLocation() NSPoint {
        const event_class = objc_getClass("NSEvent") orelse return .{ .x = 0, .y = 0 };
        const MsgPoint = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) NSPoint;
        return @as(MsgPoint, @ptrCast(&objc_msgSend))(event_class, sel_registerName("mouseLocation") orelse return .{ .x = 0, .y = 0 });
    }

    fn offsetWindow(window: ?*anyopaque, dx: f64, dy: f64) void {
        const target = window orelse return;
        const MsgRect = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) NSRect;
        const frame = @as(MsgRect, @ptrCast(&objc_msgSend))(target, sel_registerName("frame") orelse return);
        const MsgPoint = *const fn (?*anyopaque, ?*anyopaque, NSPoint) callconv(.c) void;
        @as(MsgPoint, @ptrCast(&objc_msgSend))(target, sel_registerName("setFrameOrigin:") orelse return, .{
            .x = frame.x + dx,
            .y = frame.y + dy,
        });
    }

    /// AppKit owns the pointer stream for a card drag. Move the pet and every
    /// bubble-owned window in the same event callback so neither the mascot,
    /// glass nor controls can trail the cursor while the model poll reconciles
    /// the authoritative position.
    fn offsetPetAndBubbleWindows(dx: f64, dy: f64) void {
        if (dx == 0 and dy == 0) return;
        offsetWindow(petWindow(), dx, dy);
        offsetWindow(activityWindow(), dx, dy);
        for (bubble_card_panels, bubble_card_panel_visible, 0..) |panel, visible, slot| {
            if (!visible) continue;
            offsetWindow(panel, dx, dy);
            if (bubble_card_panel_frame_valid[slot]) {
                bubble_card_panel_frames[slot].x += dx;
                bubble_card_panel_frames[slot].y += dy;
            }
        }
        if (bubble_disclosure_panel_visible) {
            offsetWindow(bubble_disclosure_panel, dx, dy);
            if (bubble_disclosure_panel_frame_valid) {
                bubble_disclosure_panel_frame.x += dx;
                bubble_disclosure_panel_frame.y += dy;
            }
        }
        if (bubble_action_panel_visible) {
            offsetWindow(bubble_action_panel, dx, dy);
            if (bubble_action_panel_frame_valid) {
                bubble_action_panel_frame.x += dx;
                bubble_action_panel_frame.y += dy;
            }
        }
    }

    fn bubbleCardAcceptsFirstMouse(_: ?*anyopaque, _: ?*anyopaque, _: ?*anyopaque) callconv(.c) bool {
        return true;
    }

    fn bubbleCardMouseDown(view: ?*anyopaque, _: ?*anyopaque, _: ?*anyopaque) callconv(.c) void {
        const identity = bubbleCardIdentityForView(view);
        if (identity == 0) return;
        bubble_card_gesture_view = view;
        bubble_card_gesture_identity = identity;
        bubble_card_gesture_start = currentMouseLocation();
        bubble_card_gesture_last = bubble_card_gesture_start;
        bubble_card_gesture_dragged = false;
    }

    fn bubbleCardMouseDragged(view: ?*anyopaque, _: ?*anyopaque, _: ?*anyopaque) callconv(.c) void {
        if (view == null or view != bubble_card_gesture_view or bubble_card_gesture_identity == 0) return;
        const current = currentMouseLocation();
        if (!bubble_card_gesture_dragged) {
            const total_x = current.x - bubble_card_gesture_start.x;
            const total_y = current.y - bubble_card_gesture_start.y;
            if (!bubbleCardDragThresholdExceeded(total_x, total_y)) return;
            bubble_card_gesture_dragged = true;
            pushBubbleNativeCardEvent(bubble_card_gesture_identity, .drag_started);
            offsetPetAndBubbleWindows(total_x, total_y);
        } else {
            offsetPetAndBubbleWindows(current.x - bubble_card_gesture_last.x, current.y - bubble_card_gesture_last.y);
        }
        bubble_card_gesture_last = current;
    }

    fn bubbleCardMouseUp(view: ?*anyopaque, _: ?*anyopaque, _: ?*anyopaque) callconv(.c) void {
        if (view == null or view != bubble_card_gesture_view or bubble_card_gesture_identity == 0) return;
        const identity = bubble_card_gesture_identity;
        if (bubble_card_gesture_dragged) {
            pushBubbleNativeCardEvent(identity, .drag_ended);
        } else if (bubbleCardActionAvailable(identity)) {
            pushBubbleNativeCardEvent(identity, .activate);
        }
        bubble_card_gesture_view = null;
        bubble_card_gesture_identity = 0;
        bubble_card_gesture_dragged = false;
    }

    fn bubbleCardActionAvailable(identity: u64) bool {
        lockBubbleGlass();
        defer unlockBubbleGlass();
        var action_available = false;
        for (bubble_glass_request.cards[0..bubble_glass_request.card_count]) |card| {
            if (card.glass.identity == identity) {
                action_available = card.action_available;
                break;
            }
        }
        return action_available;
    }

    fn bubbleCardAccessibilityPress(view: ?*anyopaque, _: ?*anyopaque) callconv(.c) bool {
        const identity = bubbleCardIdentityForView(view);
        if (identity == 0 or !bubbleCardActionAvailable(identity)) return false;
        pushBubbleNativeCardEvent(identity, .activate);
        return true;
    }

    fn bubbleButtonAcceptsFirstMouse(_: ?*anyopaque, _: ?*anyopaque, _: ?*anyopaque) callconv(.c) bool {
        // The activity panel deliberately does not activate Petdex. AppKit's
        // ordinary first click can therefore be consumed as window activation
        // instead of invoking a control. Overlay actions must work on that
        // first click while the user's agent application remains active.
        return true;
    }

    fn bubbleButtonMouseDownCanMoveWindow(_: ?*anyopaque, _: ?*anyopaque) callconv(.c) bool {
        return false;
    }

    fn bubbleControlButtonClass() ?*anyopaque {
        if (objc_getClass("PetdexBubbleOverlayButton")) |existing| return existing;
        const NSButton = objc_getClass("NSButton") orelse return null;
        const cls = objc_allocateClassPair(NSButton, "PetdexBubbleOverlayButton", 0) orelse
            return objc_getClass("PetdexBubbleOverlayButton");
        _ = class_addMethod(
            cls,
            sel_registerName("acceptsFirstMouse:") orelse return null,
            @ptrCast(&bubbleButtonAcceptsFirstMouse),
            "c@:@",
        );
        _ = class_addMethod(
            cls,
            sel_registerName("mouseDownCanMoveWindow") orelse return null,
            @ptrCast(&bubbleButtonMouseDownCanMoveWindow),
            "c@:",
        );
        objc_registerClassPair(cls);
        return cls;
    }

    fn bubbleCardHitViewClass() ?*anyopaque {
        if (objc_getClass("PetdexBubbleCardHitView")) |existing| return existing;
        const NSView = objc_getClass("NSView") orelse return null;
        const cls = objc_allocateClassPair(NSView, "PetdexBubbleCardHitView", 0) orelse
            return objc_getClass("PetdexBubbleCardHitView");
        _ = class_addMethod(
            cls,
            sel_registerName("acceptsFirstMouse:") orelse return null,
            @ptrCast(&bubbleCardAcceptsFirstMouse),
            "c@:@",
        );
        _ = class_addMethod(
            cls,
            sel_registerName("mouseDownCanMoveWindow") orelse return null,
            @ptrCast(&bubbleButtonMouseDownCanMoveWindow),
            "c@:",
        );
        _ = class_addMethod(cls, sel_registerName("mouseDown:") orelse return null, @ptrCast(&bubbleCardMouseDown), "v@:@");
        _ = class_addMethod(cls, sel_registerName("mouseDragged:") orelse return null, @ptrCast(&bubbleCardMouseDragged), "v@:@");
        _ = class_addMethod(cls, sel_registerName("mouseUp:") orelse return null, @ptrCast(&bubbleCardMouseUp), "v@:@");
        _ = class_addMethod(cls, sel_registerName("accessibilityPerformPress") orelse return null, @ptrCast(&bubbleCardAccessibilityPress), "c@:");
        objc_registerClassPair(cls);
        return cls;
    }

    fn alwaysTrue(_: ?*anyopaque, _: ?*anyopaque) callconv(.c) bool {
        return true;
    }

    fn alwaysFalse(_: ?*anyopaque, _: ?*anyopaque) callconv(.c) bool {
        return false;
    }

    fn bubbleNativeContentViewClass() ?*anyopaque {
        if (objc_getClass("PetdexBubbleNativeContentView")) |existing| return existing;
        const NSView = objc_getClass("NSView") orelse return null;
        const cls = objc_allocateClassPair(NSView, "PetdexBubbleNativeContentView", 0) orelse
            return objc_getClass("PetdexBubbleNativeContentView");
        _ = class_addMethod(
            cls,
            sel_registerName("allowsVibrancy") orelse return null,
            @ptrCast(&alwaysTrue),
            "c@:",
        );
        objc_registerClassPair(cls);
        return cls;
    }

    fn bubbleControlPanelClass() ?*anyopaque {
        if (objc_getClass("PetdexBubbleControlPanel")) |existing| return existing;
        const NSPanel = objc_getClass("NSPanel") orelse return null;
        const cls = objc_allocateClassPair(NSPanel, "PetdexBubbleControlPanel", 0) orelse
            return objc_getClass("PetdexBubbleControlPanel");
        _ = class_addMethod(
            cls,
            sel_registerName("canBecomeKeyWindow") orelse return null,
            @ptrCast(&alwaysFalse),
            "c@:",
        );
        _ = class_addMethod(
            cls,
            sel_registerName("canBecomeMainWindow") orelse return null,
            @ptrCast(&alwaysFalse),
            "c@:",
        );
        objc_registerClassPair(cls);
        return cls;
    }

    fn windowTitled(wanted: []const u8) ?*anyopaque {
        const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const app = sharedApplication() orelse return null;
        const windows = @as(MsgObj, @ptrCast(&objc_msgSend))(app, sel_registerName("windows") orelse return null) orelse return null;
        const MsgCount = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) usize;
        const count = @as(MsgCount, @ptrCast(&objc_msgSend))(windows, sel_registerName("count") orelse return null);
        const MsgAt = *const fn (?*anyopaque, ?*anyopaque, usize) callconv(.c) ?*anyopaque;
        const at_sel = sel_registerName("objectAtIndex:") orelse return null;
        const title_sel = sel_registerName("title") orelse return null;
        const utf8_sel = sel_registerName("UTF8String") orelse return null;
        const MsgCString = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?[*:0]const u8;
        for (0..count) |i| {
            const window = @as(MsgAt, @ptrCast(&objc_msgSend))(windows, at_sel, i) orelse continue;
            const title = @as(MsgObj, @ptrCast(&objc_msgSend))(window, title_sel) orelse continue;
            const title_c = @as(MsgCString, @ptrCast(&objc_msgSend))(title, utf8_sel) orelse continue;
            if (std.mem.eql(u8, std.mem.span(title_c), wanted)) return window;
        }
        return null;
    }

    fn activityWindow() ?*anyopaque {
        return windowTitled("Petdex Activity");
    }

    fn petWindow() ?*anyopaque {
        return windowTitled("Petdex");
    }

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

    fn respondsToSelector(object: ?*anyopaque, selector: ?*anyopaque) bool {
        const object_ptr = object orelse return false;
        const selector_ptr = selector orelse return false;
        const responds_sel = sel_registerName("respondsToSelector:") orelse return false;
        const MsgResponds = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) bool;
        return @as(MsgResponds, @ptrCast(&objc_msgSend))(object_ptr, responds_sel, selector_ptr);
    }

    fn semanticGlassTint(state: BubbleGlassSemanticState, dark: bool, high_contrast: bool) ?*anyopaque {
        const color_class = objc_getClass("NSColor") orelse return null;
        const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const MsgAlpha = *const fn (?*anyopaque, ?*anyopaque, f64) callconv(.c) ?*anyopaque;
        // Keep regular system glass and only bias it with a restrained
        // adaptive neutral. Foreground now lives inside contentView, so AppKit
        // can coordinate vibrancy and inactive-window adaptation itself.
        const neutral_source = @as(MsgObj, @ptrCast(&objc_msgSend))(
            color_class,
            sel_registerName("blackColor") orelse return null,
        ) orelse return null;
        const neutral_alpha: f64 = if (high_contrast)
            (if (dark) 0.18 else 0.12)
        else if (dark)
            0.14
        else
            0.08;
        const neutral = @as(MsgAlpha, @ptrCast(&objc_msgSend))(neutral_source, sel_registerName("colorWithAlphaComponent:") orelse return null, neutral_alpha) orelse return null;
        const selector_name: [*:0]const u8 = switch (state) {
            .running => "systemBlueColor",
            .completed => "systemGreenColor",
            .needs_input => "systemOrangeColor",
            .failed => "systemRedColor",
            .idle => return neutral,
        };
        const semantic = @as(MsgObj, @ptrCast(&objc_msgSend))(color_class, sel_registerName(selector_name) orelse return null) orelse return neutral;
        const semantic_tint = @as(MsgAlpha, @ptrCast(&objc_msgSend))(semantic, sel_registerName("colorWithAlphaComponent:") orelse return neutral, if (high_contrast) 0.14 else 0.10) orelse return neutral;
        const MsgBlend = *const fn (?*anyopaque, ?*anyopaque, f64, ?*anyopaque) callconv(.c) ?*anyopaque;
        return @as(MsgBlend, @ptrCast(&objc_msgSend))(
            neutral,
            sel_registerName("blendedColorWithFraction:ofColor:") orelse return neutral,
            if (high_contrast) 0.35 else 0.32,
            semantic_tint,
        ) orelse neutral;
    }

    fn systemColor(selector_name: [*:0]const u8) ?*anyopaque {
        const color_class = objc_getClass("NSColor") orelse return null;
        const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        return @as(MsgObj, @ptrCast(&objc_msgSend))(color_class, sel_registerName(selector_name) orelse return null);
    }

    fn accessibilityDisplayFlag(selector_name: [*:0]const u8) bool {
        const workspace_class = objc_getClass("NSWorkspace") orelse return false;
        const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const workspace = @as(MsgObj, @ptrCast(&objc_msgSend))(workspace_class, sel_registerName("sharedWorkspace") orelse return false) orelse return false;
        const selector = sel_registerName(selector_name) orelse return false;
        if (!respondsToSelector(workspace, selector)) return false;
        const MsgBool = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) bool;
        return @as(MsgBool, @ptrCast(&objc_msgSend))(workspace, selector);
    }

    fn applicationIsActive() bool {
        const app = sharedApplication() orelse return false;
        const MsgBool = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) bool;
        return @as(MsgBool, @ptrCast(&objc_msgSend))(app, sel_registerName("isActive") orelse return false);
    }

    fn addSubview(parent: ?*anyopaque, child: ?*anyopaque) void {
        const host = parent orelse return;
        const view = child orelse return;
        const MsgSetObj = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void;
        @as(MsgSetObj, @ptrCast(&objc_msgSend))(host, sel_registerName("addSubview:") orelse return, view);
    }

    fn makeNativeView(class_name: [*:0]const u8) ?*anyopaque {
        const cls = objc_getClass(class_name) orelse return null;
        const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const MsgInit = *const fn (?*anyopaque, ?*anyopaque, NSRect) callconv(.c) ?*anyopaque;
        const allocated = @as(MsgObj, @ptrCast(&objc_msgSend))(cls, sel_registerName("alloc") orelse return null) orelse return null;
        return @as(MsgInit, @ptrCast(&objc_msgSend))(allocated, sel_registerName("initWithFrame:") orelse return null, .{ .x = 0, .y = 0, .width = 1, .height = 1 });
    }

    fn makeNativeLabel() ?*anyopaque {
        const cls = objc_getClass("NSTextField") orelse return null;
        const empty = nsString("") orelse return null;
        const MsgLabel = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const label = @as(MsgLabel, @ptrCast(&objc_msgSend))(cls, sel_registerName("labelWithString:") orelse return null, empty) orelse return null;
        const MsgBool = *const fn (?*anyopaque, ?*anyopaque, bool) callconv(.c) void;
        const MsgInt = *const fn (?*anyopaque, ?*anyopaque, isize) callconv(.c) void;
        @as(MsgBool, @ptrCast(&objc_msgSend))(label, sel_registerName("setSelectable:") orelse return null, false);
        @as(MsgBool, @ptrCast(&objc_msgSend))(label, sel_registerName("setEditable:") orelse return null, false);
        @as(MsgBool, @ptrCast(&objc_msgSend))(label, sel_registerName("setBezeled:") orelse return null, false);
        @as(MsgBool, @ptrCast(&objc_msgSend))(label, sel_registerName("setDrawsBackground:") orelse return null, false);
        const single_line_sel = sel_registerName("setUsesSingleLineMode:");
        if (respondsToSelector(label, single_line_sel))
            @as(MsgBool, @ptrCast(&objc_msgSend))(label, single_line_sel, true);
        const maximum_lines_sel = sel_registerName("setMaximumNumberOfLines:");
        if (respondsToSelector(label, maximum_lines_sel))
            @as(MsgInt, @ptrCast(&objc_msgSend))(label, maximum_lines_sel, 1);
        @as(MsgInt, @ptrCast(&objc_msgSend))(label, sel_registerName("setLineBreakMode:") orelse return null, 4);
        @as(MsgBool, @ptrCast(&objc_msgSend))(label, sel_registerName("setWantsLayer:") orelse return null, true);
        return label;
    }

    fn makeNativeImageView() ?*anyopaque {
        const image = makeNativeView("NSImageView") orelse return null;
        const MsgInt = *const fn (?*anyopaque, ?*anyopaque, isize) callconv(.c) void;
        const MsgBool = *const fn (?*anyopaque, ?*anyopaque, bool) callconv(.c) void;
        @as(MsgInt, @ptrCast(&objc_msgSend))(image, sel_registerName("setImageScaling:") orelse return null, 2);
        @as(MsgBool, @ptrCast(&objc_msgSend))(image, sel_registerName("setWantsLayer:") orelse return null, true);
        return image;
    }

    fn ensureNativeCardViews(slot: usize, glass: ?*anyopaque, liquid: bool) ?*BubbleNativeCardViews {
        if (slot >= bubble_native_card_views.len) return null;
        var views = &bubble_native_card_views[slot];
        if (views.content != null) return views;

        const content_class = bubbleNativeContentViewClass() orelse return null;
        const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const MsgInit = *const fn (?*anyopaque, ?*anyopaque, NSRect) callconv(.c) ?*anyopaque;
        const allocated = @as(MsgObj, @ptrCast(&objc_msgSend))(content_class, sel_registerName("alloc") orelse return null) orelse return null;
        const content = @as(MsgInit, @ptrCast(&objc_msgSend))(allocated, sel_registerName("initWithFrame:") orelse return null, .{ .x = 0, .y = 0, .width = 1, .height = 1 }) orelse return null;
        views.content = content;
        const MsgBool = *const fn (?*anyopaque, ?*anyopaque, bool) callconv(.c) void;
        @as(MsgBool, @ptrCast(&objc_msgSend))(content, sel_registerName("setWantsLayer:") orelse return null, true);
        if (@as(MsgObj, @ptrCast(&objc_msgSend))(content, sel_registerName("layer") orelse return null)) |layer|
            @as(MsgBool, @ptrCast(&objc_msgSend))(layer, sel_registerName("setMasksToBounds:") orelse return null, true);

        if (liquid) {
            const MsgSetObj = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void;
            @as(MsgSetObj, @ptrCast(&objc_msgSend))(glass, sel_registerName("setContentView:") orelse return null, content);
        } else {
            addSubview(glass, content);
        }

        views.substrate = makeNativeView("NSView");
        views.foreground = makeNativeView("NSView");
        views.message_host = makeNativeView("NSView");
        views.metadata_left_label = makeNativeLabel();
        views.metadata_right_label = makeNativeLabel();
        views.title_label = makeNativeLabel();
        views.status_icon = makeNativeImageView();
        for (0..bubble_native_message_lines) |row| views.message_labels[row] = makeNativeLabel();
        for (0..bubble_native_nested_lines) |row| views.nested_labels[row] = makeNativeLabel();

        addSubview(content, views.substrate);
        addSubview(content, views.foreground);
        const foreground = views.foreground orelse return null;
        addSubview(foreground, views.metadata_left_label);
        addSubview(foreground, views.metadata_right_label);
        addSubview(foreground, views.title_label);
        addSubview(foreground, views.status_icon);
        addSubview(foreground, views.message_host);
        for (views.message_labels) |label| addSubview(views.message_host, label);
        for (views.nested_labels) |label| addSubview(foreground, label);

        if (views.substrate) |substrate|
            @as(MsgBool, @ptrCast(&objc_msgSend))(substrate, sel_registerName("setWantsLayer:") orelse return null, true);
        if (views.foreground) |foreground_view| {
            @as(MsgBool, @ptrCast(&objc_msgSend))(foreground_view, sel_registerName("setWantsLayer:") orelse return null, true);
        }
        if (views.message_host) |message_host|
            @as(MsgBool, @ptrCast(&objc_msgSend))(message_host, sel_registerName("setWantsLayer:") orelse return null, true);
        if (views.metadata_right_label) |project| {
            const MsgInt = *const fn (?*anyopaque, ?*anyopaque, isize) callconv(.c) void;
            @as(MsgInt, @ptrCast(&objc_msgSend))(project, sel_registerName("setAlignment:") orelse return null, 1);
        }
        return views;
    }

    fn setNativeLabel(
        label: ?*anyopaque,
        text: *const BubbleNativeText,
        frame: BubbleNativeFrame,
        card_height: f64,
        font_size: f32,
        weight: f64,
        color_selector: [*:0]const u8,
        alpha: f32,
    ) void {
        const field = label orelse return;
        const MsgSetObj = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void;
        const MsgFrame = *const fn (?*anyopaque, ?*anyopaque, NSRect) callconv(.c) void;
        const MsgFloat = *const fn (?*anyopaque, ?*anyopaque, f64) callconv(.c) void;
        const MsgBool = *const fn (?*anyopaque, ?*anyopaque, bool) callconv(.c) void;
        const font_class = objc_getClass("NSFont") orelse return;
        const MsgFont = *const fn (?*anyopaque, ?*anyopaque, f64, f64) callconv(.c) ?*anyopaque;
        const font = @as(MsgFont, @ptrCast(&objc_msgSend))(font_class, sel_registerName("systemFontOfSize:weight:") orelse return, font_size, weight);
        @as(MsgSetObj, @ptrCast(&objc_msgSend))(field, sel_registerName("setStringValue:") orelse return, nsStringText(text));
        @as(MsgSetObj, @ptrCast(&objc_msgSend))(field, sel_registerName("setFont:") orelse return, font);
        @as(MsgSetObj, @ptrCast(&objc_msgSend))(field, sel_registerName("setTextColor:") orelse return, systemColor(color_selector));
        @as(MsgFrame, @ptrCast(&objc_msgSend))(field, sel_registerName("setFrame:") orelse return, appKitLocalFrame(card_height, frame));
        @as(MsgFloat, @ptrCast(&objc_msgSend))(field, sel_registerName("setAlphaValue:") orelse return, std.math.clamp(alpha, 0, 1));
        @as(MsgBool, @ptrCast(&objc_msgSend))(field, sel_registerName("setHidden:") orelse return, text.len == 0 or frame.w <= 0 or frame.h <= 0 or alpha <= 0.001);
    }

    /// AppKit's `NSTextField` adds small intrinsic cell insets that are
    /// harmless for a wide label but disastrous when agent, host, separator,
    /// and project are each assigned their own exact-width field. Compose the
    /// visible metadata into two attributed strings instead, retaining the
    /// requested semantic hierarchy inside each clipping cell.
    fn attributedMetadataFragment(text: ?*anyopaque, font_size: f32, weight: f64, color_selector: [*:0]const u8) ?*anyopaque {
        const text_value = text orelse return null;
        const attributed_class = objc_getClass("NSMutableAttributedString") orelse return null;
        const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const MsgInit = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const allocated = @as(MsgObj, @ptrCast(&objc_msgSend))(attributed_class, sel_registerName("alloc") orelse return null) orelse return null;
        const attributed = @as(MsgInit, @ptrCast(&objc_msgSend))(allocated, sel_registerName("initWithString:") orelse return null, text_value) orelse return null;
        const MsgLength = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) usize;
        const length = @as(MsgLength, @ptrCast(&objc_msgSend))(attributed, sel_registerName("length") orelse return null);
        if (length == 0) return attributed;

        const font_class = objc_getClass("NSFont") orelse return attributed;
        const MsgFont = *const fn (?*anyopaque, ?*anyopaque, f64, f64) callconv(.c) ?*anyopaque;
        const font = @as(MsgFont, @ptrCast(&objc_msgSend))(font_class, sel_registerName("systemFontOfSize:weight:") orelse return null, font_size, weight);
        const MsgAddAttribute = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque, ?*anyopaque, NSRange) callconv(.c) void;
        const add_attribute = sel_registerName("addAttribute:value:range:") orelse return attributed;
        const range = NSRange{ .location = 0, .length = length };
        @as(MsgAddAttribute, @ptrCast(&objc_msgSend))(
            attributed,
            add_attribute,
            nsString("NSFont") orelse return attributed,
            font,
            range,
        );
        @as(MsgAddAttribute, @ptrCast(&objc_msgSend))(
            attributed,
            add_attribute,
            nsString("NSColor") orelse return attributed,
            systemColor(color_selector),
            range,
        );
        return attributed;
    }

    /// The temporary attributed strings are allocated from Zig, not ARC. The
    /// text field copies them, and an appended fragment is retained by its
    /// destination, so release the caller-owned references immediately.
    fn releaseObject(object: ?*anyopaque) void {
        const value = object orelse return;
        const MsgVoid = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) void;
        @as(MsgVoid, @ptrCast(&objc_msgSend))(value, sel_registerName("release") orelse return);
    }

    fn appendAttributedMetadata(target: ?*anyopaque, fragment: ?*anyopaque) void {
        defer releaseObject(fragment);
        const destination = target orelse return;
        const source = fragment orelse return;
        const MsgSetObj = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void;
        @as(MsgSetObj, @ptrCast(&objc_msgSend))(destination, sel_registerName("appendAttributedString:") orelse return, source);
    }

    /// `NSTextField.alignment` is only a field default once an attributed
    /// string is assigned. Put the single-line/truncation policy directly on
    /// the attributed metadata value so native and measured clipping agree.
    fn applyMetadataParagraphStyle(attributed: ?*anyopaque, right_aligned: bool) void {
        const value = attributed orelse return;
        const MsgLength = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) usize;
        const length = @as(MsgLength, @ptrCast(&objc_msgSend))(value, sel_registerName("length") orelse return);
        if (length == 0) return;

        const style_class = objc_getClass("NSMutableParagraphStyle") orelse return;
        const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const MsgInit = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const allocated = @as(MsgObj, @ptrCast(&objc_msgSend))(style_class, sel_registerName("alloc") orelse return) orelse return;
        const style = @as(MsgInit, @ptrCast(&objc_msgSend))(allocated, sel_registerName("init") orelse return) orelse return;
        defer releaseObject(style);

        const MsgInt = *const fn (?*anyopaque, ?*anyopaque, isize) callconv(.c) void;
        @as(MsgInt, @ptrCast(&objc_msgSend))(style, sel_registerName("setAlignment:") orelse return, if (right_aligned) 1 else 0);
        // NSLineBreakByTruncatingTail. This must match the clipping policy of
        // the measured metadata cells.
        @as(MsgInt, @ptrCast(&objc_msgSend))(style, sel_registerName("setLineBreakMode:") orelse return, 4);

        const MsgAddAttribute = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque, ?*anyopaque, NSRange) callconv(.c) void;
        @as(MsgAddAttribute, @ptrCast(&objc_msgSend))(
            value,
            sel_registerName("addAttribute:value:range:") orelse return,
            nsString("NSParagraphStyle") orelse return,
            style,
            .{ .location = 0, .length = length },
        );
    }

    fn nativeMetadataAttributedString(snapshot: *const BubbleNativeCardSnapshot) ?*anyopaque {
        const attributed_class = objc_getClass("NSMutableAttributedString") orelse return null;
        const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const MsgInit = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const allocated = @as(MsgObj, @ptrCast(&objc_msgSend))(attributed_class, sel_registerName("alloc") orelse return null) orelse return null;
        const result = @as(MsgInit, @ptrCast(&objc_msgSend))(
            allocated,
            sel_registerName("initWithString:") orelse return null,
            nsString("") orelse return null,
        ) orelse return null;

        appendAttributedMetadata(result, attributedMetadataFragment(nsStringText(&snapshot.agent), snapshot.metadata_font_size, 0.23, "labelColor"));
        appendAttributedMetadata(result, attributedMetadataFragment(nsString(" · "), snapshot.metadata_font_size, 0, "tertiaryLabelColor"));
        appendAttributedMetadata(result, attributedMetadataFragment(nsStringText(&snapshot.hostname), snapshot.metadata_font_size, 0, "secondaryLabelColor"));
        if (snapshot.project.len > 0) {
            appendAttributedMetadata(result, attributedMetadataFragment(nsString(" · "), snapshot.metadata_font_size, 0, "tertiaryLabelColor"));
            // The project is deliberately label-colored like the agent, so it
            // stays visually distinct from the adjacent muted hostname.
            appendAttributedMetadata(result, attributedMetadataFragment(nsStringText(&snapshot.project), snapshot.metadata_font_size, 0, "labelColor"));
        }
        applyMetadataParagraphStyle(result, false);
        return result;
    }

    fn metadataSignature(snapshot: *const BubbleNativeCardSnapshot) u64 {
        var hash: u64 = 1469598103934665603;
        const values = [_][]const u8{
            snapshot.agent.slice(),
            snapshot.hostname.slice(),
            snapshot.project.slice(),
        };
        for (values) |value| {
            for (value) |byte| {
                hash ^= byte;
                hash *%= 1099511628211;
            }
            hash ^= 0xff;
            hash *%= 1099511628211;
        }
        const font_bits: u32 = @bitCast(snapshot.metadata_font_size);
        hash ^= font_bits;
        hash *%= 1099511628211;
        return hash;
    }

    fn setNativeAttributedMetadataLabel(
        label: ?*anyopaque,
        attributed: ?*anyopaque,
        frame: BubbleNativeFrame,
        card_height: f64,
        alpha: f32,
        visible: bool,
        right_aligned: bool,
    ) void {
        defer releaseObject(attributed);
        const field = label orelse return;
        const MsgSetObj = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void;
        const MsgFrame = *const fn (?*anyopaque, ?*anyopaque, NSRect) callconv(.c) void;
        const MsgFloat = *const fn (?*anyopaque, ?*anyopaque, f64) callconv(.c) void;
        const MsgBool = *const fn (?*anyopaque, ?*anyopaque, bool) callconv(.c) void;
        if (attributed) |value|
            @as(MsgSetObj, @ptrCast(&objc_msgSend))(field, sel_registerName("setAttributedStringValue:") orelse return, value);
        // Reapply the field policy on every presentation update too. It keeps
        // native text behavior deterministic even if AppKit replaces a cell
        // while adapting the glass hierarchy to appearance changes.
        const MsgInt = *const fn (?*anyopaque, ?*anyopaque, isize) callconv(.c) void;
        @as(MsgInt, @ptrCast(&objc_msgSend))(field, sel_registerName("setAlignment:") orelse return, if (right_aligned) 1 else 0);
        @as(MsgInt, @ptrCast(&objc_msgSend))(field, sel_registerName("setLineBreakMode:") orelse return, 4);
        const single_line_sel = sel_registerName("setUsesSingleLineMode:");
        if (respondsToSelector(field, single_line_sel))
            @as(MsgBool, @ptrCast(&objc_msgSend))(field, single_line_sel, true);
        const maximum_lines_sel = sel_registerName("setMaximumNumberOfLines:");
        if (respondsToSelector(field, maximum_lines_sel))
            @as(MsgInt, @ptrCast(&objc_msgSend))(field, maximum_lines_sel, 1);
        @as(MsgFrame, @ptrCast(&objc_msgSend))(field, sel_registerName("setFrame:") orelse return, appKitLocalFrame(card_height, frame));
        @as(MsgFloat, @ptrCast(&objc_msgSend))(field, sel_registerName("setAlphaValue:") orelse return, std.math.clamp(alpha, 0, 1));
        @as(MsgBool, @ptrCast(&objc_msgSend))(field, sel_registerName("setHidden:") orelse return, !visible or frame.w <= 0 or frame.h <= 0 or alpha <= 0.001);
    }

    fn setNativeImage(
        image_view: ?*anyopaque,
        symbol_name: [*:0]const u8,
        accessibility: [*:0]const u8,
        frame: BubbleNativeFrame,
        card_height: f64,
        color_selector: [*:0]const u8,
        alpha: f32,
    ) void {
        const view = image_view orelse return;
        const image_class = objc_getClass("NSImage") orelse return;
        const MsgImage = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const image = @as(MsgImage, @ptrCast(&objc_msgSend))(
            image_class,
            sel_registerName("imageWithSystemSymbolName:accessibilityDescription:") orelse return,
            nsString(symbol_name),
            nsString(accessibility),
        );
        const MsgSetObj = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void;
        const MsgFrame = *const fn (?*anyopaque, ?*anyopaque, NSRect) callconv(.c) void;
        const MsgFloat = *const fn (?*anyopaque, ?*anyopaque, f64) callconv(.c) void;
        const MsgBool = *const fn (?*anyopaque, ?*anyopaque, bool) callconv(.c) void;
        @as(MsgSetObj, @ptrCast(&objc_msgSend))(view, sel_registerName("setImage:") orelse return, image);
        const tint_sel = sel_registerName("setContentTintColor:");
        if (respondsToSelector(view, tint_sel))
            @as(MsgSetObj, @ptrCast(&objc_msgSend))(view, tint_sel, systemColor(color_selector));
        @as(MsgFrame, @ptrCast(&objc_msgSend))(view, sel_registerName("setFrame:") orelse return, appKitLocalFrame(card_height, frame));
        @as(MsgFloat, @ptrCast(&objc_msgSend))(view, sel_registerName("setAlphaValue:") orelse return, std.math.clamp(alpha, 0, 1));
        @as(MsgBool, @ptrCast(&objc_msgSend))(view, sel_registerName("setHidden:") orelse return, image == null or frame.w <= 0 or frame.h <= 0 or alpha <= 0.001);
    }

    fn gradientMask(colors: []const ?*anyopaque, locations: []const f64) ?*anyopaque {
        if (colors.len == 0 or colors.len != locations.len) return null;
        const gradient_class = objc_getClass("CAGradientLayer") orelse return null;
        const array_class = objc_getClass("NSArray") orelse return null;
        const number_class = objc_getClass("NSNumber") orelse return null;
        const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const gradient = @as(MsgObj, @ptrCast(&objc_msgSend))(gradient_class, sel_registerName("layer") orelse return null) orelse return null;
        const MsgArray = *const fn (?*anyopaque, ?*anyopaque, [*]const ?*anyopaque, usize) callconv(.c) ?*anyopaque;
        var color_objects: [5]?*anyopaque = @splat(null);
        var location_objects: [5]?*anyopaque = @splat(null);
        if (colors.len > color_objects.len) return null;
        const MsgNumber = *const fn (?*anyopaque, ?*anyopaque, f64) callconv(.c) ?*anyopaque;
        for (colors, locations, 0..) |color, location, index| {
            color_objects[index] = color;
            location_objects[index] = @as(MsgNumber, @ptrCast(&objc_msgSend))(number_class, sel_registerName("numberWithDouble:") orelse return null, location);
        }
        const color_array = @as(MsgArray, @ptrCast(&objc_msgSend))(array_class, sel_registerName("arrayWithObjects:count:") orelse return null, &color_objects, colors.len);
        const location_array = @as(MsgArray, @ptrCast(&objc_msgSend))(array_class, sel_registerName("arrayWithObjects:count:") orelse return null, &location_objects, locations.len);
        const MsgSetObj = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void;
        @as(MsgSetObj, @ptrCast(&objc_msgSend))(gradient, sel_registerName("setColors:") orelse return null, color_array);
        @as(MsgSetObj, @ptrCast(&objc_msgSend))(gradient, sel_registerName("setLocations:") orelse return null, location_array);
        return gradient;
    }

    fn numberArray(values: []const f64) ?*anyopaque {
        if (values.len == 0 or values.len > 5) return null;
        const array_class = objc_getClass("NSArray") orelse return null;
        const number_class = objc_getClass("NSNumber") orelse return null;
        const MsgNumber = *const fn (?*anyopaque, ?*anyopaque, f64) callconv(.c) ?*anyopaque;
        const MsgArray = *const fn (?*anyopaque, ?*anyopaque, [*]const ?*anyopaque, usize) callconv(.c) ?*anyopaque;
        var objects: [5]?*anyopaque = @splat(null);
        for (values, 0..) |value, index|
            objects[index] = @as(MsgNumber, @ptrCast(&objc_msgSend))(number_class, sel_registerName("numberWithDouble:") orelse return null, value);
        return @as(MsgArray, @ptrCast(&objc_msgSend))(array_class, sel_registerName("arrayWithObjects:count:") orelse return null, &objects, values.len);
    }

    fn colorCg(color: ?*anyopaque) ?*anyopaque {
        const value = color orelse return null;
        const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        return @as(MsgObj, @ptrCast(&objc_msgSend))(value, sel_registerName("CGColor") orelse return null);
    }

    fn colorWithAlpha(color: ?*anyopaque, alpha: f64) ?*anyopaque {
        const value = color orelse return null;
        const MsgAlpha = *const fn (?*anyopaque, ?*anyopaque, f64) callconv(.c) ?*anyopaque;
        return @as(MsgAlpha, @ptrCast(&objc_msgSend))(value, sel_registerName("colorWithAlphaComponent:") orelse return null, alpha);
    }

    fn applyMessageShimmer(views: *BubbleNativeCardViews, snapshot: *const BubbleNativeCardSnapshot) void {
        const message_host = views.message_host orelse return;
        const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const layer = @as(MsgObj, @ptrCast(&objc_msgSend))(message_host, sel_registerName("layer") orelse return) orelse return;
        const MsgSetObj = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void;
        const animation_key = nsString("petdex.message-shimmer") orelse return;
        if (!snapshot.busy or snapshot.reduce_motion or snapshot.message_line_count == 0 or snapshot.glass.materialization == .hidden) {
            if (@as(MsgObj, @ptrCast(&objc_msgSend))(layer, sel_registerName("mask") orelse return)) |old_mask|
                @as(MsgSetObj, @ptrCast(&objc_msgSend))(old_mask, sel_registerName("removeAnimationForKey:") orelse return, animation_key);
            @as(MsgSetObj, @ptrCast(&objc_msgSend))(layer, sel_registerName("setMask:") orelse return, null);
            return;
        }
        var mask = @as(MsgObj, @ptrCast(&objc_msgSend))(layer, sel_registerName("mask") orelse return);
        if (mask == null) {
            const dim = colorCg(colorWithAlpha(systemColor("whiteColor"), 0.68));
            const bright = colorCg(colorWithAlpha(systemColor("whiteColor"), 1));
            // A narrow, soft horizontal band reads as liquid light travelling
            // across the prose rather than a scanner. The outer dim stops
            // preserve contrast while the bright core stays near 16% wide.
            mask = gradientMask(&.{ dim, dim, bright, dim, dim }, &.{ 0.00, 0.42, 0.50, 0.58, 1.00 });
            @as(MsgSetObj, @ptrCast(&objc_msgSend))(layer, sel_registerName("setMask:") orelse return, mask);
        }
        const live_mask = mask orelse return;
        const MsgFrame = *const fn (?*anyopaque, ?*anyopaque, NSRect) callconv(.c) void;
        const MsgPoint = *const fn (?*anyopaque, ?*anyopaque, NSPoint) callconv(.c) void;
        // CAGradientLayer defaults to top-to-bottom. Pin its unit-space
        // vector on every update so a reused mask remains left-to-right.
        @as(MsgPoint, @ptrCast(&objc_msgSend))(live_mask, sel_registerName("setStartPoint:") orelse return, .{ .x = 0, .y = 0.5 });
        @as(MsgPoint, @ptrCast(&objc_msgSend))(live_mask, sel_registerName("setEndPoint:") orelse return, .{ .x = 1, .y = 0.5 });
        @as(MsgFrame, @ptrCast(&objc_msgSend))(live_mask, sel_registerName("setFrame:") orelse return, .{ .x = 0, .y = 0, .width = snapshot.glass.w, .height = snapshot.glass.h });
        const MsgGetObj = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        if (@as(MsgGetObj, @ptrCast(&objc_msgSend))(live_mask, sel_registerName("animationForKey:") orelse return, animation_key) != null) return;

        const animation_class = objc_getClass("CABasicAnimation") orelse return;
        const animation = @as(MsgGetObj, @ptrCast(&objc_msgSend))(
            animation_class,
            sel_registerName("animationWithKeyPath:") orelse return,
            nsString("locations"),
        ) orelse return;
        // The bright core is roughly 16% of the message width. A single mask
        // spans both lines, so all visible busy cards retain the same subtle
        // left-to-right activity cue without multiplying layer work.
        const from_locations = numberArray(&.{ -0.16, -0.08, 0.00, 0.08, 0.16 }) orelse return;
        const to_locations = numberArray(&.{ 0.84, 0.92, 1.00, 1.08, 1.16 }) orelse return;
        @as(MsgSetObj, @ptrCast(&objc_msgSend))(animation, sel_registerName("setFromValue:") orelse return, from_locations);
        @as(MsgSetObj, @ptrCast(&objc_msgSend))(animation, sel_registerName("setToValue:") orelse return, to_locations);
        const MsgDouble = *const fn (?*anyopaque, ?*anyopaque, f64) callconv(.c) void;
        const MsgFloat = *const fn (?*anyopaque, ?*anyopaque, f32) callconv(.c) void;
        @as(MsgDouble, @ptrCast(&objc_msgSend))(animation, sel_registerName("setDuration:") orelse return, 3.2);
        // Give each retained card a stable compositor-owned phase so a stack
        // does not scan in lockstep. This never requires an app redraw.
        const phase = @as(f64, @floatFromInt((snapshot.glass.identity >> 8) % 997)) / 997.0;
        @as(MsgDouble, @ptrCast(&objc_msgSend))(animation, sel_registerName("setTimeOffset:") orelse return, phase * 3.2);
        @as(MsgFloat, @ptrCast(&objc_msgSend))(animation, sel_registerName("setRepeatCount:") orelse return, 1_000_000);
        const timing_class = objc_getClass("CAMediaTimingFunction") orelse return;
        const timing = @as(MsgGetObj, @ptrCast(&objc_msgSend))(
            timing_class,
            sel_registerName("functionWithName:") orelse return,
            nsString("linear"),
        );
        if (timing != null)
            @as(MsgSetObj, @ptrCast(&objc_msgSend))(animation, sel_registerName("setTimingFunction:") orelse return, timing);
        const MsgSetObj2 = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void;
        @as(MsgSetObj2, @ptrCast(&objc_msgSend))(live_mask, sel_registerName("addAnimation:forKey:") orelse return, animation, animation_key);
    }

    fn applyStatusBreath(image_view: ?*anyopaque, active: bool) void {
        const view = image_view orelse return;
        const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const layer = @as(MsgObj, @ptrCast(&objc_msgSend))(view, sel_registerName("layer") orelse return) orelse return;
        const key = nsString("petdex.attention-breath") orelse return;
        const MsgSetObj = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void;
        if (!active) {
            @as(MsgSetObj, @ptrCast(&objc_msgSend))(layer, sel_registerName("removeAnimationForKey:") orelse return, key);
            return;
        }
        const MsgGetObj = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        if (@as(MsgGetObj, @ptrCast(&objc_msgSend))(layer, sel_registerName("animationForKey:") orelse return, key) != null) return;

        const animation_class = objc_getClass("CABasicAnimation") orelse return;
        const animation = @as(MsgGetObj, @ptrCast(&objc_msgSend))(
            animation_class,
            sel_registerName("animationWithKeyPath:") orelse return,
            nsString("opacity"),
        ) orelse return;
        const number_class = objc_getClass("NSNumber") orelse return;
        const MsgNumber = *const fn (?*anyopaque, ?*anyopaque, f64) callconv(.c) ?*anyopaque;
        const low = @as(MsgNumber, @ptrCast(&objc_msgSend))(number_class, sel_registerName("numberWithDouble:") orelse return, 0.72);
        const high = @as(MsgNumber, @ptrCast(&objc_msgSend))(number_class, sel_registerName("numberWithDouble:") orelse return, 0.96);
        @as(MsgSetObj, @ptrCast(&objc_msgSend))(animation, sel_registerName("setFromValue:") orelse return, low);
        @as(MsgSetObj, @ptrCast(&objc_msgSend))(animation, sel_registerName("setToValue:") orelse return, high);
        const MsgDouble = *const fn (?*anyopaque, ?*anyopaque, f64) callconv(.c) void;
        const MsgFloat = *const fn (?*anyopaque, ?*anyopaque, f32) callconv(.c) void;
        const MsgBool = *const fn (?*anyopaque, ?*anyopaque, bool) callconv(.c) void;
        @as(MsgDouble, @ptrCast(&objc_msgSend))(animation, sel_registerName("setDuration:") orelse return, 0.9);
        @as(MsgFloat, @ptrCast(&objc_msgSend))(animation, sel_registerName("setRepeatCount:") orelse return, 1_000_000);
        @as(MsgBool, @ptrCast(&objc_msgSend))(animation, sel_registerName("setAutoreverses:") orelse return, true);
        const MsgSetObj2 = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void;
        @as(MsgSetObj2, @ptrCast(&objc_msgSend))(layer, sel_registerName("addAnimation:forKey:") orelse return, animation, key);
    }

    /// Fade only the foreground under a hovered action rail. The glass card
    /// itself remains one continuous native surface; no rectangular blur or
    /// opaque chip is introduced behind the buttons.
    fn applyActionFade(views: *BubbleNativeCardViews, snapshot: *const BubbleNativeCardSnapshot) void {
        const foreground = views.foreground orelse return;
        const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const layer = @as(MsgObj, @ptrCast(&objc_msgSend))(foreground, sel_registerName("layer") orelse return) orelse return;
        const MsgSetObj = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void;
        const MsgFrame = *const fn (?*anyopaque, ?*anyopaque, NSRect) callconv(.c) void;
        if (snapshot.action_fade_alpha <= 0.001 or snapshot.action_fade_start <= 0 or snapshot.glass.w <= 0) {
            @as(MsgSetObj, @ptrCast(&objc_msgSend))(layer, sel_registerName("setMask:") orelse return, null);
            return;
        }
        var mask = @as(MsgObj, @ptrCast(&objc_msgSend))(layer, sel_registerName("mask") orelse return);
        if (mask == null) {
            const solid = colorCg(colorWithAlpha(systemColor("whiteColor"), 1));
            const clear = colorCg(colorWithAlpha(systemColor("whiteColor"), 0));
            mask = gradientMask(&.{ solid, solid, clear }, &.{ 0, 0.78, 1 });
            const live = mask orelse return;
            const MsgPoint = *const fn (?*anyopaque, ?*anyopaque, NSPoint) callconv(.c) void;
            @as(MsgPoint, @ptrCast(&objc_msgSend))(live, sel_registerName("setStartPoint:") orelse return, .{ .x = 0, .y = 0.5 });
            @as(MsgPoint, @ptrCast(&objc_msgSend))(live, sel_registerName("setEndPoint:") orelse return, .{ .x = 1, .y = 0.5 });
            @as(MsgSetObj, @ptrCast(&objc_msgSend))(layer, sel_registerName("setMask:") orelse return, live);
        }
        const live_mask = mask orelse return;
        const start = std.math.clamp(@as(f64, snapshot.action_fade_start) / @as(f64, snapshot.glass.w), 0.35, 0.92);
        const locations = numberArray(&.{ 0, start, 1 }) orelse return;
        @as(MsgSetObj, @ptrCast(&objc_msgSend))(live_mask, sel_registerName("setLocations:") orelse return, locations);
        @as(MsgFrame, @ptrCast(&objc_msgSend))(live_mask, sel_registerName("setFrame:") orelse return, .{ .x = 0, .y = 0, .width = snapshot.glass.w, .height = snapshot.glass.h });
    }

    fn applyNativeCardContent(views: *BubbleNativeCardViews, snapshot: *const BubbleNativeCardSnapshot) void {
        const content = views.content orelse return;
        const height: f64 = snapshot.glass.h;
        const width: f64 = snapshot.glass.w;
        const MsgFrame = *const fn (?*anyopaque, ?*anyopaque, NSRect) callconv(.c) void;
        const MsgFloat = *const fn (?*anyopaque, ?*anyopaque, f64) callconv(.c) void;
        const MsgBool = *const fn (?*anyopaque, ?*anyopaque, bool) callconv(.c) void;
        const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const MsgSetObj = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void;
        @as(MsgFrame, @ptrCast(&objc_msgSend))(content, sel_registerName("setFrame:") orelse return, .{ .x = 0, .y = 0, .width = width, .height = height });
        @as(MsgFloat, @ptrCast(&objc_msgSend))(content, sel_registerName("setAlphaValue:") orelse return, std.math.clamp(snapshot.content_alpha, 0, 1));
        @as(MsgBool, @ptrCast(&objc_msgSend))(content, sel_registerName("setHidden:") orelse return, snapshot.content_alpha <= 0.001);

        if (views.foreground) |foreground|
            @as(MsgFrame, @ptrCast(&objc_msgSend))(foreground, sel_registerName("setFrame:") orelse return, .{ .x = 0, .y = 0, .width = width, .height = height });
        if (views.message_host) |message_host|
            @as(MsgFrame, @ptrCast(&objc_msgSend))(message_host, sel_registerName("setFrame:") orelse return, .{ .x = 0, .y = 0, .width = width, .height = height });

        if (views.substrate) |substrate| {
            @as(MsgFrame, @ptrCast(&objc_msgSend))(substrate, sel_registerName("setFrame:") orelse return, .{ .x = 0, .y = 0, .width = width, .height = height });
            if (@as(MsgObj, @ptrCast(&objc_msgSend))(substrate, sel_registerName("layer") orelse return)) |layer| {
                const inactive_boost: f64 = if (applicationIsActive()) 0 else 0.055;
                const contrast_boost: f64 = if (snapshot.glass.high_contrast or accessibilityDisplayFlag("accessibilityDisplayShouldIncreaseContrast")) 0.055 else 0;
                const transparency_boost: f64 = if (accessibilityDisplayFlag("accessibilityDisplayShouldReduceTransparency")) 0.10 else 0;
                const base: f64 = if (snapshot.glass.dark_appearance) 0.04 else 0.025;
                const alpha = @min(0.30, base + inactive_boost + contrast_boost + transparency_boost);
                const substrate_color = colorWithAlpha(systemColor("blackColor"), alpha);
                @as(MsgSetObj, @ptrCast(&objc_msgSend))(layer, sel_registerName("setBackgroundColor:") orelse return, colorCg(substrate_color));
                @as(MsgFloat, @ptrCast(&objc_msgSend))(layer, sel_registerName("setCornerRadius:") orelse return, snapshot.glass.corner_radius);
                @as(MsgBool, @ptrCast(&objc_msgSend))(layer, sel_registerName("setMasksToBounds:") orelse return, true);
            }
        }

        const new_metadata_signature = metadataSignature(snapshot);
        const metadata_changed = !views.metadata_initialized or views.metadata_signature != new_metadata_signature;
        const left_metadata = if (metadata_changed) nativeMetadataAttributedString(snapshot) else null;
        setNativeAttributedMetadataLabel(
            views.metadata_left_label,
            left_metadata,
            snapshot.metadata_left_frame,
            height,
            snapshot.metadata_alpha,
            snapshot.agent.len > 0 or snapshot.hostname.len > 0,
            false,
        );
        setNativeAttributedMetadataLabel(
            views.metadata_right_label,
            null,
            snapshot.metadata_right_frame,
            height,
            snapshot.metadata_alpha,
            false,
            false,
        );
        if (metadata_changed) {
            views.metadata_signature = new_metadata_signature;
            views.metadata_initialized = true;
        }
        setNativeLabel(views.title_label, &snapshot.title, snapshot.title_frame, height, snapshot.title_font_size, 0.23, "labelColor", 1);

        const status_symbol: ?[*:0]const u8 = switch (snapshot.glass.semantic_state) {
            .completed => "checkmark.circle",
            .needs_input => "questionmark.message",
            .failed => "exclamationmark.triangle",
            .running, .idle => null,
        };
        if (status_symbol) |symbol| {
            const status_color: [*:0]const u8 = switch (snapshot.glass.semantic_state) {
                .completed => "systemGreenColor",
                .needs_input => "systemOrangeColor",
                .failed => "systemRedColor",
                .running => "systemBlueColor",
                .idle => "secondaryLabelColor",
            };
            setNativeImage(views.status_icon, symbol, "Session status", snapshot.status_frame, height, status_color, 1);
            applyStatusBreath(views.status_icon, snapshot.glass.semantic_state == .needs_input and !snapshot.reduce_motion);
        } else {
            setNativeImage(views.status_icon, "circle", "Session status", .{}, height, "secondaryLabelColor", 0);
            applyStatusBreath(views.status_icon, false);
        }

        for (0..bubble_native_message_lines) |row| {
            const alpha: f32 = if (row < snapshot.message_line_count) 1 else 0;
            setNativeLabel(views.message_labels[row], &snapshot.message_lines[row], snapshot.message_frames[row], height, snapshot.message_font_size, 0, "secondaryLabelColor", alpha);
        }
        applyMessageShimmer(views, snapshot);
        for (0..bubble_native_nested_lines) |row| {
            const alpha: f32 = if (row < snapshot.nested_line_count) snapshot.nested_alpha else 0;
            setNativeLabel(views.nested_labels[row], &snapshot.nested_lines[row], snapshot.nested_frames[row], height, snapshot.nested_font_size, 0, "tertiaryLabelColor", alpha);
        }

        applyActionFade(views, snapshot);
    }

    const BubbleControlPanelSnapshot = struct {
        valid: bool = false,
        frame: NSRect = .{ .x = 0, .y = 0, .width = 1, .height = 1 },
    };

    fn ensureControlPanel(panel: *?*anyopaque, host: *?*anyopaque, activity: ?*anyopaque) ?*anyopaque {
        if (panel.*) |existing| return existing;
        const panel_class = bubbleControlPanelClass() orelse return null;
        const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const allocated = @as(MsgObj, @ptrCast(&objc_msgSend))(panel_class, sel_registerName("alloc") orelse return null) orelse return null;
        const MsgInitPanel = *const fn (?*anyopaque, ?*anyopaque, NSRect, usize, isize, bool) callconv(.c) ?*anyopaque;
        const created = @as(MsgInitPanel, @ptrCast(&objc_msgSend))(
            allocated,
            sel_registerName("initWithContentRect:styleMask:backing:defer:") orelse return null,
            .{ .x = 0, .y = 0, .width = 1, .height = 1 },
            1 << 7, // NSWindowStyleMaskNonactivatingPanel
            2, // NSBackingStoreBuffered
            false,
        ) orelse return null;
        panel.* = created;
        host.* = @as(MsgObj, @ptrCast(&objc_msgSend))(created, sel_registerName("contentView") orelse return null);
        const MsgBool = *const fn (?*anyopaque, ?*anyopaque, bool) callconv(.c) void;
        const MsgSetObj = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void;
        const MsgInt = *const fn (?*anyopaque, ?*anyopaque, isize) callconv(.c) void;
        @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setReleasedWhenClosed:") orelse return null, false);
        @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setOpaque:") orelse return null, false);
        @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setHasShadow:") orelse return null, false);
        @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setHidesOnDeactivate:") orelse return null, false);
        @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setFloatingPanel:") orelse return null, true);
        @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setBecomesKeyOnlyIfNeeded:") orelse return null, false);
        @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setIgnoresMouseEvents:") orelse return null, false);
        @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setExcludedFromWindowsMenu:") orelse return null, true);
        @as(MsgSetObj, @ptrCast(&objc_msgSend))(created, sel_registerName("setBackgroundColor:") orelse return null, systemColor("clearColor"));
        if (activity) |window| {
            const MsgGetInt = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) isize;
            const level = @as(MsgGetInt, @ptrCast(&objc_msgSend))(window, sel_registerName("level") orelse return null);
            // Card hit panels sit one level over the click-through activity
            // window. Controls stay above those panels so their first-click,
            // hover and pressed behavior always wins over card dragging.
            @as(MsgInt, @ptrCast(&objc_msgSend))(created, sel_registerName("setLevel:") orelse return null, level + 2);
            const behavior = @as(MsgGetInt, @ptrCast(&objc_msgSend))(window, sel_registerName("collectionBehavior") orelse return null);
            @as(MsgInt, @ptrCast(&objc_msgSend))(created, sel_registerName("setCollectionBehavior:") orelse return null, behavior);
        }
        return created;
    }

    fn ensureCardPanel(slot: usize, activity: ?*anyopaque) ?*anyopaque {
        if (slot >= bubble_card_panels.len) return null;
        if (bubble_card_panels[slot]) |existing| return existing;
        const panel_class = bubbleControlPanelClass() orelse return null;
        const view_class = bubbleCardHitViewClass() orelse return null;
        const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const allocated = @as(MsgObj, @ptrCast(&objc_msgSend))(panel_class, sel_registerName("alloc") orelse return null) orelse return null;
        const MsgInitPanel = *const fn (?*anyopaque, ?*anyopaque, NSRect, usize, isize, bool) callconv(.c) ?*anyopaque;
        const created = @as(MsgInitPanel, @ptrCast(&objc_msgSend))(
            allocated,
            sel_registerName("initWithContentRect:styleMask:backing:defer:") orelse return null,
            .{ .x = 0, .y = 0, .width = 1, .height = 1 },
            1 << 7, // NSWindowStyleMaskNonactivatingPanel
            2, // NSBackingStoreBuffered
            false,
        ) orelse return null;
        const MsgInitView = *const fn (?*anyopaque, ?*anyopaque, NSRect) callconv(.c) ?*anyopaque;
        const view_allocated = @as(MsgObj, @ptrCast(&objc_msgSend))(view_class, sel_registerName("alloc") orelse return null) orelse return null;
        const host = @as(MsgInitView, @ptrCast(&objc_msgSend))(view_allocated, sel_registerName("initWithFrame:") orelse return null, .{
            .x = 0,
            .y = 0,
            .width = 1,
            .height = 1,
        }) orelse return null;
        bubble_card_panels[slot] = created;
        bubble_card_panel_hosts[slot] = host;
        const MsgBool = *const fn (?*anyopaque, ?*anyopaque, bool) callconv(.c) void;
        const MsgSetObj = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void;
        const MsgInt = *const fn (?*anyopaque, ?*anyopaque, isize) callconv(.c) void;
        @as(MsgSetObj, @ptrCast(&objc_msgSend))(created, sel_registerName("setContentView:") orelse return null, host);
        @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setReleasedWhenClosed:") orelse return null, false);
        @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setOpaque:") orelse return null, false);
        @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setHasShadow:") orelse return null, false);
        @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setHidesOnDeactivate:") orelse return null, false);
        @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setFloatingPanel:") orelse return null, true);
        @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setBecomesKeyOnlyIfNeeded:") orelse return null, false);
        @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setIgnoresMouseEvents:") orelse return null, false);
        @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setExcludedFromWindowsMenu:") orelse return null, true);
        @as(MsgSetObj, @ptrCast(&objc_msgSend))(created, sel_registerName("setBackgroundColor:") orelse return null, systemColor("clearColor"));
        @as(MsgBool, @ptrCast(&objc_msgSend))(host, sel_registerName("setAccessibilityElement:") orelse return null, true);
        @as(MsgSetObj, @ptrCast(&objc_msgSend))(host, sel_registerName("setAccessibilityRole:") orelse return null, nsString("AXButton"));
        @as(MsgSetObj, @ptrCast(&objc_msgSend))(host, sel_registerName("setAccessibilityHelp:") orelse return null, nsString("Press to open this agent session; drag to move Petdex."));
        if (activity) |window| {
            const MsgGetInt = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) isize;
            const level = @as(MsgGetInt, @ptrCast(&objc_msgSend))(window, sel_registerName("level") orelse return null);
            @as(MsgInt, @ptrCast(&objc_msgSend))(created, sel_registerName("setLevel:") orelse return null, level + 1);
            const behavior = @as(MsgGetInt, @ptrCast(&objc_msgSend))(window, sel_registerName("collectionBehavior") orelse return null);
            @as(MsgInt, @ptrCast(&objc_msgSend))(created, sel_registerName("setCollectionBehavior:") orelse return null, behavior);
        }
        return created;
    }

    fn cardGlobalFrame(activity_frame: NSRect, glass: BubbleGlassRect) NSRect {
        return .{
            .x = activity_frame.x + @as(f64, glass.x),
            .y = activity_frame.y + activity_frame.height - @as(f64, glass.y + glass.h),
            .width = @as(f64, glass.w),
            .height = @as(f64, glass.h),
        };
    }

    fn applyBubbleCardPanels(request: *const BubbleGlassRequest, activity: ?*anyopaque) void {
        const window = activity orelse return;
        const MsgRect = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) NSRect;
        const activity_frame = @as(MsgRect, @ptrCast(&objc_msgSend))(window, sel_registerName("frame") orelse return);
        var card_slots: [max_bubble_native_cards]?usize = @splat(null);
        var slot_active: [max_bubble_native_cards]bool = @splat(false);
        for (request.cards[0..request.card_count], 0..) |card, card_index| {
            const glass = card.glass;
            if (glass.identity == 0 or glass.materialization == .hidden or glass.alpha <= 0.001 or glass.w <= 0 or glass.h <= 0) continue;
            var selected: ?usize = null;
            for (bubble_card_panel_identities, 0..) |identity, slot| {
                if (!slot_active[slot] and identity == glass.identity) {
                    selected = slot;
                    break;
                }
            }
            if (selected == null) for (bubble_card_panel_identities, 0..) |identity, slot| {
                if (!slot_active[slot] and identity == 0) {
                    selected = slot;
                    break;
                }
            };
            if (selected == null) for (slot_active, 0..) |active, slot| {
                if (!active) {
                    selected = slot;
                    break;
                }
            };
            const slot = selected orelse continue;
            slot_active[slot] = true;
            card_slots[slot] = card_index;
        }
        const MsgWindowFrame = *const fn (?*anyopaque, ?*anyopaque, NSRect, bool) callconv(.c) void;
        const MsgVoid = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) void;
        const MsgObjectArg = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void;
        for (0..max_bubble_native_cards) |slot| {
            const card_index = card_slots[slot] orelse {
                if (bubble_card_panel_visible[slot]) {
                    if (bubble_card_panels[slot]) |panel|
                        @as(MsgObjectArg, @ptrCast(&objc_msgSend))(panel, sel_registerName("orderOut:") orelse return, null);
                }
                bubble_card_panel_visible[slot] = false;
                bubble_card_panel_frame_valid[slot] = false;
                bubble_card_panel_identities[slot] = 0;
                continue;
            };
            const card = request.cards[card_index];
            const panel = ensureCardPanel(slot, window) orelse continue;
            bubble_card_panel_identities[slot] = card.glass.identity;
            if (bubble_card_panel_hosts[slot]) |host| {
                const label = nsStringAccessibilityText(&card.accessibility_label) orelse nsString("Agent session");
                const value = nsStringAccessibilityText(&card.accessibility_value) orelse nsString("");
                @as(MsgObjectArg, @ptrCast(&objc_msgSend))(host, sel_registerName("setAccessibilityLabel:") orelse return, label);
                @as(MsgObjectArg, @ptrCast(&objc_msgSend))(host, sel_registerName("setAccessibilityValue:") orelse return, value);
                @as(MsgObjectArg, @ptrCast(&objc_msgSend))(host, sel_registerName("setAccessibilityRole:") orelse return, nsString(if (card.action_available) "AXButton" else "AXGroup"));
                const MsgBool = *const fn (?*anyopaque, ?*anyopaque, bool) callconv(.c) void;
                const enabled_sel = sel_registerName("setAccessibilityEnabled:") orelse return;
                if (respondsToSelector(host, enabled_sel))
                    @as(MsgBool, @ptrCast(&objc_msgSend))(host, enabled_sel, card.action_available);
            }
            const frame = cardGlobalFrame(activity_frame, card.glass);
            if (!bubble_card_panel_frame_valid[slot] or bubbleControlPanelFrameChanged(bubble_card_panel_frames[slot], frame)) {
                @as(MsgWindowFrame, @ptrCast(&objc_msgSend))(panel, sel_registerName("setFrame:display:") orelse return, frame, false);
                bubble_card_panel_frames[slot] = frame;
                bubble_card_panel_frame_valid[slot] = true;
            }
            if (!bubble_card_panel_visible[slot]) {
                @as(MsgVoid, @ptrCast(&objc_msgSend))(panel, sel_registerName("orderFrontRegardless") orelse return);
                bubble_card_panel_visible[slot] = true;
            }
        }
    }

    fn controlGlobalFrame(activity_frame: NSRect, control: BubbleNativeControl) NSRect {
        const inset: f64 = @max(0, control.activation_inset);
        return .{
            .x = activity_frame.x + @as(f64, control.x) - inset,
            .y = activity_frame.y + activity_frame.height - @as(f64, control.y + control.h) - inset,
            .width = @as(f64, control.w) + inset * 2,
            .height = @as(f64, control.h) + inset * 2,
        };
    }

    fn controlPanelSnapshot(request: *const BubbleGlassRequest, activity_frame: NSRect, overlay: bool) BubbleControlPanelSnapshot {
        var result: BubbleControlPanelSnapshot = .{};
        var right: f64 = 0;
        var top: f64 = 0;
        for (request.controls[0..request.control_count]) |control| {
            if (control.overlay != overlay or control.presentation_alpha <= 0.001) continue;
            const frame = controlGlobalFrame(activity_frame, control);
            if (!result.valid) {
                result.valid = true;
                result.frame = frame;
                right = frame.x + frame.width;
                top = frame.y + frame.height;
            } else {
                const left = @min(result.frame.x, frame.x);
                const bottom = @min(result.frame.y, frame.y);
                right = @max(right, frame.x + frame.width);
                top = @max(top, frame.y + frame.height);
                result.frame = .{ .x = left, .y = bottom, .width = right - left, .height = top - bottom };
            }
        }
        return result;
    }

    fn bubbleControlPanelFrameChanged(previous: NSRect, next: NSRect) bool {
        const epsilon: f64 = 0.125;
        return @abs(previous.x - next.x) > epsilon or
            @abs(previous.y - next.y) > epsilon or
            @abs(previous.width - next.width) > epsilon or
            @abs(previous.height - next.height) > epsilon;
    }

    fn applyBubbleControlPanelPresentation(
        panel: ?*anyopaque,
        snapshot: BubbleControlPanelSnapshot,
        visible: *bool,
        last_frame: *NSRect,
        frame_valid: *bool,
    ) void {
        const window = panel orelse {
            visible.* = false;
            frame_valid.* = false;
            return;
        };
        const transition = bubbleControlPanelTransition(visible.*, snapshot.valid);
        if (snapshot.valid and (!frame_valid.* or bubbleControlPanelFrameChanged(last_frame.*, snapshot.frame))) {
            const MsgWindowFrame = *const fn (?*anyopaque, ?*anyopaque, NSRect, bool) callconv(.c) void;
            @as(MsgWindowFrame, @ptrCast(&objc_msgSend))(window, sel_registerName("setFrame:display:") orelse return, snapshot.frame, false);
            last_frame.* = snapshot.frame;
            frame_valid.* = true;
        }
        switch (transition) {
            .unchanged => {},
            .show => {
                const MsgVoid = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) void;
                @as(MsgVoid, @ptrCast(&objc_msgSend))(window, sel_registerName("orderFrontRegardless") orelse return);
                visible.* = true;
            },
            .hide => {
                const MsgObjectArg = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void;
                @as(MsgObjectArg, @ptrCast(&objc_msgSend))(window, sel_registerName("orderOut:") orelse return, null);
                visible.* = false;
                frame_valid.* = false;
            },
        }
    }

    fn applyBubbleControlPanels(request: *const BubbleGlassRequest, activity: ?*anyopaque) void {
        const window = activity orelse return;
        const MsgVoid = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) void;
        const MsgRect = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) NSRect;
        const activity_frame = @as(MsgRect, @ptrCast(&objc_msgSend))(window, sel_registerName("frame") orelse return);

        const disclosure_snapshot = controlPanelSnapshot(request, activity_frame, false);
        const action_snapshot = controlPanelSnapshot(request, activity_frame, true);
        // Dematerialize a panel once, before its buttons change. Re-ordering
        // every presentation frame synchronously flushes WindowServer and
        // starves the main thread while shimmer or spring motion is active.
        if (!disclosure_snapshot.valid)
            applyBubbleControlPanelPresentation(bubble_disclosure_panel, disclosure_snapshot, &bubble_disclosure_panel_visible, &bubble_disclosure_panel_frame, &bubble_disclosure_panel_frame_valid);
        if (!action_snapshot.valid)
            applyBubbleControlPanelPresentation(bubble_action_panel, action_snapshot, &bubble_action_panel_visible, &bubble_action_panel_frame, &bubble_action_panel_frame_valid);
        if (disclosure_snapshot.valid)
            _ = ensureControlPanel(&bubble_disclosure_panel, &bubble_disclosure_panel_host, window);
        if (action_snapshot.valid)
            _ = ensureControlPanel(&bubble_action_panel, &bubble_action_panel_host, window);

        var control_slots: [max_bubble_native_controls]?usize = @splat(null);
        var control_slot_active: [max_bubble_native_controls]bool = @splat(false);
        for (request.controls[0..request.control_count], 0..) |control, request_index| {
            if (control.presentation_alpha <= 0.001) continue;
            const key = control.identity ^ (@as(u64, @intFromEnum(control.action)) +% 0xd6e8feb86659fd93);
            var selected_slot: ?usize = null;
            for (bubble_control_button_keys, 0..) |existing, slot| {
                if (!control_slot_active[slot] and existing == key) {
                    selected_slot = slot;
                    break;
                }
            }
            if (selected_slot == null) {
                for (bubble_control_button_keys, 0..) |existing, slot| {
                    if (!control_slot_active[slot] and existing == 0) {
                        selected_slot = slot;
                        break;
                    }
                }
            }
            if (selected_slot == null) {
                for (control_slot_active, 0..) |active, slot| if (!active) {
                    selected_slot = slot;
                    break;
                };
            }
            const slot = selected_slot orelse continue;
            bubble_control_button_keys[slot] = key;
            control_slot_active[slot] = true;
            control_slots[slot] = request_index;
        }

        const action_sel = registerBubbleControlAction() orelse return;
        const control_target = bubble_control_target orelse return;
        const button_class = bubbleControlButtonClass() orelse return;
        const image_class = objc_getClass("NSImage") orelse return;
        const MsgImage = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const MsgButton = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const MsgInitFrame = *const fn (?*anyopaque, ?*anyopaque, NSRect) callconv(.c) ?*anyopaque;
        const MsgSetObj = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void;
        const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const MsgBool = *const fn (?*anyopaque, ?*anyopaque, bool) callconv(.c) void;
        const MsgInt = *const fn (?*anyopaque, ?*anyopaque, isize) callconv(.c) void;
        const MsgFloat = *const fn (?*anyopaque, ?*anyopaque, f64) callconv(.c) void;
        const MsgFrame = *const fn (?*anyopaque, ?*anyopaque, NSRect) callconv(.c) void;
        const MsgAdd = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque, isize, ?*anyopaque) callconv(.c) void;
        const MsgTagSet = *const fn (?*anyopaque, ?*anyopaque, isize) callconv(.c) void;
        const hidden_sel = sel_registerName("setHidden:") orelse return;
        const symbol_sel = sel_registerName("imageWithSystemSymbolName:accessibilityDescription:") orelse return;

        for (0..max_bubble_native_controls) |slot| {
            const request_index = control_slots[slot] orelse {
                if (bubble_control_buttons[slot]) |button| @as(MsgBool, @ptrCast(&objc_msgSend))(button, hidden_sel, true);
                if (bubble_control_material_views[slot]) |material| @as(MsgBool, @ptrCast(&objc_msgSend))(material, hidden_sel, true);
                if (bubble_control_hit_buttons[slot]) |button| @as(MsgBool, @ptrCast(&objc_msgSend))(button, hidden_sel, true);
                continue;
            };
            const control = request.controls[request_index];
            const panel_snapshot = if (control.overlay) action_snapshot else disclosure_snapshot;
            const host = if (control.overlay) bubble_action_panel_host else bubble_disclosure_panel_host;
            const parent = host orelse continue;
            const label = nsStringAccessibilityText(&control.accessibility_label) orelse nsString(controlLabel(control)) orelse continue;
            const accessibility_value = nsStringAccessibilityText(&control.accessibility_value) orelse nsString("");
            const symbol = nsString(controlSymbol(control)) orelse continue;
            const image = @as(MsgImage, @ptrCast(&objc_msgSend))(image_class, symbol_sel, symbol, label) orelse continue;
            var button = bubble_control_buttons[slot];
            if (button == null) {
                button = @as(MsgButton, @ptrCast(&objc_msgSend))(button_class, sel_registerName("buttonWithImage:target:action:") orelse return, image, control_target, action_sel);
                const created = button orelse continue;
                // buttonWithImage: is autoreleased; the bounded native cache
                // must own its entries independently of temporary superviews.
                _ = @as(MsgObj, @ptrCast(&objc_msgSend))(created, sel_registerName("retain") orelse return);
                bubble_control_buttons[slot] = created;
                @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setRefusesFirstResponder:") orelse return, true);
                @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setAccessibilityElement:") orelse return, false);
                @as(MsgInt, @ptrCast(&objc_msgSend))(created, sel_registerName("setFocusRingType:") orelse return, 1);
            }
            const native_button = button orelse continue;
            var material_view = bubble_control_material_views[slot];
            if (material_view == null) {
                const material_class = objc_getClass("NSGlassEffectView") orelse objc_getClass("NSVisualEffectView") orelse continue;
                const allocated_material = @as(MsgObj, @ptrCast(&objc_msgSend))(material_class, sel_registerName("alloc") orelse return) orelse continue;
                material_view = @as(MsgInitFrame, @ptrCast(&objc_msgSend))(allocated_material, sel_registerName("initWithFrame:") orelse return, .{ .x = 0, .y = 0, .width = 1, .height = 1 });
                const created = material_view orelse continue;
                _ = @as(MsgObj, @ptrCast(&objc_msgSend))(created, sel_registerName("retain") orelse return);
                bubble_control_material_views[slot] = created;
                @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setWantsLayer:") orelse return, true);
                @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setAccessibilityElement:") orelse return, false);
                if (objc_getClass("NSGlassEffectView") == null) {
                    @as(MsgInt, @ptrCast(&objc_msgSend))(created, sel_registerName("setMaterial:") orelse return, 6);
                    @as(MsgInt, @ptrCast(&objc_msgSend))(created, sel_registerName("setBlendingMode:") orelse return, 0);
                    @as(MsgInt, @ptrCast(&objc_msgSend))(created, sel_registerName("setState:") orelse return, 1);
                }
            }
            const native_material = material_view orelse continue;
            var hit_button = bubble_control_hit_buttons[slot];
            if (hit_button == null) {
                const allocated_hit = @as(MsgObj, @ptrCast(&objc_msgSend))(button_class, sel_registerName("alloc") orelse return) orelse continue;
                hit_button = @as(MsgInitFrame, @ptrCast(&objc_msgSend))(allocated_hit, sel_registerName("initWithFrame:") orelse return, .{ .x = 0, .y = 0, .width = 1, .height = 1 });
                const created = hit_button orelse continue;
                _ = @as(MsgObj, @ptrCast(&objc_msgSend))(created, sel_registerName("retain") orelse return);
                bubble_control_hit_buttons[slot] = created;
                @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setAccessibilityElement:") orelse return, true);
                @as(MsgSetObj, @ptrCast(&objc_msgSend))(created, sel_registerName("setTarget:") orelse return, control_target);
                @as(MsgSetObj, @ptrCast(&objc_msgSend))(created, sel_registerName("setAction:") orelse return, action_sel);
                // The transparent 40pt hit target is the authoritative
                // control for both AX and keyboard traversal. It must accept
                // first responder even though the decorative glass button
                // above it deliberately does not.
                @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setRefusesFirstResponder:") orelse return, false);
                @as(MsgInt, @ptrCast(&objc_msgSend))(created, sel_registerName("setFocusRingType:") orelse return, 1);
                @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setBordered:") orelse return, false);
                @as(MsgSetObj, @ptrCast(&objc_msgSend))(created, sel_registerName("setTitle:") orelse return, nsString(""));
                @as(MsgSetObj, @ptrCast(&objc_msgSend))(created, sel_registerName("setImage:") orelse return, null);
            }
            const native_hit = hit_button orelse continue;
            const native_superview = @as(MsgObj, @ptrCast(&objc_msgSend))(native_button, sel_registerName("superview") orelse return);
            if (native_superview != parent) {
                @as(MsgVoid, @ptrCast(&objc_msgSend))(native_button, sel_registerName("removeFromSuperview") orelse return);
                addSubview(parent, native_button);
            }
            const material_superview = @as(MsgObj, @ptrCast(&objc_msgSend))(native_material, sel_registerName("superview") orelse return);
            if (material_superview != parent) {
                @as(MsgVoid, @ptrCast(&objc_msgSend))(native_material, sel_registerName("removeFromSuperview") orelse return);
                addSubview(parent, native_material);
            }
            const hit_superview = @as(MsgObj, @ptrCast(&objc_msgSend))(native_hit, sel_registerName("superview") orelse return);
            if (hit_superview != parent) {
                @as(MsgVoid, @ptrCast(&objc_msgSend))(native_hit, sel_registerName("removeFromSuperview") orelse return);
                addSubview(parent, native_hit);
            }
            // The visible control is a native circular glass button. The
            // transparent companion keeps the full 40pt activation target
            // without enlarging the visible glass surface.
            @as(MsgBool, @ptrCast(&objc_msgSend))(native_button, sel_registerName("setBordered:") orelse return, false);
            const bezel_sel = sel_registerName("setBezelStyle:") orelse return;
            const liquid_buttons = objc_getClass("NSGlassEffectView") != null;
            @as(MsgInt, @ptrCast(&objc_msgSend))(native_button, bezel_sel, if (liquid_buttons) 16 else 7);
            const border_shape_sel = sel_registerName("setBorderShape:") orelse return;
            if (respondsToSelector(native_button, border_shape_sel))
                @as(MsgInt, @ptrCast(&objc_msgSend))(native_button, border_shape_sel, 3);
            var badge_buf: [8:0]u8 = @splat(0);
            const button_title = if (control.badge_count > 0)
                nsString(std.fmt.bufPrintZ(&badge_buf, "{d}", .{control.badge_count}) catch "")
            else
                nsString("");
            const visible_image: ?*anyopaque = if (control.action == .toggle_visibility and control.disclosure_mode == .hidden and !control.show_status_icon) null else image;
            @as(MsgSetObj, @ptrCast(&objc_msgSend))(native_button, sel_registerName("setImage:") orelse return, visible_image);
            @as(MsgSetObj, @ptrCast(&objc_msgSend))(native_button, sel_registerName("setTitle:") orelse return, button_title);
            @as(MsgInt, @ptrCast(&objc_msgSend))(native_button, sel_registerName("setImagePosition:") orelse return, if (control.badge_count > 0) 2 else 1);
            @as(MsgSetObj, @ptrCast(&objc_msgSend))(native_button, sel_registerName("setToolTip:") orelse return, label);
            @as(MsgSetObj, @ptrCast(&objc_msgSend))(native_button, sel_registerName("setAccessibilityLabel:") orelse return, label);
            @as(MsgSetObj, @ptrCast(&objc_msgSend))(native_button, sel_registerName("setAccessibilityValue:") orelse return, accessibility_value);
            @as(MsgBool, @ptrCast(&objc_msgSend))(native_button, sel_registerName("setEnabled:") orelse return, control.enabled);
            @as(MsgInt, @ptrCast(&objc_msgSend))(native_button, sel_registerName("setState:") orelse return, if (control.toggled) 1 else 0);
            const tint_selector: [*:0]const u8 = if (control.overlay)
                "labelColor"
            else switch (control.semantic_state) {
                .failed => "systemRedColor",
                .needs_input => "systemOrangeColor",
                .running => "systemBlueColor",
                .completed => "systemGreenColor",
                .idle => "labelColor",
            };
            const tint_sel = sel_registerName("setContentTintColor:");
            if (respondsToSelector(native_button, tint_sel))
                @as(MsgSetObj, @ptrCast(&objc_msgSend))(native_button, tint_sel, systemColor(tint_selector));
            @as(MsgTagSet, @ptrCast(&objc_msgSend))(native_button, sel_registerName("setTag:") orelse return, @intCast(request_index));
            @as(MsgTagSet, @ptrCast(&objc_msgSend))(native_hit, sel_registerName("setTag:") orelse return, @intCast(request_index));
            const global = controlGlobalFrame(activity_frame, control);
            const inset: f64 = @max(0, control.activation_inset);
            const visual = NSRect{
                .x = global.x + inset - panel_snapshot.frame.x,
                .y = global.y + inset - panel_snapshot.frame.y,
                .width = @as(f64, control.w),
                .height = @as(f64, control.h),
            };
            const hit = NSRect{
                .x = global.x - panel_snapshot.frame.x,
                .y = global.y - panel_snapshot.frame.y,
                .width = global.width,
                .height = global.height,
            };
            @as(MsgFrame, @ptrCast(&objc_msgSend))(native_hit, sel_registerName("setFrame:") orelse return, hit);
            @as(MsgFrame, @ptrCast(&objc_msgSend))(native_material, sel_registerName("setFrame:") orelse return, visual);
            @as(MsgFrame, @ptrCast(&objc_msgSend))(native_button, sel_registerName("setFrame:") orelse return, visual);
            // Clip the visible native button itself to its circular action
            // surface. The transparent hit view intentionally keeps the
            // larger activation inset for motor accessibility.
            @as(MsgBool, @ptrCast(&objc_msgSend))(native_button, sel_registerName("setWantsLayer:") orelse return, true);
            const button_layer = @as(MsgObj, @ptrCast(&objc_msgSend))(native_button, sel_registerName("layer") orelse return);
            if (button_layer) |layer| {
                @as(MsgFloat, @ptrCast(&objc_msgSend))(layer, sel_registerName("setCornerRadius:") orelse return, @min(visual.width, visual.height) / 2);
                @as(MsgBool, @ptrCast(&objc_msgSend))(layer, sel_registerName("setMasksToBounds:") orelse return, true);
            }
            const material_layer = @as(MsgObj, @ptrCast(&objc_msgSend))(native_material, sel_registerName("layer") orelse return);
            if (material_layer) |layer| {
                @as(MsgFloat, @ptrCast(&objc_msgSend))(layer, sel_registerName("setCornerRadius:") orelse return, @min(visual.width, visual.height) / 2);
                @as(MsgBool, @ptrCast(&objc_msgSend))(layer, sel_registerName("setMasksToBounds:") orelse return, true);
            }
            const material_corner_sel = sel_registerName("setCornerRadius:") orelse return;
            if (respondsToSelector(native_material, material_corner_sel))
                @as(MsgFloat, @ptrCast(&objc_msgSend))(native_material, material_corner_sel, @min(visual.width, visual.height) / 2);
            @as(MsgFloat, @ptrCast(&objc_msgSend))(native_material, sel_registerName("setAlphaValue:") orelse return, std.math.clamp(control.presentation_alpha, 0, 1));
            @as(MsgFloat, @ptrCast(&objc_msgSend))(native_button, sel_registerName("setAlphaValue:") orelse return, std.math.clamp(control.presentation_alpha, 0, 1));
            // A borderless, content-free NSButton remains visually clear at
            // full alpha while allowing AppKit to render a visible keyboard
            // focus ring. Near-zero alpha hid that ring from keyboard users.
            @as(MsgFloat, @ptrCast(&objc_msgSend))(native_hit, sel_registerName("setAlphaValue:") orelse return, 1);
            @as(MsgSetObj, @ptrCast(&objc_msgSend))(native_hit, sel_registerName("setAccessibilityLabel:") orelse return, label);
            @as(MsgSetObj, @ptrCast(&objc_msgSend))(native_hit, sel_registerName("setAccessibilityValue:") orelse return, accessibility_value);
            @as(MsgSetObj, @ptrCast(&objc_msgSend))(native_hit, sel_registerName("setAccessibilityRole:") orelse return, nsString(if (control.accessibility_role == .toggle_button) "AXCheckBox" else "AXButton"));
            @as(MsgBool, @ptrCast(&objc_msgSend))(native_hit, sel_registerName("setEnabled:") orelse return, control.enabled);
            @as(MsgInt, @ptrCast(&objc_msgSend))(native_hit, sel_registerName("setState:") orelse return, if (control.toggled) 1 else 0);
            const add_positioned = sel_registerName("addSubview:positioned:relativeTo:") orelse return;
            @as(MsgAdd, @ptrCast(&objc_msgSend))(parent, add_positioned, native_material, -1, native_button);
            @as(MsgAdd, @ptrCast(&objc_msgSend))(parent, add_positioned, native_hit, 1, native_button);
            @as(MsgAdd, @ptrCast(&objc_msgSend))(parent, add_positioned, native_button, 1, native_hit);
            @as(MsgBool, @ptrCast(&objc_msgSend))(native_button, hidden_sel, false);
            @as(MsgBool, @ptrCast(&objc_msgSend))(native_material, hidden_sel, false);
            @as(MsgBool, @ptrCast(&objc_msgSend))(native_hit, hidden_sel, false);
        }

        if (disclosure_snapshot.valid)
            applyBubbleControlPanelPresentation(bubble_disclosure_panel, disclosure_snapshot, &bubble_disclosure_panel_visible, &bubble_disclosure_panel_frame, &bubble_disclosure_panel_frame_valid);
        if (action_snapshot.valid)
            applyBubbleControlPanelPresentation(bubble_action_panel, action_snapshot, &bubble_action_panel_visible, &bubble_action_panel_frame, &bubble_action_panel_frame_valid);
    }

    fn applyBubbleGlass(_: ?*anyopaque) callconv(.c) void {
        var request: BubbleGlassRequest = .{};
        lockBubbleGlass();
        request = bubble_glass_request;
        bubble_glass_dispatch_scheduled = false;
        bubble_native_render_counters.appkit_applies +%= 1;
        unlockBubbleGlass();

        const window = activityWindow() orelse return;
        const MsgObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
        const root = @as(MsgObj, @ptrCast(&objc_msgSend))(window, sel_registerName("contentView") orelse return) orelse return;
        const MsgBool = *const fn (?*anyopaque, ?*anyopaque, bool) callconv(.c) void;
        const MsgInt = *const fn (?*anyopaque, ?*anyopaque, isize) callconv(.c) void;
        const MsgFloat = *const fn (?*anyopaque, ?*anyopaque, f64) callconv(.c) void;
        const MsgFrame = *const fn (?*anyopaque, ?*anyopaque, NSRect) callconv(.c) void;
        const MsgSetObj = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void;
        const MsgAdd = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque, isize, ?*anyopaque) callconv(.c) void;
        const MsgVoid = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) void;
        const MsgInit = *const fn (?*anyopaque, ?*anyopaque, NSRect) callconv(.c) ?*anyopaque;
        const alloc_sel = sel_registerName("alloc") orelse return;
        const init_sel = sel_registerName("initWithFrame:") orelse return;
        const hidden_sel = sel_registerName("setHidden:") orelse return;
        const set_frame_sel = sel_registerName("setFrame:") orelse return;
        const add_positioned_sel = sel_registerName("addSubview:positioned:relativeTo:") orelse return;

        // The SDK-managed Metal window stays permanently click-through. Tiny
        // sibling NSPanels below are the sole mouse owners.
        @as(MsgBool, @ptrCast(&objc_msgSend))(window, sel_registerName("setIgnoresMouseEvents:") orelse return, true);

        var effects: [max_bubble_glass_rects]BubbleGlassRect = @splat(.{});
        var effect_keys: [max_bubble_glass_rects]u64 = @splat(0);
        var effect_card_indices: [max_bubble_glass_rects]?usize = @splat(null);
        var effect_count: usize = 0;
        for (request.cards[0..request.card_count], 0..) |card, card_index| {
            if (card.glass.materialization == .hidden) continue;
            effects[effect_count] = card.glass;
            effect_keys[effect_count] = if (card.glass.identity != 0) card.glass.identity else card_index + 1;
            effect_card_indices[effect_count] = card_index;
            effect_count += 1;
        }
        if (request.disclosure.visible and request.disclosure.glass.materialization != .hidden and effect_count < effects.len) {
            effects[effect_count] = request.disclosure.glass;
            effect_keys[effect_count] = request.disclosure.glass.identity;
            effect_count += 1;
        }

        var slot_effects: [max_bubble_glass_rects]BubbleGlassRect = @splat(.{});
        var slot_card_indices: [max_bubble_glass_rects]?usize = @splat(null);
        var slot_active: [max_bubble_glass_rects]bool = @splat(false);
        for (effects[0..effect_count], effect_keys[0..effect_count], effect_card_indices[0..effect_count]) |effect, key, card_index| {
            var selected: ?usize = null;
            for (bubble_glass_view_identities, 0..) |identity, slot| {
                if (!slot_active[slot] and identity == key) {
                    selected = slot;
                    break;
                }
            }
            if (selected == null) for (bubble_glass_view_identities, 0..) |identity, slot| {
                if (!slot_active[slot] and identity == 0) {
                    selected = slot;
                    break;
                }
            };
            if (selected == null) for (slot_active, 0..) |active, slot| {
                if (!active) {
                    selected = slot;
                    break;
                }
            };
            const slot = selected orelse continue;
            bubble_glass_view_identities[slot] = key;
            slot_effects[slot] = effect;
            slot_card_indices[slot] = card_index;
            slot_active[slot] = true;
        }

        var host_width: f64 = 1;
        for (effects[0..effect_count]) |rect| host_width = @max(host_width, @as(f64, bubbleGlassBounds(rect).right));
        const host_frame = NSRect{ .x = 0, .y = 0, .width = host_width, .height = @max(1, @as(f64, request.window_height)) };

        if (bubble_glass_root != root) {
            bubble_glass_views = @splat(null);
            bubble_glass_view_identities = @splat(0);
            bubble_native_card_views = @splat(.{});
            bubble_native_applied_cards = @splat(.{});
            bubble_control_presentation_digest = 0;
            bubble_glass_root = root;
            bubble_glass_group = null;
            bubble_glass_host = null;
            const glass_view_class = objc_getClass("NSGlassEffectView");
            const glass_container_class = objc_getClass("NSGlassEffectContainerView");
            bubble_glass_liquid = bubbleGlassBackend(glass_view_class != null, glass_container_class != null) == .liquid;
        }

        // The renderer already supplies spring presentation frames. Disable
        // implicit geometry animation so glass, content and hit panels cannot
        // lag one frame behind each other.
        const transaction_class = objc_getClass("CATransaction");
        const transaction_begin_sel = sel_registerName("begin");
        const transaction_disable_sel = sel_registerName("setDisableActions:");
        const transaction_commit_sel = sel_registerName("commit");
        const transaction_open = transaction_class != null and transaction_begin_sel != null and transaction_disable_sel != null and transaction_commit_sel != null;
        if (transaction_open) {
            @as(MsgVoid, @ptrCast(&objc_msgSend))(transaction_class, transaction_begin_sel);
            @as(MsgBool, @ptrCast(&objc_msgSend))(transaction_class, transaction_disable_sel, true);
        }
        defer if (transaction_open)
            @as(MsgVoid, @ptrCast(&objc_msgSend))(transaction_class, transaction_commit_sel);

        if (bubble_glass_group) |group| @as(MsgBool, @ptrCast(&objc_msgSend))(group, hidden_sel, true);
        if (bubble_glass_liquid) {
            const container_class = objc_getClass("NSGlassEffectContainerView") orelse return;
            const view_class = objc_getClass("NSView") orelse return;
            if (bubble_glass_group == null or bubble_glass_host == null) {
                const group_allocated = @as(MsgObj, @ptrCast(&objc_msgSend))(container_class, alloc_sel);
                const group = if (group_allocated) |value| @as(MsgInit, @ptrCast(&objc_msgSend))(value, init_sel, host_frame) else null;
                const host_allocated = @as(MsgObj, @ptrCast(&objc_msgSend))(view_class, alloc_sel);
                const card_host = if (host_allocated) |value| @as(MsgInit, @ptrCast(&objc_msgSend))(value, init_sel, host_frame) else null;
                if (group != null and card_host != null) {
                    @as(MsgSetObj, @ptrCast(&objc_msgSend))(group, sel_registerName("setContentView:") orelse return, card_host);
                    @as(MsgFloat, @ptrCast(&objc_msgSend))(group, sel_registerName("setSpacing:") orelse return, 0);
                    @as(MsgAdd, @ptrCast(&objc_msgSend))(root, add_positioned_sel, group, -1, null);
                    bubble_glass_group = group;
                    bubble_glass_host = card_host;
                }
            }
            const group = bubble_glass_group orelse return;
            const card_host = bubble_glass_host orelse return;
            @as(MsgFrame, @ptrCast(&objc_msgSend))(group, set_frame_sel, host_frame);
            @as(MsgFrame, @ptrCast(&objc_msgSend))(card_host, set_frame_sel, host_frame);
            @as(MsgBool, @ptrCast(&objc_msgSend))(group, hidden_sel, effect_count == 0);
        }

        const effect_class = if (bubble_glass_liquid)
            (objc_getClass("NSGlassEffectView") orelse return)
        else
            (objc_getClass("NSVisualEffectView") orelse return);

        for (0..max_bubble_glass_rects) |slot| {
            if (!slot_active[slot]) {
                const applied = &bubble_native_applied_cards[slot];
                if (applied.visible) {
                    if (bubble_glass_views[slot]) |view| @as(MsgBool, @ptrCast(&objc_msgSend))(view, hidden_sel, true);
                    if (bubble_native_card_views[slot].content) |content| @as(MsgBool, @ptrCast(&objc_msgSend))(content, hidden_sel, true);
                    applied.* = .{};
                }
                continue;
            }
            var view = bubble_glass_views[slot];
            if (view == null) {
                const allocated = @as(MsgObj, @ptrCast(&objc_msgSend))(effect_class, alloc_sel) orelse continue;
                view = @as(MsgInit, @ptrCast(&objc_msgSend))(allocated, init_sel, .{ .x = 0, .y = 0, .width = 1, .height = 1 });
                const created = view orelse continue;
                bubble_glass_views[slot] = created;
                if (bubble_glass_liquid) {
                    const style_sel = sel_registerName("setStyle:") orelse return;
                    if (respondsToSelector(created, style_sel))
                        @as(MsgInt, @ptrCast(&objc_msgSend))(created, style_sel, 0);
                } else {
                    @as(MsgInt, @ptrCast(&objc_msgSend))(created, sel_registerName("setMaterial:") orelse return, 6);
                    @as(MsgInt, @ptrCast(&objc_msgSend))(created, sel_registerName("setBlendingMode:") orelse return, 0);
                    @as(MsgInt, @ptrCast(&objc_msgSend))(created, sel_registerName("setState:") orelse return, 1);
                    @as(MsgBool, @ptrCast(&objc_msgSend))(created, sel_registerName("setWantsLayer:") orelse return, true);
                }
            }
            const glass = view orelse continue;
            const rect = slot_effects[slot];
            const card_index = slot_card_indices[slot];
            var glass_digest = if (card_index) |index| request.cards[index].glass_digest else bubbleGlassDigestValue(rect);
            // AppKit's coordinate conversion is bottom-origin, so a window
            // height change moves a card even if its top-origin rect did not.
            bubbleDigestF32(&glass_digest, request.window_height);
            const applied = &bubble_native_applied_cards[slot];
            const identity_changed = !applied.visible or applied.identity != rect.identity;
            const glass_changed = identity_changed or applied.glass_digest != glass_digest;
            const content_changed = if (card_index) |index|
                identity_changed or applied.content_digest != request.cards[index].content_digest
            else
                identity_changed or applied.content_digest != 0;
            const desired_host = if (bubble_glass_liquid) bubble_glass_host else root;
            if (glass_changed and @as(MsgObj, @ptrCast(&objc_msgSend))(glass, sel_registerName("superview") orelse return) != desired_host) {
                @as(MsgVoid, @ptrCast(&objc_msgSend))(glass, sel_registerName("removeFromSuperview") orelse return);
                @as(MsgAdd, @ptrCast(&objc_msgSend))(desired_host, add_positioned_sel, glass, -1, null);
            }
            if (glass_changed) {
                const bounds = bubbleGlassBounds(rect);
                const frame = NSRect{
                    .x = bounds.left,
                    .y = @as(f64, request.window_height) - bounds.bottom,
                    .width = bounds.right - bounds.left,
                    .height = bounds.bottom - bounds.top,
                };
                @as(MsgFrame, @ptrCast(&objc_msgSend))(glass, set_frame_sel, frame);
                if (bubble_glass_liquid) {
                    const corner_radius_sel = sel_registerName("setCornerRadius:") orelse return;
                    if (respondsToSelector(glass, corner_radius_sel))
                        @as(MsgFloat, @ptrCast(&objc_msgSend))(glass, corner_radius_sel, rect.corner_radius);
                    const interactive_sel = sel_registerName("setEffectIsInteractive:") orelse return;
                    if (respondsToSelector(glass, interactive_sel))
                        @as(MsgBool, @ptrCast(&objc_msgSend))(glass, interactive_sel, true);
                    const tint_sel = sel_registerName("setTintColor:") orelse return;
                    if (respondsToSelector(glass, tint_sel))
                        @as(MsgSetObj, @ptrCast(&objc_msgSend))(glass, tint_sel, semanticGlassTint(rect.semantic_state, rect.dark_appearance, rect.high_contrast));
                } else if (@as(MsgObj, @ptrCast(&objc_msgSend))(glass, sel_registerName("layer") orelse return)) |layer| {
                    @as(MsgFloat, @ptrCast(&objc_msgSend))(layer, sel_registerName("setCornerRadius:") orelse return, rect.corner_radius);
                    @as(MsgBool, @ptrCast(&objc_msgSend))(layer, sel_registerName("setMasksToBounds:") orelse return, true);
                }
                const material_alpha: f64 = if (bubble_glass_liquid) 1 else std.math.clamp(rect.alpha, 0, 1);
                @as(MsgFloat, @ptrCast(&objc_msgSend))(glass, sel_registerName("setAlphaValue:") orelse return, material_alpha);
                @as(MsgBool, @ptrCast(&objc_msgSend))(glass, hidden_sel, false);
            }

            if (card_index) |index| {
                const native_views = ensureNativeCardViews(slot, glass, bubble_glass_liquid) orelse continue;
                if (content_changed)
                    applyNativeCardContent(native_views, &request.cards[index]);
            } else if (bubble_native_card_views[slot].content) |content| {
                if (content_changed)
                    @as(MsgBool, @ptrCast(&objc_msgSend))(content, hidden_sel, true);
            }
            if (glass_changed or content_changed) {
                lockBubbleGlass();
                bubble_native_render_counters.changed_card_applies +%= 1;
                unlockBubbleGlass();
            }
            applied.identity = rect.identity;
            applied.glass_digest = glass_digest;
            applied.content_digest = if (card_index) |index| request.cards[index].content_digest else 0;
            applied.visible = true;
        }

        // The visual activity window remains click-through so transparent
        // gaps never block the desktop. Stable card-sized sibling panels own
        // the card bodies and are updated from the exact same presentation
        // frames as glass/content before the higher-level action controls.
        applyBubbleCardPanels(&request, window);

        if (request.controls_digest != bubble_control_presentation_digest) {
            applyBubbleControlPanels(&request, window);
            bubble_control_presentation_digest = request.controls_digest;
        }
    }
} else struct {};

pub fn visibleScreenFrameAt(x: f64, y: f64) ?VisibleScreenFrame {
    if (builtin.is_test) return null;
    if (comptime builtin.os.tag != .macos) return null;
    return AppleApp.visibleScreenFrameAt(x, y);
}

pub fn setBubbleNativePresentation(presentation: *const BubbleNativePresentation) void {
    if (builtin.is_test or builtin.os.tag != .macos) return;
    var prepared = presentation.*;
    prepareBubbleNativePresentation(&prepared);
    lockBubbleGlass();
    if (prepared.digest == bubble_glass_submitted_digest) {
        bubble_native_render_counters.suppressed_equal_snapshots +%= 1;
        unlockBubbleGlass();
        return;
    }
    bubble_glass_request = prepared;
    bubble_glass_submitted_digest = prepared.digest;
    bubble_native_render_counters.submissions +%= 1;
    const should_dispatch = !bubble_glass_dispatch_scheduled;
    bubble_glass_dispatch_scheduled = true;
    unlockBubbleGlass();
    if (should_dispatch) AppleApp.dispatch_async_f(&AppleApp._dispatch_main_q, null, AppleApp.applyBubbleGlass);
}

/// Hit-test the exact native card presentation last submitted to AppKit.
/// This avoids rebuilding measured text/layout just to service the global
/// pointer poll while the activity window remains click-through.
pub fn bubbleNativeCardIdentityAt(local_x: f32, local_y: f32, slop: f32) u64 {
    if (builtin.is_test or builtin.os.tag != .macos) return 0;
    lockBubbleGlass();
    defer unlockBubbleGlass();
    return bubbleNativeCardIdentityAtPresentation(&bubble_glass_request, local_x, local_y, slop);
}

pub fn clearBubbleNativePresentation() void {
    var presentation: BubbleNativePresentation = .{};
    setBubbleNativePresentation(&presentation);
}

/// Snapshot of the in-process counters used by focused tests and manual
/// performance diagnosis.  Deliberately not exported to product telemetry.
pub fn bubbleNativeRenderCounters() BubbleNativeRenderCounters {
    lockBubbleGlass();
    defer unlockBubbleGlass();
    return bubble_native_render_counters;
}

pub fn pollBubbleNativeControl() ?BubbleNativeControlEvent {
    if (builtin.is_test or builtin.os.tag != .macos) return null;
    lockBubbleGlass();
    defer unlockBubbleGlass();
    if (bubble_native_action_len == 0) return null;
    const event = bubble_native_action_ring[bubble_native_action_head];
    bubble_native_action_head = (bubble_native_action_head + 1) % bubble_native_action_capacity;
    bubble_native_action_len -= 1;
    return event;
}

pub fn pollBubbleNativeCardEvent() ?BubbleNativeCardEvent {
    if (builtin.is_test or builtin.os.tag != .macos) return null;
    lockBubbleGlass();
    defer unlockBubbleGlass();
    if (bubble_native_card_event_len == 0) return null;
    const event = bubble_native_card_event_ring[bubble_native_card_event_head];
    bubble_native_card_event_head = (bubble_native_card_event_head + 1) % bubble_native_card_event_capacity;
    bubble_native_card_event_len -= 1;
    return event;
}

/// Hide or show the app's Dock icon (macOS activation policy
/// `.accessory` vs `.regular`). Windows still open and focus in
/// accessory mode; the app just leaves the Dock and app switcher.
/// No-op on other platforms.
pub fn setDockIconHidden(hidden: bool) void {
    if (builtin.is_test or builtin.os.tag != .macos) return;
    const ctx: ?*anyopaque = if (hidden) @ptrFromInt(1) else null;
    AppleApp.dispatch_async_f(&AppleApp._dispatch_main_q, ctx, AppleApp.applyPolicy);
}

/// Whether the app is registered as a login item (macOS 13+;
/// SMAppServiceStatusEnabled == 1). False anywhere the API is missing.
pub fn launchAtLoginEnabled() bool {
    if (builtin.is_test or builtin.os.tag != .macos) return false;
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
    if (builtin.is_test or builtin.os.tag != .macos) return false;
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

/// Resolve the current default HTTP handler through NSWorkspace, then activate
/// only an already-running instance. No URL is opened or passed to the target,
/// so this cannot navigate the browser or create a new tab. A closed browser
/// remains closed and reports `not_running` to the caller.
pub fn activateRunningDefaultBrowser() BrowserActivation {
    if (builtin.is_test or builtin.os.tag != .macos) return .unsupported;

    _ = AppleApp.dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", 2);
    const MsgSendObj = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
    const MsgSendObj1 = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
    const MsgSendObjIndex = *const fn (?*anyopaque, ?*anyopaque, usize) callconv(.c) ?*anyopaque;
    const MsgSendUsize = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) usize;
    const MsgSendBool = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) bool;
    const MsgSendBoolOptions = *const fn (?*anyopaque, ?*anyopaque, usize) callconv(.c) bool;

    const ns_string = AppleApp.objc_getClass("NSString") orelse return .no_handler;
    const string_sel = AppleApp.sel_registerName("stringWithUTF8String:") orelse return .no_handler;
    const url_text = @as(MsgSendObj1, @ptrCast(&AppleApp.objc_msgSend))(ns_string, string_sel, @ptrCast(@constCast("http://localhost".ptr))) orelse return .no_handler;

    const ns_url = AppleApp.objc_getClass("NSURL") orelse return .no_handler;
    const url_sel = AppleApp.sel_registerName("URLWithString:") orelse return .no_handler;
    const http_url = @as(MsgSendObj1, @ptrCast(&AppleApp.objc_msgSend))(ns_url, url_sel, url_text) orelse return .no_handler;

    const ns_workspace = AppleApp.objc_getClass("NSWorkspace") orelse return .no_handler;
    const shared_sel = AppleApp.sel_registerName("sharedWorkspace") orelse return .no_handler;
    const workspace = @as(MsgSendObj, @ptrCast(&AppleApp.objc_msgSend))(ns_workspace, shared_sel) orelse return .no_handler;
    const handler_sel = AppleApp.sel_registerName("URLForApplicationToOpenURL:") orelse return .no_handler;
    const handler_url = @as(MsgSendObj1, @ptrCast(&AppleApp.objc_msgSend))(workspace, handler_sel, http_url) orelse return .no_handler;

    const ns_bundle = AppleApp.objc_getClass("NSBundle") orelse return .no_handler;
    const bundle_sel = AppleApp.sel_registerName("bundleWithURL:") orelse return .no_handler;
    const bundle = @as(MsgSendObj1, @ptrCast(&AppleApp.objc_msgSend))(ns_bundle, bundle_sel, handler_url) orelse return .no_handler;
    const bundle_id_sel = AppleApp.sel_registerName("bundleIdentifier") orelse return .no_handler;
    const bundle_id = @as(MsgSendObj, @ptrCast(&AppleApp.objc_msgSend))(bundle, bundle_id_sel) orelse return .no_handler;

    const ns_running_application = AppleApp.objc_getClass("NSRunningApplication") orelse return .not_running;
    const running_sel = AppleApp.sel_registerName("runningApplicationsWithBundleIdentifier:") orelse return .no_handler;
    const running = @as(MsgSendObj1, @ptrCast(&AppleApp.objc_msgSend))(ns_running_application, running_sel, bundle_id) orelse return .not_running;
    const count_sel = AppleApp.sel_registerName("count") orelse return .not_running;
    const count = @as(MsgSendUsize, @ptrCast(&AppleApp.objc_msgSend))(running, count_sel);
    if (count == 0) return .not_running;

    const item_sel = AppleApp.sel_registerName("objectAtIndex:") orelse return .activation_failed;
    const terminated_sel = AppleApp.sel_registerName("isTerminated") orelse return .activation_failed;
    const active_sel = AppleApp.sel_registerName("isActive") orelse return .activation_failed;
    const activate_sel = AppleApp.sel_registerName("activateWithOptions:") orelse return .activation_failed;
    for (0..count) |index| {
        const app = @as(MsgSendObjIndex, @ptrCast(&AppleApp.objc_msgSend))(running, item_sel, index) orelse continue;
        if (@as(MsgSendBool, @ptrCast(&AppleApp.objc_msgSend))(app, terminated_sel)) continue;
        if (@as(MsgSendBool, @ptrCast(&AppleApp.objc_msgSend))(app, active_sel)) return .already_active;
        if (@as(MsgSendBoolOptions, @ptrCast(&AppleApp.objc_msgSend))(app, activate_sel, 0)) return .activated;
    }
    return .activation_failed;
}

test "writeFile creates missing parent directories atomically" {
    const root = ".zig-cache/petdex-plat-write-file";
    _ = deleteTree(root);
    defer _ = deleteTree(root);

    const path = root ++ "/nested/pet.json";
    try std.testing.expect(writeFile(path, "petdex"));

    var buf: [32]u8 = undefined;
    const got = readFile(path, &buf) orelse return error.ReadFailed;
    try std.testing.expectEqualStrings("petdex", got);
}
