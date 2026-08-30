//! In-process replacement for the Node sidecar's HTTP surface on
//! 127.0.0.1:7777. Same contract the hooks already speak: token-gated
//! POST /state, /bubble and /bubble/title (header x-petdex-update-token, token file
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
const builtin = @import("builtin");
const plat = @import("plat.zig");
const dsh_integration = @import("dsh_integration.zig");

/// One connection with the persistent buffered writer used for its response.
/// The request is pre-read under one absolute deadline before routing.
const Conn = struct {
    stream: std.Io.net.Stream,
    io: std.Io,
    writer: *std.Io.Writer,
};

pub const max_pending = 50;
const max_active_connections: u32 = 64;
const max_request_bytes: usize = 8192;
const connection_timeout_ms: i64 = 5_000;
const response_drain_grace_ms: i64 = 300;
pub const bubble_text_capacity: usize = 4096;
pub const bubble_title_capacity: usize = 256;
pub const bubble_session_capacity: usize = 96;
pub const bubble_message_id_capacity: usize = 96;
pub const bubble_child_message_capacity: usize = 512;
pub const max_child_messages: usize = 8;
pub const max_pending_inputs: usize = 4;

pub const SessionStatus = enum(u8) {
    idle,
    running,
    needs_input,
    completed,
    failed,

    pub fn fromWire(raw: []const u8) ?SessionStatus {
        if (std.mem.eql(u8, raw, "idle")) return .idle;
        if (std.mem.eql(u8, raw, "running")) return .running;
        if (std.mem.eql(u8, raw, "needs_input")) return .needs_input;
        if (std.mem.eql(u8, raw, "completed")) return .completed;
        if (std.mem.eql(u8, raw, "failed")) return .failed;
        return null;
    }

    pub fn wireName(self: SessionStatus) []const u8 {
        return switch (self) {
            .idle => "idle",
            .running => "running",
            .needs_input => "needs_input",
            .completed => "completed",
            .failed => "failed",
        };
    }
};

pub const SessionKind = enum(u8) {
    primary,
    subagent,

    fn fromWire(raw: []const u8) SessionKind {
        return if (std.mem.eql(u8, raw, "subagent")) .subagent else .primary;
    }
};

pub const MessageKind = enum(u8) {
    status,
    reasoning,
    assistant,
    tool,
    lifecycle,
    prompt,

    fn fromWire(raw: []const u8) MessageKind {
        if (std.mem.eql(u8, raw, "reasoning")) return .reasoning;
        if (std.mem.eql(u8, raw, "assistant")) return .assistant;
        if (std.mem.eql(u8, raw, "tool")) return .tool;
        if (std.mem.eql(u8, raw, "lifecycle")) return .lifecycle;
        if (std.mem.eql(u8, raw, "prompt")) return .prompt;
        return .status;
    }
};

pub const TitleSource = enum(u8) {
    unknown,
    prompt,
    server,

    fn fromWire(raw: []const u8) TitleSource {
        if (std.mem.eql(u8, raw, "server")) return .server;
        if (std.mem.eql(u8, raw, "prompt")) return .prompt;
        return .unknown;
    }
};

pub const FeedSource = enum(u8) {
    hook,
    journal,
    native_store,
    local_api,

    fn fromWire(raw: []const u8) FeedSource {
        if (std.mem.eql(u8, raw, "journal")) return .journal;
        if (std.mem.eql(u8, raw, "native_store") or
            std.mem.eql(u8, raw, "rollout") or
            std.mem.eql(u8, raw, "hermes_state")) return .native_store;
        if (std.mem.eql(u8, raw, "local_api")) return .local_api;
        return .hook;
    }

    fn rank(self: FeedSource) u8 {
        return switch (self) {
            .journal => 1,
            .native_store => 2,
            .local_api => 3,
            .hook => 4,
        };
    }
};

pub const ChildMessage = struct {
    text: [bubble_child_message_capacity]u8 = @splat(0),
    text_len: usize = 0,
    label: [48]u8 = @splat(0),
    label_len: usize = 0,
    source_session: [bubble_session_capacity]u8 = @splat(0),
    source_session_len: usize = 0,
    message_id: [bubble_message_id_capacity]u8 = @splat(0),
    message_id_len: usize = 0,
    counter: u64 = 0,

    pub fn textSlice(self: *const ChildMessage) []const u8 {
        return self.text[0..self.text_len];
    }

    pub fn labelSlice(self: *const ChildMessage) []const u8 {
        return self.label[0..self.label_len];
    }

    pub fn sourceSessionSlice(self: *const ChildMessage) []const u8 {
        return self.source_session[0..self.source_session_len];
    }

    pub fn messageIdSlice(self: *const ChildMessage) []const u8 {
        return self.message_id[0..self.message_id_len];
    }
};

/// Windows' std.Io stream reader intentionally waits for the AFD receive
/// operation to complete, but it has no stream-level timeout API. Poll the
/// socket with the native AFD control path first, then use the existing
/// reader only after the kernel reports readable or closed state. This keeps
/// the receive buffer and the platform-independent parser unchanged while
/// making the connection deadline real on Windows too.
const AfdPollHandle = extern struct {
    handle: std.os.windows.HANDLE,
    events: std.os.windows.ULONG,
    status: std.os.windows.NTSTATUS,
};

const AfdPollInfo = extern struct {
    timeout: std.os.windows.LARGE_INTEGER,
    handle_count: std.os.windows.ULONG,
    exclusive: std.os.windows.ULONG,
    handles: [1]AfdPollHandle,
};

const afd_event_receive: std.os.windows.ULONG = 1 << 0;
const afd_event_disconnect: std.os.windows.ULONG = 1 << 3;
const afd_event_abort: std.os.windows.ULONG = 1 << 4;
const afd_event_close: std.os.windows.ULONG = 1 << 5;
const afd_readable_events = afd_event_receive |
    afd_event_disconnect |
    afd_event_abort |
    afd_event_close;

// AFD.POLL is issued directly on each accepted socket handle below. The AFD
// endpoint is created by Winsock; opening a separate \Device\Afd child and
// sending the ioctl to that control handle is rejected by Windows.
pub const StateEvent = struct {
    state: [16]u8 = @splat(0),
    state_len: usize = 0,
    duration_ms: u32 = 0,

    pub fn slice(self: *const StateEvent) []const u8 {
        return self.state[0..self.state_len];
    }
};

pub const Bubble = struct {
    text: [bubble_text_capacity]u8 = @splat(0),
    text_len: usize = 0,
    title: [bubble_title_capacity]u8 = @splat(0),
    title_len: usize = 0,
    agent: [24]u8 = @splat(0),
    agent_len: usize = 0,
    /// Which conversation this bubble belongs to. Empty is the sentinel
    /// key an agent without a session_id lands on (older CLI, the MCP
    /// path), which is what keeps single-bubble behaviour identical.
    session: [bubble_session_capacity]u8 = @splat(0),
    session_len: usize = 0,
    /// Raw provider session that emitted the current primary update. The
    /// `session` field above is the stable canonical conversation key.
    source_session: [bubble_session_capacity]u8 = @splat(0),
    source_session_len: usize = 0,
    parent_session: [bubble_session_capacity]u8 = @splat(0),
    parent_session_len: usize = 0,
    session_kind: SessionKind = .primary,
    status: SessionStatus = .idle,
    message_kind: MessageKind = .status,
    title_source: TitleSource = .unknown,
    feed_source: FeedSource = .hook,
    message_id: [bubble_message_id_capacity]u8 = @splat(0),
    message_id_len: usize = 0,
    pending_input_ids: [max_pending_inputs][bubble_message_id_capacity]u8 = @splat(@splat(0)),
    pending_input_id_lens: [max_pending_inputs]usize = @splat(0),
    pending_input_ids_len: usize = 0,
    /// Providers that cannot supply a correlation id get one bounded pending
    /// request per conversation. Unlike keyed requests, definitive resumed
    /// work may safely clear this fallback.
    pending_unkeyed_input: bool = false,
    completed_at_ms: i64 = 0,
    child_messages: [max_child_messages]ChildMessage = @splat(.{}),
    child_messages_len: usize = 0,
    origin_app: plat.OriginApplication = .none,
    source_tty: [64]u8 = @splat(0),
    source_tty_len: usize = 0,
    source_cwd: [512]u8 = @splat(0),
    source_cwd_len: usize = 0,
    herdr_pane: [64]u8 = @splat(0),
    herdr_pane_len: usize = 0,
    /// Machine that owns the agent process. Local hooks report the Mac's
    /// hostname; SSH hooks report the remote host, so the header never has
    /// to infer locality from a filesystem path.
    hostname: [64]u8 = @splat(0),
    hostname_len: usize = 0,
    /// Active agent turn. Codex requires both thread + turn ids for a safe
    /// interrupt/steer request; other agents leave this empty.
    turn: [64]u8 = @splat(0),
    turn_len: usize = 0,
    remote: bool = false,
    busy: bool = false,
    /// Per-agent attention, when the sender knows it. `busy` alone cannot
    /// tell a blocked agent from an idle one, and that distinction is the
    /// whole point of showing a body per agent. Empty means the sender did
    /// not say, and readers fall back to `busy`.
    agent_state: [16]u8 = @splat(0),
    agent_state_len: usize = 0,
    /// Last distinct running event accepted for this conversation. This is
    /// intentionally separate from `counter`: repeated transport heartbeats
    /// must not keep an abandoned card visually active forever.
    last_meaningful_activity_ms: i64 = 0,
    last_activity_fingerprint: u64 = 0,
    /// Set after the desktop has quieted a running card. An identical running
    /// snapshot must not immediately restart its animation; a meaningful
    /// event below clears this flag.
    stale_running_suppressed: bool = false,
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
    pub fn agentStateSlice(self: *const Bubble) []const u8 {
        return self.agent_state[0..self.agent_state_len];
    }
    pub fn hostnameSlice(self: *const Bubble) []const u8 {
        return self.hostname[0..self.hostname_len];
    }
    pub fn turnSlice(self: *const Bubble) []const u8 {
        return self.turn[0..self.turn_len];
    }
    pub fn sourceSessionSlice(self: *const Bubble) []const u8 {
        return self.source_session[0..self.source_session_len];
    }
    pub fn parentSessionSlice(self: *const Bubble) []const u8 {
        return self.parent_session[0..self.parent_session_len];
    }
    pub fn messageIdSlice(self: *const Bubble) []const u8 {
        return self.message_id[0..self.message_id_len];
    }
};

/// How many conversations can narrate at once. Fixed because the
/// mailbox holds them inline: no allocator runs on the hook hot path.
pub const max_bubbles = 8;

/// Provider-neutral update accepted by the mailbox. The HTTP route and
/// in-process rollout reconcilers both lower their event shapes into this one
/// record, so canonical identity and message precedence cannot drift by feed.
pub const BubbleUpdate = struct {
    conversation_key: []const u8 = "",
    source_session: []const u8 = "",
    parent_session: []const u8 = "",
    text: []const u8 = "",
    agent: []const u8 = "",
    title: []const u8 = "",
    origin_app: plat.OriginApplication = .none,
    source_tty: []const u8 = "",
    source_cwd: []const u8 = "",
    herdr_pane: []const u8 = "",
    hostname: []const u8 = "",
    turn: []const u8 = "",
    message_id: []const u8 = "",
    event_kind: []const u8 = "",
    request_id: []const u8 = "",
    resolves_request_id: []const u8 = "",
    notification_kind: []const u8 = "",
    subagent_label: []const u8 = "",
    remote: bool = false,
    busy: bool = false,
    status: ?SessionStatus = null,
    session_kind: SessionKind = .primary,
    message_kind: MessageKind = .status,
    title_source: TitleSource = .unknown,
    feed_source: FeedSource = .hook,
};

fn copyField(destination: []u8, source: []const u8) usize {
    const count = @min(destination.len, source.len);
    @memset(destination, 0);
    @memcpy(destination[0..count], source[0..count]);
    return count;
}

fn identityMatches(bubble: *const Bubble, update: BubbleUpdate) bool {
    if (!std.mem.eql(u8, bubble.sessionSlice(), update.conversation_key)) return false;
    // Empty is the compatibility slot used by pre-session integrations.
    if (update.conversation_key.len == 0) return true;
    if (bubble.remote != update.remote) return false;
    if (!std.ascii.eqlIgnoreCase(bubble.agent[0..bubble.agent_len], update.agent)) return false;
    if (!update.remote) return true;
    return std.ascii.eqlIgnoreCase(bubble.hostnameSlice(), update.hostname);
}

/// Match a provisional card opened under a raw child id before its provider
/// had persisted canonical ancestry. Once that same raw id is authoritatively
/// identified as a subagent, the provisional card must disappear rather than
/// survive beside its parent until normal expiry.
fn sourceSessionIdentityMatches(bubble: *const Bubble, update: BubbleUpdate) bool {
    if (update.source_session.len == 0 or
        std.mem.eql(u8, update.source_session, update.conversation_key) or
        !std.mem.eql(u8, bubble.sessionSlice(), update.source_session)) return false;
    if (bubble.remote != update.remote) return false;
    if (!std.ascii.eqlIgnoreCase(bubble.agent[0..bubble.agent_len], update.agent)) return false;
    if (!update.remote) return true;
    return std.ascii.eqlIgnoreCase(bubble.hostnameSlice(), update.hostname);
}

fn shouldReplaceMessage(bubble: *const Bubble, update: BubbleUpdate) bool {
    if (std.mem.trim(u8, update.text, " \t\r\n").len == 0) return false;
    if (bubble.text_len == 0) return true;
    if (update.status == .failed) return true;
    if (update.message_kind == .assistant or update.message_kind == .prompt) return true;
    if (update.status == .needs_input) return true;
    if (update.turn.len > 0 and !std.mem.eql(u8, bubble.turnSlice(), update.turn)) return true;
    // Once user-visible assistant prose exists for this turn, lower-level
    // reasoning, tools and lifecycle summaries may update state but not the
    // feed text. This is the Codex Pet/Petdesk parity invariant.
    if (bubble.message_kind == .assistant) return false;
    if (update.message_kind == .reasoning) return true;
    if (update.message_kind == .tool and bubble.message_kind != .reasoning) return true;
    return bubble.message_kind == .status or bubble.message_kind == .lifecycle;
}

fn childMessageMatches(message: *const ChildMessage, update: BubbleUpdate) bool {
    if (update.message_id.len > 0 and message.message_id_len > 0)
        return std.mem.eql(u8, message.messageIdSlice(), update.message_id);
    return std.mem.eql(u8, message.sourceSessionSlice(), update.source_session) and
        std.mem.eql(u8, message.textSlice(), update.text);
}

fn childMessageEquivalent(message: *const ChildMessage, update: BubbleUpdate) bool {
    return std.mem.eql(u8, message.textSlice(), update.text) and
        std.mem.eql(u8, message.labelSlice(), if (update.subagent_label.len > 0) update.subagent_label else "Subagent") and
        std.mem.eql(u8, message.sourceSessionSlice(), update.source_session) and
        std.mem.eql(u8, message.messageIdSlice(), update.message_id);
}

/// A provider may poll/replay a `running` status for minutes without any new
/// assistant work. Only an event with a distinct, user-relevant token is
/// allowed to refresh a card's activity lease.
fn runningActivityFingerprint(update: BubbleUpdate) u64 {
    if (update.message_id.len == 0 and update.turn.len == 0 and update.text.len == 0 and update.event_kind.len == 0)
        return 0;
    var hash: u64 = 1469598103934665603;
    const mix = struct {
        fn apply(current: *u64, value: []const u8) void {
            for (value) |byte| current.* = (current.* ^ byte) *% 1099511628211;
            current.* = (current.* ^ 0xff) *% 1099511628211;
        }
    }.apply;
    mix(&hash, update.message_id);
    mix(&hash, update.turn);
    mix(&hash, update.event_kind);
    mix(&hash, update.text);
    return hash;
}

fn bubblePresentationEquivalent(before: Bubble, after: Bubble) bool {
    var left = before;
    var right = after;
    // These fields govern feed freshness and ordering, not visible card
    // content. Comparing them would turn an otherwise identical heartbeat
    // into a redraw.
    left.counter = 0;
    right.counter = 0;
    left.last_meaningful_activity_ms = 0;
    right.last_meaningful_activity_ms = 0;
    left.last_activity_fingerprint = 0;
    right.last_activity_fingerprint = 0;
    return std.meta.eql(left, right);
}

fn pendingInputKey(update: BubbleUpdate) []const u8 {
    if (update.request_id.len > 0) return update.request_id;
    return update.message_id;
}

fn pendingInputIndex(bubble: *const Bubble, key: []const u8) ?usize {
    if (key.len == 0) return null;
    for (0..bubble.pending_input_ids_len) |index| {
        if (std.mem.eql(u8, bubble.pending_input_ids[index][0..bubble.pending_input_id_lens[index]], key)) return index;
    }
    return null;
}

fn clearPendingInputs(bubble: *Bubble) void {
    bubble.pending_input_ids_len = 0;
    bubble.pending_unkeyed_input = false;
    @memset(&bubble.pending_input_ids, @splat(0));
    @memset(&bubble.pending_input_id_lens, 0);
}

fn notificationNeedsInput(kind: []const u8) bool {
    return std.mem.eql(u8, kind, "permission_prompt") or
        std.mem.eql(u8, kind, "elicitation_dialog") or
        std.mem.eql(u8, kind, "elicitation_url_dialog") or
        std.mem.eql(u8, kind, "agent_needs_input");
}

fn notificationCompletes(kind: []const u8) bool {
    return std.mem.eql(u8, kind, "idle_prompt") or
        std.mem.eql(u8, kind, "agent_completed");
}

fn normalizedProposedStatus(update: BubbleUpdate) SessionStatus {
    const proposed = update.status orelse if (update.busy) SessionStatus.running else SessionStatus.idle;
    // Claude-shaped Notification hooks are deliberately closed over the
    // documented notification_type values. Unknown or authentication-only
    // notifications must never manufacture an orange card.
    if (std.mem.eql(u8, update.event_kind, "notification")) {
        if (notificationNeedsInput(update.notification_kind)) return .needs_input;
        if (notificationCompletes(update.notification_kind)) return .completed;
        return if (update.busy) .running else .idle;
    }
    // `waiting` is a mascot phase used by older integrations, not evidence of
    // an outstanding user request. Explicit approval/question event kinds and
    // legacy callers without event_kind retain their intended status.
    if (std.mem.eql(u8, update.event_kind, "waiting"))
        return if (update.busy) .running else .idle;
    return proposed;
}

fn isDefinitiveResume(update: BubbleUpdate) bool {
    if (std.mem.eql(u8, update.event_kind, "user-prompt") or
        std.mem.eql(u8, update.event_kind, "new-turn") or
        std.mem.eql(u8, update.event_kind, "assistant") or
        std.mem.eql(u8, update.event_kind, "approval-response")) return true;
    return update.message_kind == .assistant or update.message_kind == .reasoning or
        update.message_kind == .tool or
        (update.turn.len > 0);
}

fn removePendingInput(bubble: *Bubble, index: usize) void {
    if (index >= bubble.pending_input_ids_len) return;
    std.mem.copyForwards([bubble_message_id_capacity]u8, bubble.pending_input_ids[index .. bubble.pending_input_ids_len - 1], bubble.pending_input_ids[index + 1 .. bubble.pending_input_ids_len]);
    std.mem.copyForwards(usize, bubble.pending_input_id_lens[index .. bubble.pending_input_ids_len - 1], bubble.pending_input_id_lens[index + 1 .. bubble.pending_input_ids_len]);
    bubble.pending_input_ids_len -= 1;
    bubble.pending_input_ids[bubble.pending_input_ids_len] = @splat(0);
    bubble.pending_input_id_lens[bubble.pending_input_ids_len] = 0;
}

fn reconcileStatus(bubble: *Bubble, update: BubbleUpdate, proposed: SessionStatus) SessionStatus {
    const key = pendingInputKey(update);
    switch (proposed) {
        .failed, .completed, .idle => clearPendingInputs(bubble),
        .needs_input => {
            if (key.len > 0 and pendingInputIndex(bubble, key) == null) {
                if (bubble.pending_input_ids_len == max_pending_inputs) removePendingInput(bubble, 0);
                const index = bubble.pending_input_ids_len;
                bubble.pending_input_id_lens[index] = copyField(&bubble.pending_input_ids[index], key);
                bubble.pending_input_ids_len += 1;
            } else if (key.len == 0) {
                bubble.pending_unkeyed_input = true;
            }
        },
        .running => {
            const resolving_key = if (update.resolves_request_id.len > 0) update.resolves_request_id else "";
            if (pendingInputIndex(bubble, resolving_key)) |index| {
                removePendingInput(bubble, index);
            }
            if (bubble.pending_unkeyed_input and isDefinitiveResume(update))
                bubble.pending_unkeyed_input = false;
            // A genuinely new turn invalidates even keyed requests from the
            // previous turn. Ordinary tool/assistant progress only resolves
            // the bounded unkeyed fallback.
            if (std.mem.eql(u8, update.event_kind, "user-prompt") or
                std.mem.eql(u8, update.event_kind, "new-turn")) clearPendingInputs(bubble);
        },
    }
    if (proposed == .failed) return .failed;
    if (bubble.pending_input_ids_len > 0 or bubble.pending_unkeyed_input) return .needs_input;
    return proposed;
}

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
    /// In-process diagnostic counters for duplicate/stale feed behavior.
    /// They deliberately stay with each mailbox instance and are not emitted
    /// as telemetry.
    pub const BubbleRenderDebugCounters = struct {
        suppressed_duplicates: u64 = 0,
        stale_transitions: u64 = 0,
    };

    mutex: SpinMutex = .{},
    pending: [max_pending]StateEvent = @splat(.{}),
    pending_len: usize = 0,
    /// Last semantic sprite state accepted by the queue.  It intentionally
    /// survives a drain: providers commonly emit the same `running` state for
    /// every tool heartbeat, and re-enqueuing it after each poll would restart
    /// the pet animation forever without conveying new user-visible state.
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
    bubble_render_debug: BubbleRenderDebugCounters = .{},

    pub const EnqueueResult = struct {
        queued: bool,
        counter: u64,
    };

    /// Coalesce + append, sidecar semantics: identical steady states collapse
    /// even after the consumer drains them.  A different state (or duration)
    /// remains an explicit transition, so completion, failure, and the next
    /// task still reach the mascot immediately.
    pub fn enqueue(self: *Mailbox, event: StateEvent) bool {
        return self.enqueueWithCounter(event).queued;
    }

    pub fn enqueueWithCounter(self: *Mailbox, event: StateEvent) EnqueueResult {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.last_enqueued.state_len > 0 and stateEventEquivalent(self.last_enqueued, event)) {
            return .{ .queued = false, .counter = self.state_counter };
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
        if (self.pending_len == 0) return null;
        const head = self.pending[0];
        std.mem.copyForwards(StateEvent, self.pending[0 .. self.pending_len - 1], self.pending[1..self.pending_len]);
        self.pending_len -= 1;
        return head;
    }

    pub fn bubbleRenderDebugCounters(self: *Mailbox) BubbleRenderDebugCounters {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.bubble_render_debug;
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
        return self.applyBubbleUpdate(.{
            .conversation_key = session,
            .source_session = session,
            .text = text,
            .agent = agent,
            .title = title,
            .origin_app = origin_app,
            .source_tty = source_tty,
            .source_cwd = source_cwd,
            .herdr_pane = herdr_pane,
            .busy = busy,
            .status = if (busy) .running else .idle,
        });
    }

    pub fn setBubbleWithContext(self: *Mailbox, session: []const u8, text: []const u8, agent: []const u8, title: []const u8, origin_app: plat.OriginApplication, source_tty: []const u8, source_cwd: []const u8, hostname: []const u8, turn: []const u8, remote: bool, busy: bool) u64 {
        return self.applyBubbleUpdate(.{
            .conversation_key = session,
            .source_session = session,
            .text = text,
            .agent = agent,
            .title = title,
            .origin_app = origin_app,
            .source_tty = source_tty,
            .source_cwd = source_cwd,
            .hostname = hostname,
            .turn = turn,
            .remote = remote,
            .busy = busy,
            .status = if (busy) .running else .idle,
        });
    }

    pub fn applyBubbleUpdate(self: *Mailbox, update_raw: BubbleUpdate) u64 {
        var conversation_hash: [64]u8 = undefined;
        var source_hash: [64]u8 = undefined;
        var parent_hash: [64]u8 = undefined;
        var update = update_raw;
        update.conversation_key = normalizeBubbleSession(update_raw.conversation_key, &conversation_hash) orelse "";
        update.source_session = normalizeBubbleSession(update_raw.source_session, &source_hash) orelse "";
        update.parent_session = normalizeBubbleSession(update_raw.parent_session, &parent_hash) orelse "";
        self.mutex.lock();
        defer self.mutex.unlock();

        // Hermes can emit a child's first tool event before state.db contains
        // `_delegate_from`. Older adapters therefore opened a raw child card,
        // then correctly classified later events without ever retracting that
        // provisional card. An authoritative child update owns the cleanup.
        if (update.session_kind == .subagent) {
            var index: usize = 0;
            while (index < self.bubbles_len) : (index += 1) {
                if (!sourceSessionIdentityMatches(&self.bubbles[index], update)) continue;
                if (index + 1 < self.bubbles_len)
                    std.mem.copyForwards(Bubble, self.bubbles[index .. self.bubbles_len - 1], self.bubbles[index + 1 .. self.bubbles_len]);
                self.bubbles_len -= 1;
                self.bubbles[self.bubbles_len] = .{};
                self.bubble_counter += 1;
                self.bubbles_dirty = true;
                break;
            }
        }

        var matched_existing: ?*Bubble = null;
        for (self.bubbles[0..self.bubbles_len]) |*bubble| {
            if (identityMatches(bubble, update)) {
                matched_existing = bubble;
                break;
            }
        }

        // A child never owns a top-level card. If its parent has not appeared
        // yet, drop the event rather than manufacturing a blank ghost card.
        // The next meaningful parent update will establish the aggregate.
        if (update.session_kind == .subagent) {
            const parent = matched_existing orelse return self.bubble_counter;
            if (update.message_kind != .assistant or std.mem.trim(u8, update.text, " \t\r\n").len == 0)
                return self.bubble_counter;

            var duplicate: ?usize = null;
            for (parent.child_messages[0..parent.child_messages_len], 0..) |*message, i| {
                if (childMessageMatches(message, update)) {
                    duplicate = i;
                    break;
                }
            }
            if (duplicate) |index| {
                if (childMessageEquivalent(&parent.child_messages[index], update)) {
                    self.bubble_render_debug.suppressed_duplicates +%= 1;
                    return self.bubble_counter;
                }
                // Move an updated duplicate to the tail so "two most recent"
                // is chronological even when a provider replays an event.
                const existing = parent.child_messages[index];
                std.mem.copyForwards(ChildMessage, parent.child_messages[index .. parent.child_messages_len - 1], parent.child_messages[index + 1 .. parent.child_messages_len]);
                parent.child_messages[parent.child_messages_len - 1] = existing;
            } else {
                if (parent.child_messages_len == max_child_messages) {
                    std.mem.copyForwards(ChildMessage, parent.child_messages[0 .. max_child_messages - 1], parent.child_messages[1..max_child_messages]);
                    parent.child_messages_len -= 1;
                }
                parent.child_messages[parent.child_messages_len] = .{};
                parent.child_messages_len += 1;
            }
            var child = &parent.child_messages[parent.child_messages_len - 1];
            child.text_len = copyField(&child.text, update.text);
            child.label_len = copyField(&child.label, if (update.subagent_label.len > 0) update.subagent_label else "Subagent");
            child.source_session_len = copyField(&child.source_session, update.source_session);
            child.message_id_len = copyField(&child.message_id, update.message_id);
            self.bubble_counter += 1;
            child.counter = self.bubble_counter;
            parent.counter = self.bubble_counter;
            self.bubbles_dirty = true;
            return parent.counter;
        }

        const is_new = matched_existing == null;
        const slot = matched_existing orelse blk: {
            var selected: *Bubble = undefined;
            if (self.bubbles_len < max_bubbles) {
                selected = &self.bubbles[self.bubbles_len];
                self.bubbles_len += 1;
            } else {
                selected = &self.bubbles[0];
                for (self.bubbles[1..self.bubbles_len]) |*bubble| {
                    if (bubble.counter < selected.counter) selected = bubble;
                }
            }
            selected.* = .{};
            selected.session_len = copyField(&selected.session, update.conversation_key);
            selected.remote = update.remote;
            break :blk selected;
        };

        // Sessionless integrations intentionally share one compatibility
        // slot. Treat each write as unrelated so title/message provenance from
        // an older legacy agent cannot leak into the next one.
        const sessionless_replace = matched_existing != null and update.conversation_key.len == 0;
        const before = slot.*;
        if (sessionless_replace) {
            slot.* = .{};
            slot.remote = update.remote;
        }

        const metadata_wins = is_new or update.feed_source.rank() >= slot.feed_source.rank();
        if (update.agent.len > 0 and (metadata_wins or slot.agent_len == 0)) slot.agent_len = copyField(&slot.agent, update.agent);
        if (update.source_session.len > 0 and (metadata_wins or slot.source_session_len == 0)) slot.source_session_len = copyField(&slot.source_session, update.source_session);
        if (update.parent_session.len > 0 and (metadata_wins or slot.parent_session_len == 0)) slot.parent_session_len = copyField(&slot.parent_session, update.parent_session);
        slot.session_kind = .primary;
        if (metadata_wins) slot.feed_source = update.feed_source;
        if (update.origin_app != .none and (metadata_wins or slot.origin_app == .none)) slot.origin_app = update.origin_app;
        if (update.source_tty.len > 0 and (metadata_wins or slot.source_tty_len == 0)) slot.source_tty_len = copyField(&slot.source_tty, update.source_tty);
        if (update.source_cwd.len > 0 and (metadata_wins or slot.source_cwd_len == 0)) slot.source_cwd_len = copyField(&slot.source_cwd, update.source_cwd);
        if (update.herdr_pane.len > 0 and (metadata_wins or slot.herdr_pane_len == 0)) slot.herdr_pane_len = copyField(&slot.herdr_pane, update.herdr_pane);
        if (update.hostname.len > 0 and (metadata_wins or slot.hostname_len == 0)) slot.hostname_len = copyField(&slot.hostname, update.hostname);
        slot.remote = update.remote;

        const replace_title = update.title.len > 0 and switch (update.title_source) {
            .server => true,
            .prompt => slot.title_len == 0,
            .unknown => slot.title_len == 0 or slot.title_source != .server,
        };
        if (replace_title) {
            slot.title_len = copyField(&slot.title, update.title);
            slot.title_source = update.title_source;
        }

        if (shouldReplaceMessage(slot, update)) {
            slot.text_len = copyField(&slot.text, update.text);
            slot.message_kind = update.message_kind;
            slot.message_id_len = copyField(&slot.message_id, update.message_id);
        }
        const previous_status = slot.status;
        var proposed_status = normalizedProposedStatus(update);
        const activity_fingerprint = runningActivityFingerprint(update);
        const meaningful_running_activity = proposed_status == .running and activity_fingerprint != 0 and
            (is_new or sessionless_replace or activity_fingerprint != before.last_activity_fingerprint);
        // Once a card has been quieted, an unchanged provider heartbeat is
        // not evidence of new work. A changed assistant/tool/progress event
        // clears the suppression and immediately restores the running state.
        if (slot.stale_running_suppressed and proposed_status == .running and !meaningful_running_activity)
            proposed_status = .idle;
        const status = reconcileStatus(slot, update, proposed_status);
        if (update.turn.len > 0) slot.turn_len = copyField(&slot.turn, update.turn);
        slot.status = status;
        slot.busy = status == .running;
        slot.completed_at_ms = if (status == .completed)
            (if (previous_status == .completed and slot.completed_at_ms > 0) slot.completed_at_ms else nowMs())
        else
            0;

        // A newly running card has a lease even when an older integration
        // cannot provide a message id yet.  Subsequent unkeyed heartbeats do
        // not refresh it; that lets the 30s stale guard quiet every provider.
        const started_running = status == .running and
            (is_new or sessionless_replace or before.status != .running);
        if ((meaningful_running_activity or started_running) and status == .running) {
            slot.last_meaningful_activity_ms = nowMs();
            slot.last_activity_fingerprint = activity_fingerprint;
            slot.stale_running_suppressed = false;
        } else if (status == .needs_input or status == .completed or status == .failed) {
            // Terminal and attention states are explicit. They do not retain
            // a stale-running marker that could interfere with a later turn.
            slot.stale_running_suppressed = false;
        }

        const changed = is_new or sessionless_replace or meaningful_running_activity or
            !bubblePresentationEquivalent(before, slot.*);
        if (!changed) {
            self.bubble_render_debug.suppressed_duplicates +%= 1;
            return self.bubble_counter;
        }
        self.bubble_counter += 1;
        slot.counter = self.bubble_counter;
        self.bubbles_dirty = true;
        return slot.counter;
    }

    /// Record per-agent attention for a session that already has a slot.
    /// Separate from setBubbleWithMetadata so the nine-parameter contract
    /// every existing caller uses stays exactly as it is: a sender that
    /// knows the state calls this right after, and one that does not
    /// leaves the field empty for readers to fall back on `busy`.
    pub fn setBubbleAgentState(self: *Mailbox, session: []const u8, state: []const u8) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        for (self.bubbles[0..self.bubbles_len]) |*b| {
            if (!std.mem.eql(u8, b.sessionSlice(), session)) continue;
            const n = @min(state.len, b.agent_state.len);
            @memcpy(b.agent_state[0..n], state[0..n]);
            @memset(b.agent_state[n..], 0);
            b.agent_state_len = n;
            self.bubbles_dirty = true;
            return;
        }
    }

    /// Quiet running cards whose provider has stopped emitting meaningful
    /// work. The card remains retained and becomes neutral; only a distinct
    /// running event may wake it again.
    pub fn suppressStaleRunning(self: *Mailbox, now_ms: i64, grace_ms: i64) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        var suppressed: usize = 0;
        for (self.bubbles[0..self.bubbles_len]) |*bubble| {
            if (bubble.status != .running or bubble.last_meaningful_activity_ms <= 0) continue;
            if (now_ms - bubble.last_meaningful_activity_ms < grace_ms) continue;
            bubble.status = .idle;
            bubble.busy = false;
            bubble.stale_running_suppressed = true;
            self.bubble_counter += 1;
            bubble.counter = self.bubble_counter;
            self.bubbles_dirty = true;
            self.bubble_render_debug.stale_transitions +%= 1;
            suppressed += 1;
        }
        return suppressed;
    }

    /// Apply an authoritative title without manufacturing a message update.
    /// Used by agent servers that publish renames independently from tool and
    /// lifecycle events (OpenCode's session.updated, Codex's title index).
    pub fn setBubbleTitle(self: *Mailbox, session: []const u8, title: []const u8) ?u64 {
        return self.setBubbleTitleIdentity(session, title, "", "", false, false);
    }

    pub fn setBubbleTitleIdentity(self: *Mailbox, session: []const u8, title: []const u8, agent: []const u8, hostname: []const u8, remote: bool, exact: bool) ?u64 {
        if (session.len == 0 or title.len == 0) return null;
        self.mutex.lock();
        defer self.mutex.unlock();
        for (self.bubbles[0..self.bubbles_len]) |*bubble| {
            if (!std.mem.eql(u8, bubble.sessionSlice(), session)) continue;
            if (exact) {
                if (bubble.remote != remote) continue;
                if (!std.ascii.eqlIgnoreCase(bubble.agent[0..bubble.agent_len], agent)) continue;
                if (remote and !std.ascii.eqlIgnoreCase(bubble.hostnameSlice(), hostname)) continue;
            }
            const capped = title[0..@min(title.len, bubble.title.len)];
            if (std.mem.eql(u8, bubble.title[0..bubble.title_len], capped)) return bubble.counter;
            @memset(&bubble.title, 0);
            @memcpy(bubble.title[0..capped.len], capped);
            bubble.title_len = capped.len;
            bubble.title_source = .server;
            self.bubble_counter += 1;
            bubble.counter = self.bubble_counter;
            self.bubbles_dirty = true;
            return bubble.counter;
        }
        return null;
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
        self.dropBubbleIdentity(session, "", "", false, false);
    }

    pub fn dropBubbleIdentity(self: *Mailbox, conversation: []const u8, agent: []const u8, hostname: []const u8, remote: bool, exact: bool) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        for (self.bubbles[0..self.bubbles_len], 0..) |*b, i| {
            if (!std.mem.eql(u8, b.sessionSlice(), conversation)) continue;
            if (exact) {
                if (b.remote != remote) continue;
                if (!std.ascii.eqlIgnoreCase(b.agent[0..b.agent_len], agent)) continue;
                if (remote and !std.ascii.eqlIgnoreCase(b.hostnameSlice(), hostname)) continue;
            }
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

pub const AuthCallback = struct {
    code: [2048]u8 = @splat(0),
    code_len: usize = 0,
    state: [128]u8 = @splat(0),
    state_len: usize = 0,
    error_text: [256]u8 = @splat(0),
    error_len: usize = 0,

    pub fn codeSlice(self: *const AuthCallback) []const u8 {
        return self.code[0..self.code_len];
    }

    pub fn stateSlice(self: *const AuthCallback) []const u8 {
        return self.state[0..self.state_len];
    }

    pub fn errorSlice(self: *const AuthCallback) []const u8 {
        return self.error_text[0..self.error_len];
    }
};

pub const AuthMailbox = struct {
    mutex: SpinMutex = .{},
    callback: AuthCallback = .{},
    dirty: bool = false,

    pub fn set(self: *AuthMailbox, callback: AuthCallback) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.callback = callback;
        self.dirty = true;
    }

    pub fn take(self: *AuthMailbox) ?AuthCallback {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (!self.dirty) return null;
        self.dirty = false;
        return self.callback;
    }
};

pub var auth_mailbox: AuthMailbox = .{};

const RemoteCredential = struct {
    active: bool = false,
    principal: [32]u8 = @splat(0),
    principal_len: usize = 0,
    secret: [64]u8 = @splat(0),
};

var remote_credentials_lock: SpinMutex = .{};
var remote_credentials: [8]RemoteCredential = @splat(.{});

pub fn issueRemoteCredential(principal: []const u8, out: []u8) ?[]const u8 {
    if (principal.len == 0 or principal.len > 32) return null;
    for (principal) |byte| if (!(std.ascii.isAlphanumeric(byte) or byte == '-' or byte == '_')) return null;
    var raw: [32]u8 = undefined;
    fillRandom(&raw) catch return null;
    var secret: [64]u8 = undefined;
    secret = std.fmt.bytesToHex(raw, .lower);

    remote_credentials_lock.lock();
    defer remote_credentials_lock.unlock();
    var selected: *RemoteCredential = &remote_credentials[0];
    for (&remote_credentials) |*entry| {
        if (entry.active and std.mem.eql(u8, entry.principal[0..entry.principal_len], principal)) {
            selected = entry;
            break;
        }
        if (!entry.active) selected = entry;
    }
    selected.* = .{ .active = true, .secret = secret };
    selected.principal_len = principal.len;
    @memcpy(selected.principal[0..principal.len], principal);
    return std.fmt.bufPrint(out, "remote:{s}:{s}", .{ principal, &secret }) catch null;
}

pub fn revokeRemoteCredential(principal: []const u8) void {
    remote_credentials_lock.lock();
    defer remote_credentials_lock.unlock();
    for (&remote_credentials) |*entry| {
        if (entry.active and std.mem.eql(u8, entry.principal[0..entry.principal_len], principal)) entry.* = .{};
    }
}

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
const monotonicMs = plat.monotonicMs;

const ReadDeadlineEntry = struct {
    active: bool = false,
    timed_out: bool = false,
    stream: std.Io.net.Stream = undefined,
    io: std.Io = undefined,
    deadline: std.Io.Clock.Timestamp = undefined,
};

var read_deadline_lock: SpinMutex = .{};
var read_deadlines: [max_active_connections]ReadDeadlineEntry = @splat(.{});
var read_deadline_thread_started: std.atomic.Value(bool) = .init(false);

fn readDeadlineTimer() void {
    var scope = plat.Scope.init();
    defer scope.deinit();
    const io = scope.io();
    while (true) {
        std.Io.sleep(io, std.Io.Duration.fromMilliseconds(25), .awake) catch {};
        const now = std.Io.Clock.Timestamp.now(io, .boot);
        read_deadline_lock.lock();
        for (&read_deadlines) |*entry| {
            if (!entry.active or entry.timed_out or !entry.deadline.compare(.lte, now)) continue;
            entry.timed_out = true;
            // Closing an AFD-backed stream while Zig's Windows reader is
            // pending produces STATUS_CANCELLED, which Zig 0.16 treats as an
            // unreachable state. A full AFD partial-disconnect wakes that
            // read as a normal disconnected socket; final handle close still
            // belongs to the connection thread. Send the small 408 first so a
            // responsive peer gets the same contract as POSIX, then disconnect
            // even if a malicious peer is not reading the response.
            var response_buffer: [256]u8 = undefined;
            var response_writer = entry.stream.writer(entry.io, &response_buffer);
            var conn: Conn = .{ .stream = entry.stream, .io = entry.io, .writer = &response_writer.interface };
            respond(&conn, 408, "{\"ok\":false,\"error\":\"request_timeout\"}");
            entry.stream.shutdown(entry.io, .both) catch {};
        }
        read_deadline_lock.unlock();
    }
}

fn registerReadDeadline(stream: std.Io.net.Stream, io: std.Io, deadline: std.Io.Clock.Timestamp) ?usize {
    if (read_deadline_thread_started.cmpxchgStrong(false, true, .acq_rel, .acquire) == null) {
        const thread = std.Thread.spawn(.{}, readDeadlineTimer, .{}) catch {
            read_deadline_thread_started.store(false, .release);
            return null;
        };
        thread.detach();
    }
    read_deadline_lock.lock();
    defer read_deadline_lock.unlock();
    for (&read_deadlines, 0..) |*entry, index| {
        if (entry.active) continue;
        entry.* = .{ .active = true, .stream = stream, .io = io, .deadline = deadline };
        return index;
    }
    return null;
}

fn removeReadDeadline(index: usize) bool {
    read_deadline_lock.lock();
    defer read_deadline_lock.unlock();
    const timed_out = read_deadlines[index].timed_out;
    read_deadlines[index] = .{};
    return timed_out;
}

fn readBeforeDeadline(stream: std.Io.net.Stream, reader: *std.Io.Reader, io: std.Io, buffer: []u8, deadline: std.Io.Clock.Timestamp) ![]const u8 {
    if (builtin.os.tag != .windows) return (try stream.socket.receiveTimeout(io, buffer, .{ .deadline = deadline })).data;
    const slot = registerReadDeadline(stream, io, deadline) orelse return error.SystemResources;
    // readSliceShort fills the entire destination before returning. Passing
    // the 64 KiB request tail would therefore stall every ordinary HTTP
    // request until the deadline. peekByte triggers one AFD receive into the
    // reader's 1 KiB buffer; copy the bytes already delivered by that single
    // receive without initiating a second blocking operation.
    _ = reader.peekByte() catch |err| {
        if (removeReadDeadline(slot)) return error.Timeout;
        return err;
    };
    if (removeReadDeadline(slot)) return error.Timeout;
    const count = @min(buffer.len, reader.bufferedLen());
    @memcpy(buffer[0..count], reader.buffered()[0..count]);
    reader.toss(count);
    return buffer[0..count];
}

const AuthContext = struct {
    remote: bool = false,
    principal: []const u8 = "local",
};

const AuthClaimConflict = enum { remote, hostname };

fn authClaimConflict(auth: AuthContext, claimed_remote: ?bool, hostname: []const u8) ?AuthClaimConflict {
    if (claimed_remote) |value| if (value != auth.remote) return .remote;
    if (auth.remote and hostname.len > 0 and !std.mem.eql(u8, hostname, auth.principal)) return .hostname;
    return null;
}

/// State events are deliberately tiny, so equality must include both the
/// semantic state and its optional dwell.  Treat the old directional running
/// aliases as one activity class as well: they are sprite flavor, not a new
/// piece of work worthy of rearming the whole desktop renderer.
fn stateEventEquivalent(a: StateEvent, b: StateEvent) bool {
    if (a.duration_ms != b.duration_ms) return false;
    const a_state = a.slice();
    const b_state = b.slice();
    if (std.mem.eql(u8, a_state, b_state)) return true;
    const a_running = std.mem.eql(u8, a_state, "running") or
        std.mem.eql(u8, a_state, "running-left") or
        std.mem.eql(u8, a_state, "running-right");
    const b_running = std.mem.eql(u8, b_state, "running") or
        std.mem.eql(u8, b_state, "running-left") or
        std.mem.eql(u8, b_state, "running-right");
    return a_running and b_running;
}

fn isValidState(s: []const u8) bool {
    for (valid_states) |v| {
        if (std.mem.eql(u8, v, s)) return true;
    }
    return false;
}

const Server = struct {
    const PrincipalBucket = struct {
        used: bool = false,
        principal: [32]u8 = @splat(0),
        principal_len: usize = 0,
        bucket: f64 = 30,
        stamp_ms: i64 = 0,
    };
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
    principal_buckets: [8]PrincipalBucket = @splat(.{}),
    pid: i32,

    fn rateLimitOk(self: *Server, auth: AuthContext) bool {
        self.request_lock.lock();
        defer self.request_lock.unlock();
        const now = monotonicMs();
        if (auth.remote) {
            var selected: *PrincipalBucket = &self.principal_buckets[0];
            for (&self.principal_buckets) |*candidate| {
                if (candidate.used and std.mem.eql(u8, candidate.principal[0..candidate.principal_len], auth.principal)) {
                    selected = candidate;
                    break;
                }
                if (!candidate.used) selected = candidate;
            }
            if (!selected.used or !std.mem.eql(u8, selected.principal[0..selected.principal_len], auth.principal)) {
                selected.* = .{ .used = true };
                selected.principal_len = @min(selected.principal.len, auth.principal.len);
                @memcpy(selected.principal[0..selected.principal_len], auth.principal[0..selected.principal_len]);
            }
            if (selected.stamp_ms == 0) selected.stamp_ms = now;
            const elapsed: f64 = @floatFromInt(@max(@as(i64, 0), now - selected.stamp_ms));
            selected.bucket = @min(30.0, selected.bucket + elapsed * 30.0 / 1000.0);
            selected.stamp_ms = now;
            if (selected.bucket < 1) return false;
            selected.bucket -= 1;
            return true;
        }
        if (self.bucket_stamp_ms == 0) self.bucket_stamp_ms = now;
        const elapsed: f64 = @floatFromInt(@max(@as(i64, 0), now - self.bucket_stamp_ms));
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
        .pid = @intCast(plat.processId()),
    };
    var raw: [32]u8 = undefined;
    try fillRandom(&raw);
    _ = std.fmt.bufPrint(&server.token, "{x}", .{&raw}) catch unreachable;
    const thread = try std.Thread.spawn(.{}, run, .{server});
    thread.detach();
}

fn run(server: *Server) void {
    // This thread owns its Io for its whole life: the listener blocks
    // in accept() forever and must never touch the main thread's.
    var scope = plat.Scope.init();
    defer scope.deinit();
    const io = scope.io();

    const addr: std.Io.net.IpAddress = .{ .ip4 = .loopback(7777) };
    var listener = addr.listen(io, .{
        .kernel_backlog = 16,
        // This endpoint is a single-owner service. Zig maps true to
        // SO_REUSEPORT on POSIX, which would let a second desktop bind the
        // same port and replace the first instance's token file.
        .reuse_address = false,
        .mode = .stream,
        .protocol = .tcp,
    }) catch {
        std.debug.print("petdex: :7777 bind failed; is another petdex running?\n", .{});
        return;
    };
    defer listener.deinit(io);

    // Bind before replacing the token file. A second desktop instance may
    // fail to bind; it must not invalidate the token of the listener that is
    // already serving hooks.
    writeRuntimeFile(server, "update-token", &server.token, 0o600) catch |err| {
        std.debug.print("petdex: token write failed ({s})\n", .{@errorName(err)});
        return;
    };
    mirrorState(server, "idle", 0) catch {};

    // Installation is not connection. Each Petdex process requires a fresh
    // event from the plugin before Settings may show DSH as connected.
    deleteRuntimeFile(server, "dsh-handshake.json");
    std.debug.print("petdex: hook server on 127.0.0.1:7777 (in-process)\n", .{});

    while (true) {
        const stream = listener.accept(io) catch continue;
        const active = server.active_connections.fetchAdd(1, .acq_rel);
        if (active >= max_active_connections) {
            _ = server.active_connections.fetchSub(1, .release);
            stream.close(io);
            continue;
        }
        // Keep an abandoned client off the accept loop, but retain the Io that
        // accepted the stream. A replacement Threaded Io cannot safely operate
        // the existing Winsock handle.
        const thread = std.Thread.spawn(.{}, handleConnectionThread, .{ server, stream, io }) catch {
            _ = server.active_connections.fetchSub(1, .release);
            stream.close(io);
            continue;
        };
        thread.detach();
    }
}

fn handleConnectionThread(server: *Server, stream: std.Io.net.Stream, io: std.Io) void {
    defer _ = server.active_connections.fetchSub(1, .release);
    defer stream.close(io);

    var request_buffer: [max_request_bytes]u8 = undefined;
    var write_buffer: [1024]u8 = undefined;
    var stream_writer = stream.writer(io, &write_buffer);
    var conn: Conn = .{
        .stream = stream,
        .io = io,
        .writer = &stream_writer.interface,
    };
    const timeout = (std.Io.Timeout{ .duration = .{
        .raw = std.Io.Duration.fromMilliseconds(connection_timeout_ms),
        .clock = .awake,
    } }).toDeadline(io);
    var total: usize = 0;
    var request_len: ?usize = null;
    while (request_len == null or total < request_len.?) {
        if (total == request_buffer.len) return respond(&conn, 413, "{\"ok\":false,\"error\":\"request_too_large\"}");
        const incoming = receiveWithTimeout(&conn, request_buffer[total..], timeout) catch |err| {
            if (err == error.Timeout) respond(&conn, 408, "{\"ok\":false,\"error\":\"request_timeout\"}");
            return;
        };
        if (incoming == 0) return;
        total += incoming;
        if (request_len == null) {
            const end_at = std.mem.indexOf(u8, request_buffer[0..total], "\r\n\r\n") orelse continue;
            const head_len = end_at + 4;
            const head = request_buffer[0..head_len];
            const content_length = if (headerValue(head, "content-length")) |raw| std.fmt.parseInt(usize, raw, 10) catch
                return respond(&conn, 400, "{\"ok\":false,\"error\":\"invalid_content_length\"}") else 0;
            if (content_length > request_buffer.len - head_len) return respond(&conn, 413, "{\"ok\":false,\"error\":\"body_too_large\"}");
            request_len = head_len + content_length;
        }
    }
    handleConnection(server, &conn, request_buffer[0..request_len.?]);
    stream.shutdown(io, .send) catch {};
    if (builtin.os.tag == .windows) {
        var drain: [1024]u8 = undefined;
        const drain_timeout = (std.Io.Timeout{ .duration = .{
            .raw = std.Io.Duration.fromMilliseconds(response_drain_grace_ms),
            .clock = .awake,
        } }).toDeadline(io);
        while (true) {
            const received = receiveWithTimeout(&conn, &drain, drain_timeout) catch break;
            if (received == 0) break;
        }
    }
}

const RequestObject = struct {
    root: std.json.Value,
    valid: bool = true,

    fn string(self: *RequestObject, key: []const u8) ?[]const u8 {
        const value = self.root.object.get(key) orelse return null;
        // Older CLI hooks serialize an unknown optional agent source as
        // JSON null. Treat null like an omitted optional field so the typed
        // parser remains backward-compatible; concrete non-string values are
        // still rejected below.
        if (value == .null) return null;
        if (value != .string) {
            self.valid = false;
            return null;
        }
        return value.string;
    }

    fn boolean(self: *RequestObject, key: []const u8) ?bool {
        const value = self.root.object.get(key) orelse return null;
        if (value != .bool) {
            self.valid = false;
            return null;
        }
        return value.bool;
    }
};

fn parseRequest(allocator: std.mem.Allocator, body: []const u8) !std.json.Value {
    if (!std.unicode.utf8ValidateSlice(body)) return error.InvalidJson;
    const root = try std.json.parseFromSliceLeaky(std.json.Value, allocator, body, .{
        .duplicate_field_behavior = .@"error",
        .max_value_len = max_request_bytes,
    });
    if (root != .object) return error.InvalidJson;
    return root;
}

fn handleConnection(server: *Server, conn: *Conn, request: []const u8) void {
    const header_at = std.mem.indexOf(u8, request, "\r\n\r\n") orelse return;
    const head_len = header_at + 4;
    const head = request[0..head_len];
    const content_length = if (headerValue(head, "content-length")) |raw| std.fmt.parseInt(usize, raw, 10) catch {
        respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_content_length\"}");
        return;
    } else 0;
    if (content_length > request.len - head_len) {
        respond(conn, 413, "{\"ok\":false,\"error\":\"body_too_large\"}");
        return;
    }
    const request_len = head_len + content_length;
    const body = request[head_len..request_len];

    var line_it = std.mem.splitSequence(u8, head, "\r\n");
    const request_line = line_it.next() orelse return;
    var part_it = std.mem.splitScalar(u8, request_line, ' ');
    const method = part_it.next() orelse return;
    const target = part_it.next() orelse return;
    const path = if (std.mem.indexOfScalar(u8, target, '?')) |q| target[0..q] else target;

    route(server, conn, method, target, path, head, body);
}

fn receiveWithTimeout(conn: *Conn, buffer: []u8, timeout: std.Io.Timeout) !usize {
    if (builtin.os.tag == .windows) {
        try waitForWindowsReadable(conn, timeout);
        var reader = conn.stream.reader(conn.io, &.{});
        var data = [_][]u8{buffer};
        return reader.interface.readVec(&data) catch |err| switch (err) {
            error.EndOfStream => 0,
            error.ReadFailed => return reader.err orelse error.Unexpected,
        };
    }
    return (try conn.stream.socket.receiveTimeout(conn.io, buffer, timeout)).data.len;
}

fn waitForWindowsReadable(conn: *Conn, timeout: std.Io.Timeout) !void {
    if (comptime builtin.os.tag != .windows) return;

    var poll = AfdPollInfo{
        .timeout = windowsRelativeTimeout(timeout, conn.io),
        .handle_count = 1,
        .exclusive = 0,
        .handles = .{.{
            .handle = conn.stream.socket.handle,
            .events = afd_readable_events,
            .status = .SUCCESS,
        }},
    };
    const bytes = std.mem.asBytes(&poll);
    const result = (try conn.io.operate(.{
        .device_io_control = .{
            .file = .{
                // AFD.POLL is an endpoint ioctl. Windows requires the
                // endpoint socket handle as the NtDeviceIoControlFile
                // target; a separately opened \Device\Afd control handle
                // returns STATUS_INVALID_DEVICE_REQUEST.
                .handle = conn.stream.socket.handle,
                // AFD.POLL completes through the APC path when the request is
                // pending. The synchronous flag would hit Zig's unreachable
                // branch on STATUS_PENDING instead of honoring the deadline.
                .flags = .{ .nonblocking = true },
            },
            .code = std.os.windows.IOCTL.AFD.POLL,
            .in = bytes,
            .out = bytes,
        },
    })).device_io_control;

    switch (result.u.Status) {
        .SUCCESS => {},
        .TIMEOUT => return error.Timeout,
        .CANCELLED => return error.Canceled,
        else => |status| return std.os.windows.unexpectedStatus(status),
    }
    if (poll.handles[0].status != .SUCCESS) {
        return std.os.windows.unexpectedStatus(poll.handles[0].status);
    }
    if (poll.handles[0].events & afd_readable_events == 0) {
        return error.Unexpected;
    }
}

fn windowsRelativeTimeout(timeout: std.Io.Timeout, io: std.Io) std.os.windows.LARGE_INTEGER {
    const duration = timeout.toDurationFromNow(io) orelse return std.math.minInt(std.os.windows.LARGE_INTEGER);
    return windowsRelativeTimeoutFromNanoseconds(duration.raw.toNanoseconds());
}

fn windowsRelativeTimeoutFromNanoseconds(nanoseconds: i96) std.os.windows.LARGE_INTEGER {
    if (nanoseconds <= 0) return 0;
    const ticks: i128 = @divTrunc(@as(i128, nanoseconds) + 99, 100);
    const bounded = @min(ticks, @as(i128, std.math.maxInt(std.os.windows.LARGE_INTEGER)));
    return -@as(std.os.windows.LARGE_INTEGER, @intCast(bounded));
}

fn route(server: *Server, conn: *Conn, method: []const u8, target: []const u8, path: []const u8, head: []const u8, body: []const u8) void {
    const get = std.mem.eql(u8, method, "GET");
    const post = std.mem.eql(u8, method, "POST");
    var scratch: [512]u8 = undefined;
    var json_memory: [max_request_bytes * 2]u8 = undefined;
    var fixed = std.heap.FixedBufferAllocator.init(&json_memory);
    var parsed_root: ?std.json.Value = null;
    const typed_json_post = post and (std.mem.eql(u8, path, "/state") or
        std.mem.eql(u8, path, "/bubble") or std.mem.eql(u8, path, "/bubble/title"));
    if (typed_json_post and body.len > 0) {
        const root = parseRequest(fixed.allocator(), body) catch return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_json\"}");
        parsed_root = root;
    }

    if (get and std.mem.eql(u8, path, "/callback")) {
        const query = if (std.mem.indexOfScalar(u8, target, '?')) |q| target[q + 1 ..] else "";
        var callback: AuthCallback = .{};
        if (queryValue(query, "code", &callback.code)) |value| callback.code_len = value.len;
        if (queryValue(query, "state", &callback.state)) |value| callback.state_len = value.len;
        if (queryValue(query, "error_description", &callback.error_text)) |value| {
            callback.error_len = value.len;
        } else if (queryValue(query, "error", &callback.error_text)) |value| {
            callback.error_len = value.len;
        }
        auth_mailbox.set(callback);
        if (callback.code_len > 0 and callback.state_len > 0) {
            return respondHtml(conn, 200, "<!doctype html><meta charset=utf-8><title>Petdex</title><style>body{background:#0c0c0f;color:#f5f5f7;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0}main{text-align:center}h1{font-size:24px}</style><main><h1>Signed in to Petdex</h1><p>You can close this tab and return to the app.</p></main>");
        }
        return respondHtml(conn, 400, "<!doctype html><meta charset=utf-8><title>Petdex</title><style>body{background:#0c0c0f;color:#f5f5f7;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0}main{text-align:center}h1{font-size:24px}</style><main><h1>Petdex sign-in failed</h1><p>Return to the app and try again.</p></main>");
    }

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
        _ = authenticate(server, head) orelse return respond(conn, 401, "{\"ok\":false,\"error\":\"unauthorized\"}");
        return respond(conn, 409, "{\"ok\":false,\"error\":\"unsupported_install\",\"message\":\"Self-update lands in a later slice; download the current build from petdex.dev/download.\"}");
    }

    if (post and std.mem.eql(u8, path, "/state")) {
        const auth = authenticate(server, head) orelse return respond(conn, 401, "{\"ok\":false,\"error\":\"unauthorized\"}");
        if (!server.rateLimitOk(auth)) return respond(conn, 429, "{\"ok\":false,\"error\":\"rate_limited\"}");
        var request: RequestObject = .{ .root = parsed_root orelse return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_json\"}") };
        const state_raw = request.string("state") orelse
            return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_state\"}");
        if (!isValidState(state_raw) or state_raw.len > 15) {
            return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_state\"}");
        }
        // Keep the deployed hook contract: both the packaged TypeScript CLI
        // and the native/remote runners send `duration`, and the legacy
        // parser accepts JSON numbers before capping them to 30 seconds.
        var duration: u32 = 0;
        switch (parseDuration(body)) {
            .missing => {},
            .invalid => return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_duration\"}"),
            .value => |value| duration = value,
        }

        // A bare `running` is a stable semantic state.  Alternating it into
        // left/right variants on every hook heartbeat made equivalent work
        // look like a fresh state transition and continuously restarted the
        // pet's frame timer.  Directional values are still accepted for
        // direct gesture callers; provider hooks stay on the neutral row.
        const applied = state_raw;

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

    if (post and std.mem.eql(u8, path, "/bubble/title")) {
        const auth = authenticate(server, head) orelse return respond(conn, 401, "{\"ok\":false,\"error\":\"unauthorized\"}");
        if (!server.rateLimitOk(auth)) return respond(conn, 429, "{\"ok\":false,\"error\":\"rate_limited\"}");
        var request: RequestObject = .{ .root = parsed_root orelse return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_json\"}") };
        const session = request.string("conversation_key") orelse request.string("session_id") orelse
            return respond(conn, 400, "{\"ok\":false,\"error\":\"missing_session_id\"}");
        const title_raw = request.string("title") orelse
            return respond(conn, 400, "{\"ok\":false,\"error\":\"missing_title\"}");
        const title = boundedUtf8(title_raw, bubble_title_capacity) orelse
            return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_title\"}");
        const agent = request.string("agent_source") orelse "";
        const hostname = request.string("hostname") orelse "";
        const claimed_remote = request.boolean("remote");
        if (!request.valid) return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_field_type\"}");
        const remote = auth.remote;
        if (authClaimConflict(auth, claimed_remote, hostname)) |conflict| switch (conflict) {
            .remote => return respond(conn, 400, "{\"ok\":false,\"error\":\"contradictory_remote_identity\"}"),
            .hostname => return respond(conn, 400, "{\"ok\":false,\"error\":\"contradictory_remote_hostname\"}"),
        };
        const exact = agent.len > 0 and (!remote or auth.principal.len > 0);
        const safe_agent = boundedUtf8(agent, 24) orelse return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_agent\"}");
        const safe_hostname = if (auth.remote) auth.principal else (boundedUtf8(hostname, 64) orelse return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_hostname\"}"));
        var session_hash: [64]u8 = undefined;
        const canonical_session = normalizeBubbleSession(session, &session_hash) orelse
            return respond(conn, 400, "{\"ok\":false,\"error\":\"missing_session_id\"}");
        const counter = mailbox.setBubbleTitleIdentity(
            canonical_session,
            title,
            safe_agent,
            safe_hostname,
            remote,
            exact,
        );
        const out = if (counter) |value|
            std.fmt.bufPrint(&scratch, "{{\"ok\":true,\"updated\":true,\"counter\":{d}}}", .{value}) catch return
        else
            "{\"ok\":true,\"updated\":false}";
        return respond(conn, 200, out);
    }

    if (post and std.mem.eql(u8, path, "/bubble")) {
        const auth = authenticate(server, head) orelse return respond(conn, 401, "{\"ok\":false,\"error\":\"unauthorized\"}");
        if (!server.rateLimitOk(auth)) return respond(conn, 429, "{\"ok\":false,\"error\":\"rate_limited\"}");
        var request: RequestObject = .{ .root = parsed_root orelse return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_json\"}") };
        const text_raw = request.string("text") orelse
            return respond(conn, 400, "{\"ok\":false,\"error\":\"missing_text\"}");
        const capped = boundedUtf8(text_raw, bubble_text_capacity) orelse
            return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_text\"}");
        const agent = request.string("agent_source") orelse "";
        const title = request.string("title") orelse "";
        const origin_app = plat.OriginApplication.fromTermProgram(request.string("source_app"));
        const source_tty = plat.safeSourceTty(request.string("source_tty")) orelse "";
        const source_cwd = plat.safeSourceCwd(request.string("source_cwd")) orelse "";
        const herdr_pane = plat.safeHerdrPaneId(request.string("herdr_pane_id")) orelse "";
        const hostname = request.string("hostname") orelse "";
        const turn = request.string("turn_id") orelse "";
        const message_id = request.string("message_id") orelse "";
        const event_kind = request.string("event_kind") orelse "";
        const request_id = request.string("request_id") orelse "";
        const resolves_request_id = request.string("resolves_request_id") orelse "";
        const notification_kind = request.string("notification_kind") orelse "";
        const parent_session = request.string("parent_session_id") orelse "";
        const subagent_label = request.string("subagent_label") orelse "";
        const agent_state = request.string("agent_state") orelse "";
        const remote = auth.remote;
        const claimed_remote = request.boolean("remote");
        const busy = request.boolean("busy") orelse false;
        // No session_id means an agent that predates per-conversation
        // bubbles (or the MCP path, which has no session): the empty key
        // is one shared slot, so those callers keep the old behaviour.
        // Canonical conversation metadata wins over raw continuation/session
        // ids. Normalize arbitrary provider keys rather than truncating them
        // into possible collisions in the mailbox's bounded identity field.
        var conversation_hash: [64]u8 = undefined;
        const conversation = requestSessionKey(&request, &conversation_hash);
        const integration_version = request.string("integration_version") orelse "";
        if (std.mem.eql(u8, agent, "dsh") and std.mem.eql(u8, integration_version, dsh_integration.integration_version)) {
            writeRuntimeFile(
                server,
                "dsh-handshake.json",
                "{\"integrationVersion\":\"" ++ dsh_integration.integration_version ++ "\"}",
                0o600,
            ) catch {};
        }
        const session = request.string("session_id") orelse "";
        const source_session = request.string("source_session_id") orelse session;
        const status: ?SessionStatus = if (request.string("status")) |raw|
            (SessionStatus.fromWire(raw) orelse return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_status\"}"))
        else
            null;
        const session_kind = request.string("session_kind") orelse "primary";
        const message_kind = request.string("message_kind") orelse event_kind;
        const title_source = request.string("title_source") orelse "unknown";
        _ = request.string("feed_source");
        if (!request.valid) return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_field_type\"}");
        if (authClaimConflict(auth, claimed_remote, hostname)) |conflict| switch (conflict) {
            .remote => return respond(conn, 400, "{\"ok\":false,\"error\":\"contradictory_remote_identity\"}"),
            .hostname => return respond(conn, 400, "{\"ok\":false,\"error\":\"contradictory_remote_hostname\"}"),
        };
        const safe_agent = boundedUtf8(agent, 24) orelse return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_agent\"}");
        const safe_hostname = if (auth.remote) auth.principal else (boundedUtf8(hostname, 64) orelse return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_hostname\"}"));
        const safe_turn = boundedUtf8(turn, 64) orelse return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_turn_id\"}");
        const safe_title = boundedUtf8(title, bubble_title_capacity) orelse return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_title\"}");
        const safe_subagent_label = boundedUtf8(subagent_label, 48) orelse return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_subagent_label\"}");
        const safe_message_id = boundedUtf8(message_id, bubble_message_id_capacity) orelse return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_message_id\"}");
        const safe_event_kind = boundedUtf8(event_kind, 48) orelse return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_event_kind\"}");
        const safe_request_id = boundedUtf8(request_id, bubble_message_id_capacity) orelse return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_request_id\"}");
        const safe_resolves_request_id = boundedUtf8(resolves_request_id, bubble_message_id_capacity) orelse return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_resolves_request_id\"}");
        const safe_notification_kind = boundedUtf8(notification_kind, 64) orelse return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_notification_kind\"}");
        const safe_agent_state = boundedUtf8(agent_state, 16) orelse return respond(conn, 400, "{\"ok\":false,\"error\":\"invalid_agent_state\"}");
        const counter = mailbox.applyBubbleUpdate(.{
            .conversation_key = conversation[0..@min(conversation.len, bubble_session_capacity)],
            // Mailbox owns canonical identity normalization. Passing the raw
            // decoded values prevents distinct long provider ids that share a
            // bounded prefix from colliding before they can be hashed.
            .source_session = source_session,
            .parent_session = parent_session,
            .text = capped,
            .agent = safe_agent,
            .title = safe_title,
            .origin_app = origin_app,
            .source_tty = source_tty,
            .source_cwd = source_cwd,
            .herdr_pane = herdr_pane,
            .hostname = safe_hostname,
            .turn = safe_turn,
            .message_id = safe_message_id,
            .event_kind = safe_event_kind,
            .request_id = safe_request_id,
            .resolves_request_id = safe_resolves_request_id,
            .notification_kind = safe_notification_kind,
            .subagent_label = safe_subagent_label,
            .remote = remote,
            .busy = busy,
            .status = status,
            .session_kind = SessionKind.fromWire(session_kind),
            .message_kind = MessageKind.fromWire(message_kind),
            .title_source = TitleSource.fromWire(title_source),
            .feed_source = .hook,
        });
        if (safe_agent_state.len > 0) mailbox.setBubbleAgentState(conversation, safe_agent_state);
        const mirror_busy = if (status) |value| value == .running else busy;
        mirrorBubble(server, capped, counter, safe_title, safe_agent, safe_hostname, mirror_busy) catch {};
        const out = std.fmt.bufPrint(&scratch, "{{\"ok\":true,\"counter\":{d}}}", .{counter}) catch return;
        return respond(conn, 200, out);
    }

    respond(conn, 404, "{\"ok\":false,\"error\":\"not_found\"}");
}

// ------------------------------------------------------------------ auth

fn authenticate(server: *Server, head: []const u8) ?AuthContext {
    const provided = headerValue(head, "x-petdex-update-token") orelse return null;
    if (constantTimeEqual(provided, &server.token)) return .{};

    const prefix = "remote:";
    if (!std.mem.startsWith(u8, provided, prefix)) return null;
    const rest = provided[prefix.len..];
    const separator = std.mem.indexOfScalar(u8, rest, ':') orelse return null;
    const principal = rest[0..separator];
    const signature = rest[separator + 1 ..];
    if (principal.len == 0 or principal.len > 32 or signature.len != 64) return null;
    for (principal) |byte| if (!(std.ascii.isAlphanumeric(byte) or byte == '-' or byte == '_')) return null;

    remote_credentials_lock.lock();
    defer remote_credentials_lock.unlock();
    var valid = false;
    for (&remote_credentials) |*entry| {
        if (!entry.active or !std.mem.eql(u8, entry.principal[0..entry.principal_len], principal)) continue;
        valid = constantTimeEqual(signature, &entry.secret);
        break;
    }
    if (!valid) return null;
    return .{ .remote = true, .principal = principal };
}

fn constantTimeEqual(provided: []const u8, expected: []const u8) bool {
    if (provided.len != expected.len) return false;
    var diff: u8 = 0;
    for (provided, expected) |a, b| diff |= a ^ b;
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
    respondTyped(conn, status, "application/json", body);
}

fn respondHtml(conn: *Conn, status: u16, body: []const u8) void {
    respondTyped(conn, status, "text/html; charset=utf-8", body);
}

fn respondTyped(conn: *Conn, status: u16, content_type: []const u8, body: []const u8) void {
    var buf: [max_request_bytes]u8 = undefined;
    const reason = switch (status) {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        408 => "Request Timeout",
        404 => "Not Found",
        409 => "Conflict",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        else => "OK",
    };
    const head = std.fmt.bufPrint(&buf, "HTTP/1.1 {d} {s}\r\ncontent-type: {s}\r\ncontent-length: {d}\r\nconnection: close\r\n\r\n", .{ status, reason, content_type, body.len }) catch return;
    writeAll(conn, head);
    writeAll(conn, body);
}

fn writeAll(conn: *Conn, bytes: []const u8) void {
    conn.writer.writeAll(bytes) catch return;
    conn.writer.flush() catch return;
}

fn hexValue(c: u8) ?u8 {
    if (c >= '0' and c <= '9') return c - '0';
    if (c >= 'a' and c <= 'f') return c - 'a' + 10;
    if (c >= 'A' and c <= 'F') return c - 'A' + 10;
    return null;
}

fn queryValue(query: []const u8, wanted: []const u8, out: []u8) ?[]const u8 {
    var pairs = std.mem.splitScalar(u8, query, '&');
    while (pairs.next()) |pair| {
        const equal = std.mem.indexOfScalar(u8, pair, '=') orelse continue;
        if (!std.mem.eql(u8, pair[0..equal], wanted)) continue;
        var source = pair[equal + 1 ..];
        var written: usize = 0;
        while (source.len > 0) {
            if (written >= out.len) return null;
            if (source[0] == '%' and source.len >= 3) {
                const hi = hexValue(source[1]) orelse return null;
                const lo = hexValue(source[2]) orelse return null;
                out[written] = (hi << 4) | lo;
                source = source[3..];
            } else {
                out[written] = if (source[0] == '+') ' ' else source[0];
                source = source[1..];
            }
            written += 1;
        }
        return out[0..written];
    }
    return null;
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

fn jsonBool(body: []const u8, key: []const u8) ?bool {
    const value_start = switch (jsonFieldStart(body, key)) {
        .value => |value| value,
        else => return null,
    };
    if (std.mem.startsWith(u8, body[value_start..], "true")) {
        const end = value_start + 4;
        if (end == body.len or body[end] == ',' or body[end] == '}' or body[end] == ']' or std.ascii.isWhitespace(body[end])) return true;
    }
    if (std.mem.startsWith(u8, body[value_start..], "false")) {
        const end = value_start + 5;
        if (end == body.len or body[end] == ',' or body[end] == '}' or body[end] == ']' or std.ascii.isWhitespace(body[end])) return false;
    }
    return null;
}

/// Bound a decoded JSON string without splitting a UTF-8 code point.
fn boundedUtf8(value: []const u8, max: usize) ?[]const u8 {
    if (!std.unicode.utf8ValidateSlice(value)) return null;
    var cut = @min(value.len, max);
    while (cut > 0 and !std.unicode.utf8ValidateSlice(value[0..cut])) cut -= 1;
    return value[0..cut];
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

    var title_hash: [64]u8 = undefined;
    try std.testing.expectEqualStrings(normalized, normalizeBubbleSession(long, &title_hash).?);
}

fn requestSessionKey(request: *RequestObject, hash_buf: *[64]u8) []const u8 {
    if (normalizeBubbleSession(request.string("conversation_key"), hash_buf)) |key| return key;
    if (normalizeBubbleSession(request.string("petdex_conversation_key"), hash_buf)) |key| return key;
    if (normalizeBubbleSession(request.string("session_key"), hash_buf)) |key| return key;
    return normalizeBubbleSession(request.string("session_id"), hash_buf) orelse "";
}

test "bounded decoded strings preserve utf8 boundaries" {
    try std.testing.expectEqualStrings("abc\\", boundedUtf8("abc\\", 4).?);
    try std.testing.expectEqualStrings("ab", boundedUtf8("ab🙂", 5).?);
    try std.testing.expectEqualStrings("ab🙂", boundedUtf8("ab🙂", 6).?);
    try std.testing.expect(boundedUtf8(&.{0xff}, 8) == null);
}

test "authenticated provenance rejects contradictory body claims" {
    const local: AuthContext = .{};
    const remote: AuthContext = .{ .remote = true, .principal = "buildbox" };
    try std.testing.expectEqual(AuthClaimConflict.remote, authClaimConflict(local, true, "").?);
    try std.testing.expectEqual(AuthClaimConflict.remote, authClaimConflict(remote, false, "buildbox").?);
    try std.testing.expectEqual(AuthClaimConflict.hostname, authClaimConflict(remote, true, "other-host").?);
    try std.testing.expect(authClaimConflict(remote, null, "") == null);
    try std.testing.expect(authClaimConflict(remote, true, "buildbox") == null);
    try std.testing.expect(authClaimConflict(local, false, "client-supplied-local-label") == null);
}

fn serveOneTestConnection(listener: *std.Io.net.Server, server: *Server, io: std.Io) void {
    const stream = listener.accept(io) catch return;
    _ = server.active_connections.fetchAdd(1, .acq_rel);
    handleConnectionThread(server, stream, io);
}

fn testSocketDeadline(io: std.Io, milliseconds: i64) std.Io.Clock.Timestamp {
    const duration: std.Io.Clock.Duration = .{
        .raw = std.Io.Duration.fromMilliseconds(milliseconds),
        .clock = .boot,
    };
    return std.Io.Clock.Timestamp.fromNow(io, duration);
}

fn readTestHttpResponse(stream: std.Io.net.Stream, reader: *std.Io.Reader, io: std.Io, buffer: []u8, deadline: std.Io.Clock.Timestamp) ![]const u8 {
    var total: usize = 0;
    var expected: ?usize = null;
    while (total < buffer.len) {
        const incoming = try readBeforeDeadline(stream, reader, io, buffer[total..], deadline);
        if (incoming.len == 0) break;
        total += incoming.len;
        if (expected == null) {
            if (std.mem.indexOf(u8, buffer[0..total], "\r\n\r\n")) |at| {
                const head_len = at + 4;
                const body_len = if (headerValue(buffer[0..head_len], "content-length")) |raw|
                    try std.fmt.parseInt(usize, raw, 10)
                else
                    0;
                expected = head_len + body_len;
            }
        }
        if (expected) |length| if (total >= length) return buffer[0..length];
    }
    return error.IncompleteHttpResponse;
}

test "loopback slowloris times out and the next authenticated request succeeds" {
    // Zig 0.16's Windows test runner cannot connect to and tear down its AFD
    // listener reliably. The Windows desktop smoke exercises the production
    // executable's timeout, liveness, slot release, and recovery instead.
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    const runtime_dir = ".zig-cache/petdex-hook-slowloris";
    plat.makeDir(runtime_dir);
    var server: Server = .{
        .allocator = std.testing.allocator,
        .runtime_dir = runtime_dir,
        .token = @splat('a'),
        .pid = 1,
    };
    var server_scope = plat.Scope.init();
    defer server_scope.deinit();
    const server_io = server_scope.io();
    var client_scope = plat.Scope.init();
    defer client_scope.deinit();
    const client_io = client_scope.io();

    var listener_opt: ?std.Io.net.Server = null;
    var address: std.Io.net.IpAddress = undefined;
    for (38171..38271) |port| {
        address = .{ .ip4 = .loopback(@intCast(port)) };
        listener_opt = address.listen(server_io, .{
            .kernel_backlog = 4,
            .reuse_address = true,
            .mode = .stream,
            .protocol = .tcp,
        }) catch null;
        if (listener_opt != null) break;
    }
    var listener = listener_opt orelse return error.SkipZigTest;
    defer listener.deinit(server_io);
    const slow_server_thread = try std.Thread.spawn(.{}, serveOneTestConnection, .{ &listener, &server, server_io });

    var slow = try address.connect(client_io, .{ .mode = .stream, .protocol = .tcp });
    var slow_write_buf: [256]u8 = undefined;
    var slow_read_buf: [256]u8 = undefined;
    var slow_reader = slow.reader(client_io, &slow_read_buf);
    var slow_writer = slow.writer(client_io, &slow_write_buf);
    try slow_writer.interface.writeAll("POST /state HTTP/1.1\r\nContent-Length: 32\r\n\r\n{\"state\":\"");
    try slow_writer.interface.flush();
    const started = plat.monotonicMs();
    var response_buf: [512]u8 = undefined;
    const timeout_response = readTestHttpResponse(slow, &slow_reader.interface, client_io, &response_buf, testSocketDeadline(client_io, 6_000)) catch |err| switch (err) {
        else => if (builtin.os.tag == .windows) "" else return err,
    };
    const elapsed = plat.monotonicMs() - started;
    slow.close(client_io);
    slow_server_thread.join();
    if (builtin.os.tag == .windows)
        try std.testing.expectEqual(@as(usize, 0), timeout_response.len)
    else
        try std.testing.expect(std.mem.indexOf(u8, timeout_response, " 408 ") != null);
    try std.testing.expect(elapsed >= 1_000 and elapsed < 6_000);

    const healthy_server_thread = try std.Thread.spawn(.{}, serveOneTestConnection, .{ &listener, &server, server_io });
    var healthy = try address.connect(client_io, .{ .mode = .stream, .protocol = .tcp });
    var healthy_write_buf: [512]u8 = undefined;
    var healthy_read_buf: [256]u8 = undefined;
    var healthy_reader = healthy.reader(client_io, &healthy_read_buf);
    var healthy_writer = healthy.writer(client_io, &healthy_write_buf);
    const body = "{\"state\":\"idle\"}";
    var request_buf: [512]u8 = undefined;
    const authenticated = try std.fmt.bufPrint(&request_buf, "POST /state HTTP/1.1\r\nContent-Length: {d}\r\nx-petdex-update-token: {s}\r\n\r\n{s}", .{ body.len, &server.token, body });
    try healthy_writer.interface.writeAll(authenticated);
    try healthy_writer.interface.flush();
    const healthy_response = try readTestHttpResponse(healthy, &healthy_reader.interface, client_io, &response_buf, testSocketDeadline(client_io, 3_000));
    healthy.close(client_io);
    healthy_server_thread.join();
    try std.testing.expect(std.mem.indexOf(u8, healthy_response, " 200 ") != null);
    try std.testing.expect(std.mem.indexOf(u8, healthy_response, "\"ok\":true") != null);
    try std.testing.expectEqual(@as(u32, 0), server.active_connections.load(.acquire));
}

test "typed request parsing decodes strings and rejects ambiguity" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const root = try parseRequest(arena.allocator(), "{\"text\":\"quote: \\\" slash: \\\\ line: \\n\",\"busy\":true}");
    var request: RequestObject = .{ .root = root };
    try std.testing.expectEqualStrings("quote: \" slash: \\ line: \n", request.string("text").?);
    try std.testing.expectEqual(true, request.boolean("busy").?);
    _ = request.string("busy");
    try std.testing.expect(!request.valid);

    _ = arena.reset(.retain_capacity);
    const legacy_root = try parseRequest(arena.allocator(), "{\"text\":\"Thinking\",\"agent_source\":null}");
    var legacy_request: RequestObject = .{ .root = legacy_root };
    try std.testing.expectEqualStrings("Thinking", legacy_request.string("text").?);
    try std.testing.expect(legacy_request.string("agent_source") == null);
    try std.testing.expect(legacy_request.valid);

    _ = arena.reset(.retain_capacity);
    try std.testing.expectError(error.DuplicateField, parseRequest(arena.allocator(), "{\"text\":\"one\",\"text\":\"two\"}"));
    try std.testing.expectError(error.InvalidJson, parseRequest(arena.allocator(), "[]"));
}

test "bubble mirror JSON round trips decoded control and escape characters" {
    const json = try bubbleMirrorJson(std.testing.allocator, "quote \" slash \\ line\n🙂", 7, "title\tvalue", "codex", "host", true, 42);
    defer std.testing.allocator.free(json);
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, json, .{});
    defer parsed.deinit();
    try std.testing.expectEqualStrings("quote \" slash \\ line\n🙂", parsed.value.object.get("text").?.string);
    try std.testing.expectEqualStrings("title\tvalue", parsed.value.object.get("title").?.string);
    try std.testing.expect(parsed.value.object.get("busy").?.bool);
}

test "remote credentials are scoped and identify their principal" {
    var server: Server = undefined;
    server.token = @splat('a');
    var token: [128]u8 = undefined;
    const principal = "buildbox";
    const scoped = issueRemoteCredential(principal, &token).?;
    var first_token: [128]u8 = undefined;
    @memcpy(first_token[0..scoped.len], scoped);
    const first = first_token[0..scoped.len];
    var head_buf: [256]u8 = undefined;
    const head = try std.fmt.bufPrint(&head_buf, "POST /bubble HTTP/1.1\r\nx-petdex-update-token: {s}\r\n\r\n", .{scoped});
    const auth = authenticate(&server, head).?;
    try std.testing.expect(auth.remote);
    try std.testing.expectEqualStrings(principal, auth.principal);

    const rotated = issueRemoteCredential(principal, &token).?;
    try std.testing.expect(!std.mem.eql(u8, first, rotated));
    try std.testing.expect(authenticate(&server, head) == null);
    var rotated_head_buf: [256]u8 = undefined;
    const rotated_head = try std.fmt.bufPrint(&rotated_head_buf, "POST /bubble HTTP/1.1\r\nx-petdex-update-token: {s}\r\n\r\n", .{rotated});
    try std.testing.expectEqualStrings(principal, authenticate(&server, rotated_head).?.principal);

    var peer_token_buf: [128]u8 = undefined;
    const peer = issueRemoteCredential("peer", &peer_token_buf).?;
    var peer_head_buf: [256]u8 = undefined;
    const peer_head = try std.fmt.bufPrint(&peer_head_buf, "POST /bubble HTTP/1.1\r\nx-petdex-update-token: {s}\r\n\r\n", .{peer});
    try std.testing.expectEqualStrings("peer", authenticate(&server, peer_head).?.principal);

    revokeRemoteCredential(principal);
    try std.testing.expect(authenticate(&server, rotated_head) == null);
    try std.testing.expectEqualStrings("peer", authenticate(&server, peer_head).?.principal);
    revokeRemoteCredential("peer");
    try std.testing.expect(authenticate(&server, peer_head) == null);
}

test "OAuth callback query values are decoded and bounded" {
    var out: [32]u8 = undefined;
    try std.testing.expectEqualStrings("hello world", queryValue("code=hello%20world&state=abc", "code", &out).?);
    try std.testing.expectEqualStrings("abc", queryValue("code=hello&state=abc", "state", &out).?);
    try std.testing.expect(queryValue("code=toolong", "code", out[0..3]) == null);
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

test "mailbox canonicalizes long provider identities before matching" {
    var mb: Mailbox = .{};
    const prefix = "provider/session/identity/with/a/shared-prefix-that-is-longer-than-the-storage-boundary/";
    const first = prefix ++ "alpha";
    const second = prefix ++ "beta";
    _ = mb.applyBubbleUpdate(.{ .conversation_key = first, .source_session = first, .text = "one", .agent = "codex", .feed_source = .native_store });
    _ = mb.applyBubbleUpdate(.{ .conversation_key = second, .source_session = second, .text = "two", .agent = "codex", .feed_source = .native_store });
    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, 2), mb.takeBubbles(&out));
    try std.testing.expectEqual(@as(usize, 64), out[0].session_len);
    try std.testing.expectEqual(@as(usize, 64), out[1].session_len);
    try std.testing.expect(!std.mem.eql(u8, out[0].sessionSlice(), out[1].sessionSlice()));
}

test "bubble metadata preserves the Herdr pane id" {
    var mb: Mailbox = .{};
    _ = mb.setBubbleWithMetadata("herdr:w1:p5", "Needs approval", "cursor", "Fix auth", .terminal, "", "/repo", "w1:p5", false);

    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, 1), mb.takeBubbles(&out));
    try std.testing.expectEqualStrings("w1:p5", out[0].herdrPaneSlice());
}

test "keyed bubble retains omitted title and accepts a later server rename" {
    var mb: Mailbox = .{};
    _ = mb.setBubble("thread-7", "Thinking…", "codex", "Prompt fallback", true);
    // Tool hooks normally omit title. This update must not clear the card.
    _ = mb.setBubble("thread-7", "Reading main.zig", "codex", "", true);

    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, 1), mb.takeBubbles(&out));
    try std.testing.expectEqualStrings("Prompt fallback", out[0].title[0..out[0].title_len]);

    // The authoritative title may arrive after the first prompt or change on
    // the server while the session is alive. Non-empty always wins.
    _ = mb.setBubble("thread-7", "Running tests", "codex", "Server generated title", true);
    try std.testing.expectEqual(@as(?usize, 1), mb.takeBubbles(&out));
    try std.testing.expectEqualStrings("Server generated title", out[0].title[0..out[0].title_len]);

    // Sessionless callers share one compatibility slot; retaining here would
    // leak a title between unrelated legacy agents.
    _ = mb.setBubble("", "first", "codex", "Legacy title", true);
    _ = mb.setBubble("", "second", "gemini", "", true);
    try std.testing.expectEqual(@as(?usize, 2), mb.takeBubbles(&out));
    for (out[0..2]) |bubble| {
        if (bubble.session_len == 0) try std.testing.expectEqual(@as(usize, 0), bubble.title_len);
    }
}

test "title-only sync updates an existing session without changing its message" {
    var mb: Mailbox = .{};
    _ = mb.setBubble("thread-9", "Running tests", "opencode", "Old title", true);
    try std.testing.expect(mb.setBubbleTitle("thread-9", "Renamed on server") != null);
    // Duplicate server events are a no-op for rendering and retain the same
    // counter, while unknown/sessionless titles never create ghost cards.
    const duplicate_counter = mb.setBubbleTitle("thread-9", "Renamed on server").?;
    try std.testing.expect(mb.setBubbleTitle("missing", "No ghost") == null);
    try std.testing.expect(mb.setBubbleTitle("", "No legacy leak") == null);

    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, 1), mb.takeBubbles(&out));
    try std.testing.expectEqualStrings("Running tests", out[0].text[0..out[0].text_len]);
    try std.testing.expectEqualStrings("Renamed on server", out[0].title[0..out[0].title_len]);
    try std.testing.expectEqual(duplicate_counter, out[0].counter);
    try std.testing.expect(out[0].busy);
}

test "title-only sync can target one agent and host sharing a conversation id" {
    var mb: Mailbox = .{};
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "shared",
        .source_session = "shared",
        .text = "Local work",
        .agent = "opencode",
        .title = "Local title",
        .hostname = "mac",
        .remote = false,
        .busy = true,
    });
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "shared",
        .source_session = "shared",
        .text = "Remote work",
        .agent = "opencode",
        .title = "Remote title",
        .hostname = "inframework",
        .remote = true,
        .busy = true,
    });
    try std.testing.expect(mb.setBubbleTitleIdentity("shared", "Remote rename", "opencode", "inframework", true, true) != null);

    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, 2), mb.takeBubbles(&out));
    for (out[0..2]) |*bubble| {
        if (bubble.remote) {
            try std.testing.expectEqualStrings("Remote rename", bubble.title[0..bubble.title_len]);
        } else {
            try std.testing.expectEqualStrings("Local title", bubble.title[0..bubble.title_len]);
        }
    }
}

test "bubble context preserves host turn remote and launch metadata" {
    var mb: Mailbox = .{};
    _ = mb.setBubbleWithContext(
        "thread-7",
        "Running tests",
        "codex",
        "Revamp bubbles",
        .codex,
        "/dev/ttys003",
        "/work/petdex",
        "inframework",
        "turn-9",
        true,
        true,
    );

    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, 1), mb.takeBubbles(&out));
    try std.testing.expectEqualStrings("inframework", out[0].hostnameSlice());
    try std.testing.expectEqualStrings("turn-9", out[0].turnSlice());
    try std.testing.expect(out[0].remote);
    try std.testing.expectEqual(plat.OriginApplication.codex, out[0].origin_app);
    try std.testing.expectEqualStrings("/work/petdex", out[0].cwdSlice());
}

test "canonical identity includes agent locality and remote host" {
    var mb: Mailbox = .{};
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "conversation-1",
        .source_session = "raw-local",
        .agent = "codex",
        .hostname = "shakib-mac",
        .text = "Local Codex",
        .status = .running,
    });
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "conversation-1",
        .source_session = "raw-remote",
        .agent = "codex",
        .hostname = "inframework",
        .remote = true,
        .text = "Remote Codex",
        .status = .running,
    });
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "conversation-1",
        .source_session = "raw-hermes",
        .agent = "hermes",
        .hostname = "inframework",
        .remote = true,
        .text = "Remote Hermes",
        .status = .running,
    });

    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, 3), mb.takeBubbles(&out));
}

test "authoritative subagent update retracts provisional child card" {
    var mb: Mailbox = .{};
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "root-conversation",
        .source_session = "root-session",
        .agent = "hermes",
        .hostname = "inframework",
        .remote = true,
        .text = "Parent is working",
        .message_kind = .reasoning,
        .status = .running,
    });
    // Simulate the persistence race: the child's first hook was initially
    // treated as a primary conversation under its raw session id.
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "child-session",
        .source_session = "child-session",
        .agent = "hermes",
        .hostname = "inframework",
        .remote = true,
        .text = "Called terminal",
        .message_kind = .tool,
        .status = .running,
    });
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "root-conversation",
        .source_session = "child-session",
        .parent_session = "root-session",
        .session_kind = .subagent,
        .agent = "hermes",
        .hostname = "inframework",
        .remote = true,
        .text = "Called search_files",
        .message_kind = .tool,
        .status = .running,
    });

    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, 1), mb.takeBubbles(&out));
    try std.testing.expectEqualStrings("root-conversation", out[0].sessionSlice());
    try std.testing.expectEqualStrings("Parent is working", out[0].text[0..out[0].text_len]);
}

test "subagent tool noise is ignored and assistant prose folds into parent" {
    var mb: Mailbox = .{};
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "root-conversation",
        .source_session = "root-session",
        .agent = "hermes",
        .hostname = "inframework",
        .remote = true,
        .text = "Working on the request",
        .message_kind = .reasoning,
        .status = .running,
    });
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "root-conversation",
        .source_session = "child-session",
        .parent_session = "root-session",
        .session_kind = .subagent,
        .subagent_label = "Research",
        .agent = "hermes",
        .hostname = "inframework",
        .remote = true,
        .text = "Called terminal",
        .message_kind = .tool,
        .status = .running,
    });
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "root-conversation",
        .source_session = "child-session",
        .parent_session = "root-session",
        .session_kind = .subagent,
        .subagent_label = "Research",
        .agent = "hermes",
        .hostname = "inframework",
        .remote = true,
        .text = "The migration needs one compatibility shim.",
        .message_id = "child-message-1",
        .message_kind = .assistant,
        .status = .completed,
    });

    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, 1), mb.takeBubbles(&out));
    try std.testing.expectEqualStrings("Working on the request", out[0].text[0..out[0].text_len]);
    try std.testing.expectEqual(@as(usize, 1), out[0].child_messages_len);
    try std.testing.expectEqualStrings("Research", out[0].child_messages[0].labelSlice());
    try std.testing.expectEqualStrings("The migration needs one compatibility shim.", out[0].child_messages[0].textSlice());
}

test "subagent prose is deduplicated and bounded to eight recent entries" {
    var mb: Mailbox = .{};
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "root",
        .source_session = "root",
        .agent = "codex",
        .text = "Parent",
        .status = .running,
    });
    for (0..10) |index| {
        var text_buf: [32]u8 = undefined;
        var id_buf: [32]u8 = undefined;
        const child_text = std.fmt.bufPrint(&text_buf, "Child answer {d}", .{index}) catch unreachable;
        const message_id = std.fmt.bufPrint(&id_buf, "child-{d}", .{index}) catch unreachable;
        _ = mb.applyBubbleUpdate(.{
            .conversation_key = "root",
            .source_session = "child",
            .session_kind = .subagent,
            .subagent_label = "Worker",
            .agent = "codex",
            .text = child_text,
            .message_id = message_id,
            .message_kind = .assistant,
        });
    }
    // A replay updates ordering but does not create a ninth row.
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "root",
        .source_session = "child",
        .session_kind = .subagent,
        .subagent_label = "Worker",
        .agent = "codex",
        .text = "Child answer 9",
        .message_id = "child-9",
        .message_kind = .assistant,
    });

    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, 1), mb.takeBubbles(&out));
    try std.testing.expectEqual(max_child_messages, out[0].child_messages_len);
    try std.testing.expectEqualStrings("Child answer 2", out[0].child_messages[0].textSlice());
    try std.testing.expectEqualStrings("Child answer 9", out[0].child_messages[max_child_messages - 1].textSlice());
}

test "assistant prose survives tool summaries and server title survives prompt fallback" {
    var mb: Mailbox = .{};
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "thread",
        .source_session = "thread",
        .agent = "codex",
        .title = "Authoritative title",
        .title_source = .server,
        .text = "Here is the actual assistant response.",
        .message_kind = .assistant,
        .status = .running,
    });
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "thread",
        .source_session = "thread",
        .agent = "codex",
        .title = "Intermediate prompt",
        .title_source = .prompt,
        .text = "Called terminal",
        .message_kind = .tool,
        .status = .running,
    });
    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, 1), mb.takeBubbles(&out));
    try std.testing.expectEqualStrings("Authoritative title", out[0].title[0..out[0].title_len]);
    try std.testing.expectEqualStrings("Here is the actual assistant response.", out[0].text[0..out[0].text_len]);
}

test "pending inputs obey attention precedence until matching responses arrive" {
    var mb: Mailbox = .{};
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "thread",
        .source_session = "thread",
        .agent = "codex",
        .text = "Approve launch?",
        .message_id = "approval-1",
        .message_kind = .prompt,
        .status = .needs_input,
    });
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "thread",
        .source_session = "thread",
        .agent = "codex",
        .text = "Choose a host",
        .message_id = "question-2",
        .message_kind = .prompt,
        .status = .needs_input,
    });
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "thread",
        .source_session = "thread",
        .agent = "codex",
        .text = "Continuing",
        .message_id = "approval-1",
        .resolves_request_id = "approval-1",
        .message_kind = .status,
        .status = .running,
    });
    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, 1), mb.takeBubbles(&out));
    try std.testing.expectEqual(SessionStatus.needs_input, out[0].status);
    try std.testing.expectEqual(@as(usize, 1), out[0].pending_input_ids_len);

    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "thread",
        .source_session = "thread",
        .agent = "codex",
        .text = "Thinking…",
        .message_id = "question-2",
        .resolves_request_id = "question-2",
        .message_kind = .status,
        .status = .running,
    });
    try std.testing.expectEqual(@as(?usize, 1), mb.takeBubbles(&out));
    try std.testing.expectEqual(SessionStatus.running, out[0].status);
    try std.testing.expectEqual(@as(usize, 0), out[0].pending_input_ids_len);
}

test "generic notifications and waiting phases never manufacture attention" {
    for ([_][]const u8{ "notification", "waiting" }) |event_kind| {
        var mb: Mailbox = .{};
        _ = mb.applyBubbleUpdate(.{
            .conversation_key = "thread",
            .source_session = "thread",
            .agent = "claude-code",
            .text = "Informational event",
            .event_kind = event_kind,
            .notification_kind = "unknown_future_type",
            .message_kind = .prompt,
            .status = .needs_input,
        });
        var out: [max_bubbles]Bubble = @splat(.{});
        try std.testing.expectEqual(@as(?usize, 1), mb.takeBubbles(&out));
        try std.testing.expectEqual(SessionStatus.idle, out[0].status);
        try std.testing.expectEqual(@as(usize, 0), out[0].pending_input_ids_len);
        try std.testing.expect(!out[0].pending_unkeyed_input);
    }
}

test "documented notification prompts create one bounded unkeyed request" {
    for ([_][]const u8{ "permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input" }) |kind| {
        var mb: Mailbox = .{};
        _ = mb.applyBubbleUpdate(.{
            .conversation_key = "thread",
            .source_session = "thread",
            .agent = "claude-code",
            .text = "Waiting for you",
            .event_kind = "notification",
            .notification_kind = kind,
            .message_kind = .prompt,
            .status = .idle,
        });
        var out: [max_bubbles]Bubble = @splat(.{});
        try std.testing.expectEqual(@as(?usize, 1), mb.takeBubbles(&out));
        try std.testing.expectEqual(SessionStatus.needs_input, out[0].status);
        try std.testing.expect(out[0].pending_unkeyed_input);
    }
}

test "definitive tool progress clears only the unkeyed fallback" {
    var mb: Mailbox = .{};
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "thread",
        .source_session = "thread",
        .agent = "hermes",
        .text = "Approve?",
        .event_kind = "approval-request",
        .message_kind = .prompt,
        .status = .needs_input,
    });
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "thread",
        .source_session = "thread",
        .agent = "hermes",
        .text = "Calling terminal",
        .event_kind = "tool-progress",
        .message_kind = .tool,
        .status = .running,
    });
    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, 1), mb.takeBubbles(&out));
    try std.testing.expectEqual(SessionStatus.running, out[0].status);
    try std.testing.expect(!out[0].pending_unkeyed_input);
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

test "identical running snapshots do not dirty the mailbox" {
    var mb: Mailbox = .{};
    const update = BubbleUpdate{
        .conversation_key = "alpha",
        .source_session = "alpha",
        .agent = "codex",
        .text = "Reading project files",
        .message_id = "event-1",
        .event_kind = "agent-progress",
        .message_kind = .tool,
        .status = .running,
    };
    const first = mb.applyBubbleUpdate(update);
    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, 1), mb.takeBubbles(&out));
    try std.testing.expect(out[0].last_meaningful_activity_ms > 0);

    const duplicate = mb.applyBubbleUpdate(update);
    try std.testing.expectEqual(first, duplicate);
    try std.testing.expectEqual(@as(?usize, null), mb.takeBubbles(&out));
    try std.testing.expectEqual(@as(u64, 1), mb.bubbleRenderDebugCounters().suppressed_duplicates);
}

test "stale running cards become idle until meaningful work resumes" {
    var mb: Mailbox = .{};
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "alpha",
        .source_session = "alpha",
        .agent = "codex",
        .text = "Reading project files",
        .message_id = "event-1",
        .event_kind = "agent-progress",
        .message_kind = .tool,
        .status = .running,
    });
    var out: [max_bubbles]Bubble = @splat(.{});
    _ = mb.takeBubbles(&out);
    const last_activity = out[0].last_meaningful_activity_ms;
    try std.testing.expectEqual(@as(usize, 1), mb.suppressStaleRunning(last_activity + 30_000, 30_000));
    try std.testing.expectEqual(@as(u64, 1), mb.bubbleRenderDebugCounters().stale_transitions);
    try std.testing.expectEqual(@as(?usize, 1), mb.takeBubbles(&out));
    try std.testing.expectEqual(SessionStatus.idle, out[0].status);
    try std.testing.expect(out[0].stale_running_suppressed);

    // A replayed heartbeat cannot restart the animation.
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "alpha",
        .source_session = "alpha",
        .agent = "codex",
        .text = "Reading project files",
        .message_id = "event-1",
        .event_kind = "agent-progress",
        .message_kind = .tool,
        .status = .running,
    });
    try std.testing.expectEqual(@as(?usize, null), mb.takeBubbles(&out));

    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "alpha",
        .source_session = "alpha",
        .agent = "codex",
        .text = "Read package manifest",
        .message_id = "event-2",
        .event_kind = "agent-progress",
        .message_kind = .tool,
        .status = .running,
    });
    try std.testing.expectEqual(@as(?usize, 1), mb.takeBubbles(&out));
    try std.testing.expectEqual(SessionStatus.running, out[0].status);
    try std.testing.expect(!out[0].stale_running_suppressed);
}

test "unkeyed running cards still become stale after their initial lease" {
    var mb: Mailbox = .{};
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "alpha",
        .source_session = "alpha",
        .agent = "legacy",
        .status = .running,
    });
    var out: [max_bubbles]Bubble = @splat(.{});
    _ = mb.takeBubbles(&out);
    try std.testing.expect(out[0].last_meaningful_activity_ms > 0);
    const lease = out[0].last_meaningful_activity_ms;
    try std.testing.expectEqual(@as(usize, 1), mb.suppressStaleRunning(lease + 30_000, 30_000));
    _ = mb.takeBubbles(&out);
    try std.testing.expectEqual(SessionStatus.idle, out[0].status);

    // A generic heartbeat cannot reanimate a card that has been quieted.
    _ = mb.applyBubbleUpdate(.{
        .conversation_key = "alpha",
        .source_session = "alpha",
        .agent = "legacy",
        .status = .running,
    });
    try std.testing.expectEqual(@as(?usize, null), mb.takeBubbles(&out));
}

/// Lower a canonical bubble JSON record directly into a mailbox. Startup
/// journals and passive provider adapters use this path so their validation,
/// bounded identity, pending-input correlation, and subagent behavior cannot
/// drift from the loopback HTTP endpoint. `feed_source` is transport-owned and
/// therefore overrides an untrusted or stale value in the record.
pub fn applyBubbleJson(target: *Mailbox, body: []const u8, feed_source: FeedSource) ?u64 {
    if (body.len == 0 or body.len > max_request_bytes) return null;
    var json_memory: [max_request_bytes * 2]u8 = undefined;
    var fixed = std.heap.FixedBufferAllocator.init(&json_memory);
    const root = parseRequest(fixed.allocator(), body) catch return null;
    var request: RequestObject = .{ .root = root };

    const text = boundedUtf8(request.string("text") orelse return null, bubble_text_capacity) orelse return null;
    const agent = boundedUtf8(request.string("agent_source") orelse return null, 24) orelse return null;
    const title = boundedUtf8(request.string("title") orelse "", bubble_title_capacity) orelse return null;
    const source_app = request.string("source_app");
    const origin_app = plat.OriginApplication.fromTermProgram(source_app);
    const source_tty = plat.safeSourceTty(request.string("source_tty")) orelse "";
    const source_cwd = plat.safeSourceCwd(request.string("source_cwd")) orelse "";
    const hostname = boundedUtf8(request.string("hostname") orelse "", 64) orelse return null;
    const turn = boundedUtf8(request.string("turn_id") orelse "", 64) orelse return null;
    const message_id = boundedUtf8(request.string("message_id") orelse "", bubble_message_id_capacity) orelse return null;
    const event_kind = boundedUtf8(request.string("event_kind") orelse "", 48) orelse return null;
    const request_id = boundedUtf8(request.string("request_id") orelse "", bubble_message_id_capacity) orelse return null;
    const resolves_request_id = boundedUtf8(request.string("resolves_request_id") orelse "", bubble_message_id_capacity) orelse return null;
    const notification_kind = boundedUtf8(request.string("notification_kind") orelse "", 64) orelse return null;
    const parent_session = request.string("parent_session_id") orelse "";
    const subagent_label = boundedUtf8(request.string("subagent_label") orelse "", 48) orelse return null;
    const remote = request.boolean("remote") orelse false;
    const busy = request.boolean("busy") orelse false;
    var conversation_hash: [64]u8 = undefined;
    const conversation = requestSessionKey(&request, &conversation_hash);
    const session = request.string("session_id") orelse "";
    const source_session = request.string("source_session_id") orelse session;
    const status: ?SessionStatus = if (request.string("status")) |raw| SessionStatus.fromWire(raw) orelse return null else null;
    const session_kind = request.string("session_kind") orelse "primary";
    const message_kind = request.string("message_kind") orelse event_kind;
    const title_source = request.string("title_source") orelse "unknown";
    _ = request.string("feed_source");
    if (!request.valid) return null;
    return target.applyBubbleUpdate(.{
        .conversation_key = conversation[0..@min(conversation.len, bubble_session_capacity)],
        .source_session = source_session,
        .parent_session = parent_session,
        .text = text,
        .agent = agent,
        .title = title,
        .origin_app = origin_app,
        .source_tty = source_tty,
        .source_cwd = source_cwd,
        .hostname = hostname,
        .turn = turn,
        .message_id = message_id,
        .event_kind = event_kind,
        .request_id = request_id,
        .resolves_request_id = resolves_request_id,
        .notification_kind = notification_kind,
        .subagent_label = subagent_label,
        .remote = remote,
        .busy = busy,
        .status = status,
        .session_kind = SessionKind.fromWire(session_kind),
        .message_kind = MessageKind.fromWire(message_kind),
        .title_source = TitleSource.fromWire(title_source),
        .feed_source = feed_source,
    });
}

test "journal lowering decodes escaped Unicode and preserves UTF-8 boundaries" {
    var mb: Mailbox = .{};
    const body =
        "{\"text\":\"quote: \\\" slash: \\\\ line: \\n smile: \\u263a \\ud83d\\ude42\",\"agent_source\":\"codex\",\"session_id\":\"escaped\",\"message_id\":\"id-\\u263a\",\"busy\":true}";
    try std.testing.expect(applyBubbleJson(&mb, body, .journal) != null);
    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, 1), mb.takeBubbles(&out));
    try std.testing.expectEqualStrings("quote: \" slash: \\ line: \n smile: ☺ 🙂", out[0].text[0..out[0].text_len]);
    try std.testing.expectEqualStrings("id-☺", out[0].message_id[0..out[0].message_id_len]);
    try std.testing.expect(std.unicode.utf8ValidateSlice(out[0].text[0..out[0].text_len]));
}

test "journal lowering hashes long source identities before bounded storage" {
    const shared = "provider/session/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const first = shared ++ "-first";
    const second = shared ++ "-second";
    try std.testing.expect(first.len > bubble_session_capacity and second.len > bubble_session_capacity);
    var first_buf: [512]u8 = undefined;
    var second_buf: [512]u8 = undefined;
    const first_body = try std.fmt.bufPrint(&first_buf, "{{\"text\":\"one\",\"agent_source\":\"codex\",\"conversation_key\":\"one\",\"source_session_id\":\"{s}\"}}", .{first});
    const second_body = try std.fmt.bufPrint(&second_buf, "{{\"text\":\"two\",\"agent_source\":\"codex\",\"conversation_key\":\"two\",\"source_session_id\":\"{s}\"}}", .{second});
    var mb: Mailbox = .{};
    try std.testing.expect(applyBubbleJson(&mb, first_body, .journal) != null);
    try std.testing.expect(applyBubbleJson(&mb, second_body, .journal) != null);
    var out: [max_bubbles]Bubble = @splat(.{});
    try std.testing.expectEqual(@as(?usize, 2), mb.takeBubbles(&out));
    try std.testing.expectEqual(@as(usize, 64), out[0].source_session_len);
    try std.testing.expectEqual(@as(usize, 64), out[1].source_session_len);
    try std.testing.expect(!std.mem.eql(u8, out[0].source_session[0..out[0].source_session_len], out[1].source_session[0..out[1].source_session_len]));
}

test "journal lowering rejects duplicate and malformed field types" {
    var mb: Mailbox = .{};
    try std.testing.expect(applyBubbleJson(&mb, "{\"text\":\"one\",\"text\":\"two\",\"agent_source\":\"codex\"}", .journal) == null);
    try std.testing.expect(applyBubbleJson(&mb, "{\"text\":7,\"agent_source\":\"codex\"}", .journal) == null);
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

test "Windows AFD readable mask includes normal data and terminal events" {
    try std.testing.expectEqual(
        @as(std.os.windows.ULONG, (1 << 0) | (1 << 3) | (1 << 4) | (1 << 5)),
        afd_readable_events,
    );
}

test "Windows AFD relative timeout rounds up to 100ns units" {
    try std.testing.expectEqual(@as(std.os.windows.LARGE_INTEGER, 0), windowsRelativeTimeoutFromNanoseconds(-1));
    try std.testing.expectEqual(@as(std.os.windows.LARGE_INTEGER, 0), windowsRelativeTimeoutFromNanoseconds(0));
    try std.testing.expectEqual(@as(std.os.windows.LARGE_INTEGER, -1), windowsRelativeTimeoutFromNanoseconds(1));
    try std.testing.expectEqual(@as(std.os.windows.LARGE_INTEGER, -1), windowsRelativeTimeoutFromNanoseconds(100));
    try std.testing.expectEqual(@as(std.os.windows.LARGE_INTEGER, -2), windowsRelativeTimeoutFromNanoseconds(101));
    try std.testing.expectEqual(@as(std.os.windows.LARGE_INTEGER, -10_000), windowsRelativeTimeoutFromNanoseconds(1_000_000));
}

test "Windows AFD poll structures keep the native ABI layout" {
    if (@sizeOf(usize) == 8) {
        try std.testing.expectEqual(@as(usize, 16), @offsetOf(AfdPollInfo, "handles"));
        try std.testing.expectEqual(@as(usize, 32), @sizeOf(AfdPollInfo));
        try std.testing.expectEqual(@as(usize, 0), @offsetOf(AfdPollHandle, "handle"));
        try std.testing.expectEqual(@as(usize, 8), @offsetOf(AfdPollHandle, "events"));
        try std.testing.expectEqual(@as(usize, 12), @offsetOf(AfdPollHandle, "status"));
        try std.testing.expectEqual(@as(usize, 16), @sizeOf(AfdPollHandle));
    }
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

test "only a real current DSH bubble completes the connection handshake" {
    try std.testing.expect(!isDshHandshakeBubble(
        "{\"agent_source\":\"dsh\",\"integration_version\":\"0.0.9\"}",
    ));
    try std.testing.expect(!isDshHandshakeBubble(
        "{\"agent_source\":\"codex\",\"integration_version\":\"0.1.0\"}",
    ));
    try std.testing.expect(isDshHandshakeBubble(
        "{\"agent_source\":\"dsh\",\"integration_version\":\"0.1.0\"}",
    ));
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

test "steady running state stays coalesced after the mailbox drains" {
    var box: Mailbox = .{};
    var running = StateEvent{};
    running.state_len = "running".len;
    @memcpy(running.state[0..running.state_len], "running");
    try std.testing.expect(box.enqueue(running));
    _ = box.pop();
    try std.testing.expect(!box.enqueue(running));

    var review = StateEvent{};
    review.state_len = "review".len;
    @memcpy(review.state[0..review.state_len], "review");
    try std.testing.expect(box.enqueue(review));

    var directional_running = StateEvent{};
    directional_running.state_len = "running-left".len;
    @memcpy(directional_running.state[0..directional_running.state_len], "running-left");
    try std.testing.expect(box.enqueue(directional_running));
    _ = box.pop();
    try std.testing.expect(!box.enqueue(running));
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

fn isDshHandshakeBubble(body: []const u8) bool {
    const agent = jsonString(body, "agent_source") orelse return false;
    const version = jsonString(body, "integration_version") orelse return false;
    return std.mem.eql(u8, agent, "dsh") and
        std.mem.eql(u8, version, dsh_integration.integration_version);
}

// --------------------------------------------------------- runtime files

fn deleteRuntimeFile(server: *Server, name: []const u8) void {
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ server.runtime_dir, name }) catch return;
    plat.deleteFile(path);
}

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

fn mirrorBubble(server: *Server, text: []const u8, counter: u64, title: []const u8, agent: []const u8, hostname: []const u8, busy: bool) !void {
    var scope = plat.Scope.init();
    defer scope.deinit();
    const io = scope.io();
    server.mirror_lock.lock(io);
    defer server.mirror_lock.unlock(io);
    if (counter < server.last_bubble_mirror) return;
    var memory: [max_request_bytes]u8 = undefined;
    var fixed = std.heap.FixedBufferAllocator.init(&memory);
    const json = try bubbleMirrorJson(fixed.allocator(), text, counter, title, agent, hostname, busy, nowMs());
    try writeRuntimeFile(server, "bubble.json", json, 0o644);
    server.last_bubble_mirror = counter;
}

fn bubbleMirrorJson(allocator: std.mem.Allocator, text: []const u8, counter: u64, title: []const u8, agent: []const u8, hostname: []const u8, busy: bool, at: i64) ![]u8 {
    return std.json.Stringify.valueAlloc(allocator, .{
        .text = text,
        .title = title,
        .agent_source = agent,
        .hostname = hostname,
        .busy = busy,
        .counter = counter,
        .at = at,
    }, .{});
}
