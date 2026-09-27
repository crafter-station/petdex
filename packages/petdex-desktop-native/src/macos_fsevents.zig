//! Minimal recursive macOS directory-change backend.
//!
//! CoreServices is loaded dynamically so consumers do not need to change their
//! framework link set. The callback deliberately reports only a coalesced hint;
//! the bounded reconciliation scan remains authoritative.

const std = @import("std");
const builtin = @import("builtin");

pub const Signal = enum { dirty, overflow };

/// `publish` runs on a private serial GCD queue and must be thread-safe,
/// non-blocking, and remain valid for the lifetime of `run`.
pub const Sink = struct {
    context: *anyopaque,
    publish: *const fn (context: *anyopaque, signal: Signal) void,
};

pub const Error = error{
    UnsupportedPlatform,
    OpenFrameworkFailed,
    MissingCoreServicesSymbol,
    SystemResources,
    InvalidPath,
    CreateStreamFailed,
    StartStreamFailed,
    RootChanged,
};

/// Starts one recursive FSEvent stream and blocks permanently. The caller is
/// expected to own a dedicated process-lifetime watcher thread.
pub fn run(path: []const u8, sink: Sink) Error!void {
    if (comptime builtin.os.tag != .macos) return error.UnsupportedPlatform;
    if (path.len == 0 or !std.unicode.utf8ValidateSlice(path)) return error.InvalidPath;

    const dispatch = std.c.dispatch;
    var core_services = std.DynLib.open("/System/Library/Frameworks/CoreServices.framework/CoreServices") catch
        return error.OpenFrameworkFailed;
    defer core_services.close();

    var symbols: Symbols = undefined;
    inline for (@typeInfo(Symbols).@"struct".fields) |field| {
        @field(symbols, field.name) = core_services.lookup(field.type, field.name) orelse
            return error.MissingCoreServicesSymbol;
    }

    const path_z = std.heap.page_allocator.dupeZ(u8, path) catch return error.SystemResources;
    defer std.heap.page_allocator.free(path_z);
    const cf_path = symbols.CFStringCreateWithCString(null, path_z, .utf8) orelse return error.InvalidPath;
    defer symbols.CFRelease(cf_path);
    const path_values = [1]?*const anyopaque{@ptrCast(cf_path)};
    const paths = symbols.CFArrayCreate(null, &path_values, path_values.len, null) orelse
        return error.SystemResources;
    defer symbols.CFRelease(paths);

    const queue = dispatch.queue_create("petdex-session-watch", dispatch.QUEUE_SERIAL()) orelse
        return error.SystemResources;
    defer queue.as_object().release();
    const blocker = dispatch.semaphore_create(0) orelse return error.SystemResources;
    defer blocker.as_object().release();

    var callback_context: CallbackContext = .{ .sink = sink, .restart = @ptrCast(blocker) };
    const stream = symbols.FSEventStreamCreate(
        null,
        eventCallback,
        &.{
            .version = 0,
            .info = &callback_context,
            .retain = null,
            .release = null,
            .copy_description = null,
        },
        paths,
        .since_now,
        0.1,
        .{ .no_defer = true, .watch_root = true, .file_events = true },
    ) orelse return error.CreateStreamFailed;
    defer symbols.FSEventStreamRelease(stream);
    symbols.FSEventStreamSetDispatchQueue(stream, queue);
    defer symbols.FSEventStreamInvalidate(stream);
    if (!symbols.FSEventStreamStart(stream)) return error.StartStreamFailed;
    defer symbols.FSEventStreamStop(stream);

    // The process-lifetime watcher has no stop path today. Keeping this frame
    // alive also keeps the callback context and dynamically loaded symbols
    // valid for every dispatch callback.
    _ = blocker.wait(.FOREVER);
    return error.RootChanged;
}

const CallbackContext = struct {
    sink: Sink,
    restart: ?*anyopaque,
};

fn eventCallback(
    stream: ConstFSEventStreamRef,
    raw_context: ?*anyopaque,
    event_count: usize,
    event_paths: *anyopaque,
    event_flags: [*]const FSEventStreamEventFlags,
    event_ids: [*]const FSEventStreamEventId,
) callconv(.c) void {
    _ = stream;
    _ = event_paths;
    _ = event_ids;
    const context: *CallbackContext = @ptrCast(@alignCast(raw_context orelse return));
    var saw_dirty = false;
    for (event_flags[0..event_count]) |flags| {
        if (flags.history_done) continue;
        if (flags.root_changed) {
            context.sink.publish(context.sink.context, .overflow);
            if (comptime builtin.os.tag == .macos) {
                const restart: std.c.dispatch.semaphore_t = @ptrCast(@alignCast(context.restart orelse return));
                _ = restart.signal();
            }
            return;
        }
        if (flags.must_scan_sub_dirs or flags.user_dropped or flags.kernel_dropped or
            flags.event_ids_wrapped or flags.mount or flags.unmount)
        {
            context.sink.publish(context.sink.context, .overflow);
            return;
        }
        saw_dirty = true;
    }
    if (saw_dirty) context.sink.publish(context.sink.context, .dirty);
}

const Symbols = struct {
    FSEventStreamCreate: *const fn (
        allocator: CFAllocatorRef,
        callback: FSEventStreamCallback,
        context: ?*const FSEventStreamContext,
        paths: CFArrayRef,
        since_when: FSEventStreamEventId,
        latency: f64,
        flags: FSEventStreamCreateFlags,
    ) callconv(.c) ?FSEventStreamRef,
    FSEventStreamSetDispatchQueue: *const fn (stream: FSEventStreamRef, queue: std.c.dispatch.queue_t) callconv(.c) void,
    FSEventStreamStart: *const fn (stream: FSEventStreamRef) callconv(.c) bool,
    FSEventStreamStop: *const fn (stream: FSEventStreamRef) callconv(.c) void,
    FSEventStreamInvalidate: *const fn (stream: FSEventStreamRef) callconv(.c) void,
    FSEventStreamRelease: *const fn (stream: FSEventStreamRef) callconv(.c) void,
    CFRelease: *const fn (value: *const anyopaque) callconv(.c) void,
    CFArrayCreate: *const fn (
        allocator: CFAllocatorRef,
        values: [*]const ?*const anyopaque,
        count: isize,
        callbacks: ?*const anyopaque,
    ) callconv(.c) ?CFArrayRef,
    CFStringCreateWithCString: *const fn (
        allocator: CFAllocatorRef,
        value: [*:0]const u8,
        encoding: CFStringEncoding,
    ) callconv(.c) ?CFStringRef,
};

const CFAllocatorRef = ?*const opaque {};
const CFArrayRef = *const opaque {};
const CFStringRef = *const opaque {};
const CFStringEncoding = enum(u32) { utf8 = 0x08000100 };
const CFIndex = isize;
const CFAllocatorRetainCallBack = *const fn (info: ?*const anyopaque) callconv(.c) *const anyopaque;
const CFAllocatorReleaseCallBack = *const fn (info: ?*const anyopaque) callconv(.c) void;
const CFAllocatorCopyDescriptionCallBack = *const fn (info: ?*const anyopaque) callconv(.c) CFStringRef;

const FSEventStreamRef = *opaque {};
const ConstFSEventStreamRef = *const @typeInfo(FSEventStreamRef).pointer.child;
const FSEventStreamCallback = *const fn (
    stream: ConstFSEventStreamRef,
    context: ?*anyopaque,
    event_count: usize,
    event_paths: *anyopaque,
    event_flags: [*]const FSEventStreamEventFlags,
    event_ids: [*]const FSEventStreamEventId,
) callconv(.c) void;
const FSEventStreamContext = extern struct {
    version: CFIndex,
    info: ?*anyopaque,
    retain: ?CFAllocatorRetainCallBack,
    release: ?CFAllocatorReleaseCallBack,
    copy_description: ?CFAllocatorCopyDescriptionCallBack,
};
const FSEventStreamEventId = enum(u64) {
    since_now = std.math.maxInt(u64),
    _,
};
const FSEventStreamCreateFlags = packed struct(u32) {
    use_cf_types: bool = false,
    no_defer: bool = false,
    watch_root: bool = false,
    ignore_self: bool = false,
    file_events: bool = false,
    _: u27 = 0,
};
const FSEventStreamEventFlags = packed struct(u32) {
    must_scan_sub_dirs: bool = false,
    user_dropped: bool = false,
    kernel_dropped: bool = false,
    event_ids_wrapped: bool = false,
    history_done: bool = false,
    root_changed: bool = false,
    mount: bool = false,
    unmount: bool = false,
    _: u24 = 0,
};

test "overflow-class FSEvent flags dominate a dirty batch" {
    const TestSink = struct {
        fn publish(raw: *anyopaque, signal: Signal) void {
            const result: *Signal = @ptrCast(@alignCast(raw));
            result.* = signal;
        }
    };
    var result: Signal = .dirty;
    var context: CallbackContext = .{
        .sink = .{ .context = &result, .publish = TestSink.publish },
        .restart = null,
    };
    const flags = [_]FSEventStreamEventFlags{
        .{},
        .{ .kernel_dropped = true },
    };
    const ids = [_]FSEventStreamEventId{ @enumFromInt(1), @enumFromInt(2) };
    var unused_paths: u8 = 0;
    eventCallback(undefined, &context, flags.len, &unused_paths, &flags, &ids);
    try std.testing.expectEqual(Signal.overflow, result);
}
