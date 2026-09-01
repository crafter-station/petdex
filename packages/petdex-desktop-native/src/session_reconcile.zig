//! Provider-neutral local session reconciliation.
//!
//! Hooks and embedded plugins remain the low-latency path. This bounded,
//! in-process registry recovers their private journal and provider-owned local
//! stores so sessions that predate Petdex still feed the same mailbox without
//! a sidecar, Petdex database, Python runtime, cloud call, or state mutation.

const std = @import("std");
const builtin = @import("builtin");
const directory_watch = @import("directory_watch.zig");
const hook_server = @import("hook_server.zig");
const plat = @import("plat.zig");

const discovery_ms: i64 = 2_000;
const follow_ms: i64 = 250;
const provider_discovery_max_ms: i64 = 60_000;
const provider_discovery_budget_ms: i64 = 20;
const max_index_bytes: usize = 4 * 1024 * 1024;
const max_rollout_bytes: usize = 4 * 1024 * 1024;
const max_meta_bytes: usize = 64 * 1024;
const max_recent: usize = 32;
const max_watches: usize = hook_server.max_bubbles;
const initial_running_max_age_ms: i64 = 15 * 60 * 1_000;
const max_path_bytes: usize = 1024;
const max_discovery_entries: usize = 4096;
const max_directory_watch_roots: usize = 12;
const journal_version_marker = "\"journal_version\":1";

pub const AdapterCapabilities = packed struct(u8) {
    explicit_parentage: bool = false,
    input_correlation: bool = false,
    authoritative_titles: bool = false,
    origin_activation: bool = false,
    subagents: bool = false,
    _reserved: u3 = 0,
};

pub const StoreKind = enum { codex_rollout, transcript_json, sqlite, hooks_only };

pub const ProviderSchema = enum { claude, codex, gemini, opencode, qoder, kimi, codebuddy, omp, hermes };

/// Static registry for every local AgentKind. Adapters share scheduling and
/// lowering but keep provider-specific roots/capabilities explicit so a schema
/// fallback can never silently masquerade as another provider.
pub const AgentSessionAdapter = struct {
    agent: []const u8,
    schema: ProviderSchema,
    roots: []const []const u8,
    store: StoreKind,
    capabilities: AdapterCapabilities,
};

const claude_roots = [_][]const u8{".claude/projects"};
const codex_roots = [_][]const u8{".codex/sessions"};
const gemini_roots = [_][]const u8{ ".gemini/tmp", ".gemini/sessions" };
const opencode_roots = [_][]const u8{ ".local/share/opencode/storage", ".opencode/storage" };
const qoder_roots = [_][]const u8{ ".qoder/projects", ".qoder-cn/projects" };
const kimi_roots = [_][]const u8{ ".kimi-code", ".kimi" };
const codebuddy_roots = [_][]const u8{".codebuddy/projects"};
const omp_roots = [_][]const u8{ ".omp/agent/sessions", ".omp/sessions" };
const hermes_roots = [_][]const u8{".hermes"};

pub const adapters = [_]AgentSessionAdapter{
    .{ .agent = "claude-code", .schema = .claude, .roots = &claude_roots, .store = .transcript_json, .capabilities = .{ .origin_activation = true } },
    .{ .agent = "codex", .schema = .codex, .roots = &codex_roots, .store = .codex_rollout, .capabilities = .{ .explicit_parentage = true, .input_correlation = true, .authoritative_titles = true, .origin_activation = true, .subagents = true } },
    .{ .agent = "gemini", .schema = .gemini, .roots = &gemini_roots, .store = .transcript_json, .capabilities = .{ .explicit_parentage = true, .authoritative_titles = true, .origin_activation = true, .subagents = true } },
    // These providers remain fully supported through their installed hooks,
    // but their durable stores are proprietary or multi-file/SQLite layouts
    // without a stable versioned contract. Fail closed instead of inventing a
    // flat transcript vocabulary that can silently misidentify sessions.
    .{ .agent = "opencode", .schema = .opencode, .roots = &opencode_roots, .store = .hooks_only, .capabilities = .{} },
    .{ .agent = "qoder", .schema = .qoder, .roots = &qoder_roots, .store = .hooks_only, .capabilities = .{} },
    .{ .agent = "kimi-code", .schema = .kimi, .roots = &kimi_roots, .store = .hooks_only, .capabilities = .{} },
    .{ .agent = "codebuddy", .schema = .codebuddy, .roots = &codebuddy_roots, .store = .hooks_only, .capabilities = .{} },
    .{ .agent = "omp", .schema = .omp, .roots = &omp_roots, .store = .transcript_json, .capabilities = .{ .explicit_parentage = true, .authoritative_titles = true, .origin_activation = true, .subagents = true } },
    .{ .agent = "hermes", .schema = .hermes, .roots = &hermes_roots, .store = .sqlite, .capabilities = .{ .explicit_parentage = true, .authoritative_titles = true, .subagents = true } },
};

/// Snapshotted by main alongside the hook installer override. Keeping recovery
/// on the same resolved Hermes home prevents hooks and state.db from describing
/// different installations.
pub var env_hermes_home: ?[]const u8 = null;
pub var env_claude_config_dir: ?[]const u8 = null;
pub var env_kimi_code_home: ?[]const u8 = null;
pub var env_kimi_share_dir: ?[]const u8 = null;
pub var env_pi_coding_agent_dir: ?[]const u8 = null;
pub var env_xdg_data_home: ?[]const u8 = null;
pub var env_qoder_config_dir: ?[]const u8 = null;
pub var env_qoder_cn_config_dir: ?[]const u8 = null;
pub var env_qoder_cli_home: ?[]const u8 = null;
pub var env_qoder_cn_cli_home: ?[]const u8 = null;

const Status = enum { idle, running, needs_input, completed, failed };
const MessageKind = enum { status, prompt, reasoning, assistant };

const SmallText = struct {
    bytes: [200]u8 = @splat(0),
    len: usize = 0,

    fn slice(self: *const SmallText) []const u8 {
        return self.bytes[0..self.len];
    }

    fn set(self: *SmallText, value: []const u8) void {
        self.* = .{};
        var out: usize = 0;
        var pending_space = false;
        for (value) |byte| {
            if (std.ascii.isWhitespace(byte)) {
                pending_space = out > 0;
                continue;
            }
            if (pending_space and out < self.bytes.len) {
                self.bytes[out] = ' ';
                out += 1;
            }
            pending_space = false;
            if (out == self.bytes.len) break;
            self.bytes[out] = byte;
            out += 1;
        }
        self.len = out;
        while (self.len > 0 and !std.unicode.utf8ValidateSlice(self.bytes[0..self.len])) self.len -= 1;
    }
};

const TitleText = struct {
    bytes: [96]u8 = @splat(0),
    len: usize = 0,

    fn slice(self: *const TitleText) []const u8 {
        return self.bytes[0..self.len];
    }

    fn set(self: *TitleText, value: []const u8) void {
        self.* = .{};
        var compact: SmallText = .{};
        compact.set(value);
        const n = @min(compact.len, self.bytes.len);
        @memcpy(self.bytes[0..n], compact.bytes[0..n]);
        self.len = n;
        while (self.len > 0 and !std.unicode.utf8ValidateSlice(self.bytes[0..self.len])) self.len -= 1;
    }
};

const CwdText = struct {
    bytes: [512]u8 = @splat(0),
    len: usize = 0,

    fn slice(self: *const CwdText) []const u8 {
        return self.bytes[0..self.len];
    }

    fn set(self: *CwdText, value: []const u8) void {
        self.* = .{};
        const n = @min(value.len, self.bytes.len);
        @memcpy(self.bytes[0..n], value[0..n]);
        self.len = n;
        while (self.len > 0 and !std.unicode.utf8ValidateSlice(self.bytes[0..self.len])) self.len -= 1;
    }
};

test "bounded provider text preserves utf8 boundaries" {
    var text: SmallText = .{};
    var input: [202]u8 = @splat('a');
    input[199] = 0xf0;
    input[200] = 0x9f;
    input[201] = 0x98;
    text.set(&input);
    try std.testing.expect(std.unicode.utf8ValidateSlice(text.slice()));
    try std.testing.expectEqual(@as(usize, 199), text.len);

    var title: TitleText = .{};
    var title_input: [99]u8 = @splat('b');
    title_input[95] = 0xe2;
    title_input[96] = 0x82;
    title_input[97] = 0xac;
    title_input[98] = '!';
    title.set(&title_input);
    try std.testing.expect(std.unicode.utf8ValidateSlice(title.slice()));
    try std.testing.expectEqual(@as(usize, 95), title.len);
}

const Pending = struct {
    active: bool = false,
    id: [96]u8 = @splat(0),
    id_len: usize = 0,
    text: SmallText = .{},

    fn idSlice(self: *const Pending) []const u8 {
        return self.id[0..self.id_len];
    }
};

const CorrelationId = struct {
    bytes: [hook_server.bubble_message_id_capacity]u8 = @splat(0),
    len: usize = 0,

    fn slice(self: *const CorrelationId) []const u8 {
        return self.bytes[0..self.len];
    }

    fn set(self: *CorrelationId, value: []const u8) void {
        self.* = .{};
        self.len = @min(value.len, self.bytes.len);
        @memcpy(self.bytes[0..self.len], value[0..self.len]);
        while (self.len > 0 and !std.unicode.utf8ValidateSlice(self.bytes[0..self.len])) self.len -= 1;
    }
};

const CorrelationIds = struct {
    entries: [8]CorrelationId = @splat(.{}),
    len: usize = 0,

    fn append(self: *CorrelationIds, value: []const u8) void {
        if (value.len == 0) return;
        for (self.entries[0..self.len]) |*entry| {
            if (std.mem.eql(u8, entry.slice(), value)) return;
        }
        if (self.len == self.entries.len) {
            std.mem.copyForwards(CorrelationId, self.entries[0 .. self.len - 1], self.entries[1..self.len]);
            self.len -= 1;
        }
        self.entries[self.len].set(value);
        self.len += 1;
    }
};

const RolloutState = struct {
    status: Status = .idle,
    text: SmallText = .{},
    fallback_title: TitleText = .{},
    cwd: CwdText = .{},
    message_kind: MessageKind = .status,
    lifecycle: bool = false,
    subagent: bool = false,
    pending: [8]Pending = @splat(.{}),
    resolved: CorrelationIds = .{},

    fn removePendingAt(self: *RolloutState, index: usize) void {
        var cursor = index;
        while (cursor + 1 < self.pending.len and self.pending[cursor + 1].active) : (cursor += 1) {
            self.pending[cursor] = self.pending[cursor + 1];
        }
        self.pending[cursor] = .{};
    }

    fn setPending(self: *RolloutState, id: []const u8, prompt: []const u8) void {
        var active_len: usize = 0;
        var existing: ?usize = null;
        for (&self.pending, 0..) |*entry, index| {
            if (!entry.active) break;
            active_len = index + 1;
            if (entry.active and std.mem.eql(u8, entry.idSlice(), id)) {
                existing = index;
            }
        }
        if (existing) |index| {
            self.removePendingAt(index);
            active_len -= 1;
        } else if (active_len == self.pending.len) {
            // Bound the queue by evicting the oldest unresolved request.
            self.removePendingAt(0);
            active_len -= 1;
        }
        const entry = &self.pending[active_len];
        entry.* = .{ .active = true };
        entry.id_len = @min(id.len, entry.id.len);
        @memcpy(entry.id[0..entry.id_len], id[0..entry.id_len]);
        entry.text.set(prompt);
    }

    fn resolvePending(self: *RolloutState, id: []const u8) bool {
        for (&self.pending, 0..) |*entry, index| {
            if (!entry.active) return false;
            if (std.mem.eql(u8, entry.idSlice(), id)) {
                self.removePendingAt(index);
                return true;
            }
        }
        return false;
    }

    fn newestPending(self: *const RolloutState) ?*const Pending {
        var newest: ?*const Pending = null;
        for (&self.pending) |*entry| if (entry.active) {
            newest = entry;
        };
        return newest;
    }
};

const Event = struct {
    status: Status,
    text: SmallText,
    title: TitleText,
    cwd: CwdText,
    busy: bool,
    request_id: CorrelationId = .{},
    resolved: CorrelationIds = .{},

    fn requestIdSlice(self: *const Event) []const u8 {
        return self.request_id.slice();
    }

    fn terminal(self: *const Event) bool {
        return self.status == .completed or self.status == .failed;
    }

    fn digest(self: *const Event) u64 {
        var hash = std.hash.Wyhash.init(0);
        hash.update(self.text.slice());
        hash.update(self.title.slice());
        hash.update(self.cwd.slice());
        hash.update(std.mem.asBytes(&self.request_id.len));
        hash.update(self.requestIdSlice());
        for (self.resolved.entries[0..self.resolved.len]) |*entry| {
            hash.update(std.mem.asBytes(&entry.len));
            hash.update(entry.slice());
        }
        hash.update(&.{ @intFromEnum(self.status), @intFromBool(self.busy) });
        return hash.final();
    }
};

const TitleEntry = struct {
    session: [64]u8 = @splat(0),
    session_len: usize = 0,
    title: TitleText = .{},

    fn sessionSlice(self: *const TitleEntry) []const u8 {
        return self.session[0..self.session_len];
    }
};

const Titles = struct {
    entries: [max_recent]TitleEntry = @splat(.{}),
    len: usize = 0,

    fn put(self: *Titles, session: []const u8, title: []const u8) void {
        var existing: ?usize = null;
        for (self.entries[0..self.len], 0..) |*entry, index| {
            if (std.mem.eql(u8, entry.sessionSlice(), session)) existing = index;
        }
        if (existing) |index| {
            std.mem.copyForwards(TitleEntry, self.entries[index .. self.len - 1], self.entries[index + 1 .. self.len]);
            self.len -= 1;
        } else if (self.len == self.entries.len) {
            std.mem.copyForwards(TitleEntry, self.entries[0 .. self.len - 1], self.entries[1..self.len]);
            self.len -= 1;
        }
        var entry: TitleEntry = .{};
        entry.session_len = @min(session.len, entry.session.len);
        @memcpy(entry.session[0..entry.session_len], session[0..entry.session_len]);
        entry.title.set(title);
        self.entries[self.len] = entry;
        self.len += 1;
    }

    fn get(self: *const Titles, session: []const u8) []const u8 {
        var index = self.len;
        while (index > 0) {
            index -= 1;
            if (std.mem.eql(u8, self.entries[index].sessionSlice(), session)) return self.entries[index].title.slice();
        }
        return "";
    }
};

const Candidate = struct {
    session: [64]u8 = @splat(0),
    session_len: usize = 0,
    path: [max_path_bytes]u8 = @splat(0),
    path_len: usize = 0,
    size: u64 = 0,
    mtime_ms: i64 = 0,

    fn sessionSlice(self: *const Candidate) []const u8 {
        return self.session[0..self.session_len];
    }

    fn pathSlice(self: *const Candidate) []const u8 {
        return self.path[0..self.path_len];
    }
};

const Catalog = struct {
    entries: [max_recent]Candidate = @splat(.{}),
    len: usize = 0,

    fn add(self: *Catalog, candidate: Candidate) void {
        if (self.len < self.entries.len) {
            self.entries[self.len] = candidate;
            self.len += 1;
        } else {
            var oldest: usize = 0;
            for (self.entries[1..], 1..) |entry, index| if (entry.mtime_ms < self.entries[oldest].mtime_ms) {
                oldest = index;
            };
            if (candidate.mtime_ms <= self.entries[oldest].mtime_ms) return;
            self.entries[oldest] = candidate;
        }
    }

    fn sortNewest(self: *Catalog) void {
        var i: usize = 1;
        while (i < self.len) : (i += 1) {
            const value = self.entries[i];
            var j = i;
            while (j > 0 and value.mtime_ms > self.entries[j - 1].mtime_ms) : (j -= 1) {
                self.entries[j] = self.entries[j - 1];
            }
            self.entries[j] = value;
        }
    }
};

const Watch = struct {
    used: bool = false,
    session: [64]u8 = @splat(0),
    session_len: usize = 0,
    path: [max_path_bytes]u8 = @splat(0),
    path_len: usize = 0,
    size: u64 = 0,
    mtime_ms: i64 = 0,
    delivered: u64 = 0,
    title: TitleText = .{},
    force: bool = true,

    fn sessionSlice(self: *const Watch) []const u8 {
        return self.session[0..self.session_len];
    }

    fn pathSlice(self: *const Watch) []const u8 {
        return self.path[0..self.path_len];
    }
};

const JournalWatch = struct {
    used: bool = false,
    path: [max_path_bytes]u8 = @splat(0),
    path_len: usize = 0,
    size: u64 = 0,
    mtime_ms: i64 = 0,

    fn pathSlice(self: *const JournalWatch) []const u8 {
        return self.path[0..self.path_len];
    }
};

const ProviderEvent = struct {
    status: Status = .idle,
    text: SmallText = .{},
    title: TitleText = .{},
    cwd: CwdText = .{},
    session: [hook_server.bubble_session_capacity]u8 = @splat(0),
    session_len: usize = 0,
    parent: [hook_server.bubble_session_capacity]u8 = @splat(0),
    parent_len: usize = 0,
    message_id: [hook_server.bubble_message_id_capacity]u8 = @splat(0),
    message_id_len: usize = 0,
    request_id: [hook_server.bubble_message_id_capacity]u8 = @splat(0),
    request_id_len: usize = 0,
    resolves_request_id: [hook_server.bubble_message_id_capacity]u8 = @splat(0),
    resolves_request_id_len: usize = 0,
    label: [48]u8 = @splat(0),
    label_len: usize = 0,
    message_kind: hook_server.MessageKind = .status,
    title_source: hook_server.TitleSource = .unknown,
    subagent: bool = false,
    explicit_lifecycle: bool = false,

    fn sessionSlice(self: *const ProviderEvent) []const u8 {
        return self.session[0..self.session_len];
    }
    fn parentSlice(self: *const ProviderEvent) []const u8 {
        return self.parent[0..self.parent_len];
    }
    fn messageIdSlice(self: *const ProviderEvent) []const u8 {
        return self.message_id[0..self.message_id_len];
    }
    fn requestIdSlice(self: *const ProviderEvent) []const u8 {
        return self.request_id[0..self.request_id_len];
    }
    fn resolvesRequestIdSlice(self: *const ProviderEvent) []const u8 {
        return self.resolves_request_id[0..self.resolves_request_id_len];
    }
    fn labelSlice(self: *const ProviderEvent) []const u8 {
        return self.label[0..self.label_len];
    }
    fn digest(self: *const ProviderEvent) u64 {
        var hash = std.hash.Wyhash.init(0);
        hash.update(self.sessionSlice());
        hash.update(self.parentSlice());
        hash.update(self.text.slice());
        hash.update(self.title.slice());
        hash.update(self.cwd.slice());
        hash.update(self.messageIdSlice());
        hash.update(self.requestIdSlice());
        hash.update(self.resolvesRequestIdSlice());
        hash.update(self.labelSlice());
        hash.update(&.{
            @intFromEnum(self.status),
            @intFromEnum(self.message_kind),
            @intFromEnum(self.title_source),
            @intFromBool(self.subagent),
            @intFromBool(self.explicit_lifecycle),
        });
        return hash.final();
    }
};

const ProviderWatch = struct {
    used: bool = false,
    adapter_index: u8 = 0,
    path: [max_path_bytes]u8 = @splat(0),
    path_len: usize = 0,
    size: u64 = 0,
    mtime_ms: i64 = 0,
    delivered: u64 = 0,

    fn pathSlice(self: *const ProviderWatch) []const u8 {
        return self.path[0..self.path_len];
    }
};

const HermesSeen = struct {
    used: bool = false,
    session: [hook_server.bubble_session_capacity]u8 = @splat(0),
    session_len: usize = 0,
    digest: u64 = 0,

    fn sessionSlice(self: *const HermesSeen) []const u8 {
        return self.session[0..self.session_len];
    }
};

const Watcher = struct {
    allocator: std.mem.Allocator,
    home: []const u8,
    watches: [max_watches]Watch = @splat(.{}),
    journal_watches: [max_recent]JournalWatch = @splat(.{}),
    provider_watches: [max_recent]ProviderWatch = @splat(.{}),
    hermes_seen: [max_recent]HermesSeen = @splat(.{}),
    hermes_initialized: bool = false,
    hermes_db_stamp: u64 = 0,
    last_discovery_ms: i64 = 0,
    directory_scan_pending: bool = false,
    provider_next_discovery_ms: i64 = 0,
    provider_discovery_interval_ms: i64 = discovery_ms,
    provider_adapter_cursor: usize = 0,
    rollout_scan: DirectoryTraversal = .{},
    journal_scan: DirectoryTraversal = .{},
    provider_scans: [adapters.len]ProviderScanCursor = @splat(.{}),
    directory_changes: [max_directory_watch_roots]?directory_watch.Controller = @splat(null),
    directory_changes_len: usize = 0,
};

pub fn start(allocator: std.mem.Allocator, home: []const u8) !void {
    const watcher = try allocator.create(Watcher);
    watcher.* = .{ .allocator = allocator, .home = try allocator.dupe(u8, home) };
    const thread = try std.Thread.spawn(.{}, run, .{watcher});
    thread.detach();
}

fn addDirectoryWatch(watcher: *Watcher, path: ?[]const u8) void {
    const root = path orelse return;
    if (root.len == 0 or !std.fs.path.isAbsolute(root) or watcher.directory_changes_len == watcher.directory_changes.len) return;
    for (watcher.directory_changes[0..watcher.directory_changes_len]) |candidate| {
        if (candidate) |controller| if (std.mem.eql(u8, controller.root(), root)) return;
    }
    const slot = &watcher.directory_changes[watcher.directory_changes_len];
    slot.* = directory_watch.Controller.init(root) orelse return;
    watcher.directory_changes_len += 1;
    if (slot.*) |*controller| controller.start();
}

fn addJoinedDirectoryWatch(watcher: *Watcher, base: []const u8, suffix: []const u8) void {
    const root = std.fs.path.join(watcher.allocator, &.{ base, suffix }) catch return;
    defer watcher.allocator.free(root);
    addDirectoryWatch(watcher, root);
}

fn configureDirectoryWatches(watcher: *Watcher) void {
    // Watch only provider roots with an evidenced durable adapter. Watching
    // all of home makes unrelated browser/download churn rescan transcripts,
    // and can exhaust Linux's bounded recursive watch set. Fixed-size storage
    // bounds both detached watcher count and memory for hostile environments.
    addJoinedDirectoryWatch(watcher, watcher.home, ".codex");
    addJoinedDirectoryWatch(watcher, watcher.home, ".gemini");
    addJoinedDirectoryWatch(watcher, watcher.home, ".petdex");
    // Discovery retains the provider defaults alongside optional overrides,
    // so native notifications must cover both sets as well. Watching these
    // shallow parents catches transcript leaves created after startup.
    addJoinedDirectoryWatch(watcher, watcher.home, ".claude");
    addJoinedDirectoryWatch(watcher, watcher.home, ".omp");
    if (env_claude_config_dir) |root| addDirectoryWatch(watcher, root);
    if (env_pi_coding_agent_dir) |root| addDirectoryWatch(watcher, root);
    if (env_hermes_home) |root|
        addDirectoryWatch(watcher, root)
    else
        addJoinedDirectoryWatch(watcher, watcher.home, ".hermes");
}

fn pollDirectoryWatches(watcher: *Watcher, monotonic_now: i64) directory_watch.Trigger {
    var result: directory_watch.Trigger = .none;
    for (watcher.directory_changes[0..watcher.directory_changes_len]) |*candidate| {
        const trigger = if (candidate.*) |*controller| controller.poll(monotonic_now) else .none;
        if (trigger == .overflow) return .overflow;
        if (trigger == .changed or (trigger == .safety and result == .none)) result = trigger;
    }
    return result;
}

fn run(watcher: *Watcher) void {
    var scope = plat.Scope.init();
    defer scope.deinit();
    const io = scope.io();
    configureDirectoryWatches(watcher);
    while (true) {
        const now = plat.nowMs();
        const monotonic_now = plat.monotonicMs();
        const directory_trigger = pollDirectoryWatches(watcher, monotonic_now);
        if (directory_trigger == .changed) watcher.directory_scan_pending = true;
        const legacy_poll_due = watcher.directory_changes_len == 0 and
            (watcher.last_discovery_ms == 0 or monotonic_now - watcher.last_discovery_ms >= discovery_ms);
        const pending_scan_due = watcher.directory_scan_pending and
            (watcher.last_discovery_ms == 0 or monotonic_now - watcher.last_discovery_ms >= discovery_ms);
        const urgent_scan_due = directory_trigger == .overflow or directory_trigger == .safety;
        if (legacy_poll_due or pending_scan_due or urgent_scan_due) {
            if (directory_trigger == .overflow) resetDiscoveryCursors(watcher, io);
            // Rollouts and hook journals get independent hard budgets so a
            // large provider tree cannot starve crash-recovery journals.
            var rollout_budget: ProviderDiscoveryBudget = .{ .deadline_ms = monotonic_now + provider_discovery_budget_ms };
            discover(watcher, io, now, &rollout_budget);
            var journal_budget: ProviderDiscoveryBudget = .{ .deadline_ms = plat.monotonicMs() + provider_discovery_budget_ms };
            discoverJournals(watcher, io, now, &journal_budget);
            watcher.last_discovery_ms = monotonic_now;
            const changed = watcher.directory_scan_pending or directory_trigger == .overflow;
            // An exhausted traversal owns open directory cursors and resumes
            // after the debounce interval. Never clear it merely because this
            // bounded slice of work completed.
            watcher.directory_scan_pending = rollout_budget.exhausted or journal_budget.exhausted;
            if (changed) watcher.provider_next_discovery_ms = 0;
            if (directory_trigger == .overflow) watcher.provider_adapter_cursor = 0;
        }
        if (watcher.provider_next_discovery_ms == 0 or monotonic_now >= watcher.provider_next_discovery_ms) {
            const result = discoverProviders(watcher, io, now);
            watcher.provider_discovery_interval_ms = nextProviderDiscoveryInterval(watcher.provider_discovery_interval_ms, result);
            watcher.provider_next_discovery_ms = monotonic_now + watcher.provider_discovery_interval_ms;
        }
        follow(watcher, io, now);
        followJournals(watcher, io, now);
        followProviders(watcher, io, now);
        reconcileHermes(watcher, io, now, false);
        std.Io.sleep(io, std.Io.Duration.fromMilliseconds(follow_ms), .awake) catch {};
    }
}

fn readBounded(io: std.Io, allocator: std.mem.Allocator, path: []const u8, max: usize, tail: bool) ?[]u8 {
    var file = std.Io.Dir.openFileAbsolute(io, path, .{}) catch return null;
    defer file.close(io);
    const stat = file.stat(io) catch return null;
    if (stat.size == 0) return null;
    const want: usize = @intCast(@min(stat.size, max));
    const offset: u64 = if (tail) stat.size - want else 0;
    const bytes = allocator.alloc(u8, want) catch return null;
    const got = file.readPositionalAll(io, bytes, offset) catch {
        allocator.free(bytes);
        return null;
    };
    if (got == 0) {
        allocator.free(bytes);
        return null;
    }
    return allocator.realloc(bytes, got) catch bytes[0..got];
}

fn fileInfo(io: std.Io, path: []const u8) ?struct { size: u64, mtime_ms: i64 } {
    var file = std.Io.Dir.openFileAbsolute(io, path, .{}) catch return null;
    defer file.close(io);
    const stat = file.stat(io) catch return null;
    return .{ .size = stat.size, .mtime_ms = @intCast(@divTrunc(stat.mtime.nanoseconds, std.time.ns_per_ms)) };
}

fn valueString(value: std.json.Value, key: []const u8) ?[]const u8 {
    if (value != .object) return null;
    const item = value.object.get(key) orelse return null;
    return if (item == .string) item.string else null;
}

fn messageContentText(payload: std.json.Value, kind: []const u8) ?[]const u8 {
    if (payload != .object) return null;
    const content = payload.object.get("content") orelse return null;
    if (content != .array) return null;
    for (content.array.items) |item| {
        if (!std.mem.eql(u8, valueString(item, "type") orelse "", kind)) continue;
        if (valueString(item, "text")) |text| return text;
    }
    return null;
}

fn loadTitles(io: std.Io, allocator: std.mem.Allocator, home: []const u8) Titles {
    var out: Titles = .{};
    const path = std.fs.path.join(allocator, &.{ home, ".codex", "session_index.jsonl" }) catch return out;
    defer allocator.free(path);
    const bytes = readBounded(io, allocator, path, max_index_bytes, true) orelse return out;
    defer allocator.free(bytes);
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    var lines = std.mem.splitScalar(u8, bytes, '\n');
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        _ = arena.reset(.retain_capacity);
        const root = std.json.parseFromSliceLeaky(std.json.Value, arena.allocator(), line, .{}) catch continue;
        const session = valueString(root, "id") orelse valueString(root, "session_id") orelse continue;
        if (!validSessionId(session)) continue;
        const title = valueString(root, "thread_name") orelse valueString(root, "title") orelse "";
        out.put(session, title);
    }
    return out;
}

fn validSessionId(value: []const u8) bool {
    if (value.len != 36) return false;
    for (value, 0..) |byte, index| {
        if (index == 8 or index == 13 or index == 18 or index == 23) {
            if (byte != '-') return false;
        } else if (!std.ascii.isHex(byte)) return false;
    }
    return true;
}

const ProviderDiscoveryBudget = struct {
    visited: usize = 0,
    deadline_ms: i64,
    max_entries: usize = max_discovery_entries,
    exhausted: bool = false,

    fn take(self: *ProviderDiscoveryBudget) bool {
        if (self.exhausted) return false;
        if (self.visited >= self.max_entries or
            (self.visited > 0 and self.visited % 64 == 0 and plat.monotonicMs() >= self.deadline_ms))
        {
            self.exhausted = true;
            return false;
        }
        self.visited += 1;
        return true;
    }
};

/// Persistent bounded DFS. Directory iterators and handles survive scheduling
/// ticks, so an exhausted pass resumes after its last entry rather than
/// repeatedly enumerating the same filesystem prefix.
const DirectoryTraversal = struct {
    const max_frames = 9;
    const Frame = struct {
        dir: std.Io.Dir = undefined,
        iterator: std.Io.Dir.Iterator = undefined,
        path: [max_path_bytes]u8 = @splat(0),
        path_len: usize = 0,
        depth: u8 = 0,
    };
    const Entry = struct {
        path: []const u8,
        name: []const u8,
        kind: std.Io.File.Kind,
        depth: u8,
    };

    frames: [max_frames]Frame = undefined,
    frames_len: usize = 0,
    path_buf: [max_path_bytes]u8 = @splat(0),

    fn active(self: *const DirectoryTraversal) bool {
        return self.frames_len > 0;
    }

    fn reset(self: *DirectoryTraversal, io: std.Io) void {
        while (self.frames_len > 0) {
            self.frames_len -= 1;
            self.frames[self.frames_len].dir.close(io);
        }
    }

    fn begin(self: *DirectoryTraversal, io: std.Io, root: []const u8) bool {
        self.reset(io);
        if (root.len == 0 or root.len > max_path_bytes) return false;
        var dir = std.Io.Dir.openDirAbsolute(io, root, .{ .iterate = true }) catch return false;
        var frame: Frame = .{ .dir = dir, .iterator = dir.iterate() };
        frame.path_len = root.len;
        @memcpy(frame.path[0..root.len], root);
        self.frames[0] = frame;
        self.frames_len = 1;
        return true;
    }

    fn next(self: *DirectoryTraversal, io: std.Io, max_directory_depth: u8) !?Entry {
        while (self.frames_len > 0) {
            const frame = &self.frames[self.frames_len - 1];
            const entry = (try frame.iterator.next(io)) orelse {
                frame.dir.close(io);
                self.frames_len -= 1;
                continue;
            };
            const base = frame.path[0..frame.path_len];
            const separator = if (base.len > 0 and (base[base.len - 1] == '/' or base[base.len - 1] == '\\')) "" else std.fs.path.sep_str;
            const full = std.fmt.bufPrint(&self.path_buf, "{s}{s}{s}", .{ base, separator, entry.name }) catch continue;
            const depth = frame.depth + 1;
            if (entry.kind == .directory and frame.depth < max_directory_depth and self.frames_len < self.frames.len) {
                const child_dir = frame.dir.openDir(io, entry.name, .{ .iterate = true }) catch null;
                if (child_dir) |dir| {
                    var child: Frame = .{ .dir = dir, .iterator = dir.iterate(), .depth = depth };
                    child.path_len = full.len;
                    @memcpy(child.path[0..full.len], full);
                    self.frames[self.frames_len] = child;
                    self.frames_len += 1;
                }
            }
            return .{ .path = full, .name = entry.name, .kind = entry.kind, .depth = depth };
        }
        return null;
    }
};

const ProviderScanCursor = struct {
    traversal: DirectoryTraversal = .{},
    root_index: usize = 0,

    fn reset(self: *ProviderScanCursor, io: std.Io) void {
        self.traversal.reset(io);
        self.root_index = 0;
    }
};

fn resetDiscoveryCursors(watcher: *Watcher, io: std.Io) void {
    watcher.rollout_scan.reset(io);
    watcher.journal_scan.reset(io);
    for (&watcher.provider_scans) |*cursor| cursor.reset(io);
}

fn collectCatalog(io: std.Io, allocator: std.mem.Allocator, home: []const u8, traversal: *DirectoryTraversal, budget: *ProviderDiscoveryBudget) Catalog {
    var out: Catalog = .{};
    const path = std.fs.path.join(allocator, &.{ home, ".codex", "sessions" }) catch return out;
    defer allocator.free(path);
    if (!traversal.active() and !traversal.begin(io, path)) return out;
    while (budget.take()) {
        const entry = traversal.next(io, 3) catch {
            traversal.reset(io);
            budget.exhausted = true;
            break;
        } orelse break;
        if (entry.depth != 4 or entry.kind != .file or
            !std.mem.startsWith(u8, entry.name, "rollout-") or !std.mem.endsWith(u8, entry.name, ".jsonl")) continue;
        if (entry.name.len < 42) continue;
        const session = entry.name[entry.name.len - 42 .. entry.name.len - 6];
        if (!validSessionId(session)) continue;
        const info = fileInfo(io, entry.path) orelse continue;
        var candidate: Candidate = .{ .size = info.size, .mtime_ms = info.mtime_ms };
        candidate.session_len = session.len;
        @memcpy(candidate.session[0..session.len], session);
        candidate.path_len = entry.path.len;
        @memcpy(candidate.path[0..entry.path.len], entry.path);
        out.add(candidate);
    }
    out.sortNewest();
    return out;
}

fn collectJournalCatalog(io: std.Io, allocator: std.mem.Allocator, home: []const u8, traversal: *DirectoryTraversal, budget: *ProviderDiscoveryBudget) Catalog {
    var out: Catalog = .{};
    const root = std.fs.path.join(allocator, &.{ home, ".petdex", "runtime", "session-journal" }) catch return out;
    defer allocator.free(root);
    if (!traversal.active() and !traversal.begin(io, root)) return out;
    while (budget.take()) {
        const entry = traversal.next(io, 0) catch {
            traversal.reset(io);
            budget.exhausted = true;
            break;
        } orelse break;
        if (entry.kind != .file or !std.mem.endsWith(u8, entry.name, ".jsonl")) continue;
        const info = fileInfo(io, entry.path) orelse continue;
        var candidate: Candidate = .{ .size = info.size, .mtime_ms = info.mtime_ms };
        candidate.path_len = entry.path.len;
        @memcpy(candidate.path[0..entry.path.len], entry.path);
        out.add(candidate);
    }
    out.sortNewest();
    return out;
}

fn journalEvent(line_raw: []const u8) ?[]const u8 {
    const line = std.mem.trim(u8, line_raw, " \t\r");
    if (line.len < 3 or !std.unicode.utf8ValidateSlice(line)) return null;
    if (std.mem.indexOf(u8, line, journal_version_marker) == null) return null;
    const marker = "\"event\":";
    const at = std.mem.indexOf(u8, line, marker) orelse return null;
    const event = std.mem.trim(u8, line[at + marker.len .. line.len - 1], " \t\r");
    if (event.len < 2 or event[0] != '{' or event[event.len - 1] != '}') return null;
    return event;
}

fn journalStatus(bytes: []const u8) ?hook_server.SessionStatus {
    var result: ?hook_server.SessionStatus = null;
    var lines = std.mem.splitScalar(u8, bytes, '\n');
    while (lines.next()) |line| {
        const event = journalEvent(line) orelse continue;
        if (!std.mem.eql(u8, hook_server.jsonStringPub(event, "session_kind") orelse "primary", "primary")) continue;
        if (hook_server.jsonStringPub(event, "status")) |raw| {
            result = hook_server.SessionStatus.fromWire(raw) orelse continue;
        } else {
            result = if (std.mem.indexOf(u8, event, "\"busy\":true") != null) .running else .idle;
        }
    }
    return result;
}

fn journalPublishable(bytes: []const u8, mtime_ms: i64, now_ms: i64) bool {
    const status = journalStatus(bytes) orelse return false;
    if (status == .needs_input) return true;
    if (status != .running) return false;
    return @max(@as(i64, 0), now_ms - mtime_ms) <= initial_running_max_age_ms;
}

fn replayJournalBytes(target: *hook_server.Mailbox, bytes: []const u8) void {
    var lines = std.mem.splitScalar(u8, bytes, '\n');
    while (lines.next()) |line| {
        const event = journalEvent(line) orelse continue;
        _ = hook_server.applyBubbleJson(target, event, .journal);
    }
}

fn replayJournalFile(io: std.Io, allocator: std.mem.Allocator, path: []const u8) void {
    // A rotated generation precedes the current one so nested messages retain
    // provider order. Missing/corrupt/unsupported records are passive skips;
    // the provider store remains the authoritative rebuild source.
    var previous_buf: [max_path_bytes + 2]u8 = undefined;
    if (std.fmt.bufPrint(&previous_buf, "{s}.1", .{path})) |previous| {
        if (readBounded(io, allocator, previous, max_rollout_bytes, true)) |bytes| {
            defer allocator.free(bytes);
            replayJournalBytes(&hook_server.mailbox, bytes);
        }
    } else |_| {}
    if (readBounded(io, allocator, path, max_rollout_bytes, true)) |bytes| {
        defer allocator.free(bytes);
        replayJournalBytes(&hook_server.mailbox, bytes);
    }
}

fn findJournalWatch(watcher: *Watcher, path: []const u8) ?*JournalWatch {
    for (&watcher.journal_watches) |*watch| if (watch.used and std.mem.eql(u8, watch.pathSlice(), path)) return watch;
    return null;
}

fn freeJournalWatch(watcher: *Watcher) ?*JournalWatch {
    for (&watcher.journal_watches) |*watch| if (!watch.used) return watch;
    return null;
}

fn discoverJournals(watcher: *Watcher, io: std.Io, now_ms: i64, budget: *ProviderDiscoveryBudget) void {
    const catalog = collectJournalCatalog(io, watcher.allocator, watcher.home, &watcher.journal_scan, budget);
    for (catalog.entries[0..catalog.len]) |candidate| {
        if (findJournalWatch(watcher, candidate.pathSlice()) != null) continue;
        const bytes = readBounded(io, watcher.allocator, candidate.pathSlice(), max_rollout_bytes, true) orelse continue;
        defer watcher.allocator.free(bytes);
        if (!journalPublishable(bytes, candidate.mtime_ms, now_ms)) continue;
        const slot = freeJournalWatch(watcher) orelse break;
        slot.* = .{ .used = true, .size = candidate.size, .mtime_ms = candidate.mtime_ms };
        slot.path_len = candidate.path_len;
        @memcpy(slot.path[0..candidate.path_len], candidate.pathSlice());
        replayJournalFile(io, watcher.allocator, slot.pathSlice());
    }
}

fn followJournals(watcher: *Watcher, io: std.Io, now_ms: i64) void {
    _ = now_ms;
    for (&watcher.journal_watches) |*watch| {
        if (!watch.used) continue;
        const info = fileInfo(io, watch.pathSlice()) orelse continue;
        if (info.size == watch.size and info.mtime_ms == watch.mtime_ms) continue;
        const bytes = readBounded(io, watcher.allocator, watch.pathSlice(), max_rollout_bytes, true) orelse continue;
        defer watcher.allocator.free(bytes);
        const status = acceptParsedStamp(watch, info.size, info.mtime_ms, journalStatus(bytes)) orelse continue;
        replayJournalBytes(&hook_server.mailbox, bytes);
        if (status != .running and status != .needs_input) watch.used = false;
    }
}

const ProviderCandidate = struct {
    adapter_index: u8,
    candidate: Candidate,
};

fn selectProviderCandidates(catalogs: *const [adapters.len]Catalog, out: *[max_recent]ProviderCandidate) usize {
    // Admit one newest conversation from every detected provider before
    // recency competes for the remaining slots. A single noisy transcript
    // tree therefore cannot starve quieter agents at startup.
    var positions: [adapters.len]usize = @splat(0);
    var count: usize = 0;
    for (catalogs, 0..) |catalog, index| {
        if (catalog.len == 0 or count == out.len) continue;
        out[count] = .{ .adapter_index = @intCast(index), .candidate = catalog.entries[0] };
        count += 1;
        positions[index] = 1;
    }
    while (count < out.len) {
        var best: ?usize = null;
        for (catalogs, 0..) |catalog, index| {
            if (positions[index] >= catalog.len) continue;
            if (best == null or catalog.entries[positions[index]].mtime_ms > catalogs[best.?].entries[positions[best.?]].mtime_ms)
                best = index;
        }
        const index = best orelse break;
        out[count] = .{ .adapter_index = @intCast(index), .candidate = catalogs[index].entries[positions[index]] };
        count += 1;
        positions[index] += 1;
    }
    return count;
}

fn providerFileAllowed(name: []const u8) bool {
    if (!(std.mem.endsWith(u8, name, ".jsonl") or std.mem.endsWith(u8, name, ".json"))) return false;
    return !std.mem.eql(u8, name, "settings.json") and
        !std.mem.eql(u8, name, "config.json") and
        !std.mem.eql(u8, name, "session_index.jsonl");
}

test "provider discovery enforces entry and elapsed-work budgets" {
    var expired: ProviderDiscoveryBudget = .{ .deadline_ms = plat.monotonicMs() - 1 };
    var accepted: usize = 0;
    while (expired.take()) accepted += 1;
    try std.testing.expectEqual(@as(usize, 64), accepted);
    try std.testing.expect(expired.exhausted);

    var entry_limited: ProviderDiscoveryBudget = .{ .deadline_ms = plat.monotonicMs() + 60_000 };
    accepted = 0;
    while (entry_limited.take()) accepted += 1;
    try std.testing.expectEqual(max_discovery_entries, accepted);
    try std.testing.expect(entry_limited.exhausted);
}

test "bounded traversal resumes past its first scheduling budget" {
    const root_relative = ".zig-cache/petdex-session-continuation";
    plat.makeDir(root_relative);
    for (0..7) |index| {
        var path_buf: [256]u8 = undefined;
        const path = try std.fmt.bufPrint(&path_buf, "{s}/entry-{d}.json", .{ root_relative, index });
        try std.testing.expect(plat.writeFile(path, "{}"));
    }

    var scope = plat.Scope.init();
    defer scope.deinit();
    const io = scope.io();
    var absolute_buf: [max_path_bytes]u8 = undefined;
    const absolute_len = try std.Io.Dir.cwd().realPathFile(io, root_relative, &absolute_buf);
    var traversal: DirectoryTraversal = .{};
    defer traversal.reset(io);
    try std.testing.expect(traversal.begin(io, absolute_buf[0..absolute_len]));

    var seen: [7]bool = @splat(false);
    var ticks: usize = 0;
    while (traversal.active() and ticks < 16) : (ticks += 1) {
        var budget: ProviderDiscoveryBudget = .{
            .deadline_ms = plat.monotonicMs() + 60_000,
            .max_entries = 2,
        };
        while (budget.take()) {
            const entry = (try traversal.next(io, 0)) orelse break;
            for (0..seen.len) |index| {
                var expected_buf: [32]u8 = undefined;
                const expected = try std.fmt.bufPrint(&expected_buf, "entry-{d}.json", .{index});
                if (std.mem.eql(u8, entry.name, expected)) seen[index] = true;
            }
        }
    }
    try std.testing.expect(ticks >= 3);
    try std.testing.expect(!traversal.active());
    for (seen) |found| try std.testing.expect(found);
}

fn providerRootPath(allocator: std.mem.Allocator, home: []const u8, adapter: AgentSessionAdapter, ordinal: usize) ?[]u8 {
    var index = ordinal;
    const Custom = struct {
        fn take(allocator_inner: std.mem.Allocator, candidate: ?[]const u8, suffix: []const u8, index_inner: *usize) ?[]u8 {
            const base = candidate orelse return null;
            if (index_inner.* > 0) {
                index_inner.* -= 1;
                return null;
            }
            index_inner.* = std.math.maxInt(usize);
            if (base.len == 0 or !std.fs.path.isAbsolute(base)) return allocator_inner.alloc(u8, 0) catch null;
            return if (suffix.len > 0)
                std.fs.path.join(allocator_inner, &.{ base, suffix }) catch null
            else
                allocator_inner.dupe(u8, base) catch null;
        }
    };
    const configured: ?[]u8 = switch (adapter.schema) {
        .claude => Custom.take(allocator, env_claude_config_dir, "projects", &index),
        .kimi => Custom.take(allocator, env_kimi_code_home, "", &index) orelse
            Custom.take(allocator, env_kimi_share_dir, "", &index),
        .omp => Custom.take(allocator, env_pi_coding_agent_dir, "sessions", &index),
        .opencode => Custom.take(allocator, env_xdg_data_home, "opencode/storage", &index),
        .qoder => Custom.take(allocator, env_qoder_config_dir, "", &index) orelse
            Custom.take(allocator, env_qoder_cn_config_dir, "", &index) orelse
            Custom.take(allocator, env_qoder_cli_home, "", &index) orelse
            Custom.take(allocator, env_qoder_cn_cli_home, "", &index),
        else => null,
    };
    if (configured) |root| return root;
    if (index == std.math.maxInt(usize)) index = 0;
    if (index >= adapter.roots.len) return null;
    return std.fs.path.join(allocator, &.{ home, adapter.roots[index] }) catch null;
}

fn collectProviderCatalog(io: std.Io, allocator: std.mem.Allocator, home: []const u8, adapter: AgentSessionAdapter, cursor: *ProviderScanCursor, budget: *ProviderDiscoveryBudget) Catalog {
    var out: Catalog = .{};
    while (!budget.exhausted) {
        if (!cursor.traversal.active()) {
            const root = providerRootPath(allocator, home, adapter, cursor.root_index) orelse {
                cursor.root_index = 0;
                break;
            };
            cursor.root_index += 1;
            const started = root.len > 0 and cursor.traversal.begin(io, root);
            allocator.free(root);
            if (!started) continue;
        }
        while (budget.take()) {
            const entry = cursor.traversal.next(io, 7) catch {
                cursor.traversal.reset(io);
                budget.exhausted = true;
                break;
            } orelse break;
            if (entry.kind != .file or !providerFileAllowed(entry.name)) continue;
            const info = fileInfo(io, entry.path) orelse continue;
            var candidate: Candidate = .{ .size = info.size, .mtime_ms = info.mtime_ms };
            candidate.path_len = entry.path.len;
            @memcpy(candidate.path[0..entry.path.len], entry.path);
            out.add(candidate);
        }
        if (cursor.traversal.active()) break;
    }
    out.sortNewest();
    return out;
}

fn objectString(value: std.json.Value, key: []const u8) ?[]const u8 {
    if (value != .object) return null;
    const field = value.object.get(key) orelse return null;
    return if (field == .string) field.string else null;
}

fn contentText(value: std.json.Value, depth: u8) ?[]const u8 {
    if (depth > 4) return null;
    if (value == .string) return value.string;
    if (value == .array) {
        for (value.array.items) |item| if (contentText(item, depth + 1)) |text| return text;
        return null;
    }
    if (value != .object) return null;
    inline for (.{ "text", "content" }) |key| {
        if (value.object.get(key)) |nested| if (contentText(nested, depth + 1)) |text| return text;
    }
    return null;
}

fn setBounded(destination: []u8, len: *usize, value: []const u8) void {
    @memset(destination, 0);
    len.* = @min(destination.len, value.len);
    @memcpy(destination[0..len.*], value[0..len.*]);
}

fn providerPathFallback(path: []const u8) []const u8 {
    const base = std.fs.path.basename(path);
    const stem = if (std.mem.lastIndexOfScalar(u8, base, '.')) |dot| base[0..dot] else base;
    if (std.mem.eql(u8, stem, "wire") or std.mem.eql(u8, stem, "state") or std.mem.eql(u8, stem, "messages") or std.mem.eql(u8, stem, "chat")) {
        if (std.fs.path.dirname(path)) |parent| return std.fs.path.basename(parent);
    }
    return stem;
}

fn eventIs(value: []const u8, expected: []const u8) bool {
    return std.ascii.eqlIgnoreCase(value, expected);
}

fn objectValue(value: std.json.Value, key: []const u8) ?std.json.Value {
    if (value != .object) return null;
    return value.object.get(key);
}

fn objectBool(value: std.json.Value, key: []const u8) ?bool {
    const field = objectValue(value, key) orelse return null;
    return if (field == .bool) field.bool else null;
}

fn parentDirectoryName(path: []const u8) []const u8 {
    const dir = std.fs.path.dirname(path) orelse return "";
    return std.fs.path.basename(dir);
}

fn componentParent(path: []const u8, component: []const u8) []const u8 {
    var marker_buf: [64]u8 = undefined;
    for ([_]u8{ '/', '\\' }) |separator| {
        const marker = std.fmt.bufPrint(&marker_buf, "{c}{s}{c}", .{ separator, component, separator }) catch return "";
        if (std.mem.indexOf(u8, path, marker)) |at| return std.fs.path.basename(path[0..at]);
    }
    return "";
}

fn applyClaudeRecord(state: *ProviderEvent, root: std.json.Value) void {
    if (root != .object) return;
    if (objectString(root, "sessionId")) |value| setBounded(&state.session, &state.session_len, value);
    if (objectString(root, "cwd")) |value| state.cwd.set(value);
    if (objectString(root, "uuid")) |value| setBounded(&state.message_id, &state.message_id_len, value);
    if (objectBool(root, "isSidechain") orelse false) state.subagent = true;
    const event_type = objectString(root, "type") orelse return;
    const message = objectValue(root, "message") orelse root;
    const role = objectString(message, "role") orelse event_type;
    const content = if (objectValue(message, "content")) |value| contentText(value, 0) else null;
    if (eventIs(role, "user")) {
        if (content) |value| if (state.title.len == 0) {
            state.title.set(value);
            state.title_source = .prompt;
        };
        state.status = .running;
    } else if (eventIs(role, "assistant")) {
        if (objectString(message, "id")) |value| setBounded(&state.message_id, &state.message_id_len, value);
        if (content) |value| state.text.set(value);
        state.message_kind = .assistant;
        const stop_reason = objectString(message, "stop_reason") orelse "";
        state.status = if (eventIs(stop_reason, "end_turn") or eventIs(stop_reason, "stop_sequence")) .completed else .running;
    } else if (eventIs(event_type, "result")) {
        if (objectString(root, "result")) |value| state.text.set(value);
        state.status = if (objectBool(root, "is_error") orelse false) .failed else .completed;
        state.explicit_lifecycle = true;
    }
}

fn applyGeminiRecord(state: *ProviderEvent, root: std.json.Value) void {
    if (root != .object) return;
    if (objectValue(root, "messages")) |messages| {
        if (messages == .array) for (messages.array.items) |message| applyGeminiRecord(state, message);
    }
    if (objectString(root, "sessionId")) |value| setBounded(&state.session, &state.session_len, value);
    if (objectString(root, "summary")) |value| {
        state.title.set(value);
        state.title_source = .server;
    }
    if (objectString(root, "kind")) |value| {
        if (eventIs(value, "subagent")) state.subagent = true;
    }
    if (objectValue(root, "directories")) |directories| {
        if (directories == .array and directories.array.items.len > 0 and directories.array.items[0] == .string)
            state.cwd.set(directories.array.items[0].string);
    }
    if (objectString(root, "id")) |value| setBounded(&state.message_id, &state.message_id_len, value);
    const event_type = objectString(root, "type") orelse return;
    const content = if (objectValue(root, "content")) |value| contentText(value, 0) else null;
    if (eventIs(event_type, "user")) {
        if (content) |value| if (state.title.len == 0) {
            state.title.set(value);
            state.title_source = .prompt;
        };
        state.status = .running;
    } else if (eventIs(event_type, "gemini")) {
        if (content) |value| state.text.set(value);
        state.message_kind = .assistant;
        const has_tool_calls = if (objectValue(root, "toolCalls")) |calls| calls == .array and calls.array.items.len > 0 else false;
        state.status = if (has_tool_calls) .running else .completed;
    }
}

fn applyOmpRecord(state: *ProviderEvent, path: []const u8, root: std.json.Value) void {
    if (root != .object) return;
    const event_type = objectString(root, "type") orelse return;
    if (eventIs(event_type, "session")) {
        setBounded(&state.session, &state.session_len, providerPathFallback(path));
        if (objectString(root, "cwd")) |value| state.cwd.set(value);
        if (objectString(root, "parentSession")) |value| {
            setBounded(&state.parent, &state.parent_len, providerPathFallback(value));
            state.subagent = true;
        }
        return;
    }
    if (eventIs(event_type, "session_info")) {
        if (objectString(root, "name")) |value| {
            state.title.set(value);
            state.title_source = .server;
        }
        return;
    }
    if (!eventIs(event_type, "message")) return;
    if (objectString(root, "id")) |value| setBounded(&state.message_id, &state.message_id_len, value);
    const message = objectValue(root, "message") orelse return;
    const role = objectString(message, "role") orelse return;
    const content = if (objectValue(message, "content")) |value| contentText(value, 0) else null;
    if (eventIs(role, "user")) {
        if (content) |value| if (state.title.len == 0) {
            state.title.set(value);
            state.title_source = .prompt;
        };
        state.status = .running;
    } else if (eventIs(role, "assistant")) {
        if (content) |value| state.text.set(value);
        state.message_kind = .assistant;
        state.status = .completed;
    } else if (eventIs(role, "toolResult")) {
        state.status = .running;
    }
}

fn applyProviderRecord(state: *ProviderEvent, schema: ProviderSchema, path: []const u8, root: std.json.Value) void {
    switch (schema) {
        .claude => applyClaudeRecord(state, root),
        .gemini => applyGeminiRecord(state, root),
        .omp => applyOmpRecord(state, path, root),
        else => {},
    }
}

fn parseProviderBytes(allocator: std.mem.Allocator, schema: ProviderSchema, path: []const u8, prefix: []const u8, tail: []const u8) ?ProviderEvent {
    if (schema != .claude and schema != .gemini and schema != .omp) return null;
    var state: ProviderEvent = .{};
    const normalized_path = path;
    state.subagent = std.mem.indexOf(u8, normalized_path, "/subagents/") != null or
        std.mem.indexOf(u8, normalized_path, "\\subagents\\") != null or
        std.mem.indexOf(u8, normalized_path, "/agents/") != null or
        std.mem.indexOf(u8, normalized_path, "\\agents\\") != null;
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    for ([_][]const u8{ prefix, tail }) |bytes| {
        var lines = std.mem.splitScalar(u8, bytes, '\n');
        while (lines.next()) |line| {
            if (line.len == 0 or !std.unicode.utf8ValidateSlice(line)) continue;
            _ = arena.reset(.retain_capacity);
            const root = std.json.parseFromSliceLeaky(std.json.Value, arena.allocator(), line, .{}) catch continue;
            applyProviderRecord(&state, schema, path, root);
        }
    }
    // Gemini and several OpenCode store versions write one pretty-printed JSON
    // document rather than JSONL. Parse the bounded document as a whole after
    // the line pass; duplicate records are harmless state assignments.
    const trimmed_tail = std.mem.trim(u8, tail, " \t\r\n");
    const first_line_end = std.mem.indexOfScalar(u8, trimmed_tail, '\n') orelse trimmed_tail.len;
    const first_line = std.mem.trim(u8, trimmed_tail[0..first_line_end], " \t\r");
    if (std.mem.eql(u8, first_line, "{") or std.mem.eql(u8, first_line, "[")) {
        _ = arena.reset(.retain_capacity);
        if (std.json.parseFromSliceLeaky(std.json.Value, arena.allocator(), tail, .{})) |root| {
            applyProviderRecord(&state, schema, path, root);
        } else |_| {}
    }
    if (state.session_len == 0) setBounded(&state.session, &state.session_len, providerPathFallback(path));
    if (state.subagent and state.parent_len == 0) {
        const parent = switch (schema) {
            .claude => componentParent(path, "subagents"),
            .gemini => parentDirectoryName(path),
            else => "",
        };
        if (parent.len > 0) setBounded(&state.parent, &state.parent_len, parent);
    }
    if (state.parent_len > 0 and !std.mem.eql(u8, state.sessionSlice(), state.parentSlice())) state.subagent = true;
    if (state.subagent and state.parent_len == 0) return null;
    if (state.text.len == 0) state.text.set(switch (state.status) {
        .running => "Thinking…",
        .needs_input => "Waiting for you…",
        .completed => "Done.",
        .failed => "Session failed.",
        .idle => "",
    });
    if (state.status == .idle or state.session_len == 0) return null;
    return state;
}

fn parseProviderFile(io: std.Io, allocator: std.mem.Allocator, adapter: AgentSessionAdapter, path: []const u8) ?ProviderEvent {
    const prefix = readBounded(io, allocator, path, max_meta_bytes, false) orelse return null;
    defer allocator.free(prefix);
    const tail = readBounded(io, allocator, path, max_rollout_bytes, true) orelse return null;
    defer allocator.free(tail);
    return parseProviderBytes(allocator, adapter.schema, path, prefix, tail);
}

fn providerInitialPublishable(event: ProviderEvent, mtime_ms: i64, now_ms: i64) bool {
    if (event.subagent) return @max(@as(i64, 0), now_ms - mtime_ms) <= initial_running_max_age_ms;
    if (event.status == .needs_input) return true;
    if (event.status != .running) return false;
    return @max(@as(i64, 0), now_ms - mtime_ms) <= initial_running_max_age_ms;
}

fn providerBubbleUpdate(adapter: AgentSessionAdapter, event: *const ProviderEvent) hook_server.BubbleUpdate {
    return .{
        .conversation_key = if (event.subagent) event.parentSlice() else event.sessionSlice(),
        .source_session = event.sessionSlice(),
        .parent_session = event.parentSlice(),
        .text = event.text.slice(),
        .agent = adapter.agent,
        .title = event.title.slice(),
        .source_cwd = event.cwd.slice(),
        .message_id = event.messageIdSlice(),
        .request_id = event.requestIdSlice(),
        .resolves_request_id = event.resolvesRequestIdSlice(),
        .event_kind = if (event.subagent) "subagent" else "native-store",
        .subagent_label = event.labelSlice(),
        .busy = event.status == .running,
        .status = switch (event.status) {
            .idle => .idle,
            .running => .running,
            .needs_input => .needs_input,
            .completed => .completed,
            .failed => .failed,
        },
        .session_kind = if (event.subagent) .subagent else .primary,
        .message_kind = event.message_kind,
        .title_source = event.title_source,
        .feed_source = .native_store,
    };
}

fn publishProvider(watch: *ProviderWatch, event: ProviderEvent) void {
    const digest = event.digest();
    if (digest == watch.delivered) return;
    const adapter = adapters[watch.adapter_index];
    _ = hook_server.mailbox.applyBubbleUpdateWithDerivedAgentState(providerBubbleUpdate(adapter, &event));
    watch.delivered = digest;
    if (event.status == .completed or event.status == .failed) watch.used = false;
}

/// Active watches and unchanged terminal tombstones both suppress discovery.
/// A terminal event keeps its bounded path/stamp after releasing the live
/// watch slot, preventing the same recent multi-megabyte transcript from being
/// reparsed every two seconds. A changed stamp clears the tombstone so a file
/// that legitimately resumes can be admitted again.
fn findProviderWatch(watcher: *Watcher, adapter_index: u8, path: []const u8, size: u64, mtime_ms: i64) ?*ProviderWatch {
    for (&watcher.provider_watches) |*watch| {
        if (watch.adapter_index != adapter_index or !std.mem.eql(u8, watch.pathSlice(), path)) continue;
        if (watch.used or (watch.size == size and watch.mtime_ms == mtime_ms)) return watch;
        watch.* = .{};
        return null;
    }
    return null;
}

fn freeProviderWatch(watcher: *Watcher) ?*ProviderWatch {
    var tombstone: ?*ProviderWatch = null;
    for (&watcher.provider_watches) |*watch| {
        if (watch.used) continue;
        if (watch.path_len == 0) return watch;
        if (tombstone == null) tombstone = watch;
    }
    return tombstone;
}

const ProviderDiscoveryResult = struct { added: bool = false, budget_exhausted: bool = false };

fn nextProviderDiscoveryInterval(previous_ms: i64, result: ProviderDiscoveryResult) i64 {
    if (result.added or result.budget_exhausted) return discovery_ms;
    return @min(provider_discovery_max_ms, previous_ms * 2);
}

test "provider discovery backs off only after a complete unchanged pass" {
    try std.testing.expectEqual(discovery_ms, nextProviderDiscoveryInterval(16_000, .{ .added = true }));
    try std.testing.expectEqual(discovery_ms, nextProviderDiscoveryInterval(16_000, .{ .budget_exhausted = true }));
    try std.testing.expectEqual(@as(i64, 4_000), nextProviderDiscoveryInterval(discovery_ms, .{}));
    try std.testing.expectEqual(provider_discovery_max_ms, nextProviderDiscoveryInterval(provider_discovery_max_ms, .{}));
}

fn discoverProviders(watcher: *Watcher, io: std.Io, now_ms: i64) ProviderDiscoveryResult {
    var result: ProviderDiscoveryResult = .{};
    var catalogs: [adapters.len]Catalog = @splat(.{});
    var budget: ProviderDiscoveryBudget = .{ .deadline_ms = plat.monotonicMs() + provider_discovery_budget_ms };
    for (0..adapters.len) |offset| {
        const index = (watcher.provider_adapter_cursor + offset) % adapters.len;
        const adapter = adapters[index];
        if (adapter.store == .codex_rollout or adapter.store == .sqlite or adapter.store == .hooks_only) continue;
        catalogs[index] = collectProviderCatalog(io, watcher.allocator, watcher.home, adapter, &watcher.provider_scans[index], &budget);
        if (budget.exhausted) break;
    }
    watcher.provider_adapter_cursor = (watcher.provider_adapter_cursor + 1) % adapters.len;
    result.budget_exhausted = budget.exhausted;

    var selected: [max_recent]ProviderCandidate = undefined;
    const selected_len = selectProviderCandidates(&catalogs, &selected);

    // Parents first resolves child-before-parent races within one discovery
    // pass. The second pass adds only explicit nested assistant summaries.
    inline for (.{ false, true }) |subagents| {
        for (selected[0..selected_len]) |item| {
            const candidate = item.candidate;
            if (findProviderWatch(watcher, item.adapter_index, candidate.pathSlice(), candidate.size, candidate.mtime_ms) != null) continue;
            const event = parseProviderFile(io, watcher.allocator, adapters[item.adapter_index], candidate.pathSlice()) orelse continue;
            if (event.subagent != subagents or !providerInitialPublishable(event, candidate.mtime_ms, now_ms)) continue;
            const slot = freeProviderWatch(watcher) orelse return result;
            slot.* = .{ .used = true, .adapter_index = item.adapter_index, .size = candidate.size, .mtime_ms = candidate.mtime_ms };
            slot.path_len = candidate.path_len;
            @memcpy(slot.path[0..candidate.path_len], candidate.pathSlice());
            publishProvider(slot, event);
            result.added = true;
        }
    }
    return result;
}

fn followProviders(watcher: *Watcher, io: std.Io, now_ms: i64) void {
    _ = now_ms;
    for (&watcher.provider_watches) |*watch| {
        if (!watch.used) continue;
        const info = fileInfo(io, watch.pathSlice()) orelse continue;
        if (info.size == watch.size and info.mtime_ms == watch.mtime_ms) continue;
        const event = acceptParsedStamp(
            watch,
            info.size,
            info.mtime_ms,
            parseProviderFile(io, watcher.allocator, adapters[watch.adapter_index], watch.pathSlice()),
        ) orelse continue;
        publishProvider(watch, event);
    }
}

/// A failed read is not evidence that a changed provider file was consumed.
/// Keep the last successfully parsed stamp so the next poll retries the same
/// bytes instead of suppressing them as already observed.
fn acceptParsedStamp(watch: anytype, size: u64, mtime_ms: i64, parsed_result: anytype) @TypeOf(parsed_result) {
    const parsed = parsed_result orelse return null;
    watch.size = size;
    watch.mtime_ms = mtime_ms;
    return parsed;
}

const WindowsLibrary = struct {
    handle: *anyopaque,

    extern "kernel32" fn LoadLibraryA(name: [*:0]const u8) callconv(.winapi) ?*anyopaque;
    extern "kernel32" fn GetProcAddress(module: *anyopaque, name: [*:0]const u8) callconv(.winapi) ?*anyopaque;
    extern "kernel32" fn FreeLibrary(module: *anyopaque) callconv(.winapi) c_int;

    fn open(name: []const u8) !WindowsLibrary {
        var buffer: [260]u8 = undefined;
        if (name.len >= buffer.len) return error.NameTooLong;
        @memcpy(buffer[0..name.len], name);
        buffer[name.len] = 0;
        return .{ .handle = LoadLibraryA(@ptrCast(&buffer)) orelse return error.NotFound };
    }
    fn close(self: *WindowsLibrary) void {
        _ = FreeLibrary(self.handle);
    }
    fn lookup(self: *WindowsLibrary, comptime T: type, name: [:0]const u8) ?T {
        return @ptrCast(GetProcAddress(self.handle, name.ptr) orelse return null);
    }
};

const DynamicLibrary = if (builtin.target.os.tag == .windows) WindowsLibrary else std.DynLib;

const SqliteApi = struct {
    lib: DynamicLibrary,
    open_v2: *const fn ([*:0]const u8, *?*anyopaque, c_int, ?[*:0]const u8) callconv(.c) c_int,
    close_v2: *const fn (?*anyopaque) callconv(.c) c_int,
    busy_timeout: *const fn (?*anyopaque, c_int) callconv(.c) c_int,
    prepare_v2: *const fn (?*anyopaque, [*:0]const u8, c_int, *?*anyopaque, ?*?[*:0]const u8) callconv(.c) c_int,
    step: *const fn (?*anyopaque) callconv(.c) c_int,
    finalize: *const fn (?*anyopaque) callconv(.c) c_int,
    column_text: *const fn (?*anyopaque, c_int) callconv(.c) ?[*:0]const u8,
    column_double: *const fn (?*anyopaque, c_int) callconv(.c) f64,

    fn load() ?SqliteApi {
        const names: []const []const u8 = switch (builtin.target.os.tag) {
            .windows => &.{ "winsqlite3.dll", "sqlite3.dll" },
            .macos => &.{ "libsqlite3.dylib", "/usr/lib/libsqlite3.dylib" },
            else => &.{ "libsqlite3.so.0", "libsqlite3.so" },
        };
        for (names) |name| {
            var lib = DynamicLibrary.open(name) catch continue;
            const open_v2 = lib.lookup(@TypeOf(@as(SqliteApi, undefined).open_v2), "sqlite3_open_v2") orelse {
                lib.close();
                continue;
            };
            const close_v2 = lib.lookup(@TypeOf(@as(SqliteApi, undefined).close_v2), "sqlite3_close_v2") orelse {
                lib.close();
                continue;
            };
            const busy_timeout = lib.lookup(@TypeOf(@as(SqliteApi, undefined).busy_timeout), "sqlite3_busy_timeout") orelse {
                lib.close();
                continue;
            };
            const prepare_v2 = lib.lookup(@TypeOf(@as(SqliteApi, undefined).prepare_v2), "sqlite3_prepare_v2") orelse {
                lib.close();
                continue;
            };
            const step = lib.lookup(@TypeOf(@as(SqliteApi, undefined).step), "sqlite3_step") orelse {
                lib.close();
                continue;
            };
            const finalize = lib.lookup(@TypeOf(@as(SqliteApi, undefined).finalize), "sqlite3_finalize") orelse {
                lib.close();
                continue;
            };
            const column_text = lib.lookup(@TypeOf(@as(SqliteApi, undefined).column_text), "sqlite3_column_text") orelse {
                lib.close();
                continue;
            };
            const column_double = lib.lookup(@TypeOf(@as(SqliteApi, undefined).column_double), "sqlite3_column_double") orelse {
                lib.close();
                continue;
            };
            return .{ .lib = lib, .open_v2 = open_v2, .close_v2 = close_v2, .busy_timeout = busy_timeout, .prepare_v2 = prepare_v2, .step = step, .finalize = finalize, .column_text = column_text, .column_double = column_double };
        }
        return null;
    }
};

fn sqliteText(api: *const SqliteApi, statement: ?*anyopaque, column: c_int) []const u8 {
    const value = api.column_text(statement, column) orelse return "";
    return std.mem.span(value);
}

fn hermesSeen(watcher: *Watcher, session: []const u8) ?*HermesSeen {
    for (&watcher.hermes_seen) |*seen| if (seen.used and std.mem.eql(u8, seen.sessionSlice(), session)) return seen;
    return null;
}

fn rememberHermes(watcher: *Watcher, session: []const u8) ?*HermesSeen {
    if (hermesSeen(watcher, session)) |seen| return seen;
    for (&watcher.hermes_seen) |*seen| if (!seen.used) {
        seen.* = .{ .used = true };
        setBounded(&seen.session, &seen.session_len, session);
        return seen;
    };
    return null;
}

fn publishHermes(watcher: *Watcher, event: ProviderEvent, initial: bool) void {
    const terminal = event.status == .completed or event.status == .failed;
    if (!event.subagent) {
        const prior = hermesSeen(watcher, event.sessionSlice());
        if (terminal and (initial or prior == null)) return;
        const seen = prior orelse rememberHermes(watcher, event.sessionSlice()) orelse return;
        const digest = event.digest();
        if (seen.digest == digest) return;
        seen.digest = digest;
        if (terminal) seen.used = false;
    }
    _ = hook_server.mailbox.applyBubbleUpdateWithDerivedAgentState(hermesBubbleUpdate(&event));
}

fn hermesBubbleUpdate(event: *const ProviderEvent) hook_server.BubbleUpdate {
    return .{
        .conversation_key = if (event.subagent) event.parentSlice() else event.sessionSlice(),
        .source_session = event.sessionSlice(),
        .parent_session = event.parentSlice(),
        .text = event.text.slice(),
        .agent = "hermes",
        .title = event.title.slice(),
        .message_id = event.messageIdSlice(),
        .resolves_unkeyed_input = !event.subagent and event.status == .running,
        .event_kind = if (event.subagent) "subagent" else "native-store",
        .subagent_label = event.labelSlice(),
        .busy = event.status == .running,
        .status = switch (event.status) {
            .idle => .idle,
            .running => .running,
            .needs_input => .needs_input,
            .completed => .completed,
            .failed => .failed,
        },
        .session_kind = if (event.subagent) .subagent else .primary,
        .message_kind = if (event.subagent) .assistant else .status,
        .title_source = .server,
        .feed_source = .native_store,
    };
}

fn sqliteMillis(value: f64) i64 {
    if (!std.math.isFinite(value) or value <= 0) return 0;
    return if (value < 10_000_000_000) @intFromFloat(value * 1000) else @intFromFloat(value);
}

fn hermesSessionStatus(ended: bool, needs_input: bool, end_reason: []const u8) Status {
    const failed = std.mem.indexOf(u8, end_reason, "fail") != null or
        std.mem.indexOf(u8, end_reason, "error") != null or
        std.mem.indexOf(u8, end_reason, "interrupt") != null;
    return if (failed) .failed else if (ended) .completed else if (needs_input) .needs_input else .running;
}

fn hermesSessionIsSubagent(enriched_schema: bool, source: []const u8, model_config: []const u8, parent: []const u8, session_key: []const u8) bool {
    return eventIs(source, "subagent") or eventIs(source, "delegate") or eventIs(source, "worker") or
        std.mem.indexOf(u8, model_config, "_delegate_from") != null or
        (enriched_schema and parent.len > 0 and session_key.len == 0);
}

const HermesRow = struct {
    enriched_schema: bool,
    id: []const u8,
    session_key: []const u8,
    title: []const u8,
    source: []const u8,
    model_config: []const u8,
    parent_session_id: []const u8,
    started_ms: i64,
    activity_ms: i64,
    description: []const u8,
    ended: bool,
    end_reason: []const u8,
};

fn hermesEventFromRow(row: HermesRow) ProviderEvent {
    const input_prefix = "petdex:needs-input:";
    const needs_input = std.mem.startsWith(u8, row.description, input_prefix);
    const description = if (needs_input) row.description[input_prefix.len..] else row.description;
    const subagent = hermesSessionIsSubagent(row.enriched_schema, row.source, row.model_config, row.parent_session_id, row.session_key);
    const status = hermesSessionStatus(row.ended, needs_input, row.end_reason);
    var event: ProviderEvent = .{ .status = status, .subagent = subagent, .explicit_lifecycle = true, .title_source = .server };
    setBounded(&event.session, &event.session_len, if (!subagent and row.session_key.len > 0) row.session_key else row.id);
    if (row.parent_session_id.len > 0) setBounded(&event.parent, &event.parent_len, row.parent_session_id);
    event.title.set(if (row.title.len > 0) row.title else "Hermes session");
    event.text.set(if (description.len > 0) description else if (status == .failed) "Session failed." else if (row.ended) "Done." else if (needs_input) "Waiting for you…" else "Thinking…");
    event.message_kind = if (subagent) .assistant else .status;
    var id_buf: [64]u8 = undefined;
    const modified_ms = if (row.activity_ms > 0) row.activity_ms else row.started_ms;
    const message_id = std.fmt.bufPrint(&id_buf, "hermes-{d}", .{modified_ms}) catch "";
    // Hermes exposes attention as session state, not a request/response pair.
    // Leaving this update unkeyed lets the next authoritative running row
    // release it without pretending the row timestamp is a correlation id.
    if (!needs_input) setBounded(&event.message_id, &event.message_id_len, message_id);
    if (subagent) setBounded(&event.label, &event.label_len, row.title);
    return event;
}

const sqlite_row: c_int = 100;
const sqlite_done: c_int = 101;

fn commitHermesStampAfterScan(watcher: *Watcher, stamp: u64, step_result: c_int) bool {
    if (step_result != sqlite_done) return false;
    watcher.hermes_db_stamp = stamp;
    return true;
}

fn reconcileHermes(watcher: *Watcher, io: std.Io, now_ms: i64, force: bool) void {
    if (comptime builtin.target.os.tag != .windows and builtin.target.os.tag != .macos and builtin.target.os.tag != .linux) return;
    const root_owned: ?[]u8 = if (env_hermes_home) |configured|
        (if (configured.len > 0) watcher.allocator.dupe(u8, configured) catch return else null)
    else
        null;
    defer if (root_owned) |root| watcher.allocator.free(root);
    const default_root = std.fs.path.join(watcher.allocator, &.{ watcher.home, ".hermes" }) catch return;
    defer watcher.allocator.free(default_root);
    const root = root_owned orelse default_root;
    const db_path = std.fs.path.join(watcher.allocator, &.{ root, "state.db" }) catch return;
    defer watcher.allocator.free(db_path);
    const db_info = fileInfo(io, db_path) orelse return;
    var stamp = db_info.size ^ @as(u64, @bitCast(db_info.mtime_ms));
    const wal_path = std.fmt.allocPrint(watcher.allocator, "{s}-wal", .{db_path}) catch return;
    defer watcher.allocator.free(wal_path);
    if (fileInfo(io, wal_path)) |wal| stamp ^= wal.size *% 1099511628211 ^ @as(u64, @bitCast(wal.mtime_ms));
    if (!force and watcher.hermes_db_stamp == stamp) return;

    var api = SqliteApi.load() orelse return;
    defer api.lib.close();
    const path_z = watcher.allocator.dupeZ(u8, db_path) catch return;
    defer watcher.allocator.free(path_z);
    var database: ?*anyopaque = null;
    if (api.open_v2(path_z.ptr, &database, 0x00000001, null) != 0 or database == null) return;
    defer _ = api.close_v2(database);
    _ = api.busy_timeout(database, 1_500);
    const enriched_sql = "SELECT id,session_key,title,source,model_config,parent_session_id,started_at,last_activity_at,last_activity_description,ended_at,LOWER(COALESCE(end_reason,'')) FROM sessions ORDER BY COALESCE(last_activity_at,started_at) DESC LIMIT 32";
    // Current Hermes documents the portable sessions/messages schema. Some
    // installations additionally carry routing-index columns (session_key and
    // last_activity_*). Prefer those when present, then fall back to a pure
    // read-only/WAL-visible query over the documented provider-owned tables.
    const portable_sql =
        "SELECT s.id,s.id,COALESCE(s.title,''),s.source,COALESCE(s.model_config,''),COALESCE(s.parent_session_id,''),s.started_at," ++
        "COALESCE((SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id=s.id),s.started_at)," ++
        "CASE WHEN COALESCE((SELECT m.role FROM messages m WHERE m.session_id=s.id ORDER BY m.timestamp DESC,m.id DESC LIMIT 1),'')='assistant' AND (" ++
        "LOWER(COALESCE((SELECT m.tool_name FROM messages m WHERE m.session_id=s.id ORDER BY m.timestamp DESC,m.id DESC LIMIT 1),'')) IN ('request_user_input','ask_user','clarify') OR " ++
        "LOWER(COALESCE((SELECT m.tool_calls FROM messages m WHERE m.session_id=s.id ORDER BY m.timestamp DESC,m.id DESC LIMIT 1),'')) LIKE '%request_user_input%' OR " ++
        "LOWER(COALESCE((SELECT m.tool_calls FROM messages m WHERE m.session_id=s.id ORDER BY m.timestamp DESC,m.id DESC LIMIT 1),'')) LIKE '%ask_user%') " ++
        "THEN 'petdex:needs-input:' || COALESCE((SELECT m.content FROM messages m WHERE m.session_id=s.id ORDER BY m.timestamp DESC,m.id DESC LIMIT 1),'Waiting for you') " ++
        "ELSE COALESCE((SELECT m.content FROM messages m WHERE m.session_id=s.id AND m.content IS NOT NULL ORDER BY m.timestamp DESC,m.id DESC LIMIT 1),'') END," ++
        "s.ended_at,LOWER(COALESCE(s.end_reason,'')) FROM sessions s ORDER BY 8 DESC LIMIT 32";
    var statement: ?*anyopaque = null;
    const enriched_schema = api.prepare_v2(database, enriched_sql, -1, &statement, null) == 0 and statement != null;
    if (!enriched_schema) {
        if (statement != null) _ = api.finalize(statement);
        statement = null;
        if (api.prepare_v2(database, portable_sql, -1, &statement, null) != 0 or statement == null) return;
    }
    defer _ = api.finalize(statement);

    var events: [max_recent]ProviderEvent = @splat(.{});
    var raw_ids: [max_recent][hook_server.bubble_session_capacity]u8 = @splat(@splat(0));
    var raw_id_lens: [max_recent]usize = @splat(0);
    var len: usize = 0;
    while (true) {
        const step_result = api.step(statement);
        if (step_result != sqlite_row) {
            if (!commitHermesStampAfterScan(watcher, stamp, step_result)) return;
            break;
        }
        // Both queries are currently bounded to max_recent, but retain this
        // guard if their SQL limit changes before the fixed storage does.
        if (len == events.len) continue;
        const raw_id = sqliteText(&api, statement, 0);
        if (raw_id.len == 0) continue;
        const session_key = sqliteText(&api, statement, 1);
        const title = sqliteText(&api, statement, 2);
        const source = sqliteText(&api, statement, 3);
        const model_config = sqliteText(&api, statement, 4);
        const parent = sqliteText(&api, statement, 5);
        const started_ms = sqliteMillis(api.column_double(statement, 6));
        const activity_ms = sqliteMillis(api.column_double(statement, 7));
        const raw_description = sqliteText(&api, statement, 8);
        const ended = sqliteText(&api, statement, 9).len > 0;
        const end_reason = sqliteText(&api, statement, 10);
        const modified_ms = if (activity_ms > 0) activity_ms else started_ms;
        const fresh = modified_ms > 0 and @max(@as(i64, 0), now_ms - modified_ms) <= initial_running_max_age_ms;
        const needs_input = std.mem.startsWith(u8, raw_description, "petdex:needs-input:");
        if (!ended and !needs_input and !fresh) continue;
        setBounded(&raw_ids[len], &raw_id_lens[len], raw_id);
        events[len] = hermesEventFromRow(.{ .enriched_schema = enriched_schema, .id = raw_id, .session_key = session_key, .title = title, .source = source, .model_config = model_config, .parent_session_id = parent, .started_ms = started_ms, .activity_ms = activity_ms, .description = raw_description, .ended = ended, .end_reason = end_reason });
        len += 1;
    }

    // Resolve delegated parent ids to the parent's canonical session_key.
    for (events[0..len]) |*event| {
        if (!event.subagent) continue;
        for (raw_ids[0..len], raw_id_lens[0..len], events[0..len]) |raw, raw_len, parent_event| {
            if (std.mem.eql(u8, event.parentSlice(), raw[0..raw_len])) {
                setBounded(&event.parent, &event.parent_len, parent_event.sessionSlice());
                break;
            }
        }
    }
    for (events[0..len]) |event| if (!event.subagent) publishHermes(watcher, event, !watcher.hermes_initialized);
    for (events[0..len]) |event| if (event.subagent) publishHermes(watcher, event, !watcher.hermes_initialized);
    watcher.hermes_initialized = true;
}

fn requestPrompt(arguments: std.json.Value, output: *SmallText) void {
    if (arguments != .object) {
        output.set("Waiting for you…");
        return;
    }
    if (arguments.object.get("questions")) |questions| {
        if (questions == .array) for (questions.array.items) |question| {
            if (valueString(question, "question")) |text| {
                output.set(text);
                return;
            }
        };
    }
    inline for (.{ "question", "justification", "prompt", "reason", "message" }) |key| {
        if (valueString(arguments, key)) |text| {
            output.set(text);
            return;
        }
    }
    output.set("Waiting for you…");
}

fn parseMetaPrefix(state: *RolloutState, bytes: []const u8) void {
    const marker = std.mem.indexOf(u8, bytes, "\"type\":\"session_meta\"") orelse return;
    const meta = bytes[marker..];
    if (hook_server.jsonStringPub(meta, "cwd")) |cwd| {
        var decoded: [512]u8 = undefined;
        state.cwd.set(decodeJsonString(cwd, &decoded));
    }
    const thread_source = hook_server.jsonStringPub(meta, "thread_source") orelse "";
    const source = hook_server.jsonStringPub(meta, "source") orelse "";
    state.subagent = std.mem.eql(u8, thread_source, "subagent") or std.mem.eql(u8, source, "subagent") or
        std.mem.indexOf(u8, meta, "\"source\":{\"subagent\"") != null or
        (hook_server.jsonStringPub(meta, "parent_thread_id") != null and hook_server.jsonStringPub(meta, "agent_nickname") != null);
}

fn decodeJsonString(value: []const u8, output: []u8) []const u8 {
    var read: usize = 0;
    var written: usize = 0;
    while (read < value.len and written < output.len) {
        if (value[read] != '\\' or read + 1 >= value.len) {
            output[written] = value[read];
            read += 1;
            written += 1;
            continue;
        }
        const escaped = value[read + 1];
        output[written] = switch (escaped) {
            'n', 'r', 't' => ' ',
            else => escaped,
        };
        read += 2;
        written += 1;
    }
    return output[0..written];
}

fn applyEnvelope(state: *RolloutState, root: std.json.Value, arena: std.mem.Allocator) void {
    if (root != .object) return;
    const outer = valueString(root, "type") orelse "";
    const payload = root.object.get("payload") orelse return;
    if (payload != .object) return;
    const event_type = valueString(payload, "type") orelse "";

    if (std.mem.eql(u8, outer, "session_meta")) {
        if (valueString(payload, "cwd")) |cwd| state.cwd.set(cwd);
        const thread_source = valueString(payload, "thread_source") orelse "";
        var source_kind = valueString(payload, "source") orelse "";
        if (payload.object.get("source")) |source| if (source == .object) {
            if (source.object.get("subagent") != null) source_kind = "subagent" else source_kind = valueString(source, "type") orelse valueString(source, "kind") orelse "";
        };
        state.subagent = std.mem.eql(u8, thread_source, "subagent") or std.mem.eql(u8, source_kind, "subagent") or
            (valueString(payload, "parent_thread_id") != null and valueString(payload, "agent_nickname") != null);
        return;
    }
    if (std.mem.eql(u8, event_type, "user_message") and state.fallback_title.len == 0) {
        if (valueString(payload, "message")) |message| state.fallback_title.set(message);
        return;
    }
    if (std.mem.eql(u8, outer, "response_item") and std.mem.eql(u8, event_type, "message")) {
        const role = valueString(payload, "role") orelse "";
        if (std.mem.eql(u8, role, "user") and state.fallback_title.len == 0) {
            if (messageContentText(payload, "input_text")) |message| state.fallback_title.set(message);
        } else if (std.mem.eql(u8, role, "assistant")) {
            if (messageContentText(payload, "output_text")) |message| {
                state.text.set(message);
                state.message_kind = .assistant;
            }
        }
        return;
    }
    if (std.mem.eql(u8, event_type, "task_started")) {
        state.lifecycle = true;
        state.status = .running;
        state.text.set("");
        state.message_kind = .status;
        state.pending = @splat(.{});
        state.resolved = .{};
        return;
    }
    if (std.mem.eql(u8, event_type, "task_complete")) {
        state.lifecycle = true;
        state.status = .completed;
        state.pending = @splat(.{});
        const final_message = valueString(payload, "last_agent_message") orelse "";
        if (std.mem.trim(u8, final_message, " \t\r\n").len > 0) {
            const message = final_message;
            state.text.set(message);
            state.message_kind = .assistant;
        } else if (state.message_kind != .assistant or std.mem.trim(u8, state.text.slice(), " \t\r\n").len == 0) {
            // Codex may finish a turn without a final-message field. Never
            // carry an in-progress prompt, reasoning, or “Thinking…” cue
            // into a completed card; real assistant prose remains useful.
            state.text.set("Done.");
            state.message_kind = .status;
        }
        return;
    }
    if (std.mem.eql(u8, event_type, "turn_aborted") or std.mem.eql(u8, event_type, "task_failed")) {
        state.lifecycle = true;
        state.status = .failed;
        state.pending = @splat(.{});
        const reason = valueString(payload, "reason") orelse "";
        state.text.set(if (std.mem.eql(u8, reason, "interrupted")) "Interrupted." else "Session failed.");
        state.message_kind = .status;
        return;
    }
    if (std.mem.eql(u8, outer, "response_item") and (std.mem.eql(u8, event_type, "function_call") or std.mem.eql(u8, event_type, "custom_tool_call"))) {
        const name = valueString(payload, "name") orelse "";
        const raw_arguments = valueString(payload, "arguments") orelse valueString(payload, "input") orelse "{}";
        const arguments = std.json.parseFromSliceLeaky(std.json.Value, arena, raw_arguments, .{}) catch std.json.Value{ .object = std.json.ObjectMap.init(arena, &.{}, &.{}) catch return };
        const approval = if (valueString(arguments, "sandbox_permissions")) |permission| std.mem.eql(u8, permission, "require_escalated") else false;
        if (std.mem.endsWith(u8, name, "request_user_input") or approval) {
            const id = valueString(payload, "call_id") orelse valueString(payload, "id") orelse "input-request";
            var prompt: SmallText = .{};
            requestPrompt(arguments, &prompt);
            state.setPending(id, prompt.slice());
            state.status = .needs_input;
            state.text = prompt;
            state.message_kind = .prompt;
        }
        return;
    }
    if (std.mem.eql(u8, outer, "response_item") and (std.mem.eql(u8, event_type, "function_call_output") or std.mem.eql(u8, event_type, "custom_tool_call_output"))) {
        const id = valueString(payload, "call_id") orelse valueString(payload, "id") orelse "";
        if (state.resolvePending(id)) {
            state.resolved.append(id);
        }
        if (state.newestPending() == null and state.status == .needs_input) {
            state.status = .running;
            state.text.set("Thinking…");
            state.message_kind = .status;
        }
        return;
    }
    if (std.mem.eql(u8, event_type, "agent_message")) {
        if (valueString(payload, "message")) |message| {
            state.text.set(message);
            state.message_kind = .assistant;
        }
        return;
    }
    if (std.mem.eql(u8, event_type, "agent_reasoning") and state.message_kind != .assistant) {
        if (valueString(payload, "text")) |reasoning| {
            state.text.set(reasoning);
            state.message_kind = .reasoning;
        }
    }
}

fn parseRolloutBytes(allocator: std.mem.Allocator, prefix: []const u8, tail: []const u8, title: []const u8) ?Event {
    var state: RolloutState = .{};
    parseMetaPrefix(&state, prefix);
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    var lines = std.mem.splitScalar(u8, tail, '\n');
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        _ = arena.reset(.retain_capacity);
        const root = std.json.parseFromSliceLeaky(std.json.Value, arena.allocator(), line, .{}) catch continue;
        applyEnvelope(&state, root, arena.allocator());
    }
    if (state.subagent) return null;
    var request_id: CorrelationId = .{};
    if (state.newestPending()) |pending| {
        state.status = .needs_input;
        state.text = pending.text;
        state.message_kind = .prompt;
        request_id.set(pending.idSlice());
    } else if (!state.lifecycle) {
        if (state.text.len == 0) return null;
        state.status = .running;
    }
    if (state.text.len == 0) state.text.set(if (state.status == .running) "Thinking…" else "Done.");
    var resolved_title: TitleText = .{};
    resolved_title.set(if (title.len > 0) title else state.fallback_title.slice());
    return .{
        .status = state.status,
        .text = state.text,
        .title = resolved_title,
        .cwd = state.cwd,
        .busy = state.status == .running,
        .request_id = request_id,
        .resolved = state.resolved,
    };
}

fn parseRollout(io: std.Io, allocator: std.mem.Allocator, path: []const u8, title: []const u8) ?Event {
    const prefix = readBounded(io, allocator, path, max_meta_bytes, false) orelse return null;
    defer allocator.free(prefix);
    const tail = readBounded(io, allocator, path, max_rollout_bytes, true) orelse return null;
    defer allocator.free(tail);
    return parseRolloutBytes(allocator, prefix, tail, title);
}

fn initialPublishable(event: Event, mtime_ms: i64, now_ms: i64) bool {
    if (event.status == .needs_input) return true;
    if (event.status != .running) return false;
    return @max(@as(i64, 0), now_ms - mtime_ms) <= initial_running_max_age_ms;
}

fn findWatch(watcher: *Watcher, session: []const u8) ?*Watch {
    for (&watcher.watches) |*watch| {
        if (watch.used and std.mem.eql(u8, watch.sessionSlice(), session)) return watch;
    }
    return null;
}

fn freeWatch(watcher: *Watcher) ?*Watch {
    for (&watcher.watches) |*watch| if (!watch.used) return watch;
    return null;
}

fn codexBubbleUpdate(watch: *const Watch, event: *const Event, resolves_request_id: []const u8) hook_server.BubbleUpdate {
    return .{
        .conversation_key = watch.sessionSlice(),
        .source_session = watch.sessionSlice(),
        .text = event.text.slice(),
        .agent = "codex",
        .title = event.title.slice(),
        .source_cwd = event.cwd.slice(),
        .request_id = event.requestIdSlice(),
        .resolves_request_id = resolves_request_id,
        .busy = event.busy,
        .status = switch (event.status) {
            .idle => .idle,
            .running => .running,
            .needs_input => .needs_input,
            .completed => .completed,
            .failed => .failed,
        },
        .message_kind = switch (event.status) {
            .needs_input => .prompt,
            else => .assistant,
        },
        .title_source = if (watch.title.len > 0) .server else .prompt,
        .feed_source = .native_store,
    };
}

fn publish(watch: *Watch, event: Event) void {
    const digest = event.digest();
    if (!watch.force and digest == watch.delivered) return;
    if (event.resolved.len == 0) {
        _ = hook_server.mailbox.applyBubbleUpdateWithDerivedAgentState(codexBubbleUpdate(watch, &event, ""));
    } else {
        for (event.resolved.entries[0..event.resolved.len]) |*resolved| {
            _ = hook_server.mailbox.applyBubbleUpdateWithDerivedAgentState(codexBubbleUpdate(watch, &event, resolved.slice()));
        }
    }
    watch.delivered = digest;
    watch.force = false;
    if (event.terminal()) watch.used = false;
}

fn discover(watcher: *Watcher, io: std.Io, now_ms: i64, budget: *ProviderDiscoveryBudget) void {
    const titles = loadTitles(io, watcher.allocator, watcher.home);
    const catalog = collectCatalog(io, watcher.allocator, watcher.home, &watcher.rollout_scan, budget);
    for (&watcher.watches) |*watch| {
        if (!watch.used) continue;
        const title = titles.get(watch.sessionSlice());
        if (!std.mem.eql(u8, watch.title.slice(), title)) {
            watch.title.set(title);
            watch.force = true;
        }
    }
    for (catalog.entries[0..catalog.len]) |candidate| {
        if (findWatch(watcher, candidate.sessionSlice())) |watch| {
            if (!std.mem.eql(u8, watch.pathSlice(), candidate.pathSlice())) {
                watch.path_len = candidate.path_len;
                @memcpy(watch.path[0..candidate.path_len], candidate.pathSlice());
                watch.force = true;
            }
            continue;
        }
        const slot = freeWatch(watcher) orelse break;
        const title = titles.get(candidate.sessionSlice());
        const event = parseRollout(io, watcher.allocator, candidate.pathSlice(), title) orelse continue;
        if (!initialPublishable(event, candidate.mtime_ms, now_ms)) continue;
        slot.* = .{ .used = true, .size = candidate.size, .mtime_ms = candidate.mtime_ms };
        slot.session_len = candidate.session_len;
        @memcpy(slot.session[0..candidate.session_len], candidate.sessionSlice());
        slot.path_len = candidate.path_len;
        @memcpy(slot.path[0..candidate.path_len], candidate.pathSlice());
        slot.title.set(title);
        publish(slot, event);
    }
}

fn follow(watcher: *Watcher, io: std.Io, now_ms: i64) void {
    _ = now_ms;
    for (&watcher.watches) |*watch| {
        if (!watch.used) continue;
        const info = fileInfo(io, watch.pathSlice()) orelse continue;
        if (!watch.force and info.size == watch.size and info.mtime_ms == watch.mtime_ms) continue;
        const event = acceptParsedStamp(
            watch,
            info.size,
            info.mtime_ms,
            parseRollout(io, watcher.allocator, watch.pathSlice(), watch.title.slice()),
        ) orelse continue;
        publish(watch, event);
    }
}

test "running rollout becomes a busy titled bubble" {
    const fixture =
        \\{"type":"session_meta","payload":{"cwd":"C:\\work","thread_source":"user"}}
        \\{"type":"event_msg","payload":{"type":"user_message","message":"Fallback title"}}
        \\{"type":"event_msg","payload":{"type":"task_started"}}
    ;
    const event = parseRolloutBytes(std.testing.allocator, fixture, fixture, "Indexed title").?;
    try std.testing.expectEqual(Status.running, event.status);
    try std.testing.expect(event.busy);
    try std.testing.expectEqualStrings("Thinking…", event.text.slice());
    try std.testing.expectEqualStrings("Indexed title", event.title.slice());
    try std.testing.expectEqualStrings("C:\\work", event.cwd.slice());
}

test "pending input survives initial reconciliation and resolves" {
    const waiting =
        \\{"type":"event_msg","payload":{"type":"task_started"}}
        \\{"type":"response_item","payload":{"type":"function_call","name":"request_user_input","call_id":"q1","arguments":"{\"questions\":[{\"question\":\"Choose one?\"}]}"}}
    ;
    const event = parseRolloutBytes(std.testing.allocator, waiting, waiting, "").?;
    try std.testing.expectEqual(Status.needs_input, event.status);
    try std.testing.expect(!event.busy);
    try std.testing.expectEqualStrings("Choose one?", event.text.slice());
    try std.testing.expectEqualStrings("q1", event.requestIdSlice());

    const resolved = waiting ++ "\n" ++
        \\{"type":"response_item","payload":{"type":"function_call_output","call_id":"q1"}}
        \\{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"Finished"}}
    ;
    const done = parseRolloutBytes(std.testing.allocator, resolved, resolved, "").?;
    try std.testing.expectEqual(Status.completed, done.status);
    try std.testing.expectEqualStrings("Finished", done.text.slice());
    try std.testing.expectEqual(@as(usize, 1), done.resolved.len);
    try std.testing.expectEqualStrings("q1", done.resolved.entries[0].slice());
}

test "Codex rollout recovery publishes the matched approval resolution" {
    const waiting_rollout =
        \\{"type":"event_msg","payload":{"type":"task_started"}}
        \\{"type":"response_item","payload":{"type":"function_call","name":"request_user_input","call_id":"approval-1","arguments":"{\"questions\":[{\"question\":\"Approve deployment?\"}]}"}}
    ;
    const waiting = parseRolloutBytes(std.testing.allocator, waiting_rollout, waiting_rollout, "").?;

    var watch: Watch = .{};
    setBounded(&watch.session, &watch.session_len, "codex-session");
    var mailbox: hook_server.Mailbox = .{};
    _ = mailbox.applyBubbleUpdateWithDerivedAgentState(codexBubbleUpdate(&watch, &waiting, ""));
    try std.testing.expectEqual(hook_server.SessionStatus.needs_input, mailbox.bubbles[0].status);
    try std.testing.expectEqual(@as(usize, 1), mailbox.bubbles[0].pending_input_ids_len);
    try std.testing.expectEqualStrings("waiting", mailbox.bubbles[0].agentStateSlice());

    const resumed_rollout = waiting_rollout ++ "\n" ++
        \\{"type":"response_item","payload":{"type":"function_call_output","call_id":"approval-1"}}
    ;
    const resumed = parseRolloutBytes(std.testing.allocator, resumed_rollout, resumed_rollout, "").?;
    try std.testing.expectEqual(Status.running, resumed.status);
    try std.testing.expectEqual(@as(usize, 1), resumed.resolved.len);
    const resolution = resumed.resolved.entries[0].slice();
    try std.testing.expectEqualStrings("approval-1", resolution);

    _ = mailbox.applyBubbleUpdateWithDerivedAgentState(codexBubbleUpdate(&watch, &resumed, resolution));
    try std.testing.expectEqual(hook_server.SessionStatus.running, mailbox.bubbles[0].status);
    try std.testing.expectEqual(@as(usize, 0), mailbox.bubbles[0].pending_input_ids_len);
    try std.testing.expectEqualStrings("running", mailbox.bubbles[0].agentStateSlice());
}

test "resolving an older request keeps later pending prompts ordered" {
    var state: RolloutState = .{};
    state.setPending("q1", "First question");
    state.setPending("q2", "Second question");
    try std.testing.expect(state.resolvePending("q1"));
    state.setPending("q3", "Newest question");
    try std.testing.expectEqualStrings("Newest question", state.newestPending().?.text.slice());
    try std.testing.expect(state.resolvePending("q3"));
    try std.testing.expectEqualStrings("Second question", state.newestPending().?.text.slice());
}

test "updating a pending request moves it to the newest position" {
    var state: RolloutState = .{};
    state.setPending("q1", "First question");
    state.setPending("q2", "Second question");
    state.setPending("q1", "Updated first question");
    try std.testing.expectEqualStrings("Updated first question", state.newestPending().?.text.slice());
    try std.testing.expect(state.resolvePending("q1"));
    try std.testing.expectEqualStrings("Second question", state.newestPending().?.text.slice());
}

test "provider digest includes presentation-only metadata" {
    var baseline: ProviderEvent = .{ .status = .running };
    setBounded(&baseline.session, &baseline.session_len, "session");
    const original = baseline.digest();

    var changed = baseline;
    changed.cwd.set("/new/cwd");
    try std.testing.expect(original != changed.digest());

    changed = baseline;
    setBounded(&changed.label, &changed.label_len, "Reviewer");
    try std.testing.expect(original != changed.digest());

    changed = baseline;
    changed.message_kind = .assistant;
    try std.testing.expect(original != changed.digest());

    changed = baseline;
    changed.title_source = .server;
    try std.testing.expect(original != changed.digest());

    changed = baseline;
    changed.explicit_lifecycle = true;
    try std.testing.expect(original != changed.digest());
}

test "bare Codex completion clears transient copy but retains assistant prose" {
    const waiting =
        \\{"type":"event_msg","payload":{"type":"task_started"}}
        \\{"type":"response_item","payload":{"type":"function_call","name":"request_user_input","call_id":"q1","arguments":"{\"questions\":[{\"question\":\"Choose one?\"}]}"}}
        \\{"type":"response_item","payload":{"type":"function_call_output","call_id":"q1"}}
        \\{"type":"event_msg","payload":{"type":"task_complete"}}
    ;
    const done = parseRolloutBytes(std.testing.allocator, waiting, waiting, "").?;
    try std.testing.expectEqual(Status.completed, done.status);
    try std.testing.expect(!done.busy);
    try std.testing.expectEqualStrings("Done.", done.text.slice());

    const prose =
        \\{"type":"event_msg","payload":{"type":"task_started"}}
        \\{"type":"event_msg","payload":{"type":"agent_message","message":"Useful final answer."}}
        \\{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"   "}}
    ;
    const retained = parseRolloutBytes(std.testing.allocator, prose, prose, "").?;
    try std.testing.expectEqual(Status.completed, retained.status);
    try std.testing.expect(!retained.busy);
    try std.testing.expectEqualStrings("Useful final answer.", retained.text.slice());
}

test "subagent and stale completed history are not published" {
    const child =
        \\{"type":"session_meta","payload":{"cwd":"C:\\work","thread_source":"subagent"}}
        \\{"type":"event_msg","payload":{"type":"task_started"}}
    ;
    try std.testing.expect(parseRolloutBytes(std.testing.allocator, child, child, "Child") == null);

    const complete =
        \\{"type":"event_msg","payload":{"type":"task_started"}}
        \\{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"Old answer"}}
    ;
    const event = parseRolloutBytes(std.testing.allocator, complete, complete, "Old").?;
    try std.testing.expect(!initialPublishable(event, 0, initial_running_max_age_ms + 1));
}

test "partial final JSONL record is ignored" {
    const fixture =
        \\{"type":"event_msg","payload":{"type":"task_started"}}
        \\{"type":"event_msg","payload":{"type":"task_complete"
    ;
    const event = parseRolloutBytes(std.testing.allocator, fixture, fixture, "Live").?;
    try std.testing.expectEqual(Status.running, event.status);
}

test "failure is terminal and non-busy" {
    const fixture =
        \\{"type":"event_msg","payload":{"type":"task_started"}}
        \\{"type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}
    ;
    const event = parseRolloutBytes(std.testing.allocator, fixture, fixture, "Failed task").?;
    try std.testing.expectEqual(Status.failed, event.status);
    try std.testing.expect(!event.busy);
    try std.testing.expect(event.terminal());
    try std.testing.expectEqualStrings("Interrupted.", event.text.slice());
}

test "freshness includes old unresolved input but not abandoned running history" {
    const running_fixture =
        \\{"type":"event_msg","payload":{"type":"task_started"}}
    ;
    const running = parseRolloutBytes(std.testing.allocator, running_fixture, running_fixture, "Running").?;
    const now = initial_running_max_age_ms * 3;
    try std.testing.expect(initialPublishable(running, now - initial_running_max_age_ms, now));
    try std.testing.expect(!initialPublishable(running, now - initial_running_max_age_ms - 1, now));

    const waiting_fixture =
        \\{"type":"event_msg","payload":{"type":"task_started"}}
        \\{"type":"response_item","payload":{"type":"custom_tool_call","name":"functions.request_user_input","call_id":"q1","input":"{\"question\":\"Continue?\"}"}}
    ;
    const waiting = parseRolloutBytes(std.testing.allocator, waiting_fixture, waiting_fixture, "Waiting").?;
    try std.testing.expect(initialPublishable(waiting, 0, now));
}

test "renamed and multiple active rollouts keep one stable mailbox slot per session" {
    const fixture =
        \\{"type":"session_meta","payload":{"cwd":"C:\\work","thread_source":"user"}}
        \\{"type":"event_msg","payload":{"type":"task_started"}}
    ;
    const alpha = parseRolloutBytes(std.testing.allocator, fixture, fixture, "Alpha").?;
    const beta = parseRolloutBytes(std.testing.allocator, fixture, fixture, "Beta").?;
    var mailbox: hook_server.Mailbox = .{};
    const alpha_counter = mailbox.applyBubbleUpdate(.{ .conversation_key = "session-alpha", .source_session = "session-alpha", .text = alpha.text.slice(), .agent = "codex", .title = alpha.title.slice(), .source_cwd = alpha.cwd.slice(), .busy = alpha.busy, .status = .running, .title_source = .server, .feed_source = .native_store });
    _ = mailbox.applyBubbleUpdate(.{ .conversation_key = "session-beta", .source_session = "session-beta", .text = beta.text.slice(), .agent = "codex", .title = beta.title.slice(), .source_cwd = beta.cwd.slice(), .busy = beta.busy, .status = .running, .title_source = .server, .feed_source = .native_store });
    const renamed = parseRolloutBytes(std.testing.allocator, fixture, fixture, "Alpha renamed").?;
    const renamed_counter = mailbox.applyBubbleUpdate(.{ .conversation_key = "session-alpha", .source_session = "session-alpha", .text = renamed.text.slice(), .agent = "codex", .title = renamed.title.slice(), .source_cwd = renamed.cwd.slice(), .busy = renamed.busy, .status = .running, .title_source = .server, .feed_source = .native_store });
    try std.testing.expect(renamed_counter > alpha_counter);
    try std.testing.expectEqual(@as(usize, 2), mailbox.bubbles_len);
    try std.testing.expectEqualStrings("session-alpha", mailbox.bubbles[0].sessionSlice());
    try std.testing.expectEqualStrings("Alpha renamed", mailbox.bubbles[0].title[0..mailbox.bubbles[0].title_len]);
    try std.testing.expectEqualStrings("session-beta", mailbox.bubbles[1].sessionSlice());
}

test "native store recovery derives Flock state from canonical reconciled lifecycle" {
    var mailbox: hook_server.Mailbox = .{};
    const raw_identity = "provider/session/with:unsafe/components/and/a/conversation-key-longer-than-the-mailbox-storage-boundary/recovered-primary";
    const agent = "claude-code";

    _ = mailbox.applyBubbleUpdate(.{
        .conversation_key = raw_identity,
        .source_session = raw_identity,
        .text = "Approve the recovered action",
        .agent = agent,
        .request_id = "approval-1",
        .busy = false,
        .status = .needs_input,
        .message_kind = .prompt,
        .feed_source = .hook,
    });
    try std.testing.expectEqual(@as(usize, std.crypto.hash.sha2.Sha256.digest_length * 2), mailbox.bubbles[0].session_len);
    try std.testing.expect(!std.mem.eql(u8, raw_identity, mailbox.bubbles[0].sessionSlice()));
    mailbox.setBubbleAgentStateIdentity(mailbox.bubbles[0].sessionSlice(), "review", agent, "", false, true);

    // Generic progress cannot resolve a keyed approval. The recovered state
    // must follow the accepted needs_input status, not the proposed running
    // status, and must find the normalized long provider identity.
    _ = mailbox.applyBubbleUpdateWithDerivedAgentState(.{
        .conversation_key = raw_identity,
        .source_session = raw_identity,
        .text = "Recovered progress without approval correlation",
        .agent = agent,
        .message_id = "assistant-1",
        .event_kind = "native-store",
        .busy = true,
        .status = .running,
        .message_kind = .assistant,
        .feed_source = .native_store,
    });
    try std.testing.expectEqual(hook_server.SessionStatus.needs_input, mailbox.bubbles[0].status);
    try std.testing.expectEqualStrings("waiting", mailbox.bubbles[0].agentStateSlice());

    _ = mailbox.applyBubbleUpdateWithDerivedAgentState(.{
        .conversation_key = raw_identity,
        .source_session = raw_identity,
        .text = "Recovered progress",
        .agent = agent,
        .message_id = "assistant-2",
        .resolves_request_id = "approval-1",
        .event_kind = "native-store",
        .busy = true,
        .status = .running,
        .message_kind = .assistant,
        .feed_source = .native_store,
    });
    try std.testing.expectEqual(hook_server.SessionStatus.running, mailbox.bubbles[0].status);
    try std.testing.expectEqualStrings("running", mailbox.bubbles[0].agentStateSlice());

    _ = mailbox.applyBubbleUpdateWithDerivedAgentState(.{
        .conversation_key = raw_identity,
        .source_session = raw_identity,
        .text = "Session failed.",
        .agent = agent,
        .busy = false,
        .status = .failed,
        .feed_source = .native_store,
    });
    try std.testing.expectEqualStrings("failed", mailbox.bubbles[0].agentStateSlice());

    _ = mailbox.applyBubbleUpdateWithDerivedAgentState(.{
        .conversation_key = raw_identity,
        .source_session = raw_identity,
        .text = "Done.",
        .agent = agent,
        .busy = false,
        .status = .completed,
        .feed_source = .native_store,
    });
    try std.testing.expectEqual(hook_server.SessionStatus.completed, mailbox.bubbles[0].status);
    try std.testing.expectEqual(@as(usize, 0), mailbox.bubbles[0].agent_state_len);

    mailbox.setBubbleAgentStateIdentity(mailbox.bubbles[0].sessionSlice(), "review", agent, "", false, true);
    _ = mailbox.applyBubbleUpdateWithDerivedAgentState(.{
        .conversation_key = raw_identity,
        .source_session = "recovered-child",
        .parent_session = raw_identity,
        .text = "Child summary",
        .agent = agent,
        .message_id = "child-1",
        .busy = false,
        .status = .completed,
        .session_kind = .subagent,
        .message_kind = .assistant,
        .feed_source = .native_store,
    });
    try std.testing.expectEqualStrings("review", mailbox.bubbles[0].agentStateSlice());
}

test "current response-item messages map user titles and assistant progress" {
    const fixture =
        \\{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Fix the bubble tracker"}]}}
        \\{"type":"event_msg","payload":{"type":"task_started"}}
        \\{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Inspecting window movement"}]}}
    ;
    const event = parseRolloutBytes(std.testing.allocator, fixture, fixture, "").?;
    try std.testing.expectEqualStrings("Fix the bubble tracker", event.title.slice());
    try std.testing.expectEqualStrings("Inspecting window movement", event.text.slice());
    try std.testing.expect(event.busy);
}

test "adapter registry covers all nine agents and fails closed for unversioned stores" {
    try std.testing.expectEqual(@as(usize, 9), adapters.len);
    const expected = [_][]const u8{ "claude-code", "codex", "gemini", "opencode", "qoder", "kimi-code", "codebuddy", "omp", "hermes" };
    for (adapters, expected) |adapter, name| {
        try std.testing.expectEqualStrings(name, adapter.agent);
        if (adapter.store == .hooks_only) {
            try std.testing.expectEqual(AdapterCapabilities{}, adapter.capabilities);
        } else if (adapter.schema == .hermes) {
            try std.testing.expect(adapter.capabilities.authoritative_titles);
            try std.testing.expect(!adapter.capabilities.input_correlation);
            try std.testing.expect(!adapter.capabilities.origin_activation);
        }
    }
    try std.testing.expect(!adapters[0].capabilities.authoritative_titles);
    try std.testing.expect(adapters[2].capabilities.authoritative_titles);
    try std.testing.expect(adapters[7].capabilities.authoritative_titles);
}

test "candidate admission seeds every detected provider before noisy recency" {
    var catalogs: [adapters.len]Catalog = @splat(.{});
    catalogs[0].len = max_recent;
    for (catalogs[0].entries[0..max_recent], 0..) |*entry, index|
        entry.mtime_ms = 10_000 - @as(i64, @intCast(index));
    for (1..adapters.len) |index| {
        catalogs[index].len = 1;
        catalogs[index].entries[0].mtime_ms = @intCast(index);
    }

    var selected: [max_recent]ProviderCandidate = undefined;
    const count = selectProviderCandidates(&catalogs, &selected);
    try std.testing.expectEqual(max_recent, count);
    for (0..adapters.len) |index|
        try std.testing.expectEqual(@as(u8, @intCast(index)), selected[index].adapter_index);
    try std.testing.expectEqual(@as(u8, 0), selected[adapters.len].adapter_index);
}

test "terminal subagent provider watches release their slots" {
    var event: ProviderEvent = .{ .status = .completed, .subagent = true };
    var watch: ProviderWatch = .{ .used = true, .adapter_index = 0, .size = 4096, .mtime_ms = 42 };
    setBounded(&watch.path, &watch.path_len, "claude/child.jsonl");
    publishProvider(&watch, event);
    try std.testing.expect(!watch.used);
    try std.testing.expectEqualStrings("claude/child.jsonl", watch.pathSlice());
    try std.testing.expectEqual(@as(u64, 4096), watch.size);
    try std.testing.expectEqual(@as(i64, 42), watch.mtime_ms);

    event.status = .running;
    watch = .{ .used = true, .adapter_index = 0 };
    publishProvider(&watch, event);
    try std.testing.expect(watch.used);
}

test "unchanged terminal provider tombstones suppress rediscovery" {
    var watcher: Watcher = .{ .allocator = std.testing.allocator, .home = "" };
    const terminal = &watcher.provider_watches[0];
    terminal.* = .{ .adapter_index = 2, .size = 4096, .mtime_ms = 42 };
    setBounded(&terminal.path, &terminal.path_len, "gemini/child.jsonl");

    try std.testing.expect(findProviderWatch(&watcher, 2, "gemini/child.jsonl", 4096, 42) == terminal);
    // Prefer a genuinely empty slot so tombstones survive until capacity is
    // actually needed.
    try std.testing.expect(freeProviderWatch(&watcher) == &watcher.provider_watches[1]);

    try std.testing.expect(findProviderWatch(&watcher, 2, "gemini/child.jsonl", 4100, 43) == null);
    try std.testing.expectEqual(@as(usize, 0), watcher.provider_watches[0].path_len);
}

test "file watch stamps advance only after a successful parse" {
    var watch: ProviderWatch = .{ .used = true, .size = 1024, .mtime_ms = 10 };

    try std.testing.expectEqual(@as(?ProviderEvent, null), acceptParsedStamp(&watch, 2048, 20, @as(?ProviderEvent, null)));
    try std.testing.expectEqual(@as(u64, 1024), watch.size);
    try std.testing.expectEqual(@as(i64, 10), watch.mtime_ms);

    const event: ProviderEvent = .{ .status = .running };
    const accepted = acceptParsedStamp(&watch, 2048, 20, @as(?ProviderEvent, event)) orelse return error.TestUnexpectedResult;
    try std.testing.expectEqual(Status.running, accepted.status);
    try std.testing.expectEqual(@as(u64, 2048), watch.size);
    try std.testing.expectEqual(@as(i64, 20), watch.mtime_ms);

    var rollout: Watch = .{ .used = true, .size = 4096, .mtime_ms = 30 };
    try std.testing.expectEqual(@as(?Event, null), acceptParsedStamp(&rollout, 8192, 40, @as(?Event, null)));
    try std.testing.expectEqual(@as(u64, 4096), rollout.size);
    try std.testing.expectEqual(@as(i64, 30), rollout.mtime_ms);

    const rollout_event: Event = .{ .status = .running, .text = .{}, .title = .{}, .cwd = .{}, .busy = true };
    _ = acceptParsedStamp(&rollout, 8192, 40, @as(?Event, rollout_event)) orelse return error.TestUnexpectedResult;
    try std.testing.expectEqual(@as(u64, 8192), rollout.size);
    try std.testing.expectEqual(@as(i64, 40), rollout.mtime_ms);

    var journal: JournalWatch = .{ .used = true, .size = 16_384, .mtime_ms = 50 };
    try std.testing.expectEqual(@as(?Status, null), acceptParsedStamp(&journal, 32_768, 60, @as(?Status, null)));
    try std.testing.expectEqual(@as(u64, 16_384), journal.size);
    try std.testing.expectEqual(@as(i64, 50), journal.mtime_ms);

    try std.testing.expectEqual(Status.running, acceptParsedStamp(&journal, 32_768, 60, @as(?Status, .running)).?);
    try std.testing.expectEqual(@as(u64, 32_768), journal.size);
    try std.testing.expectEqual(@as(i64, 60), journal.mtime_ms);
}

test "Hermes portable schema distinguishes continuations workers input and failure" {
    // A documented parent_session_id can be a compression continuation; it
    // is not a delegated worker without an explicit source/config marker.
    try std.testing.expect(!hermesSessionIsSubagent(false, "cli", "{}", "previous", "current"));
    try std.testing.expect(hermesSessionIsSubagent(false, "worker", "{}", "parent", "child"));
    try std.testing.expect(hermesSessionIsSubagent(false, "cli", "{\"_delegate_from\":\"parent\"}", "parent", "child"));
    try std.testing.expect(hermesSessionIsSubagent(true, "cli", "{}", "parent", ""));

    try std.testing.expectEqual(Status.needs_input, hermesSessionStatus(false, true, ""));
    try std.testing.expectEqual(Status.completed, hermesSessionStatus(true, false, "complete"));
    try std.testing.expectEqual(Status.failed, hermesSessionStatus(true, false, "interrupted"));
}

test "Hermes DB stamp advances only after a completed SQLite scan" {
    var watcher: Watcher = .{ .allocator = std.testing.allocator, .home = "" };
    watcher.hermes_db_stamp = 17;
    try std.testing.expect(!commitHermesStampAfterScan(&watcher, 42, 5));
    try std.testing.expectEqual(@as(u64, 17), watcher.hermes_db_stamp);
    try std.testing.expect(commitHermesStampAfterScan(&watcher, 42, sqlite_done));
    try std.testing.expectEqual(@as(u64, 42), watcher.hermes_db_stamp);
}

const ProviderFixtureCase = struct {
    adapter_index: usize,
    bytes: []const u8,
    path: []const u8,
    completion_marker: []const u8,
    session: []const u8,
    parent: []const u8,
    title: []const u8,
    title_source: hook_server.TitleSource,
    final_text: []const u8,
};

test "versioned provider-owned fixtures exercise identity title parent completion and publication" {
    const cases = [_]ProviderFixtureCase{
        .{ .adapter_index = 0, .bytes = @embedFile("test-fixtures/session-reconcile/v1/claude.jsonl"), .path = "C:/fixture/projects/project/claude-primary.jsonl", .completion_marker = "{\"type\":\"assistant\"", .session = "claude-primary", .parent = "", .title = "Review the rounded bubble controls", .title_source = .prompt, .final_text = "Claude review complete" },
        .{ .adapter_index = 2, .bytes = @embedFile("test-fixtures/session-reconcile/v1/gemini.jsonl"), .path = "C:/fixture/chats/gemini-parent/gemini-child.jsonl", .completion_marker = "{\"id\":\"gemini-model-1\"", .session = "gemini-child", .parent = "gemini-parent", .title = "Gemini authoritative title", .title_source = .server, .final_text = "Gemini research complete" },
        .{ .adapter_index = 7, .bytes = @embedFile("test-fixtures/session-reconcile/v1/omp.jsonl"), .path = "C:/fixture/sessions/omp-child.jsonl", .completion_marker = "{\"type\":\"message\",\"id\":\"omp-assistant-1\"", .session = "omp-child", .parent = "omp-parent", .title = "OMP authoritative title", .title_source = .server, .final_text = "OMP review complete" },
    };
    for (cases) |case| {
        const adapter = adapters[case.adapter_index];
        const fixture_line_end = std.mem.indexOfScalar(u8, case.bytes, '\n') orelse return error.MissingFixtureMetadata;
        const fixture_root = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, case.bytes[0..fixture_line_end], .{});
        defer fixture_root.deinit();
        const fixture = fixture_root.value.object.get("_fixture") orelse return error.MissingFixtureMetadata;
        try std.testing.expectEqualStrings(adapter.agent, objectString(fixture, "provider") orelse "");
        try std.testing.expect(objectBool(fixture, "sanitized") orelse false);
        const fixture_source = objectString(fixture, "source") orelse return error.MissingFixtureMetadata;
        try std.testing.expect(std.mem.startsWith(u8, fixture_source, "provider-owned"));
        try std.testing.expect(objectValue(fixture, "version") != null);
        const checkpoint = std.mem.indexOf(u8, case.bytes, case.completion_marker) orelse return error.MissingFixtureCheckpoint;
        const running = parseProviderBytes(std.testing.allocator, adapter.schema, case.path, case.bytes[0..checkpoint], case.bytes[0..checkpoint]).?;
        try std.testing.expectEqual(Status.running, running.status);
        try std.testing.expectEqualStrings(case.session, running.sessionSlice());
        try std.testing.expectEqualStrings(case.parent, running.parentSlice());
        try std.testing.expectEqualStrings(case.title, running.title.slice());
        try std.testing.expectEqual(case.title_source, running.title_source);

        const completed = parseProviderBytes(std.testing.allocator, adapter.schema, case.path, case.bytes, case.bytes).?;
        try std.testing.expectEqual(Status.completed, completed.status);
        try std.testing.expectEqual(case.parent.len > 0, completed.subagent);
        try std.testing.expectEqualStrings(case.final_text, completed.text.slice());
        const update = providerBubbleUpdate(adapter, &completed);
        try std.testing.expectEqualStrings(if (case.parent.len > 0) case.parent else case.session, update.conversation_key);
        try std.testing.expectEqualStrings(case.session, update.source_session);
        try std.testing.expectEqual(if (case.parent.len > 0) hook_server.SessionKind.subagent else hook_server.SessionKind.primary, update.session_kind);
        try std.testing.expectEqual(hook_server.SessionStatus.completed, update.status.?);
        try std.testing.expectEqual(hook_server.FeedSource.native_store, update.feed_source);
    }
}

test "provider contracts reject another provider identity vocabulary" {
    const foreign = "{\"event\":\"task_started\",\"session_id\":\"must-not-cross\"}";
    try std.testing.expect(parseProviderBytes(std.testing.allocator, .claude, "C:/fixture/unknown.jsonl", foreign, foreign) == null);
    try std.testing.expect(parseProviderBytes(std.testing.allocator, .opencode, "C:/fixture/session.json", foreign, foreign) == null);
}

test "Hermes versioned row fixture lowers through SQLite row adapter and publication" {
    const waiting_parsed = try std.json.parseFromSlice(HermesRow, std.testing.allocator, @embedFile("test-fixtures/session-reconcile/v1/hermes-waiting.json"), .{ .ignore_unknown_fields = true });
    defer waiting_parsed.deinit();
    const waiting = hermesEventFromRow(waiting_parsed.value);
    try std.testing.expectEqual(Status.needs_input, waiting.status);
    try std.testing.expectEqualStrings("Choose a deployment target", waiting.text.slice());
    try std.testing.expectEqual(@as(usize, 0), waiting.request_id_len);
    try std.testing.expectEqual(@as(usize, 0), waiting.message_id_len);

    var mailbox: hook_server.Mailbox = .{};
    const waiting_update = hermesBubbleUpdate(&waiting);
    try std.testing.expect(!waiting_update.resolves_unkeyed_input);
    _ = mailbox.applyBubbleUpdateWithDerivedAgentState(waiting_update);
    try std.testing.expectEqual(hook_server.SessionStatus.needs_input, mailbox.bubbles[0].status);
    try std.testing.expect(mailbox.bubbles[0].pending_unkeyed_input);
    try std.testing.expectEqual(@as(usize, 0), mailbox.bubbles[0].pending_input_ids_len);

    var resumed_row = waiting_parsed.value;
    resumed_row.activity_ms += 1;
    resumed_row.description = "Planning deployment";
    const resumed = hermesEventFromRow(resumed_row);
    const resumed_update = hermesBubbleUpdate(&resumed);
    try std.testing.expect(resumed_update.resolves_unkeyed_input);
    _ = mailbox.applyBubbleUpdateWithDerivedAgentState(resumed_update);
    try std.testing.expectEqual(hook_server.SessionStatus.running, mailbox.bubbles[0].status);
    try std.testing.expect(!mailbox.bubbles[0].pending_unkeyed_input);
    try std.testing.expectEqualStrings("running", mailbox.bubbles[0].agentStateSlice());

    const parsed = try std.json.parseFromSlice(HermesRow, std.testing.allocator, @embedFile("test-fixtures/session-reconcile/v1/hermes.json"), .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const event = hermesEventFromRow(parsed.value);
    try std.testing.expectEqualStrings("hermes-child", event.sessionSlice());
    try std.testing.expectEqualStrings("hermes-parent", event.parentSlice());
    try std.testing.expectEqualStrings("Hermes authoritative title", event.title.slice());
    try std.testing.expectEqualStrings("Hermes review complete", event.text.slice());
    try std.testing.expect(event.subagent);
    try std.testing.expectEqual(Status.completed, event.status);
    const update = providerBubbleUpdate(adapters[8], &event);
    try std.testing.expectEqualStrings("hermes-parent", update.conversation_key);
    try std.testing.expectEqual(hook_server.SessionKind.subagent, update.session_kind);
    try std.testing.expectEqual(hook_server.FeedSource.native_store, update.feed_source);
}

test "journal replay deduplicates hook overlap and keeps richer hook metadata" {
    const source_cwd = if (builtin.os.tag == .windows) "C:/rich" else "/rich";
    var parent_body_buf: [1024]u8 = undefined;
    const parent_body = try std.fmt.bufPrint(
        &parent_body_buf,
        "{{\"text\":\"Working\",\"busy\":true,\"agent_source\":\"claude-code\",\"session_id\":\"parent\",\"conversation_key\":\"parent\",\"source_session_id\":\"parent\",\"session_kind\":\"primary\",\"source_cwd\":\"{s}\",\"message_id\":\"m1\",\"event_kind\":\"assistant\",\"message_kind\":\"assistant\",\"feed_source\":\"hook\",\"status\":\"running\"}}",
        .{source_cwd},
    );
    const child_body =
        \\{"text":"Nested result","busy":false,"agent_source":"claude-code","session_id":"child","conversation_key":"parent","source_session_id":"child","parent_session_id":"parent","session_kind":"subagent","subagent_label":"Reviewer","message_id":"c1","event_kind":"subagent-stop","message_kind":"assistant","feed_source":"hook","status":"completed"}
    ;
    var hook_mailbox: hook_server.Mailbox = .{};
    const hook_counter = hook_server.applyBubbleJson(&hook_mailbox, parent_body, .hook).?;
    var journal_buf: [4096]u8 = undefined;
    const journal = try std.fmt.bufPrint(
        &journal_buf,
        "{{\"journal_version\":1,\"event\":{s}}}\n{{\"journal_version\":1,\"event\":{s}}}\n",
        .{ parent_body, child_body },
    );
    replayJournalBytes(&hook_mailbox, journal);
    const after_first = hook_mailbox.bubble_counter;
    try std.testing.expect(after_first > hook_counter);
    try std.testing.expectEqual(@as(usize, 1), hook_mailbox.bubbles_len);
    try std.testing.expectEqual(@as(usize, 1), hook_mailbox.bubbles[0].child_messages_len);
    try std.testing.expectEqual(hook_server.FeedSource.hook, hook_mailbox.bubbles[0].feed_source);
    try std.testing.expectEqualStrings(source_cwd, hook_mailbox.bubbles[0].cwdSlice());
    replayJournalBytes(&hook_mailbox, journal);
    try std.testing.expectEqual(after_first, hook_mailbox.bubble_counter);
}

test "journal skips partial invalid UTF-8 corrupt and unsupported records" {
    const unsupported = "{\"journal_version\":2,\"event\":{\"text\":\"bad\",\"agent_source\":\"codex\"}}";
    const partial = "{\"journal_version\":1,\"event\":{\"text\":\"partial\"";
    const invalid = [_]u8{ '{', '"', 'j', 'o', 'u', 'r', 'n', 'a', 'l', '_', 'v', 'e', 'r', 's', 'i', 'o', 'n', '"', ':', '1', ',', '"', 'e', 'v', 'e', 'n', 't', '"', ':', '{', '"', 't', 'e', 'x', 't', '"', ':', '"', 0xff, '"', '}', '}' };
    try std.testing.expect(journalEvent(unsupported) == null);
    try std.testing.expect(journalEvent(partial) == null);
    try std.testing.expect(journalEvent(&invalid) == null);
}

test "pretty printed recorded chat is accepted without JSONL framing" {
    const chat =
        \\{
        \\  "sessionId": "gemini-session",
        \\  "projectHash": "fixture-project",
        \\  "summary": "Recorded chat",
        \\  "messages": [
        \\    {"id":"user-1","type":"user","content":[{"text":"Question"}]},
        \\    {"id":"model-1","type":"gemini","content":[{"text":"Current answer"}]}
        \\  ]
        \\}
    ;
    const event = parseProviderBytes(std.testing.allocator, .gemini, "C:/gemini/chats/session.json", chat, chat).?;
    try std.testing.expectEqualStrings("gemini-session", event.sessionSlice());
    try std.testing.expectEqualStrings("Current answer", event.text.slice());
    try std.testing.expectEqual(Status.completed, event.status);
}
