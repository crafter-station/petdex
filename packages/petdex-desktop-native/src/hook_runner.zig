//! petdex-hook: the bubble runner living INSIDE the app binary.
//!
//! Agent hooks invoke `petdex-hook bubble <phase> <agent>` (a stable
//! symlink to this binary) with the hook payload on stdin. This is the
//! hot path — it runs 20-50 times per active session — so it must cost
//! native-binary startup, not a node cold start, and it must never
//! stain the agent: every failure exits 0 silently.
//!
//! A line-for-line port of the CLI's bubble-runner.ts + templates
//! (kept in parity by the tests at the bottom, which mirror the TS
//! suite's expectations). Extraction uses the hook server's flat JSON scan:
//! hook payloads never repeat our keys across nesting levels.

const std = @import("std");
const hook_server = @import("hook_server.zig");
const plat = @import("plat.zig");

const jsonString = hook_server.jsonStringPub;

const stdin_cap = 64 * 1024;
const title_max = 60;
const preview_max = 110;
const transcript_tail_cap = 64 * 1024;
const session_ttl_secs: i64 = 24 * 60 * 60;
const post_timeout_ms: u64 = 300;
const post_poll_ms: u64 = 5;

// ------------------------------------------------------------- entry

/// argv tail after "bubble": [phase, agent?]. Reads stdin, formats,
/// POSTs bubble + state to the in-process hook server. Never fails outward.
pub fn run(phase: []const u8, arg_agent: ?[]const u8, home: []const u8) void {
    // Always finish consuming the host's payload before any early return.
    // The host may still be writing after the useful 64 KiB prefix, and
    // closing the read end early propagates EPIPE/Broken pipe to the agent.
    var stdin_buf: [stdin_cap]u8 = undefined;
    const payload = readStdin(&stdin_buf);

    var path_buf: [512]u8 = undefined;
    var probe: [1]u8 = undefined;

    // Killswitch remains a cheap no-op after the mandatory stdin drain.
    if (std.fmt.bufPrint(&path_buf, "{s}/.petdex/runtime/hooks-disabled", .{home})) |ks| {
        if (cReadFile(ks, &probe) != null) return;
    } else |_| {}

    var token_buf: [128]u8 = undefined;
    const token_raw = blk: {
        const tp = std.fmt.bufPrint(&path_buf, "{s}/.petdex/runtime/update-token", .{home}) catch break :blk null;
        break :blk cReadFile(tp, &token_buf);
    } orelse return;
    const token = std.mem.trim(u8, token_raw, " \t\r\n");
    if (token.len == 0) return;

    const agent = jsonString(payload, "agent_source") orelse (arg_agent orelse "");
    const session_id = safeSessionId(jsonString(payload, "session_id"));

    // Session title: user-prompt seeds it, every event attaches it.
    var sessions_buf: [512]u8 = undefined;
    const sessions_dir = std.fmt.bufPrint(&sessions_buf, "{s}/.petdex/runtime/sessions", .{home}) catch return;
    if (session_id) |sid| {
        if (isPromptPhase(phase)) {
            if (jsonString(payload, "prompt")) |prompt| rememberTitle(sessions_dir, sid, prompt);
        }
    }
    var title_buf: [256]u8 = undefined;
    const title: []const u8 = if (session_id) |sid| (readTitle(sessions_dir, sid, &title_buf) orelse "") else "";

    var text_buf: [256]u8 = undefined;
    var text = formatBubble(phase, payload, &text_buf) orelse "";

    var preview_buf: [512]u8 = undefined;
    var tail_buf: [transcript_tail_cap]u8 = undefined;
    if (isStopPhase(phase)) {
        // Close-of-turn preview: Codex ships last_assistant_message in
        // the payload; Claude Code needs the bounded transcript tail.
        const written: ?[]const u8 = jsonString(payload, "last_assistant_message") orelse blk: {
            const tp = jsonString(payload, "transcript_path") orelse break :blk null;
            const tail = cReadTail(tp, &tail_buf) orelse break :blk null;
            break :blk lastAssistantFromTail(tail);
        };
        if (written) |w| {
            if (clipEscaped(w, preview_max, &preview_buf)) |p| {
                if (p.len > 0) text = p;
            }
        }
        pruneSessions(sessions_dir);
    }

    // A failed tool does not end the turn — the agent reacts to the error and
    // keeps working — so the bubble keeps its spinner, same as `post`.
    const busy = isPromptPhase(phase) or std.mem.eql(u8, phase, "pre") or
        std.mem.eql(u8, phase, "post") or isToolFailurePhase(phase);
    const state = stateForEvent(phase, jsonString(payload, "tool_name"));

    var posts: [2]PostJob = undefined;
    var post_count: usize = 0;
    var body_buf: [1024]u8 = undefined;
    if (text.len > 0) {
        const body = if (title.len > 0)
            std.fmt.bufPrint(&body_buf, "{{\"text\":\"{s}\",\"title\":\"{s}\",\"busy\":{},\"agent_source\":\"{s}\"}}", .{ text, title, busy, agent }) catch null
        else
            std.fmt.bufPrint(&body_buf, "{{\"text\":\"{s}\",\"busy\":{},\"agent_source\":\"{s}\"}}", .{ text, busy, agent }) catch null;
        if (body) |b| {
            if (startPost("/bubble", b, token)) |post| {
                posts[post_count] = post;
                post_count += 1;
            }
        }
    }
    if (state) |s| {
        const duration_ms: u32 = if (isToolFailurePhase(phase)) failed_duration_ms else 0;
        const body = stateBody(&body_buf, s, duration_ms, agent);
        if (body) |b| {
            if (startPost("/state", b, token)) |post| {
                posts[post_count] = post;
                post_count += 1;
            }
        }
    }
    waitForPosts(posts[0..post_count]);
}

fn isPromptPhase(phase: []const u8) bool {
    return std.mem.eql(u8, phase, "user-prompt") or std.mem.eql(u8, phase, "session-start");
}

fn isStopPhase(phase: []const u8) bool {
    return std.mem.eql(u8, phase, "stop") or std.mem.eql(u8, phase, "session-end");
}

fn isToolFailurePhase(phase: []const u8) bool {
    return std.mem.eql(u8, phase, "tool-failure");
}

/// The /state request body. Extracted and pure for one reason: `run()` reaches
/// stdin, the token file and a socket, so a body built inline there is
/// unreachable from `zig test`. One format string with an optional fragment
/// means duration_ms == 0 provably renders exactly what shipped before this
/// phase existed — byte-identity for every other agent is structural, not a
/// promise someone has to keep across future edits.
pub fn stateBody(out: []u8, state: []const u8, duration_ms: u32, agent: []const u8) ?[]const u8 {
    var dur_buf: [24]u8 = undefined;
    const dur: []const u8 = if (duration_ms > 0)
        (std.fmt.bufPrint(&dur_buf, ",\"duration\":{d}", .{duration_ms}) catch return null)
    else
        "";
    return std.fmt.bufPrint(out, "{{\"state\":\"{s}\"{s},\"agent_source\":\"{s}\"}}", .{ state, dur, agent }) catch null;
}

// ------------------------------------------------------- state mapping

/// `failed` is a duration state (main.zig isDurationState), so it reverts to
/// idle once its dwell expires — and dwellFor(.failed, 0) yields only the 250ms
/// floor against a 1220ms animation, about two of eight frames. The tool-failure
/// POST therefore carries an explicit duration. 1220 is `failed`'s durationMs in
/// src/lib/pet-states.ts, not a magic number.
pub const failed_duration_ms: u32 = 1220;

/// Port of stateForEvent: phase + tool → sprite state.
pub fn stateForEvent(phase: []const u8, tool_name: ?[]const u8) ?[]const u8 {
    if (std.mem.eql(u8, phase, "pre")) {
        if (tool_name) |name| {
            if (asciiEqlLower(name, "read") or asciiEqlLower(name, "grep") or asciiEqlLower(name, "glob")) return "review";
        }
        return "running";
    }
    if (std.mem.eql(u8, phase, "post")) return "idle";
    if (isToolFailurePhase(phase)) return "failed";
    if (isStopPhase(phase)) return "waving";
    if (isPromptPhase(phase)) return "jumping";
    if (std.mem.eql(u8, phase, "waiting") or std.mem.eql(u8, phase, "notification")) return "waiting";
    return null;
}

// ---------------------------------------------------------- templates

/// Port of formatBubble. Writes into `out`, returns the rendered text
/// (raw JSON-escaped content passes through untouched so it can be
/// re-embedded into the POST body).
pub fn formatBubble(phase: []const u8, payload: []const u8, out: []u8) ?[]const u8 {
    if (isPromptPhase(phase)) return "Thinking…";
    if (isStopPhase(phase)) return "Done.";
    if (std.mem.eql(u8, phase, "waiting") or std.mem.eql(u8, phase, "notification")) return "Waiting for you…";
    // Tool name only, never the payload's `error` string. jsonString stops at
    // the first `"` or `\` and decodes neither, and error text routinely carries
    // both; tool_name is a controlled identifier from the agent's own registry.
    if (isToolFailurePhase(phase)) {
        const failed_tool = jsonString(payload, "tool_name") orelse return "Tool failed";
        return fmt2(out, clipRaw(failed_tool, 28), " failed");
    }

    const running = std.mem.eql(u8, phase, "pre");
    const done = std.mem.eql(u8, phase, "post");
    if (!running and !done) return null;

    const tool = jsonString(payload, "tool_name") orelse "tool";

    if (asciiEqlLower(tool, "read")) {
        if (pathField(payload)) |p| return fmt2(out, if (done) "Read " else "Reading ", clipBase(p, 40));
        return if (done) "Read file" else "Reading file";
    }
    if (asciiEqlLower(tool, "edit") or asciiEqlLower(tool, "multiedit") or asciiEqlLower(tool, "write")) {
        if (pathField(payload)) |p| return fmt2(out, if (done) "Edited " else "Editing ", clipBase(p, 40));
        return if (done) "Edited file" else "Editing file";
    }
    if (asciiEqlLower(tool, "bash") or asciiEqlLower(tool, "shell")) {
        if (jsonString(payload, "description")) |d| {
            var clip_buf: [200]u8 = undefined;
            if (clipEscaped(d, 40, &clip_buf)) |c| {
                if (c.len > 0) return fmt2(out, "", c);
            }
        }
        if (jsonString(payload, "command")) |cmd| {
            const head = firstWord(cmd, 24);
            if (head.len > 0) return fmt2(out, if (done) "Ran " else "Running ", head);
        }
        return if (done) "Ran command" else "Running command";
    }
    if (asciiEqlLower(tool, "grep")) {
        // Curly quotes, not ASCII ones: the bubble text is embedded raw
        // into the POST body and read back out by hook_server's scanner,
        // and neither step decodes escapes. A bare `"` closed the JSON
        // string early and the pattern never reached the bubble; an
        // escaped `\"` fares no better, since the reader stops at the
        // backslash too.
        if (jsonString(payload, "pattern")) |p| return fmt3(out, if (done) "Searched “" else "Searching “", clipRaw(p, 28), "”");
        return if (done) "Searched files" else "Searching files";
    }
    if (asciiEqlLower(tool, "glob")) {
        if (jsonString(payload, "pattern")) |p| return fmt2(out, if (done) "Listed " else "Listing ", clipRaw(p, 28));
        return if (done) "Listed files" else "Listing files";
    }
    if (asciiEqlLower(tool, "webfetch") or asciiEqlLower(tool, "websearch")) {
        if (jsonString(payload, "url")) |u| {
            if (hostOf(u)) |h| return fmt2(out, if (done) "Fetched " else "Fetching ", clipRaw(h, 28));
        }
        return if (done) "Fetched web" else "Searching web";
    }
    if (asciiEqlLower(tool, "task") or asciiEqlLower(tool, "agent")) {
        if (done) return "Subagent done";
        if (jsonString(payload, "description") orelse jsonString(payload, "subject")) |d| return fmt2(out, "Spawning ", clipRaw(d, 28));
        return "Spawning subagent";
    }
    return fmt2(out, if (done) "Called " else "Calling ", clipRaw(tool, 28));
}

fn pathField(payload: []const u8) ?[]const u8 {
    return jsonString(payload, "file_path") orelse jsonString(payload, "path");
}

fn fmt2(out: []u8, prefix: []const u8, rest: []const u8) ?[]const u8 {
    return std.fmt.bufPrint(out, "{s}{s}", .{ prefix, rest }) catch null;
}

fn fmt3(out: []u8, prefix: []const u8, mid: []const u8, suffix: []const u8) ?[]const u8 {
    return std.fmt.bufPrint(out, "{s}{s}{s}", .{ prefix, mid, suffix }) catch null;
}

/// basename + clip to `max` (raw clip; paths have no JSON escapes
/// worth preserving beyond the boundary rule handled by clipRaw).
fn clipBase(path: []const u8, max: usize) []const u8 {
    var base = path;
    if (std.mem.lastIndexOfAny(u8, path, "/\\")) |i| base = path[i + 1 ..];
    return clipRaw(base, max);
}

/// Clip WITHOUT an ellipsis marker, on a safe boundary: never mid
/// UTF-8 sequence, never splitting a JSON escape.
fn clipRaw(text: []const u8, max: usize) []const u8 {
    if (text.len <= max) return text;
    return text[0..safeBoundary(text, max)];
}

/// Escaped-content-aware flatten+clip into `buf`: JSON escape
/// sequences for whitespace (\n, \t, \r) become spaces, runs of
/// spaces collapse, and the cut lands on a safe boundary.
pub fn clipEscaped(text: []const u8, max: usize, buf: []u8) ?[]const u8 {
    var w: usize = 0;
    var i: usize = 0;
    var last_space = true;
    while (i < text.len and w < buf.len) {
        var ch = text[i];
        var advance: usize = 1;
        if (ch == '\\' and i + 1 < text.len) {
            const esc = text[i + 1];
            if (esc == 'n' or esc == 't' or esc == 'r') {
                ch = ' ';
                advance = 2;
            } else {
                // Any other escape passes through whole.
                if (w + 2 > buf.len) break;
                buf[w] = '\\';
                buf[w + 1] = esc;
                w += 2;
                i += 2;
                last_space = false;
                continue;
            }
        }
        if (ch == ' ' or ch == '\t') {
            if (!last_space) {
                buf[w] = ' ';
                w += 1;
            }
            last_space = true;
        } else {
            buf[w] = ch;
            w += 1;
            last_space = false;
        }
        i += advance;
    }
    var result = std.mem.trim(u8, buf[0..w], " ");
    if (result.len > max) result = result[0..safeBoundary(result, max)];
    return result;
}

/// Largest cut <= max that neither splits a UTF-8 sequence nor a JSON
/// escape (an odd run of trailing backslashes).
fn safeBoundary(text: []const u8, max: usize) usize {
    var cut = @min(max, text.len);
    while (cut > 0 and (text[cut] & 0xC0) == 0x80) cut -= 1;
    var backslashes: usize = 0;
    while (cut > backslashes and text[cut - 1 - backslashes] == '\\') backslashes += 1;
    if (backslashes % 2 == 1) cut -= 1;
    return cut;
}

fn firstWord(text: []const u8, max: usize) []const u8 {
    var end: usize = 0;
    while (end < text.len and text[end] != ' ' and text[end] != '\t' and !(text[end] == '\\' and end + 1 < text.len and (text[end + 1] == 'n' or text[end + 1] == 't'))) end += 1;
    return clipRaw(text[0..end], max);
}

fn hostOf(url: []const u8) ?[]const u8 {
    const scheme = std.mem.indexOf(u8, url, "://") orelse return null;
    const rest = url[scheme + 3 ..];
    var end: usize = 0;
    while (end < rest.len and rest[end] != '/' and rest[end] != ':' and rest[end] != '?') end += 1;
    if (end == 0) return null;
    return rest[0..end];
}

fn asciiEqlLower(text: []const u8, lower: []const u8) bool {
    if (text.len != lower.len) return false;
    for (text, lower) |a, b| {
        if (std.ascii.toLower(a) != b) return false;
    }
    return true;
}

// ------------------------------------------------------ session titles

fn safeSessionId(raw: ?[]const u8) ?[]const u8 {
    const sid = raw orelse return null;
    if (sid.len == 0 or sid.len > 64) return null;
    for (sid) |c| {
        if (!(std.ascii.isAlphanumeric(c) or c == '-' or c == '_')) return null;
    }
    return sid;
}

fn rememberTitle(dir: []const u8, session_id: []const u8, prompt: []const u8) void {
    plat.makeDir(dir);
    var title_buf: [256]u8 = undefined;
    const title = clipEscaped(prompt, title_max, &title_buf) orelse return;
    if (title.len == 0) return;
    var path_buf: [512]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/{s}.json", .{ dir, session_id }) catch return;
    var json_buf: [512]u8 = undefined;
    const json = std.fmt.bufPrint(&json_buf, "{{\"title\":\"{s}\",\"at\":{d}}}", .{ title, plat.nowSeconds() }) catch return;
    cWriteFile(path, json);
}

fn readTitle(dir: []const u8, session_id: []const u8, buf: *[256]u8) ?[]const u8 {
    var path_buf: [512]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/{s}.json", .{ dir, session_id }) catch return null;
    var file_buf: [512]u8 = undefined;
    const json = cReadFile(path, &file_buf) orelse return null;
    const title = jsonString(json, "title") orelse return null;
    if (title.len == 0 or title.len > buf.len) return null;
    @memcpy(buf[0..title.len], title);
    return buf[0..title.len];
}

const PruneCtx = struct {
    dir: []const u8,
    now: i64,
    // Deleting through the handle being iterated is not portable, so
    // expired names are staged here and unlinked after the walk. A
    // session dir past this many files just prunes on the next run.
    stale: [64][std.Io.Dir.max_name_bytes]u8 = undefined,
    stale_len: [64]usize = @splat(0),
    count: usize = 0,
};

fn pruneVisit(ctx: *PruneCtx, name: []const u8) void {
    if (ctx.count == ctx.stale.len) return;
    if (!std.mem.endsWith(u8, name, ".json")) return;
    if (name.len > std.Io.Dir.max_name_bytes) return;
    var path_buf: [512]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ ctx.dir, name }) catch return;
    var file_buf: [512]u8 = undefined;
    const json = cReadFile(path, &file_buf) orelse return;
    // The write stamp lives inside the file ("at": epoch seconds),
    // so GC never needs a stat struct.
    const at = hook_server.jsonNumberPub(json, "at") orelse return;
    if (@as(f64, @floatFromInt(ctx.now)) - at <= @as(f64, @floatFromInt(session_ttl_secs))) return;
    @memcpy(ctx.stale[ctx.count][0..name.len], name);
    ctx.stale_len[ctx.count] = name.len;
    ctx.count += 1;
}

fn pruneSessions(dir: []const u8) void {
    var ctx: PruneCtx = .{ .dir = dir, .now = plat.nowSeconds() };
    plat.forEachEntry(dir, &ctx, pruneVisit);
    for (0..ctx.count) |i| {
        var path_buf: [512]u8 = undefined;
        const path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ dir, ctx.stale[i][0..ctx.stale_len[i]] }) catch continue;
        plat.deleteFile(path);
    }
}

// --------------------------------------------------- transcript preview

/// Newest assistant text in a transcript tail: walk JSONL lines from
/// the end, take the first "type":"assistant" line that carries a
/// non-empty {"type":"text","text":...} part. Pure over bytes so the
/// parity tests need no filesystem.
pub fn lastAssistantFromTail(tail: []const u8) ?[]const u8 {
    var end = tail.len;
    while (end > 0) {
        const start = if (std.mem.lastIndexOfScalar(u8, tail[0..end], '\n')) |i| i + 1 else 0;
        const line = std.mem.trim(u8, tail[start..end], " \r");
        end = if (start == 0) 0 else start - 1;
        if (line.len == 0) continue;
        if (std.mem.indexOf(u8, line, "\"type\":\"assistant\"") == null) continue;
        if (firstTextPart(line)) |text| return text;
    }
    return null;
}

/// First {"type":"text","text":"..."} value in the line (raw escaped
/// bytes; the caller re-embeds or flattens them).
fn firstTextPart(line: []const u8) ?[]const u8 {
    const marker = "{\"type\":\"text\",\"text\":\"";
    var search: usize = 0;
    while (std.mem.indexOfPos(u8, line, search, marker)) |at| {
        const value_start = at + marker.len;
        var i = value_start;
        while (i < line.len) {
            if (line[i] == '\\') {
                i += 2;
                continue;
            }
            if (line[i] == '"') break;
            i += 1;
        }
        if (i > value_start and i <= line.len) {
            const value = line[value_start..@min(i, line.len)];
            if (std.mem.trim(u8, value, " ").len > 0) return value;
        }
        search = at + marker.len;
    }
    return null;
}

// ------------------------------------------------------------- plumbing

const readStdin = plat.readStdin;
const cReadFile = plat.readFile;
const cReadTail = plat.readFileTail;

fn cWriteFile(path: []const u8, bytes: []const u8) void {
    _ = plat.writeFile(path, bytes);
}

const PostTask = struct {
    done: std.atomic.Value(bool) = .init(false),
    path: [16]u8 = undefined,
    path_len: usize = 0,
    body: [1024]u8 = undefined,
    body_len: usize = 0,
    token: [128]u8 = undefined,
    token_len: usize = 0,

    fn run(self: *PostTask) void {
        postLocalhostBlocking(
            self.path[0..self.path_len],
            self.body[0..self.body_len],
            self.token[0..self.token_len],
        );
        self.done.store(true, .release);
    }
};

const PostJob = struct {
    task: *PostTask,
    thread: std.Thread,
};

/// Start a localhost POST on a private worker. Every byte is copied into the
/// task so the worker remains valid even when the hook's stack frame returns.
fn startPost(path: []const u8, body: []const u8, token: []const u8) ?PostJob {
    if (path.len > 16 or body.len > 1024 or token.len > 128) return null;
    const task = std.heap.page_allocator.create(PostTask) catch return null;
    task.* = .{};
    @memcpy(task.path[0..path.len], path);
    task.path_len = path.len;
    @memcpy(task.body[0..body.len], body);
    task.body_len = body.len;
    @memcpy(task.token[0..token.len], token);
    task.token_len = token.len;
    const thread = std.Thread.spawn(.{}, PostTask.run, .{task}) catch {
        std.heap.page_allocator.destroy(task);
        return null;
    };
    return .{ .task = task, .thread = thread };
}

/// The hook waits for both localhost requests together, never for more than
/// 300ms. A stalled loopback socket cannot hold an agent session hostage.
/// Timed-out jobs intentionally retain their small task allocation until the
/// short-lived runner process exits; freeing it here would race the worker.
fn waitForPosts(posts: []PostJob) void {
    if (posts.len == 0) return;
    const polls = post_timeout_ms / post_poll_ms;
    var scope = plat.Scope.init();
    defer scope.deinit();
    for (0..polls) |_| {
        var all_done = true;
        for (posts) |post| {
            if (!post.task.done.load(.acquire)) {
                all_done = false;
                break;
            }
        }
        if (all_done) break;
        std.Io.sleep(scope.io(), std.Io.Duration.fromMilliseconds(post_poll_ms), .awake) catch {};
    }
    for (posts) |*post| {
        if (post.task.done.load(.acquire)) {
            post.thread.join();
            std.heap.page_allocator.destroy(post.task);
        } else {
            post.thread.detach();
        }
    }
}

/// Minimal HTTP POST to the in-process hook server. The caller owns the deadline; this
/// worker only flushes a small request and never waits for a response.
fn postLocalhostBlocking(path: []const u8, body: []const u8, token: []const u8) void {
    var scope = plat.Scope.init();
    defer scope.deinit();
    const io = scope.io();
    const addr: std.Io.net.IpAddress = .{ .ip4 = .loopback(7777) };
    // No .timeout here: Zig 0.16 panics on it (netConnectIpPosix and
    // netConnectIpWindows are both "TODO implement ... with timeout"),
    // and a panic in the runner is the one thing this binary must never
    // do to an agent. The caller's worker deadline is the timeout boundary;
    // the target is loopback, so connect either wins immediately or fails
    // with connection refused when no app listens.
    var stream = addr.connect(io, .{ .mode = .stream, .protocol = .tcp }) catch return;
    defer stream.close(io);
    var req_buf: [1600]u8 = undefined;
    const req = std.fmt.bufPrint(&req_buf, "POST {s} HTTP/1.1\r\nhost: 127.0.0.1\r\nx-petdex-update-token: {s}\r\ncontent-type: application/json\r\ncontent-length: {d}\r\nconnection: close\r\n\r\n{s}", .{ path, token, body.len, body }) catch return;
    var write_buf: [64]u8 = undefined;
    var writer = stream.writer(io, &write_buf);
    writer.interface.writeAll(req) catch return;
    writer.interface.flush() catch return;
}

// ------------------------------------------------------------ parity

// Mirrors of bubble-templates.test.ts / bubble-runner.test.ts cases.
const t = std.testing;

test "read template uses basename" {
    var out: [256]u8 = undefined;
    const payload = "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"/a/b/server.ts\"}}";
    try t.expectEqualStrings("Reading server.ts", formatBubble("pre", payload, &out).?);
    try t.expectEqualStrings("Read server.ts", formatBubble("post", payload, &out).?);
}

test "bash description beats the command heuristic" {
    var out: [256]u8 = undefined;
    const payload = "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"for f in *.svg; do magick $f; done\",\"description\":\"Rasterize agent SVGs\"}}";
    try t.expectEqualStrings("Rasterize agent SVGs", formatBubble("pre", payload, &out).?);
}

test "bash falls back to first word" {
    var out: [256]u8 = undefined;
    const payload = "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git status\"}}";
    try t.expectEqualStrings("Running git", formatBubble("pre", payload, &out).?);
    try t.expectEqualStrings("Ran git", formatBubble("post", payload, &out).?);
}

test "unknown tool falls through to generic" {
    var out: [256]u8 = undefined;
    const payload = "{\"tool_name\":\"mcp__custom__thing\"}";
    try t.expectEqualStrings("Calling mcp__custom__thing", formatBubble("pre", payload, &out).?);
}

test "grep quotes the pattern without ASCII quotes" {
    var out: [256]u8 = undefined;
    const payload = "{\"tool_name\":\"Grep\",\"tool_input\":{\"pattern\":\"TODO\"}}";
    try t.expectEqualStrings("Searching “TODO”", formatBubble("pre", payload, &out).?);
    try t.expectEqualStrings("Searched “TODO”", formatBubble("post", payload, &out).?);
}

test "every template survives the body round trip" {
    // The bug this pins: a bubble goes out as raw bytes interpolated into
    // the POST body and comes back through hook_server's scanner, which
    // stops at the first `"` OR `\` and decodes neither. A template that
    // renders either one loses everything after it, silently — the ASCII
    // quotes Grep used to wrap its pattern in dropped the pattern.
    const payloads = [_][]const u8{
        "{\"tool_name\":\"Grep\",\"tool_input\":{\"pattern\":\"TODO\"}}",
        "{\"tool_name\":\"Glob\",\"tool_input\":{\"pattern\":\"*.zig\"}}",
        "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"/a/b/server.ts\"}}",
        "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git status\"}}",
        "{\"tool_name\":\"WebFetch\",\"tool_input\":{\"url\":\"https://petdex.dev/x\"}}",
        "{\"tool_name\":\"Agent\",\"tool_input\":{\"description\":\"review hooks\"}}",
    };
    for (payloads) |payload| {
        for ([_][]const u8{ "pre", "post" }) |phase| {
            var out: [256]u8 = undefined;
            const text = formatBubble(phase, payload, &out) orelse continue;
            var body_buf: [1024]u8 = undefined;
            const body = try std.fmt.bufPrint(
                &body_buf,
                "{{\"text\":\"{s}\",\"busy\":true,\"agent_source\":\"claude-code\"}}",
                .{text},
            );
            try t.expectEqualStrings(text, jsonString(body, "text").?);
        }
    }
}

test "session phases render fixed strings" {
    var out: [256]u8 = undefined;
    try t.expectEqualStrings("Thinking…", formatBubble("user-prompt", "", &out).?);
    try t.expectEqualStrings("Done.", formatBubble("stop", "", &out).?);
    try t.expectEqualStrings("Waiting for you…", formatBubble("notification", "", &out).?);
}

test "state mapping mirrors the TS runner" {
    try t.expectEqualStrings("review", stateForEvent("pre", "Read").?);
    try t.expectEqualStrings("running", stateForEvent("pre", "Bash").?);
    try t.expectEqualStrings("idle", stateForEvent("post", null).?);
    try t.expectEqualStrings("waving", stateForEvent("stop", null).?);
    try t.expectEqualStrings("jumping", stateForEvent("user-prompt", null).?);
    try t.expectEqualStrings("waiting", stateForEvent("notification", null).?);
    try t.expectEqualStrings("failed", stateForEvent("tool-failure", "Bash").?);
}

test "tool-failure bubble names the tool and never the error text" {
    var out: [256]u8 = undefined;
    const payload =
        "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"npm test\"}," ++
        "\"error\":\"Command failed: \\\"npm test\\\" exited 1\",\"error_type\":\"execution_failed\"}";
    const rendered = formatBubble("tool-failure", payload, &out).?;
    try t.expectEqualStrings("Bash failed", rendered);
    // AC9: the payload carries both an ASCII quote and a backslash, and neither
    // reaches the bubble. jsonString would truncate the body at the first one.
    try t.expect(std.mem.indexOfScalar(u8, rendered, '"') == null);
    try t.expect(std.mem.indexOfScalar(u8, rendered, '\\') == null);
    // Missing tool_name falls back capitalised, matching the TS runner.
    try t.expectEqualStrings("Tool failed", formatBubble("tool-failure", "{}", &out).?);
}

test "stateBody adds duration only for the failure phase" {
    var buf: [256]u8 = undefined;
    try t.expectEqualStrings(
        "{\"state\":\"failed\",\"duration\":1220,\"agent_source\":\"qoder\"}",
        stateBody(&buf, "failed", failed_duration_ms, "qoder").?,
    );
    // AC12 regression guard: every pre-existing phase must render exactly what
    // shipped before this change. This fails the moment anyone reintroduces a
    // second format string or reorders the keys.
    try t.expectEqualStrings(
        "{\"state\":\"idle\",\"agent_source\":\"claude-code\"}",
        stateBody(&buf, "idle", 0, "claude-code").?,
    );
    try t.expectEqualStrings(
        "{\"state\":\"waving\",\"agent_source\":\"codex\"}",
        stateBody(&buf, "waving", 0, "codex").?,
    );
}

test "tool-failure bubble survives the hook server reader round trip" {
    // The whole class #628 exposed: formatBubble output is embedded raw into the
    // POST body, then read back by a scanner that stops at `"` and `\`. Push the
    // new template through both halves and assert nothing is lost.
    var out: [256]u8 = undefined;
    const rendered = formatBubble("tool-failure", "{\"tool_name\":\"Bash\"}", &out).?;
    var body_buf: [512]u8 = undefined;
    const body = std.fmt.bufPrint(
        &body_buf,
        "{{\"text\":\"{s}\",\"busy\":true,\"agent_source\":\"qoder\"}}",
        .{rendered},
    ) catch unreachable;
    try t.expectEqualStrings("Bash failed", jsonString(body, "text").?);
    try t.expectEqualStrings("qoder", jsonString(body, "agent_source").?);
}

test "transcript tail takes the newest assistant text" {
    const tail =
        "{\"type\":\"user\",\"message\":{\"content\":\"hola\"}}\n" ++
        "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"older answer\"}]}}\n" ++
        "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Bash\"},{\"type\":\"text\",\"text\":\"Listo, el fix quedo\\npusheado.\"}]}}\n" ++
        "{\"type\":\"system\",\"subtype\":\"hook\"}\n";
    try t.expectEqualStrings("Listo, el fix quedo\\npusheado.", lastAssistantFromTail(tail).?);
}

test "clipEscaped flattens escapes and collapses spaces" {
    var buf: [512]u8 = undefined;
    try t.expectEqualStrings("hola mundo", clipEscaped("hola\\n  mundo", 110, &buf).?);
}

test "clipEscaped cuts on a safe boundary" {
    var buf: [512]u8 = undefined;
    var long: [200]u8 = @splat('x');
    long[109] = '\\';
    const clipped = clipEscaped(&long, 110, &buf).?;
    try t.expect(clipped.len <= 110);
    try t.expect(clipped[clipped.len - 1] != '\\');
}
