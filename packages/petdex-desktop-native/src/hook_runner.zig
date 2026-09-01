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
const title_max = hook_server.bubble_title_capacity;
const preview_max = 960;
const transcript_tail_cap = 256 * 1024;
const post_body_capacity = 8 * 1024;
const session_ttl_secs: i64 = 24 * 60 * 60;
const post_timeout_ms: u64 = 300;
const post_poll_ms: u64 = 5;
const journal_version: u8 = 1;
const journal_rotate_bytes: u64 = 4 * 1024 * 1024;

// ------------------------------------------------------------- entry

/// argv tail after "bubble": [phase, agent?]. Reads stdin, formats,
/// POSTs bubble + state to the in-process hook server. Never fails outward.
pub fn run(raw_phase: []const u8, arg_agent: ?[]const u8, origin_app: plat.OriginApplication, source_cwd_raw: ?[]const u8, herdr_pane_raw: ?[]const u8, home: []const u8) void {
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

    const agent = resolveAgent(payload, arg_agent);
    const phase = effectiveHookPhase(raw_phase, agent, payload);
    const effective_origin: plat.OriginApplication = if (origin_app == .none and std.ascii.eqlIgnoreCase(agent, "codex")) .codex else origin_app;
    const source_app = effective_origin.wireName();
    var tty_buf: [64]u8 = undefined;
    const source_tty = if (effective_origin == .terminal) (plat.controllingTty(&tty_buf) orelse "") else "";
    const source_cwd = plat.safeSourceCwd(source_cwd_raw) orelse "";
    const herdr_pane = plat.safeHerdrPaneId(herdr_pane_raw) orelse "";
    var session_hash_buf: [64]u8 = undefined;
    const session_id = payloadSessionId(phase, payload, &session_hash_buf);
    const session_context = payloadSessionContext(agent, phase, payload, session_id);
    const turn_id = safeSessionId(firstJsonString(payload, &.{ "turn_id", "turnId" }));
    var hostname_buf: [64]u8 = undefined;
    const hostname = plat.hostName(&hostname_buf) orelse "local";

    // Session title precedence: the agent/server's generated title wins and
    // may change at any time; the first user prompt is only a fallback. Every
    // event re-resolves the authoritative source so delayed auto-titles and
    // server-side renames flow into an already visible bubble.
    var sessions_buf: [512]u8 = undefined;
    const sessions_dir = std.fmt.bufPrint(&sessions_buf, "{s}/.petdex/runtime/sessions", .{home}) catch return;
    if (session_id) |sid| {
        var server_title_buf: [256]u8 = undefined;
        if (authoritativeTitle(agent, home, sid, payload, &server_title_buf)) |server_title| {
            rememberTitle(sessions_dir, sid, server_title, .server, true);
        } else if (isPromptPhase(phase)) {
            if (promptTitle(payload)) |prompt| rememberTitle(sessions_dir, sid, prompt, .prompt, false);
        }
    }
    var title_buf: [256]u8 = undefined;
    var title_source: hook_server.TitleSource = .unknown;
    const title: []const u8 = if (session_id) |sid| blk: {
        const record = readTitle(sessions_dir, sid, &title_buf) orelse break :blk "";
        title_source = record.source;
        break :blk record.text;
    } else "";

    var text_buf: [preview_max]u8 = undefined;
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
    const tool_name = jsonString(payload, "tool_name");
    const notification_kind = firstJsonString(payload, &.{ "notification_type", "notification_kind" }) orelse "";
    const status = statusForEvent(phase, tool_name, notification_kind);
    const busy = status == .running;
    const state = stateForEventWithNotification(phase, tool_name, notification_kind);

    // First lower the provider payload into the canonical event and persist it.
    // The journal deliberately precedes the update-token/HTTP path, allowing a
    // task that ran while Petdex was closed to be recovered on next launch.
    var bubble_body_buf: [post_body_capacity]u8 = undefined;
    var bubble_body: ?[]const u8 = null;
    if (text.len > 0 and shouldPostBubble(agent, phase)) {
        const correlation_id = firstJsonString(payload, &.{ "request_id", "tool_use_id", "message_id", "event_id", "call_id", "turn_id", "turnId" });
        const is_request = status == .needs_input;
        const is_response = std.mem.eql(u8, phase, "approval-response") or
            (std.mem.eql(u8, phase, "post") and tool_name != null and asciiEqlLower(tool_name.?, "clarify"));
        bubble_body = bubbleBodyWithContext(&bubble_body_buf, text, title, busy, agent, .{
            .session_id = session_id,
            .conversation_key = session_context.conversationKey(),
            .parent_session_id = session_context.parentSession(),
            .session_kind = session_context.kind,
            .subagent_label = session_context.labelSlice(),
            .source_app = source_app,
            .source_tty = source_tty,
            .source_cwd = source_cwd,
            .herdr_pane = herdr_pane,
            .hostname = hostname,
            .turn_id = turn_id,
            .message_id = correlation_id,
            .event_kind = phase,
            .request_id = if (is_request) correlation_id else null,
            .resolves_request_id = if (is_response) correlation_id else null,
            .notification_kind = notification_kind,
            .message_kind = messageKindForEvent(phase, payload, notification_kind),
            .title_source = title_source,
            .status = status,
            .agent_state = state,
        });
        if (bubble_body) |body| appendJournalEvent(home, agent, session_context.conversationKey(), body);
    }

    var token_buf: [128]u8 = undefined;
    const token_raw = blk: {
        const tp = std.fmt.bufPrint(&path_buf, "{s}/.petdex/runtime/update-token", .{home}) catch break :blk null;
        break :blk cReadFile(tp, &token_buf);
    } orelse return;
    const token = std.mem.trim(u8, token_raw, " \t\r\n");
    if (token.len == 0) return;

    var posts: [2]PostJob = undefined;
    var post_count: usize = 0;
    if (bubble_body) |body| {
        if (startPost("/bubble", body, token)) |post| {
            posts[post_count] = post;
            post_count += 1;
        }
    }
    if (state) |s| {
        var state_body_buf: [post_body_capacity]u8 = undefined;
        const duration_ms: u32 = if (isToolFailurePhase(phase)) failed_duration_ms else 0;
        const body = stateBody(&state_body_buf, s, duration_ms, agent);
        if (body) |b| {
            if (startPost("/state", b, token)) |post| {
                posts[post_count] = post;
                post_count += 1;
            }
        }
    }
    waitForPosts(posts[0..post_count]);
}

/// The hook command identifies the agent that actually invoked this runner.
/// Prefer that explicit argument over payload metadata, which may be nested,
/// copied from another integration, or supplied by an agent subprocess.
fn resolveAgent(payload: []const u8, arg_agent: ?[]const u8) []const u8 {
    if (arg_agent) |agent| {
        if (agent.len > 0) return agent;
    }
    return jsonString(payload, "agent_source") orelse "";
}

/// CodeBuddy has no distinct failure callback in the documented core hook
/// contract. Its PostToolUse payload instead carries a structured response;
/// recognize only the explicit boolean signal so arbitrary tool output or a
/// user-controlled nested `success` field cannot manufacture a failed state.
fn effectiveHookPhase(raw_phase: []const u8, agent: []const u8, payload: []const u8) []const u8 {
    if (!std.mem.eql(u8, raw_phase, "post") or !std.ascii.eqlIgnoreCase(agent, "codebuddy")) return raw_phase;

    const parsed = std.json.parseFromSlice(std.json.Value, std.heap.page_allocator, payload, .{}) catch return raw_phase;
    defer parsed.deinit();
    if (parsed.value != .object) return raw_phase;
    const response = parsed.value.object.get("tool_response") orelse return raw_phase;
    if (response != .object) return raw_phase;
    const success = response.object.get("success") orelse return raw_phase;
    if (success != .bool or success.bool) return raw_phase;
    return "tool-failure";
}

fn journalHashStem(out: *[std.crypto.hash.sha2.Sha256.digest_length * 2]u8, raw: []const u8, fallback: []const u8) []const u8 {
    const source = if (raw.len > 0) raw else fallback;
    var digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(source, &digest, .{});
    out.* = std.fmt.bytesToHex(digest, .lower);
    return out;
}

fn appendJournalEvent(home: []const u8, agent: []const u8, conversation: ?[]const u8, body: []const u8) void {
    var dir_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const dir = std.fmt.bufPrint(&dir_buf, "{s}/.petdex/runtime/session-journal", .{home}) catch return;
    if (!plat.makeDirMode(dir, 0o700)) return;

    var agent_buf: [std.crypto.hash.sha2.Sha256.digest_length * 2]u8 = undefined;
    var conversation_buf: [std.crypto.hash.sha2.Sha256.digest_length * 2]u8 = undefined;
    const agent_stem = journalHashStem(&agent_buf, agent, "agent");
    const conversation_stem = journalHashStem(&conversation_buf, conversation orelse "", "unkeyed");
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/{s}-{s}.jsonl", .{ dir, agent_stem, conversation_stem }) catch return;

    var record_buf: [post_body_capacity + 64]u8 = undefined;
    const record = std.fmt.bufPrint(&record_buf, "{{\"journal_version\":{d},\"event\":{s}}}\n", .{ journal_version, body }) catch return;
    _ = plat.appendFileModeRotating(path, record, 0o600, journal_rotate_bytes);
}

test "journal stems preserve punctuation-distinct identities" {
    var slash_buf: [std.crypto.hash.sha2.Sha256.digest_length * 2]u8 = undefined;
    var colon_buf: [std.crypto.hash.sha2.Sha256.digest_length * 2]u8 = undefined;
    var fallback_buf: [std.crypto.hash.sha2.Sha256.digest_length * 2]u8 = undefined;
    const slash = journalHashStem(&slash_buf, "team/a", "unkeyed");
    const colon = journalHashStem(&colon_buf, "team:a", "unkeyed");
    const fallback = journalHashStem(&fallback_buf, "", "unkeyed");

    try std.testing.expectEqualStrings("65f838a2fbff37d81a09242f44268f116e339d56e03dec44785d0badda4b1341", slash);
    try std.testing.expectEqualStrings("5752fddeb3d6826d1281d4ecd54493c1eca7c0d93bf64bae0ff098c833f1fee3", colon);
    try std.testing.expectEqualStrings("d43eaed1b24b2617fb850c9c81dd86891d3b64edbb62712c94f08b8b32279ebf", fallback);
    try std.testing.expect(!std.mem.eql(u8, slash, colon));
}

/// Local Codex rollouts contain the same user-visible `agent_message` and
/// `agent_reasoning` feed rendered by Codex Pet. Pre/post tool hooks still
/// drive mascot state, but must not replace that feed with lower-level
/// summaries such as "Ran rg". Other agents (and the remote shell adapter)
/// continue using hook text because no local rollout is available for them.
fn shouldPostBubble(agent: []const u8, phase: []const u8) bool {
    if (!std.ascii.eqlIgnoreCase(agent, "codex")) return true;
    return !(std.mem.eql(u8, phase, "pre") or
        std.mem.eql(u8, phase, "post") or
        isToolFailurePhase(phase));
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

fn notificationNeedsInput(kind: []const u8) bool {
    return std.mem.eql(u8, kind, "permission_prompt") or
        std.mem.eql(u8, kind, "elicitation_dialog") or
        std.mem.eql(u8, kind, "elicitation_url_dialog") or
        std.mem.eql(u8, kind, "agent_needs_input");
}

fn notificationCompletes(kind: []const u8) bool {
    return std.mem.eql(u8, kind, "idle_prompt") or std.mem.eql(u8, kind, "agent_completed");
}

fn statusForEvent(phase: []const u8, tool_name: ?[]const u8, notification_kind: []const u8) hook_server.SessionStatus {
    if (std.mem.eql(u8, phase, "approval-request")) return .needs_input;
    if (std.mem.eql(u8, phase, "notification")) {
        if (notificationNeedsInput(notification_kind)) return .needs_input;
        if (notificationCompletes(notification_kind)) return .completed;
        return .idle;
    }
    // `waiting` remains a sprite/state compatibility phase only. It is not a
    // correlated request and therefore cannot make the session orange.
    if (std.mem.eql(u8, phase, "waiting")) return .idle;
    if (std.mem.eql(u8, phase, "pre") and tool_name != null and asciiEqlLower(tool_name.?, "clarify")) return .needs_input;
    // A failed tool is an intermediate event: the harness reports the error
    // back to the agent and the same turn continues. Keep the conversation
    // active while `stateForEvent` independently drives the brief failed
    // sprite.
    if (isToolFailurePhase(phase)) return .running;
    if (isStopPhase(phase) or std.mem.eql(u8, phase, "assistant")) return .completed;
    if (isPromptPhase(phase) or
        std.mem.eql(u8, phase, "pre") or
        std.mem.eql(u8, phase, "post") or
        std.mem.eql(u8, phase, "pre-llm") or
        std.mem.eql(u8, phase, "post-model") or
        std.mem.eql(u8, phase, "approval-response") or
        std.mem.eql(u8, phase, "subagent-start") or
        std.mem.eql(u8, phase, "subagent-stop")) return .running;
    return .idle;
}

fn messageKindForEvent(phase: []const u8, payload: []const u8, notification_kind: []const u8) hook_server.MessageKind {
    if (std.mem.eql(u8, phase, "assistant")) return .assistant;
    // Hermes emits `subagent_stop` on the parent's hook stream, but includes
    // the child's concise result in `child_summary`. Preserve that one
    // user-facing summary in the nested branch rather than demoting it to
    // lifecycle noise (or replacing the parent's primary message).
    if (std.mem.eql(u8, phase, "subagent-stop") and
        firstJsonString(payload, &.{ "child_summary", "subagent_summary" }) != null)
        return .assistant;
    if (std.mem.eql(u8, phase, "pre") or std.mem.eql(u8, phase, "post") or isToolFailurePhase(phase)) return .tool;
    if (std.mem.eql(u8, phase, "approval-request") or
        (std.mem.eql(u8, phase, "notification") and notificationNeedsInput(notification_kind))) return .prompt;
    if (isStopPhase(phase) or
        std.mem.eql(u8, phase, "subagent-start") or
        std.mem.eql(u8, phase, "subagent-stop")) return .lifecycle;
    if (isPromptPhase(phase)) return .prompt;
    return .status;
}

/// The /bubble request body, extracted and pure for the same reason stateBody
/// is: `run()` reaches stdin, the token file and a socket, so a body built
/// inline there cannot be reached from `zig test`.
///
/// `session_id` is what lets the desktop hold one bubble per conversation
/// instead of one globally. Omitted rather than sent empty when absent, so a
/// payload without a session keeps landing on the server's single-bubble key
/// and renders exactly what shipped before per-conversation bubbles.
///
/// Title and session are optional fragments in ONE format string rather than a
/// separate string per combination: the two divergent bodies this replaces are
/// precisely how session_id got parsed, used for titles, and then left out of
/// the POST that needed it.
pub fn bubbleBody(out: []u8, text: []const u8, title: []const u8, busy: bool, agent: []const u8, session_id: ?[]const u8) ?[]const u8 {
    return bubbleBodyWithMetadata(out, text, title, busy, agent, session_id, "", "", "", "", null);
}

/// `agent_state` carries what this one session is doing to the bubble the
/// desktop keys by session. The same value already goes to /state, but
/// that endpoint aggregates: with several agents live it can only show
/// one. The flock renders a body per session, so the rich states the
/// hooks already compute (failed, review, waiting) have to travel here to
/// survive. Senders that pass null keep the previous body byte for byte.
pub fn bubbleBodyWithMetadata(out: []u8, text: []const u8, title: []const u8, busy: bool, agent: []const u8, session_id: ?[]const u8, source_app: []const u8, source_tty: []const u8, source_cwd: []const u8, herdr_pane: []const u8, agent_state: ?[]const u8) ?[]const u8 {
    return bubbleBodyWithContext(out, text, title, busy, agent, .{
        .session_id = session_id,
        .source_app = source_app,
        .source_tty = source_tty,
        .source_cwd = source_cwd,
        .herdr_pane = herdr_pane,
        .agent_state = agent_state,
    });
}

const BubbleWireContext = struct {
    session_id: ?[]const u8 = null,
    conversation_key: ?[]const u8 = null,
    parent_session_id: ?[]const u8 = null,
    session_kind: hook_server.SessionKind = .primary,
    subagent_label: []const u8 = "",
    source_app: []const u8 = "",
    source_tty: []const u8 = "",
    source_cwd: []const u8 = "",
    herdr_pane: []const u8 = "",
    hostname: []const u8 = "",
    turn_id: ?[]const u8 = null,
    message_id: ?[]const u8 = null,
    event_kind: []const u8 = "",
    request_id: ?[]const u8 = null,
    resolves_request_id: ?[]const u8 = null,
    notification_kind: []const u8 = "",
    message_kind: hook_server.MessageKind = .status,
    title_source: hook_server.TitleSource = .unknown,
    status: hook_server.SessionStatus = .idle,
    agent_state: ?[]const u8 = null,
};

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
        } else if (byte < 0x20) {
            if (len + 6 > output.len) return null;
            const hex = "0123456789abcdef";
            output[len] = '\\';
            output[len + 1] = 'u';
            output[len + 2] = '0';
            output[len + 3] = '0';
            output[len + 4] = hex[@as(usize, byte >> 4)];
            output[len + 5] = hex[@as(usize, byte & 0x0f)];
            len += 6;
        } else {
            if (len >= output.len) return null;
            output[len] = byte;
            len += 1;
        }
    }
    return output[0..len];
}

fn bubbleBodyWithContext(out: []u8, text: []const u8, title: []const u8, busy: bool, agent: []const u8, context: BubbleWireContext) ?[]const u8 {
    var title_buf: [256]u8 = undefined;
    const title_part: []const u8 = if (title.len > 0)
        (std.fmt.bufPrint(&title_buf, ",\"title\":\"{s}\"", .{title}) catch return null)
    else
        "";
    var session_buf: [96]u8 = undefined;
    const session_part: []const u8 = if (context.session_id) |sid|
        (std.fmt.bufPrint(&session_buf, ",\"session_id\":\"{s}\"", .{sid}) catch return null)
    else
        "";
    var context_buf: [2048]u8 = undefined;
    const conversation = context.conversation_key orelse "";
    const parent = context.parent_session_id orelse "";
    const turn = context.turn_id orelse "";
    const message_id = context.message_id orelse "";
    const request_id = context.request_id orelse "";
    const resolves_request_id = context.resolves_request_id orelse "";
    // Unlike provider-derived fields, source_cwd is a decoded environment
    // value. Windows paths therefore contain literal backslashes and must be
    // escaped before this format string becomes JSON.
    var source_cwd_buf: [3072]u8 = undefined;
    const source_cwd = jsonEscapeString(context.source_cwd, &source_cwd_buf) orelse return null;
    const session_kind = if (context.session_kind == .subagent) "subagent" else "primary";
    const has_canonical_context = conversation.len > 0 or parent.len > 0 or
        context.session_kind == .subagent or context.subagent_label.len > 0 or
        context.source_app.len > 0 or context.source_tty.len > 0 or
        context.source_cwd.len > 0 or context.herdr_pane.len > 0 or context.hostname.len > 0 or turn.len > 0 or
        message_id.len > 0 or context.event_kind.len > 0 or request_id.len > 0 or
        resolves_request_id.len > 0 or context.notification_kind.len > 0 or context.message_kind != .status or
        context.title_source != .unknown or context.status != .idle;
    const context_part: []const u8 = if (has_canonical_context)
        (std.fmt.bufPrint(&context_buf, ",\"conversation_key\":\"{s}\",\"source_session_id\":\"{s}\",\"parent_session_id\":\"{s}\",\"session_kind\":\"{s}\",\"subagent_label\":\"{s}\",\"source_app\":\"{s}\",\"source_tty\":\"{s}\",\"source_cwd\":\"{s}\",\"herdr_pane_id\":\"{s}\",\"hostname\":\"{s}\",\"turn_id\":\"{s}\",\"message_id\":\"{s}\",\"event_kind\":\"{s}\",\"request_id\":\"{s}\",\"resolves_request_id\":\"{s}\",\"notification_kind\":\"{s}\",\"message_kind\":\"{s}\",\"title_source\":\"{s}\",\"feed_source\":\"hook\",\"status\":\"{s}\"", .{ conversation, context.session_id orelse "", parent, session_kind, context.subagent_label, context.source_app, context.source_tty, source_cwd, context.herdr_pane, context.hostname, turn, message_id, context.event_kind, request_id, resolves_request_id, context.notification_kind, @tagName(context.message_kind), @tagName(context.title_source), context.status.wireName() }) catch return null)
    else
        "";
    var state_buf: [48]u8 = undefined;
    const state_part: []const u8 = if (context.agent_state) |st|
        (std.fmt.bufPrint(&state_buf, ",\"agent_state\":\"{s}\"", .{st}) catch return null)
    else
        "";
    return std.fmt.bufPrint(out, "{{\"text\":\"{s}\"{s},\"busy\":{},\"agent_source\":\"{s}\"{s}{s}{s}}}", .{ text, title_part, busy, agent, session_part, context_part, state_part }) catch null;
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
fn stateForEventWithNotification(phase: []const u8, tool_name: ?[]const u8, notification_kind: []const u8) ?[]const u8 {
    if (std.mem.eql(u8, phase, "pre")) {
        if (tool_name) |name| {
            if (asciiEqlLower(name, "clarify")) return "waiting";
            if (asciiEqlLower(name, "read") or asciiEqlLower(name, "grep") or asciiEqlLower(name, "glob")) return "review";
        }
        return "running";
    }
    if (std.mem.eql(u8, phase, "post") or std.mem.eql(u8, phase, "approval-response")) return "running";
    if (isToolFailurePhase(phase)) return "failed";
    if (isStopPhase(phase) or std.mem.eql(u8, phase, "assistant")) return "waving";
    if (isPromptPhase(phase)) return "jumping";
    if (std.mem.eql(u8, phase, "approval-request") or
        (std.mem.eql(u8, phase, "notification") and notificationNeedsInput(notification_kind))) return "waiting";
    if (std.mem.eql(u8, phase, "waiting")) return null;
    if (std.mem.eql(u8, phase, "pre-llm") or std.mem.eql(u8, phase, "post-model") or std.mem.eql(u8, phase, "subagent-start") or std.mem.eql(u8, phase, "subagent-stop")) return "running";
    return null;
}

pub fn stateForEvent(phase: []const u8, tool_name: ?[]const u8) ?[]const u8 {
    return stateForEventWithNotification(phase, tool_name, "");
}

// ---------------------------------------------------------- templates

/// Port of formatBubble. Writes into `out`, returns the rendered text
/// (raw JSON-escaped content passes through untouched so it can be
/// re-embedded into the POST body).
pub fn formatBubble(phase: []const u8, payload: []const u8, out: []u8) ?[]const u8 {
    if (isPromptPhase(phase)) return "Thinking…";
    // Hermes lifecycle callbacks report the parent as `session_id` and the
    // worker separately as `child_session_id`. The start event is activity
    // noise, while stop's summary is the one meaningful child message worth
    // keeping beneath the parent card.
    if (isSubagentLifecycle(phase, payload)) {
        if (std.mem.eql(u8, phase, "subagent-stop")) {
            if (firstJsonString(payload, &.{ "child_summary", "subagent_summary" })) |summary| {
                return clipEscaped(summary, preview_max, out);
            }
        }
        return null;
    }
    if (std.mem.eql(u8, phase, "assistant")) {
        const response = firstJsonString(payload, &.{ "assistant_response", "last_assistant_message", "prompt_response", "message", "response" }) orelse return "Done.";
        return clipEscaped(response, preview_max, out);
    }
    if (isStopPhase(phase)) {
        if (firstJsonString(payload, &.{ "last_assistant_message", "assistant_response" })) |response| {
            return clipEscaped(response, preview_max, out);
        }
        return "Done.";
    }
    if (std.mem.eql(u8, phase, "notification")) {
        const kind = firstJsonString(payload, &.{ "notification_type", "notification_kind" }) orelse "";
        if (!notificationNeedsInput(kind)) {
            if (notificationCompletes(kind)) return "Done.";
            return null;
        }
        if (firstJsonString(payload, &.{ "question", "prompt", "message", "reason" })) |question| {
            return clipEscaped(question, preview_max, out);
        }
        return "Waiting for you…";
    }
    if (std.mem.eql(u8, phase, "approval-request")) {
        if (firstJsonString(payload, &.{ "question", "prompt", "message", "reason" })) |question| {
            return clipEscaped(question, preview_max, out);
        }
        return "Waiting for you…";
    }
    if (std.mem.eql(u8, phase, "waiting")) return null;
    if (std.mem.eql(u8, phase, "approval-response")) return "Continuing…";
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

    if (asciiEqlLower(tool, "clarify")) {
        if (done) return "Continuing…";
        if (firstJsonString(payload, &.{ "question", "prompt", "message" })) |question| {
            return clipEscaped(question, preview_max, out);
        }
        return "Waiting for you…";
    }

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

const TitleSource = hook_server.TitleSource;

const TitleRecord = struct {
    text: []const u8,
    source: TitleSource,
};

fn firstJsonString(payload: []const u8, keys: []const []const u8) ?[]const u8 {
    for (keys) |key| {
        if (jsonString(payload, key)) |value| {
            if (std.mem.trim(u8, value, " \t\r\n").len > 0) return value;
        }
    }
    return null;
}

/// Agent APIs do not agree on the conversation identifier spelling. Keep the
/// aliases here, rather than teaching the mailbox about each harness.
fn normalizedConversationKey(raw: ?[]const u8, hash_buf: *[64]u8) ?[]const u8 {
    const value = raw orelse return null;
    if (safeSessionId(value)) |safe| return safe;
    if (value.len == 0) return null;
    var digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(value, &digest, .{});
    hash_buf.* = std.fmt.bytesToHex(digest, .lower);
    return hash_buf;
}

fn payloadSessionId(phase: []const u8, payload: []const u8, hash_buf: *[64]u8) ?[]const u8 {
    // Hermes's `subagent_start` / `subagent_stop` shell-hook payload places
    // the parent in `session_id`, with the real worker id in
    // `child_session_id`. Select the child before the generic aliases so the
    // lifecycle event cannot overwrite the parent as a second primary feed.
    if (isSubagentLifecycle(phase, payload)) {
        if (safeSessionId(firstJsonString(payload, &.{ "child_session_id", "childSessionId" }))) |child| return child;
    }
    if (firstJsonString(payload, &.{ "petdex_conversation_key", "conversation_key" })) |key|
        return normalizedConversationKey(key, hash_buf);
    if (safeSessionId(firstJsonString(payload, &.{
        "session_id",
        "sessionId",
        "sessionID",
        "thread_id",
        "conversation_id",
    }))) |session| return session;
    if (firstJsonString(payload, &.{"session_key"})) |key|
        return normalizedConversationKey(key, hash_buf);
    return safeSessionId(firstJsonString(payload, &.{ "parent_session_id", "parentSessionId" }));
}

fn subagentLifecycleParent(payload: []const u8) ?[]const u8 {
    return safeSessionId(firstJsonString(payload, &.{
        "parent_session_id",
        "parentSessionId",
        // Hermes's shell-hook serializer maps parent_session_id into its
        // top-level session_id field, so retain that documented fallback.
        "session_id",
        "sessionId",
        "sessionID",
    }));
}

fn isSubagentLifecycle(phase: []const u8, payload: []const u8) bool {
    if (!(std.mem.eql(u8, phase, "subagent-start") or std.mem.eql(u8, phase, "subagent-stop"))) return false;
    const child = safeSessionId(firstJsonString(payload, &.{ "child_session_id", "childSessionId" })) orelse return false;
    const parent = subagentLifecycleParent(payload) orelse return true;
    return !std.mem.eql(u8, child, parent);
}

const SessionContext = struct {
    conversation_key: ?[]const u8 = null,
    parent_session_id: ?[]const u8 = null,
    label: []const u8 = "",
    kind: hook_server.SessionKind = .primary,

    fn conversationKey(self: SessionContext) ?[]const u8 {
        return self.conversation_key;
    }

    fn parentSession(self: SessionContext) ?[]const u8 {
        return self.parent_session_id;
    }

    fn labelSlice(self: SessionContext) []const u8 {
        return self.label;
    }
};

fn safeWireScalar(raw: ?[]const u8, max: usize) ?[]const u8 {
    const value = raw orelse return null;
    if (value.len == 0 or value.len > max) return null;
    for (value) |c| {
        if (c < 0x20 or c == '"' or c == '\\') return null;
    }
    return value;
}

/// Petdesk's Hermes adapters resolve continuation/subagent ancestry against
/// state.db and attach the stable top-level key. Other harnesses can provide
/// the same namespaced fields, while legacy payloads fall back to session_id.
fn sourceMarksSubagent(raw: []const u8) bool {
    // Source names are not a stable enum across Hermes surfaces. Exact
    // delegate markers remain the authoritative path, but accept its known
    // spelling variants and tool-only workers as a conservative fallback.
    const names = [_][]const u8{
        "subagent", "sub-agent", "sub_agent",  "child",      "worker",
        "delegate", "delegated", "delegation", "background", "tool",
    };
    for (names) |name| {
        if (std.ascii.eqlIgnoreCase(raw, name)) return true;
    }
    return false;
}

fn payloadSessionContext(agent: []const u8, phase: []const u8, payload: []const u8, session_id: ?[]const u8) SessionContext {
    _ = agent;
    const explicit_conversation = safeWireScalar(firstJsonString(payload, &.{
        "petdex_conversation_key",
        "conversation_key",
        "session_key",
    }), hook_server.bubble_session_capacity);
    const explicit_parent = safeWireScalar(firstJsonString(payload, &.{
        "petdex_parent_session_id",
        "parent_session_id",
        "parentSessionId",
    }), hook_server.bubble_session_capacity);
    const lifecycle_child = isSubagentLifecycle(phase, payload);
    const parent = explicit_parent orelse if (lifecycle_child)
        safeWireScalar(subagentLifecycleParent(payload), hook_server.bubble_session_capacity)
    else
        null;
    const raw_kind = firstJsonString(payload, &.{ "petdex_session_kind", "session_kind", "source" });
    const is_subagent = if (raw_kind) |kind|
        (sourceMarksSubagent(kind) or lifecycle_child)
    else
        lifecycle_child;
    const label = safeWireScalar(firstJsonString(payload, &.{
        "petdex_subagent_label",
        "subagent_label",
        "child_role",
        "subagent_role",
        "display_name",
    }), 48) orelse "";
    const canonical = explicit_conversation orelse if (is_subagent) parent orelse session_id else session_id;
    return .{
        .conversation_key = canonical,
        .parent_session_id = parent,
        .label = label,
        .kind = if (is_subagent) .subagent else .primary,
    };
}

/// Prompt-shaped agents use `prompt`; Hermes' pre_llm_call uses
/// `user_message`. The remaining aliases cover the Claude-derived harnesses
/// without accepting a generic nested `text` field from tool input.
fn promptTitle(payload: []const u8) ?[]const u8 {
    return firstJsonString(payload, &.{ "prompt", "user_message", "userPrompt", "input" });
}

/// Latest matching entry wins because Codex appends another row when its
/// server-generated thread title changes. Walking backward also makes a rename
/// visible without confusing it with the initial "New chat"/prompt title.
fn codexIndexTitleFromTail(tail: []const u8, session_id: []const u8, out: *[256]u8) ?[]const u8 {
    var end = tail.len;
    while (end > 0) {
        const start = if (std.mem.lastIndexOfScalar(u8, tail[0..end], '\n')) |i| i + 1 else 0;
        const line = std.mem.trim(u8, tail[start..end], " \t\r\n");
        end = if (start == 0) 0 else start - 1;
        if (line.len == 0) continue;
        const id = jsonString(line, "id") orelse continue;
        if (!std.mem.eql(u8, id, session_id)) continue;
        const generated = jsonString(line, "thread_name") orelse continue;
        return clipEscaped(generated, title_max, out);
    }
    return null;
}

fn codexServerTitle(home: []const u8, session_id: []const u8, out: *[256]u8) ?[]const u8 {
    var path_buf: [512]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/.codex/session_index.jsonl", .{home}) catch return null;
    // The current session can be renamed long after its original index row,
    // and a busy installation may append enough unrelated rows to push that
    // session beyond a small tail. Read the bounded catalog and walk backward;
    // 4 MiB covers many years of the compact append-only index.
    const index = plat.readFileAlloc(std.heap.page_allocator, path, 4 * 1024 * 1024) orelse return null;
    defer std.heap.page_allocator.free(index);
    return codexIndexTitleFromTail(index, session_id, out);
}

/// Resolve a title maintained outside the hook payload. The app polls this at
/// a low frequency for visible local sessions so a manual/server rename also
/// updates while the agent is idle and emitting no lifecycle events.
pub fn storedServerTitle(agent: []const u8, home: []const u8, session_id: []const u8, out: *[256]u8) ?[]const u8 {
    if (std.ascii.eqlIgnoreCase(agent, "codex")) return codexServerTitle(home, session_id, out);
    return null;
}

fn authoritativeTitle(agent: []const u8, home: []const u8, session_id: []const u8, payload: []const u8, out: *[256]u8) ?[]const u8 {
    // Petdesk-owned adapters use a namespaced field, so nested tool arguments
    // named `title` can never masquerade as a conversation rename.
    if (firstJsonString(payload, &.{ "petdex_session_title", "session_title", "thread_name" })) |title| {
        return clipEscaped(title, title_max, out);
    }
    if (storedServerTitle(agent, home, session_id, out)) |title| return title;
    return null;
}

fn safeSessionId(raw: ?[]const u8) ?[]const u8 {
    const sid = raw orelse return null;
    if (sid.len == 0 or sid.len > 64) return null;
    for (sid) |c| {
        if (!(std.ascii.isAlphanumeric(c) or c == '-' or c == '_')) return null;
    }
    return sid;
}

fn rememberTitle(dir: []const u8, session_id: []const u8, value: []const u8, source: TitleSource, replace: bool) void {
    plat.makeDir(dir);
    var title_buf: [256]u8 = undefined;
    const title = clipEscaped(value, title_max, &title_buf) orelse return;
    if (title.len == 0) return;
    if (!replace) {
        var existing_buf: [256]u8 = undefined;
        if (readTitle(dir, session_id, &existing_buf) != null) return;
    }
    var path_buf: [512]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/{s}.json", .{ dir, session_id }) catch return;
    var json_buf: [512]u8 = undefined;
    const source_name = switch (source) {
        .prompt => "prompt",
        .server => "server",
        .unknown => "unknown",
    };
    const json = std.fmt.bufPrint(&json_buf, "{{\"title\":\"{s}\",\"source\":\"{s}\",\"at\":{d}}}", .{ title, source_name, plat.nowSeconds() }) catch return;
    cWriteFile(path, json);
}

fn readTitle(dir: []const u8, session_id: []const u8, buf: *[256]u8) ?TitleRecord {
    var path_buf: [512]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/{s}.json", .{ dir, session_id }) catch return null;
    var file_buf: [512]u8 = undefined;
    const json = cReadFile(path, &file_buf) orelse return null;
    const title = jsonString(json, "title") orelse return null;
    if (title.len == 0 or title.len > buf.len) return null;
    @memcpy(buf[0..title.len], title);
    const source: TitleSource = if (jsonString(json, "source")) |name|
        (if (std.mem.eql(u8, name, "server")) .server else .prompt)
    else
        // Files written by older Petdesk builds only contain title + stamp.
        .prompt;
    return .{ .text = buf[0..title.len], .source = source };
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

/// User-visible Codex activity recovered from a rollout tail. Codex writes the
/// same `agent_reasoning` summaries and `agent_message` text consumed by its
/// own UI into the JSONL rollout. Hidden reasoning items are deliberately not
/// considered here.
pub const CodexActivityKind = enum { status, reasoning, assistant, prompt };

pub const CodexActivity = struct {
    text: [preview_max]u8 = @splat(0),
    text_len: usize = 0,
    turn: [64]u8 = @splat(0),
    turn_len: usize = 0,
    request_id: [hook_server.bubble_message_id_capacity]u8 = @splat(0),
    request_id_len: usize = 0,
    resolves_request_id: [hook_server.bubble_message_id_capacity]u8 = @splat(0),
    resolves_request_id_len: usize = 0,
    busy: bool = false,
    kind: CodexActivityKind = .status,
    status: hook_server.SessionStatus = .idle,

    pub fn textSlice(self: *const CodexActivity) []const u8 {
        return self.text[0..self.text_len];
    }

    pub fn turnSlice(self: *const CodexActivity) []const u8 {
        return self.turn[0..self.turn_len];
    }

    pub fn requestIdSlice(self: *const CodexActivity) []const u8 {
        return self.request_id[0..self.request_id_len];
    }

    pub fn resolvesRequestIdSlice(self: *const CodexActivity) []const u8 {
        return self.resolves_request_id[0..self.resolves_request_id_len];
    }
};

fn inputCall(line: []const u8) bool {
    if (std.mem.indexOf(u8, line, "\"type\":\"response_item\"") == null) return false;
    if (std.mem.indexOf(u8, line, "\"name\":\"request_user_input\"") != null) return true;
    if (std.mem.indexOf(u8, line, "\\\"sandbox_permissions\\\":\\\"require_escalated\\\"") != null) return true;
    return std.mem.indexOf(u8, line, "\"type\":\"permission_request\"") != null or
        std.mem.indexOf(u8, line, "\"type\":\"approval_request\"") != null or
        std.mem.indexOf(u8, line, "\"type\":\"request_permissions\"") != null;
}

fn escapedArgument(line: []const u8, marker: []const u8, out: []u8) ?[]const u8 {
    const at = std.mem.indexOf(u8, line, marker) orelse return null;
    const start = at + marker.len;
    var end = start;
    while (end + 1 < line.len) : (end += 1) {
        if (line[end] == '\\' and line[end + 1] == '"') break;
    }
    if (end <= start) return null;
    return clipEscaped(line[start..end], preview_max, out);
}

fn inputPrompt(line: []const u8, out: []u8) ?[]const u8 {
    const markers = [_][]const u8{
        "\\\"question\\\":\\\"",
        "\\\"justification\\\":\\\"",
        "\\\"prompt\\\":\\\"",
        "\\\"reason\\\":\\\"",
    };
    for (markers) |marker| {
        if (escapedArgument(line, marker, out)) |value| {
            if (value.len > 0) return value;
        }
    }
    return null;
}

fn pendingCallIndex(pending: *const [8]?[]const u8, count: usize, call_id: []const u8) ?usize {
    for (pending[0..count], 0..) |candidate, index| {
        if (candidate) |value| {
            if (std.mem.eql(u8, value, call_id)) return index;
        }
    }
    return null;
}

pub fn codexActivityFromTail(tail: []const u8) ?CodexActivity {
    var display: ?[]const u8 = null;
    var kind: CodexActivityKind = .status;
    var lifecycle_found = false;
    var status: hook_server.SessionStatus = .idle;
    var turn: []const u8 = "";
    var pending: [8]?[]const u8 = @splat(null);
    var pending_count: usize = 0;
    var resolved_call_id: []const u8 = "";
    var prompt_buf: [preview_max]u8 = undefined;

    var lines = std.mem.splitScalar(u8, tail, '\n');
    while (lines.next()) |raw_line| {
        const line = std.mem.trim(u8, raw_line, " \t\r\n");
        if (line.len == 0) continue;

        if (std.mem.indexOf(u8, line, "\"type\":\"task_started\"") != null) {
            lifecycle_found = true;
            status = .running;
            turn = jsonString(line, "turn_id") orelse "";
            display = null;
            kind = .status;
            pending_count = 0;
            continue;
        }
        if (std.mem.indexOf(u8, line, "\"type\":\"task_complete\"") != null) {
            lifecycle_found = true;
            status = .completed;
            turn = jsonString(line, "turn_id") orelse "";
            pending_count = 0;
            const final_message = jsonString(line, "last_agent_message") orelse "";
            if (std.mem.trim(u8, final_message, " \t\r\n").len > 0) {
                display = final_message;
                kind = .assistant;
            } else if (kind != .assistant or display == null or std.mem.trim(u8, display.?, " \t\r\n").len == 0) {
                // A bare completion must not leave a transient progress cue
                // on a terminal card. Preserve actual assistant prose when
                // it was already observed in the rollout.
                display = "Done.";
                kind = .status;
            }
            continue;
        }
        if (std.mem.indexOf(u8, line, "\"type\":\"turn_aborted\"") != null or
            std.mem.indexOf(u8, line, "\"type\":\"task_failed\"") != null)
        {
            lifecycle_found = true;
            status = .failed;
            turn = jsonString(line, "turn_id") orelse turn;
            pending_count = 0;
            display = if (jsonString(line, "reason")) |reason|
                (if (std.ascii.eqlIgnoreCase(reason, "interrupted")) "Interrupted." else "Session failed.")
            else
                "Session failed.";
            kind = .status;
            continue;
        }

        if (inputCall(line)) {
            const call_id = jsonString(line, "call_id") orelse "input-request";
            if (pendingCallIndex(&pending, pending_count, call_id) == null and pending_count < pending.len) {
                pending[pending_count] = call_id;
                pending_count += 1;
            }
            status = .needs_input;
            display = inputPrompt(line, &prompt_buf) orelse "Waiting for you…";
            kind = .prompt;
            continue;
        }
        if (std.mem.indexOf(u8, line, "\"type\":\"function_call_output\"") != null) {
            if (jsonString(line, "call_id")) |call_id| {
                if (pendingCallIndex(&pending, pending_count, call_id)) |index| {
                    resolved_call_id = call_id;
                    std.mem.copyForwards(?[]const u8, pending[index .. pending_count - 1], pending[index + 1 .. pending_count]);
                    pending_count -= 1;
                    pending[pending_count] = null;
                    if (pending_count == 0) {
                        status = .running;
                        display = "Thinking…";
                        kind = .status;
                    }
                }
            }
            continue;
        }

        if (std.mem.indexOf(u8, line, "\"type\":\"agent_message\"") != null) {
            if (jsonString(line, "message")) |message| {
                if (std.mem.trim(u8, message, " ").len > 0) {
                    display = message;
                    kind = .assistant;
                }
            }
        } else if (std.mem.indexOf(u8, line, "\"type\":\"agent_reasoning\"") != null) {
            if (jsonString(line, "text")) |reasoning| {
                if (kind != .assistant and std.mem.trim(u8, reasoning, " ").len > 0) {
                    display = reasoning;
                    kind = .reasoning;
                }
            }
        }
    }

    // A single long Codex turn can exceed the bounded rollout tail, pushing
    // its task_started record out while fresh visible commentary remains in
    // range. No current task_complete can precede that commentary, so this is
    // still an active turn. Treat it as busy instead of dropping the feed and
    // letting a tool hook become the last writer.
    if (!lifecycle_found) {
        if (display == null) return null;
        if (status == .idle) status = .running;
    }
    if (pending_count > 0) status = .needs_input;
    var activity: CodexActivity = .{ .busy = status == .running, .kind = kind, .status = status };
    const raw = display orelse if (status == .running) "Thinking…" else "Done.";
    const clipped = clipEscaped(raw, preview_max, &activity.text) orelse return null;
    activity.text_len = clipped.len;
    const turn_len = @min(turn.len, activity.turn.len);
    @memcpy(activity.turn[0..turn_len], turn[0..turn_len]);
    activity.turn_len = turn_len;
    if (pending_count > 0) {
        const request_id = pending[pending_count - 1].?;
        activity.request_id_len = @min(request_id.len, activity.request_id.len);
        @memcpy(activity.request_id[0..activity.request_id_len], request_id[0..activity.request_id_len]);
    } else if (resolved_call_id.len > 0) {
        activity.resolves_request_id_len = @min(resolved_call_id.len, activity.resolves_request_id.len);
        @memcpy(activity.resolves_request_id[0..activity.resolves_request_id_len], resolved_call_id[0..activity.resolves_request_id_len]);
    }
    return activity;
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
    body: [post_body_capacity]u8 = undefined,
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
    if (path.len > 16 or body.len > post_body_capacity or token.len > 128) return null;
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
    var req_buf: [post_body_capacity + 768]u8 = undefined;
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
    try t.expect(formatBubble("notification", "", &out) == null);
    try t.expectEqualStrings("Waiting for you…", formatBubble("notification", "{\"notification_type\":\"permission_prompt\"}", &out).?);
}

test "state mapping keeps post-tool work active until the turn completes" {
    try t.expectEqualStrings("review", stateForEvent("pre", "Read").?);
    try t.expectEqualStrings("running", stateForEvent("pre", "Bash").?);
    try t.expectEqualStrings("running", stateForEvent("post", null).?);
    try t.expectEqualStrings("waving", stateForEvent("stop", null).?);
    try t.expectEqualStrings("jumping", stateForEvent("user-prompt", null).?);
    try t.expect(stateForEvent("notification", null) == null);
    try t.expectEqualStrings("waiting", stateForEventWithNotification("notification", null, "agent_needs_input").?);
    try t.expectEqualStrings("failed", stateForEvent("tool-failure", "Bash").?);
    try t.expectEqualStrings("running", stateForEvent("post-model", null).?);
    try t.expectEqual(hook_server.SessionStatus.running, statusForEvent("post-model", null, ""));
}

test "Gemini final response uses its documented prompt_response field" {
    var out: [256]u8 = undefined;
    try t.expectEqualStrings(
        "Gemini answer",
        formatBubble("assistant", "{\"prompt_response\":\"Gemini answer\"}", &out).?,
    );
    try t.expect(formatBubble("post-model", "{\"prompt_response\":\"intermediate\"}", &out) == null);
}

test "tool failures keep the session running while the agent briefly fails" {
    try t.expectEqual(
        hook_server.SessionStatus.running,
        statusForEvent("tool-failure", "Bash", ""),
    );
    try t.expectEqualStrings("failed", stateForEvent("tool-failure", "Bash").?);
}

test "CodeBuddy derives failure only from its scoped PostToolUse success flag" {
    const failed_payload =
        \\{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"success":true},"tool_response":{"success":false,"error":"exit 1"}}
    ;
    const failed_phase = effectiveHookPhase("post", "codebuddy", failed_payload);
    try t.expectEqualStrings("tool-failure", failed_phase);
    try t.expectEqual(hook_server.SessionStatus.running, statusForEvent(failed_phase, "Bash", ""));
    try t.expectEqualStrings("failed", stateForEvent(failed_phase, "Bash").?);
    var out: [256]u8 = undefined;
    try t.expectEqualStrings("Bash failed", formatBubble(failed_phase, failed_payload, &out).?);

    const successful_payload =
        \\{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"success":false},"tool_response":{"success":true,"error":"user prose only"}}
    ;
    try t.expectEqualStrings("post", effectiveHookPhase("post", "codebuddy", successful_payload));
    try t.expectEqualStrings("post", effectiveHookPhase("post", "qoder", failed_payload));
    try t.expectEqualStrings("post", effectiveHookPhase("post", "codebuddy", "{malformed"));
}

test "Claude notification types follow the documented attention table" {
    for ([_][]const u8{ "permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input" }) |kind| {
        try t.expectEqual(hook_server.SessionStatus.needs_input, statusForEvent("notification", null, kind));
        try t.expectEqualStrings("waiting", stateForEventWithNotification("notification", null, kind).?);
    }
    for ([_][]const u8{ "idle_prompt", "agent_completed" }) |kind|
        try t.expectEqual(hook_server.SessionStatus.completed, statusForEvent("notification", null, kind));
    for ([_][]const u8{ "auth_success", "elicitation_complete", "elicitation_response", "future_type" }) |kind| {
        try t.expectEqual(hook_server.SessionStatus.idle, statusForEvent("notification", null, kind));
        try t.expect(stateForEventWithNotification("notification", null, kind) == null);
    }
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

test "explicit hook agent wins over payload metadata" {
    try t.expectEqualStrings(
        "codex",
        resolveAgent("{\"agent_source\":\"claude-code\"}", "codex"),
    );
    try t.expectEqualStrings(
        "claude-code",
        resolveAgent("{\"agent_source\":\"claude-code\"}", null),
    );
    try t.expectEqualStrings("", resolveAgent("{}", null));
    try t.expectEqualStrings("codex", resolveAgent("{}", "codex"));
}

test "bubbleBody carries session_id, and omits it when there is none" {
    var buf: [512]u8 = undefined;
    // The bug this pins: session_id was parsed and used for titles, but
    // neither body format string emitted it, so every Claude Code session
    // installed through the Zig runner collapsed onto one bubble slot.
    try t.expectEqualStrings(
        "{\"text\":\"Reading main.zig\",\"title\":\"Fix the tail\",\"busy\":true,\"agent_source\":\"claude-code\",\"session_id\":\"abc123\"}",
        bubbleBody(&buf, "Reading main.zig", "Fix the tail", true, "claude-code", "abc123").?,
    );
    // Regression guard: no session means byte-identity with what shipped
    // before per-conversation bubbles, title present or not.
    try t.expectEqualStrings(
        "{\"text\":\"Done.\",\"busy\":false,\"agent_source\":\"codex\"}",
        bubbleBody(&buf, "Done.", "", false, "codex", null).?,
    );
    try t.expectEqualStrings(
        "{\"text\":\"Done.\",\"title\":\"Ship it\",\"busy\":false,\"agent_source\":\"codex\"}",
        bubbleBody(&buf, "Done.", "Ship it", false, "codex", null).?,
    );
    try t.expectEqualStrings(
        "{\"text\":\"Working\",\"busy\":true,\"agent_source\":\"codex\",\"session_id\":\"s-1\"}",
        bubbleBody(&buf, "Working", "", true, "codex", "s-1").?,
    );
}

test "bubble metadata carries the exact Herdr pane id" {
    var buf: [2048]u8 = undefined;
    const body = bubbleBodyWithContext(&buf, "Needs approval", "Fix auth", false, "cursor", .{
        .session_id = "session-1",
        .source_app = "ghostty",
        .source_cwd = "/repo",
        .herdr_pane = "w1:p5",
    }).?;
    try t.expectEqualStrings("w1:p5", hook_server.jsonStringPub(body, "herdr_pane_id").?);
}

test "bubble metadata JSON-escapes Windows source paths" {
    const source_cwd = "C:\\Users\\me\\petdex";
    var buf: [4096]u8 = undefined;
    const body = bubbleBodyWithMetadata(
        &buf,
        "Running tests",
        "Fix hooks",
        true,
        "claude-code",
        "session-1",
        "windows-terminal",
        "",
        source_cwd,
        "",
        "running",
    ).?;

    var parsed = try std.json.parseFromSlice(std.json.Value, t.allocator, body, .{});
    defer parsed.deinit();
    try t.expectEqualStrings(source_cwd, parsed.value.object.get("source_cwd").?.string);

    // The production reader is strict JSON too; malformed `\U` escapes used
    // to make this exact body disappear as invalid_json.
    var mailbox: hook_server.Mailbox = .{};
    try t.expect(hook_server.applyBubbleJson(&mailbox, body, .hook) != null);
}

test "bubble metadata carries hostname turn and a safe Codex origin" {
    var buf: [2048]u8 = undefined;
    const body = bubbleBodyWithContext(
        &buf,
        "Running tests",
        "Revamp bubbles",
        true,
        "codex",
        .{
            .session_id = "thread-7",
            .conversation_key = "thread-7",
            .source_app = "codex",
            .source_tty = "/dev/ttys003",
            .source_cwd = "/work/petdex",
            .hostname = "shakib-mac",
            .turn_id = "turn-9",
            .status = .running,
        },
    ).?;
    try t.expectEqualStrings("shakib-mac", jsonString(body, "hostname").?);
    try t.expectEqualStrings("turn-9", jsonString(body, "turn_id").?);
    try t.expectEqualStrings("codex", jsonString(body, "source_app").?);
    try t.expectEqualStrings("thread-7", jsonString(body, "session_id").?);
}

test "supported harness session and prompt aliases resolve consistently" {
    var hash_buf: [64]u8 = undefined;
    try t.expectEqualStrings("claude-1", payloadSessionId("pre", "{\"session_id\":\"claude-1\"}", &hash_buf).?);
    try t.expectEqualStrings("omp-2", payloadSessionId("pre", "{\"sessionId\":\"omp-2\"}", &hash_buf).?);
    try t.expectEqualStrings("open-3", payloadSessionId("pre", "{\"sessionID\":\"open-3\"}", &hash_buf).?);
    try t.expectEqualStrings("codex-4", payloadSessionId("pre", "{\"thread_id\":\"codex-4\"}", &hash_buf).?);
    try t.expectEqualStrings("hermes-5", payloadSessionId("pre", "{\"conversation_id\":\"hermes-5\"}", &hash_buf).?);
    try t.expectEqualStrings("Fix the hooks", promptTitle("{\"prompt\":\"Fix the hooks\"}").?);
    try t.expectEqualStrings("Sync Hermes", promptTitle("{\"user_message\":\"Sync Hermes\"}").?);
}

test "Hermes subagent lifecycle binds the child summary to its parent" {
    const payload =
        "{\"session_id\":\"parent-session\",\"extra\":{\"child_session_id\":\"worker-session\",\"child_role\":\"researcher\",\"child_summary\":\"Found the compatibility shim.\"}}";
    var hash_buf: [64]u8 = undefined;
    const child = payloadSessionId("subagent-stop", payload, &hash_buf).?;
    try t.expectEqualStrings("worker-session", child);
    const context = payloadSessionContext("hermes", "subagent-stop", payload, child);
    try t.expectEqual(hook_server.SessionKind.subagent, context.kind);
    try t.expectEqualStrings("parent-session", context.conversationKey().?);
    try t.expectEqualStrings("parent-session", context.parentSession().?);
    try t.expectEqualStrings("researcher", context.labelSlice());
    try t.expectEqual(hook_server.MessageKind.assistant, messageKindForEvent("subagent-stop", payload, ""));
    var rendered: [256]u8 = undefined;
    try t.expectEqualStrings("Found the compatibility shim.", formatBubble("subagent-stop", payload, &rendered).?);
    try t.expect(formatBubble("subagent-start", payload, &rendered) == null);
}

test "known Hermes worker source spellings remain children while continuations stay primary" {
    const worker_payload = "{\"session_id\":\"worker\",\"parent_session_id\":\"root\",\"source\":\"delegated\"}";
    const worker = payloadSessionContext("hermes", "assistant", worker_payload, "worker");
    try t.expectEqual(hook_server.SessionKind.subagent, worker.kind);
    try t.expectEqualStrings("root", worker.conversationKey().?);

    // Parent linkage alone is intentionally insufficient: Hermes uses the
    // same relation for compression and branch continuations.
    const continuation_payload = "{\"session_id\":\"tip\",\"parent_session_id\":\"root\",\"source\":\"tui\"}";
    const continuation = payloadSessionContext("hermes", "assistant", continuation_payload, "tip");
    try t.expectEqual(hook_server.SessionKind.primary, continuation.kind);
    try t.expectEqualStrings("tip", continuation.conversationKey().?);
}

test "Codex title index chooses the newest server-side rename" {
    const index =
        "{\"id\":\"other\",\"thread_name\":\"Other chat\"}\n" ++
        "{\"id\":\"thread-7\",\"thread_name\":\"Initial prompt title\"}\n" ++
        "{\"id\":\"thread-7\",\"thread_name\":\"Renamed by server\"}\n";
    var out: [256]u8 = undefined;
    try t.expectEqualStrings("Renamed by server", codexIndexTitleFromTail(index, "thread-7", &out).?);
    try t.expect(codexIndexTitleFromTail(index, "missing", &out) == null);
}

test "namespaced adapter title wins without reading nested tool title" {
    const payload =
        "{\"tool_input\":{\"title\":\"Document heading\"}," ++
        "\"petdex_session_title\":\"Hermes server title\"}";
    var out: [256]u8 = undefined;
    try t.expectEqualStrings(
        "Hermes server title",
        authoritativeTitle("hermes", "/missing", "session-1", payload, &out).?,
    );
}

test "two runner sessions reach the mailbox as two bubbles" {
    // End to end over the real parser and the real mailbox: this is the
    // acceptance criterion of #657 on the path the default install uses,
    // which the TS CLI fix alone never covered.
    hook_server.mailbox.clearBubbles();

    var buf_a: [512]u8 = undefined;
    var buf_b: [512]u8 = undefined;
    const body_a = bubbleBody(&buf_a, "Reading main.zig", "Fix the tail", true, "claude-code", "sess-a").?;
    const body_b = bubbleBody(&buf_b, "Running tests", "Ship it", true, "claude-code", "sess-b").?;

    for ([_][]const u8{ body_a, body_b }) |body| {
        const text = hook_server.jsonStringPub(body, "text").?;
        const agent = hook_server.jsonStringPub(body, "agent_source").?;
        const title = hook_server.jsonStringPub(body, "title") orelse "";
        const session = hook_server.jsonStringPub(body, "session_id") orelse "";
        const busy = std.mem.indexOf(u8, body, "\"busy\":true") != null;
        _ = hook_server.mailbox.setBubble(session, text, agent, title, busy);
    }

    var out: [hook_server.max_bubbles]hook_server.Bubble = @splat(.{});
    try t.expectEqual(@as(?usize, 2), hook_server.mailbox.takeBubbles(&out));
    try t.expectEqualStrings("sess-a", out[0].sessionSlice());
    try t.expectEqualStrings("sess-b", out[1].sessionSlice());

    // A payload with no session still shares the single legacy slot.
    hook_server.mailbox.clearBubbles();
    var buf_c: [512]u8 = undefined;
    const legacy = bubbleBody(&buf_c, "Done.", "", false, "codex", null).?;
    const legacy_session = hook_server.jsonStringPub(legacy, "session_id") orelse "";
    try t.expectEqualStrings("", legacy_session);
    _ = hook_server.mailbox.setBubble(legacy_session, "Done.", "codex", "", false);
    _ = hook_server.mailbox.setBubble(legacy_session, "Again.", "codex", "", false);
    try t.expectEqual(@as(?usize, 1), hook_server.mailbox.takeBubbles(&out));
    hook_server.mailbox.clearBubbles();
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

test "Codex rollout activity follows visible reasoning during an active turn" {
    const tail =
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"turn-1\"}}\n" ++
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_reasoning\",\"text\":\"Inspecting the session index\"}}\n";
    const activity = codexActivityFromTail(tail).?;
    try std.testing.expect(activity.busy);
    try std.testing.expectEqual(hook_server.SessionStatus.running, activity.status);
    try std.testing.expectEqual(CodexActivityKind.reasoning, activity.kind);
    try std.testing.expectEqualStrings("Inspecting the session index", activity.textSlice());
    try std.testing.expectEqualStrings("turn-1", activity.turnSlice());
}

test "Codex assistant prose outranks later intermediate reasoning in the turn" {
    const tail =
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"turn-prose\"}}\n" ++
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"Here is the useful answer.\"}}\n" ++
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_reasoning\",\"text\":\"Checking one more detail\"}}\n";
    const activity = codexActivityFromTail(tail).?;
    try std.testing.expectEqual(CodexActivityKind.assistant, activity.kind);
    try std.testing.expectEqualStrings("Here is the useful answer.", activity.textSlice());
}

test "Codex completed activity uses the final app-visible message" {
    const tail =
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"turn-2\"}}\n" ++
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_reasoning\",\"text\":\"Working\"}}\n" ++
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"turn-2\",\"last_agent_message\":\"Finished with details\"}}\n";
    const activity = codexActivityFromTail(tail).?;
    try std.testing.expect(!activity.busy);
    try std.testing.expectEqual(hook_server.SessionStatus.completed, activity.status);
    try std.testing.expectEqual(CodexActivityKind.assistant, activity.kind);
    try std.testing.expectEqualStrings("Finished with details", activity.textSlice());
}

test "Codex bare completion clears transient copy but retains assistant prose" {
    const transient =
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"turn-bare\"}}\n" ++
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"request_user_input\",\"arguments\":\"{\\\"questions\\\":[{\\\"question\\\":\\\"Continue?\\\"}]}\",\"call_id\":\"call-bare\"}}\n" ++
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"call-bare\"}}\n" ++
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"turn-bare\"}}\n";
    const done = codexActivityFromTail(transient).?;
    try std.testing.expectEqual(hook_server.SessionStatus.completed, done.status);
    try std.testing.expect(!done.busy);
    try std.testing.expectEqual(CodexActivityKind.status, done.kind);
    try std.testing.expectEqualStrings("Done.", done.textSlice());

    const prose =
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"turn-prose-complete\"}}\n" ++
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"Useful final answer.\"}}\n" ++
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"turn-prose-complete\",\"last_agent_message\":\"   \"}}\n";
    const retained = codexActivityFromTail(prose).?;
    try std.testing.expectEqual(hook_server.SessionStatus.completed, retained.status);
    try std.testing.expect(!retained.busy);
    try std.testing.expectEqual(CodexActivityKind.assistant, retained.kind);
    try std.testing.expectEqualStrings("Useful final answer.", retained.textSlice());
}

test "Codex aborted activity remains a terminal failure cue" {
    const tail =
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"turn-stop\"}}\n" ++
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"turn_aborted\",\"turn_id\":\"turn-stop\",\"reason\":\"interrupted\"}}\n";
    const activity = codexActivityFromTail(tail).?;
    try std.testing.expect(!activity.busy);
    try std.testing.expectEqual(hook_server.SessionStatus.failed, activity.status);
    try std.testing.expectEqualStrings("Interrupted.", activity.textSlice());
}

test "Codex unmatched input call exposes the question until its response" {
    const waiting_tail =
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"turn-input\"}}\n" ++
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"request_user_input\",\"arguments\":\"{\\\"questions\\\":[{\\\"question\\\":\\\"Which host should I use?\\\"}]}\",\"call_id\":\"call-input\"}}\n";
    const waiting = codexActivityFromTail(waiting_tail).?;
    try std.testing.expectEqual(hook_server.SessionStatus.needs_input, waiting.status);
    try std.testing.expectEqual(CodexActivityKind.prompt, waiting.kind);
    try std.testing.expectEqualStrings("Which host should I use?", waiting.textSlice());

    const resumed_tail = waiting_tail ++
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"call-input\",\"output\":\"inframework\"}}\n";
    const resumed = codexActivityFromTail(resumed_tail).?;
    try std.testing.expectEqual(hook_server.SessionStatus.running, resumed.status);
    try std.testing.expectEqualStrings("Thinking…", resumed.textSlice());
}

test "Codex escalation call is user-input-required until tool output" {
    const tail =
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"turn-approval\"}}\n" ++
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"exec_command\",\"arguments\":\"{\\\"sandbox_permissions\\\":\\\"require_escalated\\\",\\\"justification\\\":\\\"Allow launching Petdesk?\\\"}\",\"call_id\":\"call-approval\"}}\n";
    const activity = codexActivityFromTail(tail).?;
    try std.testing.expectEqual(hook_server.SessionStatus.needs_input, activity.status);
    try std.testing.expectEqualStrings("Allow launching Petdesk?", activity.textSlice());
}

test "Codex truncated active tail keeps the latest app-visible commentary" {
    const tail =
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"I’m matching the Codex Pet feed\"}}\n" ++
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"name\":\"exec_command\"}}\n" ++
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call_output\",\"output\":\"done\"}}\n";
    const activity = codexActivityFromTail(tail).?;
    try std.testing.expect(activity.busy);
    try std.testing.expectEqual(CodexActivityKind.assistant, activity.kind);
    try std.testing.expectEqualStrings("I’m matching the Codex Pet feed", activity.textSlice());
}

test "local Codex tool hooks update mascot state without replacing feed" {
    try std.testing.expect(!shouldPostBubble("codex", "pre"));
    try std.testing.expect(!shouldPostBubble("CODEX", "post"));
    try std.testing.expect(!shouldPostBubble("codex", "tool-failure"));
    try std.testing.expect(shouldPostBubble("codex", "user-prompt"));
    try std.testing.expect(shouldPostBubble("codex", "stop"));
    try std.testing.expect(shouldPostBubble("hermes", "post"));
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

test "a bubble without a reported state is byte-identical to before" {
    // The flock reads agent_state, but every sender that does not know one
    // must keep producing exactly the body that shipped before the field
    // existed: this is the compatibility promise, not a preference.
    var with: [1536]u8 = undefined;
    var without: [1536]u8 = undefined;
    const a = bubbleBodyWithMetadata(&with, "text", "title", true, "claude", "s1", "", "", "", "", null).?;
    const b = bubbleBody(&without, "text", "title", true, "claude", "s1").?;
    try std.testing.expectEqualStrings(b, a);
    try std.testing.expect(std.mem.indexOf(u8, a, "agent_state") == null);
}

test "a reported state rides the bubble that carries the session" {
    var buf: [1536]u8 = undefined;
    const body = bubbleBodyWithMetadata(&buf, "text", "title", true, "claude", "s1", "", "", "", "", "failed").?;
    try std.testing.expect(std.mem.indexOf(u8, body, "\"agent_state\":\"failed\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"session_id\":\"s1\"") != null);
}

test "the states only direct hooks can see reach the bubble" {
    // stateForEvent already computes these; before this they only went to
    // /state, which aggregates and cannot show two agents at once.
    try std.testing.expectEqualStrings("failed", stateForEvent("tool-failure", "Bash").?);
    try std.testing.expectEqualStrings("review", stateForEvent("pre", "Read").?);
    try std.testing.expectEqualStrings("waiting", stateForEvent("approval-request", null).?);
}
