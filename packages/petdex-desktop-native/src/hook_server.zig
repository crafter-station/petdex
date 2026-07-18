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

pub const max_pending = 50;

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

    pub fn setBubble(self: *Mailbox, text: []const u8) u64 {
        self.mutex.lock();
        defer self.mutex.unlock();
        const n = @min(text.len, self.bubble.text.len);
        @memcpy(self.bubble.text[0..n], text[0..n]);
        self.bubble.text_len = n;
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
    "idle", "running", "running-left", "running-right", "waving",
    "jumping", "failed", "review", "waiting",
};

/// Session token entropy straight from the kernel CSPRNG; Zig 0.16
/// removed the ambient std.crypto.random and /dev/urandom is the
/// honest cross-Unix source (Windows swaps this in a later slice).
fn fillRandom(out: []u8) !void {
    const fd = std.c.open("/dev/urandom", .{ .ACCMODE = .RDONLY });
    if (fd < 0) return error.EntropyUnavailable;
    defer _ = std.c.close(fd);
    var off: usize = 0;
    while (off < out.len) {
        const n = std.c.read(fd, out.ptr + off, out.len - off);
        if (n <= 0) return error.EntropyUnavailable;
        off += @intCast(n);
    }
}

fn nowMs() i64 {
    var tv: std.c.timeval = undefined;
    _ = std.c.gettimeofday(&tv, null);
    return @as(i64, tv.sec) * 1000 + @divTrunc(@as(i64, tv.usec), 1000);
}

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
    // Token-bucket limiter, sidecar budget: 30/s shared by state+bubble.
    bucket: f64 = 30,
    bucket_stamp_ms: i64 = 0,
    running_toggle: bool = false,
    pid: i32,

    fn rateLimitOk(self: *Server) bool {
        const now = nowMs();
        if (self.bucket_stamp_ms == 0) self.bucket_stamp_ms = now;
        const elapsed: f64 = @floatFromInt(now - self.bucket_stamp_ms);
        self.bucket = @min(30.0, self.bucket + elapsed * 30.0 / 1000.0);
        self.bucket_stamp_ms = now;
        if (self.bucket < 1) return false;
        self.bucket -= 1;
        return true;
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
        .pid = @intCast(std.c.getpid()),
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

    var addr: std.c.sockaddr.in = .{
        .family = std.c.AF.INET,
        .port = std.mem.nativeToBig(u16, 7777),
        .addr = std.mem.nativeToBig(u32, 0x7f000001),
        .zero = @splat(0),
    };
    const fd = std.c.socket(std.c.AF.INET, std.c.SOCK.STREAM, 0);
    if (fd < 0) {
        std.debug.print("petdex: hook server socket failed\n", .{});
        return;
    }
    defer _ = std.c.close(fd);
    var one: c_int = 1;
    _ = std.c.setsockopt(fd, std.c.SOL.SOCKET, std.c.SO.REUSEADDR, @ptrCast(&one), @sizeOf(c_int));
    if (std.c.bind(fd, @ptrCast(&addr), @sizeOf(std.c.sockaddr.in)) != 0) {
        std.debug.print("petdex: :7777 bind failed; is another petdex running?\n", .{});
        return;
    }
    if (std.c.listen(fd, 16) != 0) {
        std.debug.print("petdex: listen failed\n", .{});
        return;
    }
    std.debug.print("petdex: hook server on 127.0.0.1:7777 (in-process)\n", .{});

    while (true) {
        const conn = std.c.accept(fd, null, null);
        if (conn < 0) continue;
        handleConnection(server, conn);
        _ = std.c.close(conn);
    }
}

fn handleConnection(server: *Server, conn: std.c.fd_t) void {
    var buf: [8192]u8 = undefined;
    var total: usize = 0;
    // Read until end of headers; then honor content-length (bounded).
    const header_end = while (total < buf.len) {
        const n = std.c.read(conn, buf[total..].ptr, buf.len - total);
        if (n <= 0) break total;
        total += @intCast(n);
        if (std.mem.indexOf(u8, buf[0..total], "\r\n\r\n")) |idx| break idx + 4;
    } else total;
    if (header_end == 0 or header_end > total) return;
    const head = buf[0..header_end];

    const content_length = headerValueInt(head, "content-length") orelse 0;
    if (content_length > buf.len - header_end) {
        respond(conn, 413, "{\"ok\":false,\"error\":\"body_too_large\"}");
        return;
    }
    while (total < header_end + content_length) {
        const n = std.c.read(conn, buf[total..].ptr, buf.len - total);
        if (n <= 0) break;
        total += @intCast(n);
    }
    const body = buf[header_end..@min(total, header_end + content_length)];

    var line_it = std.mem.splitSequence(u8, head, "\r\n");
    const request_line = line_it.next() orelse return;
    var part_it = std.mem.splitScalar(u8, request_line, ' ');
    const method = part_it.next() orelse return;
    const target = part_it.next() orelse return;
    const path = if (std.mem.indexOfScalar(u8, target, '?')) |q| target[0..q] else target;

    route(server, conn, method, path, head, body);
}

fn route(server: *Server, conn: std.c.fd_t, method: []const u8, path: []const u8, head: []const u8, body: []const u8) void {
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
        return respond(conn, 409, "{\"ok\":false,\"error\":\"unsupported_install\",\"message\":\"Self-update lands in a later slice; run petdex update from a terminal.\"}");
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
            applied = if (server.running_toggle) "running-left" else "running-right";
            server.running_toggle = !server.running_toggle;
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
        const counter = mailbox.setBubble(capped);
        mirrorBubble(server, capped, counter) catch {};
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
fn respondRuntimeFile(server: *Server, conn: std.c.fd_t, name: []const u8, fallback: []const u8) void {
    var path_buf: [512]u8 = undefined;
    const path_z = std.fmt.bufPrintZ(&path_buf, "{s}/{s}", .{ server.runtime_dir, name }) catch {
        return respond(conn, 200, fallback);
    };
    const fd = std.c.open(path_z, .{ .ACCMODE = .RDONLY });
    if (fd < 0) return respond(conn, 200, fallback);
    defer _ = std.c.close(fd);
    var buf: [4096]u8 = undefined;
    var total: usize = 0;
    while (total < buf.len) {
        const n = std.c.read(fd, buf[total..].ptr, buf.len - total);
        if (n <= 0) break;
        total += @intCast(n);
    }
    if (total == 0) return respond(conn, 200, fallback);
    respond(conn, 200, buf[0..total]);
}

// ------------------------------------------------------------ http helpers

fn respond(conn: std.c.fd_t, status: u16, body: []const u8) void {
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

fn writeAll(conn: std.c.fd_t, bytes: []const u8) void {
    var off: usize = 0;
    while (off < bytes.len) {
        const n = std.c.write(conn, bytes.ptr + off, bytes.len - off);
        if (n <= 0) return;
        off += @intCast(n);
    }
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

/// Tiny extractor for the two flat shapes the hooks send. Not a JSON
/// parser: finds "key":"value" (no escape support needed, states are
/// enum words and bubble text is capped ASCII-ish) and "key":number.
/// Escaped quotes in bubble text truncate at the escape, which only
/// shortens the bubble, never corrupts memory.
fn jsonString(body: []const u8, key: []const u8) ?[]const u8 {
    var pat_buf: [32]u8 = undefined;
    const pat = std.fmt.bufPrint(&pat_buf, "\"{s}\"", .{key}) catch return null;
    const key_at = std.mem.indexOf(u8, body, pat) orelse return null;
    var i = key_at + pat.len;
    while (i < body.len and (body[i] == ' ' or body[i] == ':')) i += 1;
    if (i >= body.len or body[i] != '"') return null;
    i += 1;
    const val_start = i;
    while (i < body.len and body[i] != '"' and body[i] != '\\') i += 1;
    return body[val_start..i];
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
    var dir_buf: [512]u8 = undefined;
    const dir_z = std.fmt.bufPrintZ(&dir_buf, "{s}", .{server.runtime_dir}) catch return error.PathTooLong;
    _ = std.c.mkdir(dir_z, 0o755);
    var path_buf: [512]u8 = undefined;
    const path_z = std.fmt.bufPrintZ(&path_buf, "{s}/{s}", .{ server.runtime_dir, name }) catch return error.PathTooLong;
    const fd = std.c.open(path_z, .{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true }, @as(std.c.mode_t, mode));
    if (fd < 0) return error.OpenFailed;
    defer _ = std.c.close(fd);
    var off: usize = 0;
    while (off < bytes.len) {
        const n = std.c.write(fd, bytes.ptr + off, bytes.len - off);
        if (n <= 0) return error.WriteFailed;
        off += @intCast(n);
    }
}

fn mirrorState(server: *Server, state: []const u8, counter: u64) !void {
    var buf: [128]u8 = undefined;
    const json = try std.fmt.bufPrint(&buf, "{{\"state\":\"{s}\",\"counter\":{d}}}", .{ state, counter });
    try writeRuntimeFile(server, "state.json", json, 0o644);
}

fn mirrorBubble(server: *Server, text: []const u8, counter: u64) !void {
    var buf: [512]u8 = undefined;
    const json = try std.fmt.bufPrint(&buf, "{{\"text\":\"{s}\",\"counter\":{d},\"at\":{d}}}", .{ text, counter, nowMs() });
    try writeRuntimeFile(server, "bubble.json", json, 0o644);
}
