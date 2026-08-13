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
const max_request_bytes: usize = 8192;
const connection_timeout_ms: i64 = 5_000;

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
    /// Which conversation this bubble belongs to. Empty is the sentinel
    /// key an agent without a session_id lands on (older CLI, the MCP
    /// path), which is what keeps single-bubble behaviour identical.
    session: [64]u8 = @splat(0),
    session_len: usize = 0,
    origin_app: plat.OriginApplication = .none,
    source_tty: [64]u8 = @splat(0),
    source_tty_len: usize = 0,
    source_cwd: [512]u8 = @splat(0),
    source_cwd_len: usize = 0,
    herdr_pane: [64]u8 = @splat(0),
    herdr_pane_len: usize = 0,
    busy: bool = false,
    counter: u64 = 0,

    pub fn sessionSlice(self: *const Bubble) []const u8 {
        return self.session[0..self.session_len];
    }
    pub fn ttySlice(self: *const Bubble) []const u8 {
        return self.source_tty[0..self.source_tty_len];
    }
    pub fn cwdSlice(self: *const Bubble) []const u8 {
        return self.source_cwd[0..self.source_cwd_len];
    }
    pub fn herdrPaneSlice(self: *const Bubble) []const u8 {
        return self.herdr_pane[0..self.herdr_pane_len];
    }
};

/// How many conversations can narrate at once. Fixed because the
/// mailbox holds them inline: no allocator runs on the hook hot path.
pub const max_bubbles = 8;

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

/// Runtime mirrors perform filesystem I/O, so a spin lock would burn a CPU
/// while another hook waits for an atomic replace to finish. Use the SDK's
/// futex-backed Io mutex for that path; the mailbox/request locks remain
/// short spin locks because they never cross an I/O boundary.
const BlockingMutex = struct {
    inner: std.Io.Mutex = .init,

    fn lock(self: *BlockingMutex, io: std.Io) void {
        self.inner.lockUncancelable(io);
    }

    fn unlock(self: *BlockingMutex, io: std.Io) void {
        self.inner.unlock(io);
    }
};

pub const Mailbox = struct {
    mutex: SpinMutex = .{},
    pending: [max_pending]StateEvent = @splat(.{}),
    pending_len: usize = 0,
    last_enqueued: StateEvent = .{},
    /// One live bubble per conversation, keyed by session id. Slots
    /// below bubbles_len are occupied; the array is compacted on evict
    /// so the consumer copies a dense prefix.
    bubbles: [max_bubbles]Bubble = @splat(.{}),
    bubbles_len: usize = 0,
    bubbles_dirty: bool = false,
    /// Monotonic across every session, so a bubble's counter doubles as
    /// its LRU stamp: the smallest one is the least recently updated.
    bubble_counter: u64 = 0,
    state_counter: u64 = 0,

    pub const EnqueueResult = struct {
        queued: bool,
        counter: u64,
    };

    /// Coalesce + append, sidecar semantics: consecutive identical
    /// states collapse. Returns whether the event was queued.
    pub fn enqueue(self: *Mailbox, event: StateEvent) bool {
        return self.enqueueWithCounter(event).queued;
    }

    pub fn enqueueWithCounter(self: *Mailbox, event: StateEvent) EnqueueResult {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.pending_len > 0 or self.last_enqueued.state_len > 0) {
            if (std.mem.eql(u8, self.last_enqueued.slice(), event.slice())) {
                return .{ .queued = false, .counter = self.state_counter };
            }
        }
        if (self.pending_len >= max_pending) {
            return .{ .queued = false, .counter = self.state_counter };
        }
        self.pending[self.pending_len] = event;
        self.pending_len += 1;
        self.last_enqueued = event;
        self.state_counter += 1;
        return .{ .queued = true, .counter = self.state_counter };
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

    /// Update the bubble for `session`, or open a slot for it. A repeat
    /// session overwrites its own entry in place, which is what keeps
    /// two conversations from stepping on each other. When the set is
    /// full the least recently updated entry is evicted: an abandoned
    /// session must not hold a slot against a live one.
    pub fn setBubble(self: *Mailbox, session: []const u8, text: []const u8, agent: []const u8, title: []const u8, busy: bool) u64 {
        return self.setBubbleWithMetadata(session, text, agent, title, .none, "", "", "", busy);
    }

    pub fn setBubbleWithMetadata(self: *Mailbox, session: []const u8, text: []const u8, agent: []const u8, title: []const u8, origin_app: plat.OriginApplication, source_tty: []const u8, source_cwd: []const u8, herdr_pane: []const u8, busy: bool) u64 {
        self.mutex.lock();
        defer self.mutex.unlock();

        const slot = blk: {
            for (self.bubbles[0..self.bubbles_len]) |*b| {
                if (std.mem.eql(u8, b.sessionSlice(), session)) break :blk b;
            }
            if (self.bubbles_len < max_bubbles) {
                const b = &self.bubbles[self.bubbles_len];
                self.bubbles_len += 1;
                break :blk b;
            }
            var oldest = &self.bubbles[0];
            for (self.bubbles[1..self.bubbles_len]) |*b| {
                if (b.counter < oldest.counter) oldest = b;
            }
            break :blk oldest;
        };

        slot.* = .{};
        const sn = @min(session.len, slot.session.len);
        @memcpy(slot.session[0..sn], session[0..sn]);
        slot.session_len = sn;
        const n = @min(text.len, slot.text.len);
        @memcpy(slot.text[0..n], text[0..n]);
        slot.text_len = n;
        const an = @min(agent.len, slot.agent.len);
        @memcpy(slot.agent[0..an], agent[0..an]);
        slot.agent_len = an;
        const tn = @min(title.len, slot.title.len);
        @memcpy(slot.title[0..tn], title[0..tn]);
        slot.title_len = tn;
        slot.origin_app = origin_app;
        const tty_n = @min(source_tty.len, slot.source_tty.len);
        @memcpy(slot.source_tty[0..tty_n], source_tty[0..tty_n]);
        slot.source_tty_len = tty_n;
        const cwd_n = @min(source_cwd.len, slot.source_cwd.len);
        @memcpy(slot.source_cwd[0..cwd_n], source_cwd[0..cwd_n]);
        slot.source_cwd_len = cwd_n;
        const pane_n = @min(herdr_pane.len, slot.herdr_pane.len);
        @memcpy(slot.herdr_pane[0..pane_n], herdr_pane[0..pane_n]);
        slot.herdr_pane_len = pane_n;
        slot.busy = busy;

        self.bubble_counter += 1;
        slot.counter = self.bubble_counter;
        self.bubbles_dirty = true;
        return slot.counter;
    }

    /// Drain the whole set into `out`, returning how many slots landed.
    /// All-or-nothing rather than per-bubble: the consumer re-renders
    /// the stack as a unit, so a partial copy has no meaning.
    pub fn takeBubbles(self: *Mailbox, out: *[max_bubbles]Bubble) ?usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (!self.bubbles_dirty) return null;
        @memcpy(out[0..self.bubbles_len], self.bubbles[0..self.bubbles_len]);
        self.bubbles_dirty = false;
        return self.bubbles_len;
    }

    /// Drop a session's bubble once the app decides it has expired, so
    /// the slot is free for the next conversation. No dirty flag: the
    /// consumer already knows, it asked for this.
    pub fn dropBubble(self: *Mailbox, session: []const u8) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        for (self.bubbles[0..self.bubbles_len], 0..) |*b, i| {
            if (!std.mem.eql(u8, b.sessionSlice(), session)) continue;
            const last = self.bubbles_len - 1;
            if (i != last) self.bubbles[i] = self.bubbles[last];
            self.bubbles[last] = .{};
            self.bubbles_len = last;
            return;
        }
    }

    pub fn clearBubbles(self: *Mailbox) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.bubbles = @splat(.{});
        self.bubbles_len = 0;
        self.bubbles_dirty = false;
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
    mirror_lock: BlockingMutex = .{},
    last_state_mirror: u64 = 0,
    last_bubble_mirror: u64 = 0,
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
    stream.shutdown(io, .send) catch {};
    stream.close(io);
}

fn handleConnection(server: *Server, conn: *Conn) void {
    var buf: [max_request_bytes]u8 = undefined;
    var total: usize = 0;
    var header_end: ?usize = null;
    const timeout = (std.Io.Timeout{ .duration = .{
        .raw = std.Io.Duration.fromMilliseconds(connection_timeout_ms),
        .clock = .awake,
    } }).toDeadline(conn.io);

    // Read the complete header with a bounded deadline. A hook host can
    // disappear after opening a socket, so no connection may wait forever.
    while (header_end == null) {
        if (total == buf.len) {
            respond(conn, 413, "{\"ok\":false,\"error\":\"headers_too_large\"}");
            return;
        }
        const got = receiveWithTimeout(conn, buf[total..], timeout) catch return;
        if (got == 0) return;
        total += got;
        header_end = if (std.mem.indexOf(u8, buf[0..total], "\r\n\r\n")) |at| at + 4 else null;
    }

    const head_len = header_end.?;
    const head = buf[0..head_len];
    const content_length = if (headerValue(head, "content-length")) |raw| std.fmt.parseInt(usize, raw, 10) catch {
        respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_content_length\"}");
        return;
    } else 0;
    if (content_length > buf.len - head_len) {
        respond(conn, 413, "{\"ok\":false,\"error\":\"body_too_large\"}");
        return;
    }
    const request_len = head_len + content_length;
    while (total < request_len) {
        const got = receiveWithTimeout(conn, buf[total..request_len], timeout) catch return;
        if (got == 0) return;
        total += got;
    }
    const body = buf[head_len..request_len];

    var line_it = std.mem.splitSequence(u8, head, "\r\n");
    const request_line = line_it.next() orelse return;
    var part_it = std.mem.splitScalar(u8, request_line, ' ');
    const method = part_it.next() orelse return;
    const target = part_it.next() orelse return;
    const path = if (std.mem.indexOfScalar(u8, target, '?')) |q| target[0..q] else target;

    route(server, conn, method, path, head, body);
}

fn receiveWithTimeout(conn: *Conn, buffer: []u8, timeout: std.Io.Timeout) !usize {
    const message = try conn.stream.socket.receiveTimeout(conn.io, buffer, timeout);
    return message.data.len;
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
        switch (parseDuration(body)) {
            .missing => {},
            .invalid => return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_duration\"}"),
            .value => |value| duration = value,
        }

        // Sidecar's sprite variation: bare "running" alternates
        // left/right per session so consecutive tool calls vary.
        var applied: []const u8 = state_raw;
        if (std.mem.eql(u8, state_raw, "running")) {
            applied = server.nextRunningState();
        }

        var event = StateEvent{ .duration_ms = duration };
        event.state_len = applied.len;
        @memcpy(event.state[0..applied.len], applied);
        const enqueue_result = mailbox.enqueueWithCounter(event);
        mirrorQueuedState(server, applied, enqueue_result) catch {};

        const dur_out: i64 = if (duration == 0) -1 else @intCast(duration);
        const out = if (dur_out < 0)
            std.fmt.bufPrint(&scratch, "{{\"ok\":true,\"state\":\"{s}\",\"duration\":null,\"queued\":{}}}", .{ state_raw, enqueue_result.queued }) catch return
        else
            std.fmt.bufPrint(&scratch, "{{\"ok\":true,\"state\":\"{s}\",\"duration\":{d},\"queued\":{}}}", .{ state_raw, dur_out, enqueue_result.queued }) catch return;
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
        const origin_app = plat.OriginApplication.fromTermProgram(jsonString(body, "source_app"));
        const source_tty = plat.safeSourceTty(jsonString(body, "source_tty")) orelse "";
        const source_cwd = plat.safeSourceCwd(jsonString(body, "source_cwd")) orelse "";
        const herdr_pane = plat.safeHerdrPaneId(jsonString(body, "herdr_pane_id")) orelse "";
        const busy = std.mem.indexOf(u8, body, "\"busy\":true") != null;
        // Canonical conversation metadata wins over raw continuation/session
        // ids. Arbitrary provider keys are normalized to the mailbox's fixed
        // 64-byte key instead of being truncated into possible collisions.
        var session_hash: [64]u8 = undefined;
        const session = bubbleSessionKey(body, &session_hash);
        const counter = mailbox.setBubbleWithMetadata(session, capped, agent[0..@min(agent.len, 24)], title[0..@min(title.len, 96)], origin_app, source_tty, source_cwd, herdr_pane, busy);
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

const JsonFieldStart = union(enum) {
    missing,
    invalid,
    value: usize,
};

const JsonNumberResult = union(enum) {
    missing,
    invalid,
    value: f64,
};

const DurationResult = union(enum) {
    missing,
    invalid,
    value: u32,
};

fn skipJsonWhitespace(body: []const u8, offset: usize) usize {
    var i = offset;
    while (i < body.len and (body[i] == ' ' or body[i] == '\t' or body[i] == '\r' or body[i] == '\n')) i += 1;
    return i;
}

fn jsonFieldStart(body: []const u8, key: []const u8) JsonFieldStart {
    var pat_buf: [32]u8 = undefined;
    const pat = std.fmt.bufPrint(&pat_buf, "\"{s}\"", .{key}) catch return .invalid;
    var search: usize = 0;
    while (search < body.len) {
        const relative = std.mem.indexOf(u8, body[search..], pat) orelse return .missing;
        const key_at = search + relative;
        var before = key_at;
        while (before > 0 and (body[before - 1] == ' ' or body[before - 1] == '\t' or body[before - 1] == '\r' or body[before - 1] == '\n')) before -= 1;
        if (before == 0 or body[before - 1] == '{' or body[before - 1] == ',') {
            const after_key = skipJsonWhitespace(body, key_at + pat.len);
            if (after_key >= body.len or body[after_key] != ':') return .invalid;
            return .{ .value = skipJsonWhitespace(body, after_key + 1) };
        }
        search = key_at + pat.len;
    }
    return .missing;
}

fn scanJsonNumber(body: []const u8, offset: usize) ?usize {
    var i = offset;
    if (i >= body.len) return null;
    if (body[i] == '-') {
        i += 1;
        if (i >= body.len) return null;
    }

    if (body[i] == '0') {
        i += 1;
        if (i < body.len and std.ascii.isDigit(body[i])) return null;
    } else if (body[i] >= '1' and body[i] <= '9') {
        i += 1;
        while (i < body.len and std.ascii.isDigit(body[i])) i += 1;
    } else {
        return null;
    }

    if (i < body.len and body[i] == '.') {
        i += 1;
        const fraction_start = i;
        while (i < body.len and std.ascii.isDigit(body[i])) i += 1;
        if (i == fraction_start) return null;
    }

    if (i < body.len and (body[i] == 'e' or body[i] == 'E')) {
        i += 1;
        if (i < body.len and (body[i] == '+' or body[i] == '-')) i += 1;
        const exponent_start = i;
        while (i < body.len and std.ascii.isDigit(body[i])) i += 1;
        if (i == exponent_start) return null;
    }

    if (i < body.len and body[i] != ' ' and body[i] != '\t' and body[i] != '\r' and body[i] != '\n' and body[i] != ',' and body[i] != '}' and body[i] != ']') return null;
    return i;
}

fn jsonNumberResult(body: []const u8, key: []const u8) JsonNumberResult {
    const value_start = switch (jsonFieldStart(body, key)) {
        .missing => return .missing,
        .invalid => return .invalid,
        .value => |value| value,
    };
    const end = scanJsonNumber(body, value_start) orelse return .invalid;
    const value = std.fmt.parseFloat(f64, body[value_start..end]) catch return .invalid;
    if (!std.math.isFinite(value)) return .invalid;
    return .{ .value = value };
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
    var closed = false;
    while (i < body.len) {
        if (body[i] == '\\') {
            if (i + 1 >= body.len) return null;
            switch (body[i + 1]) {
                '"', '\\', '/', 'b', 'f', 'n', 'r', 't' => i += 2,
                'u' => {
                    if (i + 6 > body.len) return null;
                    for (body[i + 2 .. i + 6]) |digit| {
                        if (!std.ascii.isHex(digit)) return null;
                    }
                    i += 6;
                },
                else => return null,
            }
            continue;
        }
        if (body[i] == '"') {
            closed = true;
            break;
        }
        if (body[i] < 0x20) return null;
        i += 1;
    }
    if (!closed) return null;
    return body[val_start..i];
}

fn normalizeBubbleSession(raw: ?[]const u8, hash_buf: *[64]u8) ?[]const u8 {
    const value = raw orelse return null;
    if (value.len == 0) return null;
    if (value.len <= 64) {
        var safe = true;
        for (value) |c| {
            if (!(std.ascii.isAlphanumeric(c) or c == '-' or c == '_' or c == '.')) {
                safe = false;
                break;
            }
        }
        if (safe) return value;
    }
    var digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(value, &digest, .{});
    hash_buf.* = std.fmt.bytesToHex(digest, .lower);
    return hash_buf;
}

fn bubbleSessionKey(body: []const u8, hash_buf: *[64]u8) []const u8 {
    if (normalizeBubbleSession(jsonString(body, "conversation_key"), hash_buf)) |key| return key;
    if (normalizeBubbleSession(jsonString(body, "petdex_conversation_key"), hash_buf)) |key| return key;
    if (normalizeBubbleSession(jsonString(body, "session_key"), hash_buf)) |key| return key;
    return normalizeBubbleSession(jsonString(body, "session_id"), hash_buf) orelse "";
}

test "bubble session key prefers and normalizes canonical conversations" {
    var hash: [64]u8 = undefined;
    try std.testing.expectEqualStrings("stable-key", bubbleSessionKey(
        "{\"session_id\":\"raw-turn\",\"conversation_key\":\"stable-key\"}",
        &hash,
    ));
    const long = "gateway/conversation/key/whose/provider-spelling-is-longer-than-the-mailbox-slot";
    var body_buf: [256]u8 = undefined;
    const body = try std.fmt.bufPrint(&body_buf, "{{\"conversation_key\":\"{s}\"}}", .{long});
    const normalized = bubbleSessionKey(body, &hash);
    try std.testing.expectEqual(@as(usize, 64), normalized.len);
    try std.testing.expect(!std.mem.eql(u8, normalized, long[0..64]));
}

test "two sessions hold two bubbles and neither overwrites the other" {
    var mb: Mailbox = .{};
    _ = mb.setBubble("alpha", "reading main.zig", "claude-code", "Fix the tail", true);
    _ = mb.setBubble("beta", "running tests", "codex", "Ship it", true);

    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, 2), mb.takeBubbles(&out));
    try std.testing.expectEqualStrings("reading main.zig", out[0].text[0..out[0].text_len]);
    try std.testing.expectEqualStrings("running tests", out[1].text[0..out[1].text_len]);

    // Updating alpha must leave beta exactly as it was, including its
    // counter: that is the acceptance criterion the single slot broke.
    const beta_counter = out[1].counter;
    _ = mb.setBubble("alpha", "done", "claude-code", "Fix the tail", false);
    try std.testing.expectEqual(@as(?usize, 2), mb.takeBubbles(&out));
    try std.testing.expectEqualStrings("done", out[0].text[0..out[0].text_len]);
    try std.testing.expect(!out[0].busy);
    try std.testing.expectEqualStrings("running tests", out[1].text[0..out[1].text_len]);
    try std.testing.expect(out[1].busy);
    try std.testing.expectEqual(beta_counter, out[1].counter);
}

test "bubble metadata preserves the Herdr pane id" {
    var mb: Mailbox = .{};
    _ = mb.setBubbleWithMetadata("herdr:w1:p5", "Needs approval", "cursor", "Fix auth", .terminal, "", "/repo", "w1:p5", false);

    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, 1), mb.takeBubbles(&out));
    try std.testing.expectEqualStrings("w1:p5", out[0].herdrPaneSlice());
}

test "a sessionless agent keeps the single shared slot" {
    var mb: Mailbox = .{};
    _ = mb.setBubble("", "first", "codex", "", true);
    _ = mb.setBubble("", "second", "codex", "", false);

    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, 1), mb.takeBubbles(&out));
    try std.testing.expectEqualStrings("second", out[0].text[0..out[0].text_len]);
}

test "a full set evicts the least recently updated session" {
    var mb: Mailbox = .{};
    var key: [max_bubbles][2]u8 = undefined;
    for (0..max_bubbles) |i| {
        key[i] = .{ 's', '0' + @as(u8, @intCast(i)) };
        _ = mb.setBubble(&key[i], "hello", "codex", "", true);
    }
    // s0 is the oldest by counter, so touching s1 must make s0 the one
    // that loses its slot to the newcomer.
    _ = mb.setBubble(&key[1], "still here", "codex", "", true);
    _ = mb.setBubble("newcomer", "just arrived", "codex", "", true);

    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, max_bubbles), mb.takeBubbles(&out));
    var saw_s0 = false;
    var saw_new = false;
    for (out[0..max_bubbles]) |b| {
        if (std.mem.eql(u8, b.sessionSlice(), "s0")) saw_s0 = true;
        if (std.mem.eql(u8, b.sessionSlice(), "newcomer")) saw_new = true;
    }
    try std.testing.expect(!saw_s0);
    try std.testing.expect(saw_new);
}

test "takeBubbles only reports a set that changed" {
    var mb: Mailbox = .{};
    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, null), mb.takeBubbles(&out));
    _ = mb.setBubble("alpha", "hello", "codex", "", true);
    try std.testing.expectEqual(@as(?usize, 1), mb.takeBubbles(&out));
    try std.testing.expectEqual(@as(?usize, null), mb.takeBubbles(&out));
}

test "dropping a session frees its slot and keeps the rest dense" {
    var mb: Mailbox = .{};
    _ = mb.setBubble("alpha", "a", "codex", "", true);
    _ = mb.setBubble("beta", "b", "codex", "", true);
    _ = mb.setBubble("gamma", "c", "codex", "", true);
    mb.dropBubble("beta");

    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, 2), mb.takeBubbles(&out));
    for (out[0..2]) |b| {
        try std.testing.expect(!std.mem.eql(u8, b.sessionSlice(), "beta"));
        try std.testing.expect(b.text_len > 0);
    }
    mb.dropBubble("nobody");
    _ = mb.takeBubbles(&out);
    mb.clearBubbles();
    try std.testing.expectEqual(@as(?usize, null), mb.takeBubbles(&out));
}

test "json string scanner preserves escaped multiline content" {
    const body = "{\"last_assistant_message\":\"first\\nsecond third\",\"phase\":\"stop\"}";
    try std.testing.expectEqualStrings("first\\nsecond third", jsonString(body, "last_assistant_message").?);
}

test "json string scanner rejects malformed mirror input" {
    try std.testing.expect(jsonString("{\"text\":\"unterminated}", "text") == null);
    try std.testing.expect(jsonString("{\"text\":\"bad\\x\"}", "text") == null);
    try std.testing.expect(jsonString("{\"text\":\"bad\nline\"}", "text") == null);
}

test "json number scanner validates complete JSON numbers" {
    try std.testing.expectEqual(@as(f64, 1000), jsonNumber("{\"duration\":1e3}", "duration").?);
    try std.testing.expectEqual(@as(f64, -0.25), jsonNumber("{\"duration\":-0.25}", "duration").?);
    try std.testing.expect(jsonNumber("{\"duration\":1-2}", "duration") == null);
    try std.testing.expect(jsonNumber("{\"duration\":\"100\"}", "duration") == null);
}

test "duration parser distinguishes missing and invalid values" {
    try std.testing.expect(std.meta.activeTag(parseDuration("{}")) == .missing);
    try std.testing.expect(switch (parseDuration("{\"duration\":1e3}")) {
        .value => |value| value == 1000,
        else => false,
    });
    try std.testing.expect(std.meta.activeTag(parseDuration("{\"duration\":-1}")) == .invalid);
    try std.testing.expect(std.meta.activeTag(parseDuration("{\"duration\":\"100\"}")) == .invalid);
}

test "mailbox returns the counter while holding its lock" {
    var box: Mailbox = .{};
    var event = StateEvent{};
    event.state_len = 4;
    @memcpy(event.state[0..4], "idle");
    const first = box.enqueueWithCounter(event);
    try std.testing.expect(first.queued);
    try std.testing.expectEqual(@as(u64, 1), first.counter);
    const duplicate = box.enqueueWithCounter(event);
    try std.testing.expect(!duplicate.queued);
    try std.testing.expectEqual(@as(u64, 1), duplicate.counter);
}

test "unqueued state never reaches the runtime mirror" {
    var server = Server{
        .allocator = std.testing.allocator,
        .runtime_dir = "",
        .token = undefined,
        .pid = 0,
    };
    try mirrorQueuedState(&server, "failed", .{ .queued = false, .counter = 5 });
    try std.testing.expectEqual(@as(u64, 0), server.last_state_mirror);
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
    return switch (jsonNumberResult(body, key)) {
        .value => |value| value,
        .missing, .invalid => null,
    };
}

fn parseDuration(body: []const u8) DurationResult {
    return switch (jsonNumberResult(body, "duration")) {
        .missing => .missing,
        .invalid => .invalid,
        .value => |duration| {
            if (duration < 0) return .invalid;
            return .{ .value = @intFromFloat(@min(duration, 30_000)) };
        },
    };
}

// --------------------------------------------------------- runtime files

fn writeRuntimeFile(server: *Server, name: []const u8, bytes: []const u8, mode: u16) !void {
    plat.makeDir(server.runtime_dir);
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ server.runtime_dir, name }) catch return error.PathTooLong;
    // The 0600 on update-token is a POSIX guarantee only; on Windows
    // the file inherits the parent ACL (see plat.permissionsFromMode).
    if (!plat.writeFileMode(path, bytes, mode)) return error.WriteFailed;
}

fn mirrorState(server: *Server, state: []const u8, counter: u64) !void {
    var scope = plat.Scope.init();
    defer scope.deinit();
    const io = scope.io();
    server.mirror_lock.lock(io);
    defer server.mirror_lock.unlock(io);
    if (counter < server.last_state_mirror) return;
    var buf: [128]u8 = undefined;
    const json = try std.fmt.bufPrint(&buf, "{{\"state\":\"{s}\",\"counter\":{d}}}", .{ state, counter });
    try writeRuntimeFile(server, "state.json", json, 0o644);
    server.last_state_mirror = counter;
}

fn mirrorQueuedState(server: *Server, state: []const u8, result: Mailbox.EnqueueResult) !void {
    if (!result.queued) return;
    try mirrorState(server, state, result.counter);
}

fn mirrorBubble(server: *Server, text: []const u8, counter: u64, title: []const u8, agent: []const u8, busy: bool) !void {
    var scope = plat.Scope.init();
    defer scope.deinit();
    const io = scope.io();
    server.mirror_lock.lock(io);
    defer server.mirror_lock.unlock(io);
    if (counter < server.last_bubble_mirror) return;
    var buf: [1024]u8 = undefined;
    const json = try std.fmt.bufPrint(&buf, "{{\"text\":\"{s}\",\"title\":\"{s}\",\"agent_source\":\"{s}\",\"busy\":{},\"counter\":{d},\"at\":{d}}}", .{ text, title, agent, busy, counter, nowMs() });
    try writeRuntimeFile(server, "bubble.json", json, 0o644);
    server.last_bubble_mirror = counter;
}
