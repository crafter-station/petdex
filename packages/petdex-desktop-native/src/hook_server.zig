//! In-process replacement for the Node sidecar's HTTP surface on
//! 127.0.0.1:7777. Same contract the hooks already speak: token-gated
//! POST /state and /bubble (header x-petdex-update-token, token file
//! at ~/.petdex/runtime/update-token mode 0600, regenerated per
//! session), shared 30/s rate limit, and the read endpoints /health,
//! /whoami, /state, /bubble, /init-status. /update endpoints answer
//! honestly that install-in-place is not wired yet (later slice).
//!
//! The server thread only parses, validates, mirrors to the runtime
//! files, and enqueues; the app thread drains the queue on a poll
//! timer and owns all display logic (dwell, coalescing partner, the
//! running left/right alternation lives here because it is a
//! per-session visual choice, exactly like the sidecar's).
//!
//! Connections are one-shot (Connection: close): agent hooks curl
//! once per event, nothing keeps sockets open.

const std = @import("std");
const plat = @import("plat.zig");

/// One connection, plus the Io that owns it. Everything downstream of
/// accept() needs both, and passing them as a pair keeps the response
/// helpers' signatures as flat as the old bare fd was.
const Conn = struct {
    stream: std.Io.net.Stream,
    io: std.Io,
};

pub const max_pending = 50;
const max_active_connections: u32 = 64;

pub const StateEvent = struct {
    state: [16]u8 = @splat(0),
    state_len: usize = 0,
    duration_ms: u32 = 0,

    pub fn slice(self: *const StateEvent) []const u8 {
        return self.state[0..self.state_len];
    }
};

pub const Bubble = struct {
    text: [200]u8 = @splat(0),
    text_len: usize = 0,
    title: [96]u8 = @splat(0),
    title_len: usize = 0,
    agent: [24]u8 = @splat(0),
    agent_len: usize = 0,
    busy: bool = false,
    counter: u64 = 0,
};

/// Shared mailbox between the server thread (producer) and the app's
/// poll timer (consumer). Everything behind one mutex; operations are
/// tiny so contention is irrelevant at hook rates.
const SpinMutex = struct {
    inner: std.atomic.Mutex = .unlocked,

    fn lock(self: *SpinMutex) void {
        while (!self.inner.tryLock()) std.atomic.spinLoopHint();
    }

    fn unlock(self: *SpinMutex) void {
        self.inner.unlock();
    }
};

pub const Mailbox = struct {
    mutex: SpinMutex = .{},
    pending: [max_pending]StateEvent = @splat(.{}),
    pending_len: usize = 0,
    last_enqueued: StateEvent = .{},
    bubble: Bubble = .{},
    bubble_dirty: bool = false,
    state_counter: u64 = 0,

    /// Coalesce + append, sidecar semantics: consecutive identical
    /// states collapse. Returns whether the event was queued.
    pub fn enqueue(self: *Mailbox, event: StateEvent) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.pending_len > 0 or self.last_enqueued.state_len > 0) {
            if (std.mem.eql(u8, self.last_enqueued.slice(), event.slice())) return false;
        }
        if (self.pending_len >= max_pending) return false;
        self.pending[self.pending_len] = event;
        self.pending_len += 1;
        self.last_enqueued = event;
        self.state_counter += 1;
        return true;
    }

    pub fn pop(self: *Mailbox) ?StateEvent {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.pending_len == 0) {
            self.last_enqueued = .{};
            return null;
        }
        const head = self.pending[0];
        std.mem.copyForwards(StateEvent, self.pending[0 .. self.pending_len - 1], self.pending[1..self.pending_len]);
        self.pending_len -= 1;
        return head;
    }

    pub fn setBubble(self: *Mailbox, text: []const u8, agent: []const u8, title: []const u8, busy: bool) u64 {
        self.mutex.lock();
        defer self.mutex.unlock();
        const n = @min(text.len, self.bubble.text.len);
        @memcpy(self.bubble.text[0..n], text[0..n]);
        self.bubble.text_len = n;
        const an = @min(agent.len, self.bubble.agent.len);
        @memcpy(self.bubble.agent[0..an], agent[0..an]);
        self.bubble.agent_len = an;
        const tn = @min(title.len, self.bubble.title.len);
        @memcpy(self.bubble.title[0..tn], title[0..tn]);
        self.bubble.title_len = tn;
        self.bubble.busy = busy;
        self.bubble.counter += 1;
        self.bubble_dirty = true;
        return self.bubble.counter;
    }

    pub fn takeBubble(self: *Mailbox, out: *Bubble) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (!self.bubble_dirty) return false;
        out.* = self.bubble;
        self.bubble_dirty = false;
        return true;
    }
};

pub var mailbox: Mailbox = .{};

const valid_states = [_][]const u8{
    "idle",    "running", "running-left", "running-right", "waving",
    "jumping", "failed",  "review",       "waiting",
};

/// Session token entropy straight from the kernel CSPRNG. Zig 0.16
/// removed the ambient std.crypto.random; the hand-rolled
/// /dev/urandom read that replaced it was POSIX-only, so this now
/// goes through Io, which picks the right source per platform.
const fillRandom = plat.fillRandom;

const nowMs = plat.nowMs;

fn isValidState(s: []const u8) bool {
    for (valid_states) |v| {
        if (std.mem.eql(u8, v, s)) return true;
    }
    return false;
}

const Server = struct {
    allocator: std.mem.Allocator,
    runtime_dir: []const u8,
    token: [64]u8,
    request_lock: SpinMutex = .{},
    active_connections: std.atomic.Value(u32) = .init(0),
    // Token-bucket limiter, sidecar budget: 30/s shared by state+bubble.
    bucket: f64 = 30,
    bucket_stamp_ms: i64 = 0,
    running_toggle: bool = false,
    pid: i32,

    fn rateLimitOk(self: *Server) bool {
        self.request_lock.lock();
        defer self.request_lock.unlock();
        const now = nowMs();
        if (self.bucket_stamp_ms == 0) self.bucket_stamp_ms = now;
        const elapsed: f64 = @floatFromInt(now - self.bucket_stamp_ms);
        self.bucket = @min(30.0, self.bucket + elapsed * 30.0 / 1000.0);
        self.bucket_stamp_ms = now;
        if (self.bucket < 1) return false;
        self.bucket -= 1;
        return true;
    }

    fn nextRunningState(self: *Server) []const u8 {
        self.request_lock.lock();
        defer self.request_lock.unlock();
        const state = if (self.running_toggle) "running-left" else "running-right";
        self.running_toggle = !self.running_toggle;
        return state;
    }
};

/// Spawn the listener thread. Never blocks the caller; failures to
/// bind are printed and the thread exits (the desktop keeps running,
/// hooks just get connection refused, same as a dead sidecar).
pub fn start(allocator: std.mem.Allocator, home: []const u8) !void {
    const runtime_dir = try std.fs.path.join(allocator, &.{ home, ".petdex", "runtime" });
    const server = try allocator.create(Server);
    server.* = .{
        .allocator = allocator,
        .runtime_dir = runtime_dir,
        .token = undefined,
        .pid = @intCast(plat.processId()),
    };
    var raw: [32]u8 = undefined;
    try fillRandom(&raw);
    _ = std.fmt.bufPrint(&server.token, "{x}", .{&raw}) catch unreachable;
    const thread = try std.Thread.spawn(.{}, run, .{server});
    thread.detach();
}

fn run(server: *Server) void {
    writeRuntimeFile(server, "update-token", &server.token, 0o600) catch |err| {
        std.debug.print("petdex: token write failed ({s})\n", .{@errorName(err)});
        return;
    };
    mirrorState(server, "idle", 0) catch {};

    // This thread owns its Io for its whole life: the listener blocks
    // in accept() forever and must never touch the main thread's.
    var scope = plat.Scope.init();
    defer scope.deinit();
    const io = scope.io();

    const addr: std.Io.net.IpAddress = .{ .ip4 = .loopback(7777) };
    var listener = addr.listen(io, .{
        .kernel_backlog = 16,
        .reuse_address = true,
        .mode = .stream,
        .protocol = .tcp,
    }) catch {
        std.debug.print("petdex: :7777 bind failed; is another petdex running?\n", .{});
        return;
    };
    defer listener.deinit(io);
    std.debug.print("petdex: hook server on 127.0.0.1:7777 (in-process)\n", .{});

    while (true) {
        const stream = listener.accept(io) catch continue;
        const active = server.active_connections.fetchAdd(1, .acq_rel);
        if (active >= max_active_connections) {
            _ = server.active_connections.fetchSub(1, .release);
            stream.close(io);
            continue;
        }
        // A client can disappear after sending only part of a request. Keep
        // that blocking read off the accept loop so later hooks still reach
        // the server while the abandoned connection drains or closes.
        const thread = std.Thread.spawn(.{}, handleConnectionThread, .{ server, stream }) catch {
            _ = server.active_connections.fetchSub(1, .release);
            stream.close(io);
            continue;
        };
        thread.detach();
    }
}

fn handleConnectionThread(server: *Server, stream: std.Io.net.Stream) void {
    defer _ = server.active_connections.fetchSub(1, .release);
    var scope = plat.Scope.init();
    defer scope.deinit();
    const io = scope.io();
    var conn: Conn = .{ .stream = stream, .io = io };
    handleConnection(server, &conn);
    stream.close(io);
}

fn handleConnection(server: *Server, conn: *Conn) void {
    var buf: [8192]u8 = undefined;
    var read_buf: [8192]u8 = undefined;
    var reader = conn.stream.reader(conn.io, &read_buf);
    const r = &reader.interface;

    // Headers line by line: a sized read would block waiting for bytes
    // the client will not send until it sees a response (the old
    // std.c.read returned whatever one syscall had, this does not).
    var total: usize = 0;
    while (true) {
        // Inclusive, not exclusive: the exclusive form leaves the '\n'
        // in the stream, so the next line would start with it and read
        // back as empty, ending the loop after the request line.
        const line = r.takeDelimiterInclusive('\n') catch return;
        const trimmed = std.mem.trimEnd(u8, line, "\r\n");
        if (total + trimmed.len + 2 > buf.len) return;
        @memcpy(buf[total..][0..trimmed.len], trimmed);
        buf[total + trimmed.len] = '\r';
        buf[total + trimmed.len + 1] = '\n';
        total += trimmed.len + 2;
        if (trimmed.len == 0) break;
    }
    if (total == 0) return;
    const head = buf[0..total];

    const content_length = headerValueInt(head, "content-length") orelse 0;
    if (content_length > buf.len - total) {
        respond(conn, 413, "{\"ok\":false,\"error\":\"body_too_large\"}");
        return;
    }
    const body = if (content_length == 0) buf[total..total] else blk: {
        const got = r.readSliceShort(buf[total..][0..content_length]) catch break :blk buf[total..total];
        break :blk buf[total..][0..got];
    };

    var line_it = std.mem.splitSequence(u8, head, "\r\n");
    const request_line = line_it.next() orelse return;
    var part_it = std.mem.splitScalar(u8, request_line, ' ');
    const method = part_it.next() orelse return;
    const target = part_it.next() orelse return;
    const path = if (std.mem.indexOfScalar(u8, target, '?')) |q| target[0..q] else target;

    route(server, conn, method, path, head, body);
}

fn route(server: *Server, conn: *Conn, method: []const u8, path: []const u8, head: []const u8, body: []const u8) void {
    const get = std.mem.eql(u8, method, "GET");
    const post = std.mem.eql(u8, method, "POST");
    var scratch: [512]u8 = undefined;

    if (get and std.mem.eql(u8, path, "/health")) {
        return respond(conn, 200, "{\"ok\":true,\"port\":7777}");
    }
    if (get and std.mem.eql(u8, path, "/whoami")) {
        const out = std.fmt.bufPrint(&scratch, "{{\"ok\":true,\"pid\":{d},\"parentPid\":null,\"inProcess\":true}}", .{server.pid}) catch return;
        return respond(conn, 200, out);
    }
    if (get and std.mem.eql(u8, path, "/state")) {
        return respondRuntimeFile(server, conn, "state.json", "{\"state\":\"idle\",\"counter\":0}");
    }
    if (get and std.mem.eql(u8, path, "/bubble")) {
        return respondRuntimeFile(server, conn, "bubble.json", "{\"text\":null,\"counter\":0}");
    }
    if (get and std.mem.eql(u8, path, "/init-status")) {
        return respondRuntimeFile(server, conn, "init-status.json", "{\"needsInit\":false,\"reason\":null}");
    }
    if (get and std.mem.eql(u8, path, "/update")) {
        return respond(conn, 200, "{\"available\":false,\"installable\":false,\"status\":\"idle\",\"message\":null}");
    }
    if (post and (std.mem.eql(u8, path, "/update") or std.mem.eql(u8, path, "/update/handoff"))) {
        if (!tokenOk(server, head)) return respond(conn, 401, "{\"ok\":false,\"error\":\"unauthorized\"}");
        return respond(conn, 409, "{\"ok\":false,\"error\":\"unsupported_install\",\"message\":\"Self-update lands in a later slice; download the current build from petdex.dev/download.\"}");
    }

    if (post and std.mem.eql(u8, path, "/state")) {
        if (!tokenOk(server, head)) return respond(conn, 401, "{\"ok\":false,\"error\":\"unauthorized\"}");
        if (!server.rateLimitOk()) return respond(conn, 429, "{\"ok\":false,\"error\":\"rate_limited\"}");
        const state_raw = jsonString(body, "state") orelse
            return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_state\"}");
        if (!isValidState(state_raw) or state_raw.len > 15) {
            return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_state\"}");
        }
        var duration: u32 = 0;
        if (jsonNumber(body, "duration")) |d| duration = @intFromFloat(@min(d, 30_000));

        // Sidecar's sprite variation: bare "running" alternates
        // left/right per session so consecutive tool calls vary.
        var applied: []const u8 = state_raw;
        if (std.mem.eql(u8, state_raw, "running")) {
            applied = server.nextRunningState();
        }

        var event = StateEvent{ .duration_ms = duration };
        event.state_len = applied.len;
        @memcpy(event.state[0..applied.len], applied);
        const queued = mailbox.enqueue(event);
        mirrorState(server, applied, mailbox.state_counter) catch {};

        const dur_out: i64 = if (duration == 0) -1 else @intCast(duration);
        const out = if (dur_out < 0)
            std.fmt.bufPrint(&scratch, "{{\"ok\":true,\"state\":\"{s}\",\"duration\":null,\"queued\":{}}}", .{ state_raw, queued }) catch return
        else
            std.fmt.bufPrint(&scratch, "{{\"ok\":true,\"state\":\"{s}\",\"duration\":{d},\"queued\":{}}}", .{ state_raw, dur_out, queued }) catch return;
        return respond(conn, 200, out);
    }

    if (post and std.mem.eql(u8, path, "/bubble")) {
        if (!tokenOk(server, head)) return respond(conn, 401, "{\"ok\":false,\"error\":\"unauthorized\"}");
        if (!server.rateLimitOk()) return respond(conn, 429, "{\"ok\":false,\"error\":\"rate_limited\"}");
        const text = jsonString(body, "text") orelse
            return respond(conn, 400, "{\"ok\":false,\"error\":\"missing_text\"}");
        const capped = text[0..@min(text.len, 200)];
        const agent = jsonString(body, "agent_source") orelse "";
        const title = jsonString(body, "title") orelse "";
        const busy = std.mem.indexOf(u8, body, "\"busy\":true") != null;
        const counter = mailbox.setBubble(capped, agent[0..@min(agent.len, 24)], title[0..@min(title.len, 96)], busy);
        mirrorBubble(server, capped, counter, title[0..@min(title.len, 96)], agent[0..@min(agent.len, 24)], busy) catch {};
        const out = std.fmt.bufPrint(&scratch, "{{\"ok\":true,\"counter\":{d}}}", .{counter}) catch return;
        return respond(conn, 200, out);
    }

    respond(conn, 404, "{\"ok\":false,\"error\":\"not_found\"}");
}

// ------------------------------------------------------------------ auth

fn tokenOk(server: *Server, head: []const u8) bool {
    const provided = headerValue(head, "x-petdex-update-token") orelse return false;
    if (provided.len != server.token.len) return false;
    // Constant-time compare, same defense as the sidecar's.
    var diff: u8 = 0;
    for (provided, server.token) |a, b| diff |= a ^ b;
    return diff == 0;
}

/// Serve a runtime mirror file if present, else the given fallback
/// JSON. Bounded read; these files are small JSON blobs we write.
fn respondRuntimeFile(server: *Server, conn: *Conn, name: []const u8, fallback: []const u8) void {
    var path_buf: [512]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ server.runtime_dir, name }) catch {
        return respond(conn, 200, fallback);
    };
    var buf: [4096]u8 = undefined;
    const contents = plat.readFileIo(conn.io, path, &buf) orelse return respond(conn, 200, fallback);
    respond(conn, 200, contents);
}

// ------------------------------------------------------------ http helpers

fn respond(conn: *Conn, status: u16, body: []const u8) void {
    var buf: [1024]u8 = undefined;
    const reason = switch (status) {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        else => "OK",
    };
    const head = std.fmt.bufPrint(&buf, "HTTP/1.1 {d} {s}\r\ncontent-type: application/json\r\ncontent-length: {d}\r\nconnection: close\r\n\r\n", .{ status, reason, body.len }) catch return;
    writeAll(conn, head);
    writeAll(conn, body);
}

fn writeAll(conn: *Conn, bytes: []const u8) void {
    var write_buf: [64]u8 = undefined;
    var writer = conn.stream.writer(conn.io, &write_buf);
    writer.interface.writeAll(bytes) catch return;
    writer.interface.flush() catch return;
}

fn headerValue(head: []const u8, name: []const u8) ?[]const u8 {
    var it = std.mem.splitSequence(u8, head, "\r\n");
    _ = it.next();
    while (it.next()) |line| {
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
        if (std.ascii.eqlIgnoreCase(std.mem.trim(u8, line[0..colon], " "), name)) {
            return std.mem.trim(u8, line[colon + 1 ..], " \r");
        }
    }
    return null;
}

fn headerValueInt(head: []const u8, name: []const u8) ?usize {
    const v = headerValue(head, name) orelse return null;
    return std.fmt.parseInt(usize, v, 10) catch null;
}

// ----------------------------------------------------------- json helpers

/// Small allocation-free parser: finds "key":"value" and "key":number.
/// String slices retain JSON escapes for the caller to decode or flatten, but
/// the scanner must skip them so multiline assistant messages are not cut at
/// their first `\n`.
pub fn jsonStringPub(body: []const u8, key: []const u8) ?[]const u8 {
    return jsonString(body, key);
}

pub fn jsonNumberPub(body: []const u8, key: []const u8) ?f64 {
    return jsonNumber(body, key);
}

fn jsonString(body: []const u8, key: []const u8) ?[]const u8 {
    var pat_buf: [32]u8 = undefined;
    const pat = std.fmt.bufPrint(&pat_buf, "\"{s}\"", .{key}) catch return null;
    const key_at = std.mem.indexOf(u8, body, pat) orelse return null;
    var i = key_at + pat.len;
    while (i < body.len and (body[i] == ' ' or body[i] == ':')) i += 1;
    if (i >= body.len or body[i] != '"') return null;
    i += 1;
    const val_start = i;
    while (i < body.len) {
        if (body[i] == '\\') {
            i += @min(@as(usize, 2), body.len - i);
            continue;
        }
        if (body[i] == '"') break;
        i += 1;
    }
    return body[val_start..i];
}

test "json string scanner preserves escaped multiline content" {
    const body = "{\"last_assistant_message\":\"first\\nsecond third\",\"phase\":\"stop\"}";
    try std.testing.expectEqualStrings("first\\nsecond third", jsonString(body, "last_assistant_message").?);
}

test "running state alternates without sharing mutable state with callers" {
    var server = Server{
        .allocator = std.testing.allocator,
        .runtime_dir = "",
        .token = undefined,
        .pid = 0,
    };
    try std.testing.expectEqualStrings("running-right", server.nextRunningState());
    try std.testing.expectEqualStrings("running-left", server.nextRunningState());
    try std.testing.expectEqualStrings("running-right", server.nextRunningState());
}

fn jsonNumber(body: []const u8, key: []const u8) ?f64 {
    var pat_buf: [32]u8 = undefined;
    const pat = std.fmt.bufPrint(&pat_buf, "\"{s}\"", .{key}) catch return null;
    const key_at = std.mem.indexOf(u8, body, pat) orelse return null;
    var i = key_at + pat.len;
    while (i < body.len and (body[i] == ' ' or body[i] == ':')) i += 1;
    const val_start = i;
    while (i < body.len and (std.ascii.isDigit(body[i]) or body[i] == '.' or body[i] == '-')) i += 1;
    if (i == val_start) return null;
    return std.fmt.parseFloat(f64, body[val_start..i]) catch null;
}

// --------------------------------------------------------- runtime files

fn writeRuntimeFile(server: *Server, name: []const u8, bytes: []const u8, mode: u16) !void {
    plat.makeDir(server.runtime_dir);
    var path_buf: [512]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ server.runtime_dir, name }) catch return error.PathTooLong;
    // The 0600 on update-token is a POSIX guarantee only; on Windows
    // the file inherits the parent ACL (see plat.permissionsFromMode).
    if (!plat.writeFileMode(path, bytes, mode)) return error.WriteFailed;
}

fn mirrorState(server: *Server, state: []const u8, counter: u64) !void {
    var buf: [128]u8 = undefined;
    const json = try std.fmt.bufPrint(&buf, "{{\"state\":\"{s}\",\"counter\":{d}}}", .{ state, counter });
    try writeRuntimeFile(server, "state.json", json, 0o644);
}

fn mirrorBubble(server: *Server, text: []const u8, counter: u64, title: []const u8, agent: []const u8, busy: bool) !void {
    var buf: [1024]u8 = undefined;
    const json = try std.fmt.bufPrint(&buf, "{{\"text\":\"{s}\",\"title\":\"{s}\",\"agent_source\":\"{s}\",\"busy\":{},\"counter\":{d},\"at\":{d}}}", .{ text, title, agent, busy, counter, nowMs() });
    try writeRuntimeFile(server, "bubble.json", json, 0o644);
}
