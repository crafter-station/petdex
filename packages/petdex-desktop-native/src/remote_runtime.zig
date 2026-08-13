//! Remote runtime driver: the per-remote state machine that sequences
//! probe -> quiesce -> tunnel readiness -> fetch-merge-writeback -> token ->
//! watchers, plus reconnect/sync backoff. Pure of SDK types: it returns Actions and main.zig
//! turns them into fx.spawn / fx.startTimer calls, so the whole flow is
//! unit-testable with fixture homes and no effects runtime.
//!
//! One writeback pass runs after every successful tunnel establishment, before
//! the token gate opens. The tunnel runs for the app's lifetime, respawned
//! with backoff when it dies. fs work (staging fetched bytes, running
//! the local installers against the fake home) happens inside the
//! driver via plat, not in main.zig.

const std = @import("std");
const agent_hooks = @import("agent_hooks.zig");
const remote_agents = @import("remote_agents.zig");
const remote_ssh = @import("remote_ssh.zig");
const remote_writeback = @import("remote_writeback.zig");
const plat = @import("plat.zig");

const AgentKind = agent_hooks.AgentKind;

pub const max_remotes = 8;

/// Spawn kinds a slot can have in flight. Key derivation tags the
/// slot's key with these; backoff rides a timer tag instead.
pub const Op = enum { none, probe, quiesce, tunnel, profile, fetch, push, token, watcher };

/// Key space far above the hand-numbered single-digit keys main.zig
/// uses for its own effects. 16 tags per slot leaves room.
pub const key_base: u64 = @as(u64, 1) << 40;

fn opTag(op: Op) u64 {
    return switch (op) {
        .none => 0,
        .probe => 1,
        .fetch => 2,
        .push => 3,
        .token => 4,
        .watcher => 5,
        .tunnel => 6,
        .quiesce => 7,
        .profile => 8,
    };
}

const backoff_tag: u64 = 15;

pub fn keyFor(slot_idx: usize, op: Op) u64 {
    return key_base + @as(u64, slot_idx) * 16 + opTag(op);
}

pub fn backoffKey(slot_idx: usize) u64 {
    return key_base + @as(u64, slot_idx) * 16 + backoff_tag;
}

/// Decode a spawn key back to (slot, op); null for foreign keys.
pub fn slotOpFromKey(key: u64) ?struct { slot: usize, op: Op } {
    if (key < key_base) return null;
    const off = key - key_base;
    const tag = off % 16;
    const slot = off / 16;
    if (slot >= max_remotes) return null;
    inline for ([_]Op{ .probe, .quiesce, .tunnel, .profile, .fetch, .push, .token, .watcher }) |op| {
        if (opTag(op) == tag) return .{ .slot = slot, .op = op };
    }
    return null;
}

pub fn slotFromBackoffKey(key: u64) ?usize {
    if (key < key_base) return null;
    const off = key - key_base;
    if (off % 16 != backoff_tag) return null;
    const slot = off / 16;
    return if (slot < max_remotes) slot else null;
}

/// POD per-remote state, embedded in the Model. Strings are fixed
/// buffers; heap content (fetched bytes, push payloads) lives in the
/// module-level stores below, never in the Model.
pub const Slot = struct {
    active: bool = false,
    name: [remote_agents.max_name_bytes + 1]u8 = @splat(0),
    name_len: usize = 0,
    host: [remote_agents.max_host_bytes]u8 = @splat(0),
    host_len: usize = 0,
    port: u16 = 22,
    identity: [remote_agents.max_identity_bytes]u8 = @splat(0),
    identity_len: usize = 0,
    kinds: [3]AgentKind = undefined,
    kind_count: usize = 0,
    op: Op = .none,
    /// Reverse forward passed its remote `/health` probe. This is separate
    /// from `op`: the tunnel remains alive while short sync SSH jobs run.
    tunnel_ready: bool = false,
    /// Hooks were patched, the fresh token was installed, and reconcilers
    /// started for this exact tunnel establishment.
    sync_complete: bool = false,
    probe_failed: bool = false,
    wb_failed: bool = false,
    kind_idx: usize = 0,
    file_idx: usize = 0,
    output_idx: usize = 0,
    chunk_idx: usize = 0,
    backoff_ms: u32 = 0,
    /// Named Hermes profile discovered from `~/.hermes/active_profile`.
    /// Empty means the default Hermes home remains authoritative.
    hermes_profile: [64]u8 = @splat(0),
    hermes_profile_len: usize = 0,
    /// Remote Hermes data root. Empty means ~/.hermes.
    hermes_home: [remote_agents.max_agent_home_bytes]u8 = @splat(0),
    hermes_home_len: usize = 0,
    /// Dynamic remote fetch path. Action slices must remain valid until the
    /// effect is spawned, so this lives in the slot rather than a stack frame.
    remote_path: [512]u8 = @splat(0),

    pub fn nameSlice(self: *const Slot) []const u8 {
        return self.name[0..self.name_len];
    }

    pub fn hermesProfileSlice(self: *const Slot) []const u8 {
        return self.hermes_profile[0..self.hermes_profile_len];
    }

    pub fn hermesHomeSlice(self: *const Slot) []const u8 {
        return if (self.hermes_home_len > 0)
            self.hermes_home[0..self.hermes_home_len]
        else
            remote_agents.default_hermes_home;
    }
};

/// Heap stores indexed by slot, kept out of the Model: the collected
/// push outputs for the agent currently being written back, and the
/// token stdin bytes (the exit Msg's slices die with the update call,
/// so anything a later spawn needs must live here).
var outputs: [max_remotes]?[]remote_writeback.Output = .{null} ** max_remotes;
const max_token_len = 128;
var token_bufs: [max_remotes][max_token_len + 1]u8 = undefined;
var token_lens: [max_remotes]usize = .{0} ** max_remotes;

/// One resettable arena per remote. Its current output survives until the
/// final push effect completes; the next agent/pass then reclaims it in one
/// operation instead of growing for the lifetime of the app.
var wb_arenas: [max_remotes]std.heap.ArenaAllocator = undefined;
var wb_arena_live: [max_remotes]bool = .{false} ** max_remotes;

fn releaseWriteback(slot_idx: usize) void {
    outputs[slot_idx] = null;
    if (wb_arena_live[slot_idx]) {
        wb_arenas[slot_idx].deinit();
        wb_arena_live[slot_idx] = false;
    }
}

fn freshWritebackAllocator(slot_idx: usize) std.mem.Allocator {
    releaseWriteback(slot_idx);
    wb_arenas[slot_idx] = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    wb_arena_live[slot_idx] = true;
    return wb_arenas[slot_idx].allocator();
}

pub fn deinitWritebacks() void {
    for (0..max_remotes) |i| releaseWriteback(i);
}

/// What main.zig should do next for a slot. Slices in .spawn point at
/// static tables or the slot's heap store, both of which outlive the
/// update call.
pub const Action = union(enum) {
    none,
    spawn: Spawn,
    backoff: u32,
};

pub const Spawn = struct {
    op: Op,
    /// Remote path for .fetch (cat) and .push (write); "" otherwise.
    path: []const u8 = "",
    stdin: []const u8 = "",
    first_chunk: bool = false,
    last_chunk: bool = false,
    executable: bool = false,
    watch_codex: bool = false,
    watch_hermes: bool = false,
};

/// Fill slots from a loaded config, skipping invalid remotes (logged,
/// not fatal. One bad entry must not cost the rest). Returns how many
/// slots went active.
pub fn fillFromConfig(slots: *[max_remotes]Slot, cfg: *const remote_agents.Config) usize {
    var n: usize = 0;
    for (cfg.remotes) |*r| {
        if (!r.enabled) continue;
        if (n >= max_remotes) {
            std.debug.print("petdex: more than {d} remotes configured; ignoring the rest\n", .{max_remotes});
            break;
        }
        if (remote_agents.validateRemote(r)) |why| {
            std.debug.print("petdex: remote '{s}' skipped: {s}\n", .{ r.name, why });
            continue;
        }
        var duplicate = false;
        for (slots[0..n]) |*existing| {
            if (std.ascii.eqlIgnoreCase(existing.nameSlice(), r.name)) {
                duplicate = true;
                break;
            }
        }
        if (duplicate) {
            std.debug.print("petdex: remote '{s}' skipped: names must be unique (case-insensitive)\n", .{r.name});
            continue;
        }
        var slot = &slots[n];
        slot.* = .{};
        @memcpy(slot.name[0..r.name.len], r.name);
        slot.name_len = r.name.len;
        @memcpy(slot.host[0..r.host.len], r.host);
        slot.host_len = r.host.len;
        slot.port = r.port;
        if (r.identity_file) |identity| {
            @memcpy(slot.identity[0..identity.len], identity);
            slot.identity_len = identity.len;
        }
        if (r.agents.hermes.home) |hermes_home| {
            @memcpy(slot.hermes_home[0..hermes_home.len], hermes_home);
            slot.hermes_home_len = hermes_home.len;
        }
        var kinds: [3]AgentKind = undefined;
        slot.kind_count = remote_agents.enabledAgents(r, &kinds);
        @memcpy(slot.kinds[0..slot.kind_count], kinds[0..slot.kind_count]);
        slot.active = true;
        n += 1;
    }
    return n;
}

/// Rebuild the config-shaped Remote a slot carries, for the argv
/// builders. Identity slice points into the slot and is valid for the call.
pub fn remoteFor(slot: *const Slot) remote_agents.Remote {
    return .{
        .name = slot.nameSlice(),
        .host = slot.host[0..slot.host_len],
        .port = slot.port,
        .identity_file = if (slot.identity_len > 0) slot.identity[0..slot.identity_len] else null,
        .agents = .{ .hermes = .{ .home = slot.hermesHomeSlice() } },
    };
}

/// The fake home one remote's writeback stages into.
pub fn fakeHome(buf: []u8, home: []const u8, slot_idx: usize, slot: *const Slot) ?[]const u8 {
    const host_hash = std.hash.Wyhash.hash(0, slot.host[0..slot.host_len]);
    return std.fmt.bufPrint(buf, "{s}/.petdex/runtime/remote-wb/{d}-{s}-{x}", .{ home, slot_idx, slot.nameSlice(), host_hash }) catch null;
}

fn cleanupAttempt(slot_idx: usize, slot: *const Slot, home: []const u8) void {
    releaseWriteback(slot_idx);
    var home_buf: [512]u8 = undefined;
    if (fakeHome(&home_buf, home, slot_idx, slot)) |fake| remote_writeback.cleanupStaging(fake);
}

/// Boot action for a slot: probe first.
pub fn startAction(slot: *Slot) Action {
    slot.tunnel_ready = false;
    slot.sync_complete = false;
    slot.probe_failed = false;
    slot.wb_failed = false;
    slot.backoff_ms = 0;
    return probeAction(slot);
}

fn probeAction(slot: *Slot) Action {
    slot.op = .probe;
    return .{ .spawn = .{ .op = .probe } };
}

fn quiesceAction(slot: *Slot) Action {
    slot.op = .quiesce;
    slot.tunnel_ready = false;
    slot.sync_complete = false;
    return .{ .spawn = .{ .op = .quiesce } };
}

fn profileAction(slot: *Slot) Action {
    slot.op = .profile;
    return .{ .spawn = .{ .op = .profile } };
}

fn fetchAction(slot: *Slot) Action {
    const files = remote_writeback.filesOf(slot.kinds[slot.kind_idx]);
    const path = remote_writeback.remotePath(
        &slot.remote_path,
        slot.kinds[slot.kind_idx],
        files[slot.file_idx],
        slot.hermesProfileSlice(),
        slot.hermesHomeSlice(),
    ) orelse return .none;
    slot.op = .fetch;
    return .{ .spawn = .{ .op = .fetch, .path = path } };
}

fn tokenAction(slot: *Slot, slot_idx: usize, home: []const u8) Action {
    var path_buf: [512]u8 = undefined;
    const token_path = std.fmt.bufPrint(&path_buf, "{s}/.petdex/runtime/update-token", .{home}) catch return retry(slot, true);
    const bytes = plat.readFile(token_path, &token_bufs[slot_idx]) orelse return retry(slot, true);
    if (bytes.len > max_token_len) return retry(slot, true);
    const trimmed = std.mem.trim(u8, bytes, " \t\r\n");
    token_lens[slot_idx] = trimmed.len;
    if (trimmed.len == 0) return retry(slot, true);
    slot.op = .token;
    return .{ .spawn = .{ .op = .token, .path = remote_ssh.remote_token_file, .stdin = token_bufs[slot_idx][0..token_lens[slot_idx]] } };
}

fn tunnelAction(slot: *Slot) Action {
    slot.op = .tunnel;
    slot.tunnel_ready = false;
    slot.sync_complete = false;
    return .{ .spawn = .{ .op = .tunnel } };
}

fn hasKind(slot: *const Slot, wanted: AgentKind) bool {
    for (slot.kinds[0..slot.kind_count]) |kind| {
        if (kind == wanted) return true;
    }
    return false;
}

fn finishSync(slot: *Slot) Action {
    slot.op = .none;
    slot.sync_complete = true;
    slot.wb_failed = false;
    slot.backoff_ms = 0;
    return .none;
}

fn watcherOrToken(slot: *Slot, slot_idx: usize, home: []const u8) Action {
    const watch_codex = hasKind(slot, .codex);
    const watch_hermes = hasKind(slot, .hermes);
    if (watch_codex or watch_hermes) {
        slot.op = .watcher;
        return .{ .spawn = .{
            .op = .watcher,
            .watch_codex = watch_codex,
            .watch_hermes = watch_hermes,
        } };
    }
    return tokenAction(slot, slot_idx, home);
}

/// Advance after the current agent's last fetch staged: run the local
/// installer against the fake home and start pushing outputs. Any local
/// preparation failure keeps the remote feed gate closed and retries.
fn beginPushOrNextKind(slot: *Slot, slot_idx: usize, home: []const u8) Action {
    var home_buf: [512]u8 = undefined;
    const fake = fakeHome(&home_buf, home, slot_idx, slot) orelse return retry(slot, true);
    const allocator = freshWritebackAllocator(slot_idx);
    if (!remote_writeback.runInstaller(allocator, slot.kinds[slot.kind_idx], fake)) {
        std.debug.print("petdex: remote '{s}': writeback install failed for {s}\n", .{ slot.nameSlice(), slot.kinds[slot.kind_idx].hookAgentName() });
        remote_writeback.cleanupStaging(fake);
        releaseWriteback(slot_idx);
        return retry(slot, true);
    }
    outputs[slot_idx] = remote_writeback.collectOutputs(
        allocator,
        slot.kinds[slot.kind_idx],
        fake,
        slot.hermesProfileSlice(),
        slot.hermesHomeSlice(),
    );
    remote_writeback.cleanupStaging(fake);
    if (outputs[slot_idx] == null) {
        releaseWriteback(slot_idx);
        return retry(slot, true);
    }
    slot.output_idx = 0;
    slot.chunk_idx = 0;
    return pushAction(slot, slot_idx);
}

fn pushAction(slot: *Slot, slot_idx: usize) Action {
    const outs = outputs[slot_idx].?;
    const out = outs[slot.output_idx];
    const start = slot.chunk_idx * remote_ssh.stdin_chunk;
    const end = @min(start + remote_ssh.stdin_chunk, out.bytes.len);
    slot.op = .push;
    return .{ .spawn = .{
        .op = .push,
        .path = out.remote,
        .stdin = out.bytes[start..end],
        .first_chunk = slot.chunk_idx == 0,
        .last_chunk = end == out.bytes.len,
        .executable = out.executable,
    } };
}

fn nextKind(slot: *Slot, slot_idx: usize, home: []const u8) Action {
    releaseWriteback(slot_idx);
    slot.kind_idx += 1;
    slot.file_idx = 0;
    slot.output_idx = 0;
    slot.chunk_idx = 0;
    if (slot.kind_idx < slot.kind_count) {
        const action = fetchAction(slot);
        return if (action == .none) retry(slot, true) else action;
    }
    // Reconciler startup is part of the gated installation. It is safe for
    // watchers to run before the token exists (posts simply retry), whereas
    // publishing the token first would briefly expose a half-started feed.
    return watcherOrToken(slot, slot_idx, home);
}

fn nextRetryDelay(slot: *Slot) u32 {
    if (slot.backoff_ms == 0) {
        slot.backoff_ms = 5000;
    } else {
        slot.backoff_ms = @min(slot.backoff_ms * 3, 60000);
    }
    return slot.backoff_ms;
}

fn retry(slot: *Slot, sync_failed: bool) Action {
    slot.op = .none;
    slot.sync_complete = false;
    if (sync_failed) slot.wb_failed = true;
    return .{ .backoff = nextRetryDelay(slot) };
}

/// Drive one slot past a finished spawn. `output` is the collected
/// stdout (valid only during this call; staging copies it to disk
/// before returning).
pub fn onSpawnExit(slot: *Slot, slot_idx: usize, op: Op, code: i32, output: []const u8, home: []const u8) Action {
    return onSpawnExitDetailed(slot, slot_idx, op, code, output, false, home);
}

pub fn onSpawnExitDetailed(slot: *Slot, slot_idx: usize, op: Op, code: i32, output: []const u8, output_truncated: bool, home: []const u8) Action {
    // Tunnel teardown can race a short sync SSH process. The teardown resets
    // `slot.op`; ignore that stale completion so it cannot reopen the token
    // gate during a later reconnect cycle.
    if (op != .tunnel and slot.op != op) return .none;
    if (output_truncated and op != .tunnel) {
        std.debug.print("petdex: remote '{s}': {s} output exceeded the collection limit; feed remains gated\n", .{ slot.nameSlice(), @tagName(op) });
        cleanupAttempt(slot_idx, slot, home);
        return retry(slot, op != .probe and op != .quiesce);
    }
    switch (op) {
        .probe => {
            if (code != 0) {
                slot.probe_failed = true;
                std.debug.print("petdex: remote '{s}': probe failed (ssh exit {d}); retrying before tunnel\n", .{ slot.nameSlice(), code });
                return retry(slot, false);
            }
            slot.probe_failed = false;
            setHermesProfile(slot, output);
            return quiesceAction(slot);
        },
        .quiesce => {
            if (code != 0) {
                slot.probe_failed = true;
                std.debug.print("petdex: remote '{s}': feed gate failed (ssh exit {d}); tunnel withheld\n", .{ slot.nameSlice(), code });
                return retry(slot, false);
            }
            slot.probe_failed = false;
            return tunnelAction(slot);
        },
        .profile => {
            if (code != 0) {
                std.debug.print("petdex: remote '{s}': post-tunnel profile check failed (ssh exit {d}); feed remains gated\n", .{ slot.nameSlice(), code });
                return retry(slot, true);
            }
            setHermesProfile(slot, output);
            slot.kind_idx = 0;
            slot.file_idx = 0;
            slot.output_idx = 0;
            slot.chunk_idx = 0;
            var home_buf: [512]u8 = undefined;
            const fake = fakeHome(&home_buf, home, slot_idx, slot) orelse return retry(slot, true);
            releaseWriteback(slot_idx);
            if (!remote_writeback.prepareStaging(fake)) {
                std.debug.print("petdex: remote '{s}': could not prepare private writeback staging\n", .{slot.nameSlice()});
                return retry(slot, true);
            }
            if (slot.kind_count == 0) return tokenAction(slot, slot_idx, home);
            const action = fetchAction(slot);
            return if (action == .none) retry(slot, true) else action;
        },
        .fetch => {
            // readArgv reserves one explicit status for a verified missing
            // path. Permission, I/O, and shell failures must never be treated
            // as a fresh install because doing so would clobber user config.
            if (code != 0 and code != remote_ssh.missing_file_exit_code) {
                std.debug.print("petdex: remote '{s}': hook check failed (ssh exit {d}); feed remains gated\n", .{ slot.nameSlice(), code });
                cleanupAttempt(slot_idx, slot, home);
                return retry(slot, true);
            }
            const files = remote_writeback.filesOf(slot.kinds[slot.kind_idx]);
            const rel = files[slot.file_idx];
            var home_buf: [512]u8 = undefined;
            const fake = fakeHome(&home_buf, home, slot_idx, slot) orelse return retry(slot, true);
            if (code == 0) {
                if (!remote_writeback.stageFetched(fake, rel, output)) {
                    std.debug.print("petdex: remote '{s}': could not stage fetched {s}; feed remains gated\n", .{ slot.nameSlice(), rel });
                    cleanupAttempt(slot_idx, slot, home);
                    return retry(slot, true);
                }
            } else {
                // No remote file: a fresh install. Remove any staged
                // copy from a previous run so it cannot merge stale.
                var stale_buf: [512]u8 = undefined;
                if (std.fmt.bufPrint(&stale_buf, "{s}/{s}", .{ fake, rel })) |stale| {
                    plat.deleteFile(stale);
                } else |_| {}
            }
            slot.file_idx += 1;
            if (slot.file_idx < files.len) {
                const action = fetchAction(slot);
                return if (action == .none) retry(slot, true) else action;
            }
            return beginPushOrNextKind(slot, slot_idx, home);
        },
        .push => {
            if (code != 0) {
                std.debug.print("petdex: remote '{s}': auto-patch failed (ssh exit {d}); feed remains gated\n", .{ slot.nameSlice(), code });
                releaseWriteback(slot_idx);
                return retry(slot, true);
            }
            const outs = outputs[slot_idx].?;
            const out = outs[slot.output_idx];
            const chunks = remote_ssh.chunkCount(out.bytes.len);
            slot.chunk_idx += 1;
            if (slot.chunk_idx < chunks) return pushAction(slot, slot_idx);
            slot.output_idx += 1;
            slot.chunk_idx = 0;
            if (slot.output_idx < outs.len) return pushAction(slot, slot_idx);
            return nextKind(slot, slot_idx, home);
        },
        .token => {
            if (code != 0) {
                std.debug.print("petdex: remote '{s}': token gate open failed (ssh exit {d}); retrying\n", .{ slot.nameSlice(), code });
                return retry(slot, true);
            }
            return finishSync(slot);
        },
        .watcher => {
            if (code != 0) {
                std.debug.print("petdex: remote '{s}': watcher startup failed (ssh exit {d})\n", .{ slot.nameSlice(), code });
                return retry(slot, true);
            }
            return tokenAction(slot, slot_idx, home);
        },
        .tunnel => {
            // Any tunnel exit is a reconnect: ssh only exits when the
            // connection dropped (ExitOnForwardFailure makes a taken
            // port a fast exit too).
            slot.op = .none;
            slot.tunnel_ready = false;
            slot.sync_complete = false;
            cleanupAttempt(slot_idx, slot, home);
            return .{ .backoff = nextRetryDelay(slot) };
        },
        .none => return .none,
    }
}

/// First readiness marker for a newly established long-lived tunnel starts
/// the authoritative post-tunnel check/patch pass. Duplicate/noisy stdout is
/// ignored and cannot restart sync.
pub fn onSpawnLine(slot: *Slot, op: Op, line: []const u8) Action {
    if (op != .tunnel or slot.op != .tunnel or slot.tunnel_ready) return .none;
    if (!std.mem.eql(u8, std.mem.trim(u8, line, " \t\r\n"), remote_ssh.tunnel_ready_marker)) return .none;
    slot.tunnel_ready = true;
    slot.sync_complete = false;
    slot.wb_failed = false;
    slot.backoff_ms = 0;
    return profileAction(slot);
}

fn isProfileName(value: []const u8) bool {
    if (value.len == 0 or value.len > 64) return false;
    if (!std.ascii.isAlphanumeric(value[0])) return false;
    for (value[1..]) |c| {
        if (!std.ascii.isAlphanumeric(c) and c != '-' and c != '_') return false;
    }
    return true;
}

/// Probe output is remote-controlled input, so accept only Hermes' documented
/// profile-id alphabet before it becomes part of a later remote path. Invalid
/// or `default` content deliberately falls back to the normal Hermes home.
fn setHermesProfile(slot: *Slot, output: []const u8) void {
    slot.hermes_profile_len = 0;
    const marker = "petdex-hermes-profile=";
    var lines = std.mem.splitScalar(u8, output, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, marker)) continue;
        const candidate = std.mem.trim(u8, line[marker.len..], " \t\r\n");
        if (std.mem.eql(u8, candidate, "default") or !isProfileName(candidate)) return;
        @memcpy(slot.hermes_profile[0..candidate.len], candidate);
        slot.hermes_profile_len = candidate.len;
        return;
    }
}

/// Backoff timer fired. A live, gated tunnel retries its verification/patch
/// pass. A dead tunnel must pass probe + quiesce again before reconnecting.
pub fn onBackoff(slot: *Slot, slot_idx: usize, home: []const u8) Action {
    _ = slot_idx;
    _ = home;
    if (slot.tunnel_ready) return profileAction(slot);
    return probeAction(slot);
}

/// One-line status for the Settings row. Failures win over progress:
/// a tunnel that is up while the sync failed must not read as
/// "Connected". A completed sync has already cleared wb_failed.
pub fn statusCaption(slot: *const Slot) []const u8 {
    if (slot.tunnel_ready and slot.sync_complete) {
        return "Connected";
    }
    return switch (slot.op) {
        .probe => "Connecting…",
        .quiesce => "Securing remote feed…",
        .tunnel => "Opening secure tunnel…",
        .profile, .fetch, .push => "Checking and patching hooks…",
        .token => "Enabling remote feed…",
        .watcher => "Starting remote feeds…",
        .none => if (slot.tunnel_ready)
            (if (slot.wb_failed) "Tunnel up; patch retrying…" else "Tunnel up; setup retrying…")
        else if (slot.backoff_ms > 0)
            "Reconnecting…"
        else
            "Idle",
    };
}

// -------------------------------------------------------------- tests

const t = std.testing;

fn testSlot() Slot {
    var slot: Slot = .{};
    @memcpy(slot.name[0..5], "rogue");
    slot.name_len = 5;
    @memcpy(slot.host[0..8], "10.0.0.5");
    slot.host_len = 8;
    slot.kinds[0] = .opencode;
    slot.kinds[1] = .codex;
    slot.kind_count = 2;
    slot.active = true;
    return slot;
}

test "statusCaption puts failures ahead of progress" {
    var slot = testSlot();
    slot.op = .probe;
    try t.expectEqualStrings("Connecting…", statusCaption(&slot));
    slot.op = .fetch;
    try t.expectEqualStrings("Checking and patching hooks…", statusCaption(&slot));
    slot.op = .watcher;
    try t.expectEqualStrings("Starting remote feeds…", statusCaption(&slot));
    slot.op = .none;
    slot.tunnel_ready = true;
    slot.sync_complete = true;
    try t.expectEqualStrings("Connected", statusCaption(&slot));
    slot.wb_failed = true;
    try t.expectEqualStrings("Connected", statusCaption(&slot));
    slot.tunnel_ready = false;
    slot.sync_complete = false;
    slot.op = .none;
    try t.expectEqualStrings("Idle", statusCaption(&slot));
    slot.backoff_ms = 5000;
    try t.expectEqualStrings("Reconnecting…", statusCaption(&slot));
}

test "named Hermes profile routes writeback to the live profile" {
    var slot: Slot = .{};
    slot.active = true;
    slot.kinds[0] = .hermes;
    slot.kind_count = 1;

    slot.op = .profile;
    slot.tunnel_ready = true;
    const action = onSpawnExit(&slot, 0, .profile, 0, "petdex-hermes-profile=snoop\n", ".zig-cache/petdex-remote-profile");
    switch (action) {
        .spawn => |spec| {
            try t.expectEqual(Op.fetch, spec.op);
            try t.expectEqualStrings("~/.hermes/profiles/snoop/config.yaml", spec.path);
        },
        else => try t.expect(false),
    }
}

test "custom Hermes home routes profile probes and writeback" {
    var slot: Slot = .{};
    slot.active = true;
    slot.kinds[0] = .hermes;
    slot.kind_count = 1;
    const custom = "/srv/hermes data";
    @memcpy(slot.hermes_home[0..custom.len], custom);
    slot.hermes_home_len = custom.len;
    slot.op = .profile;
    slot.tunnel_ready = true;
    const action = onSpawnExit(&slot, 0, .profile, 0, "petdex-hermes-profile=snoop\n", ".zig-cache/petdex-remote-custom-profile");
    switch (action) {
        .spawn => |spec| try t.expectEqualStrings("/srv/hermes data/profiles/snoop/config.yaml", spec.path),
        else => try t.expect(false),
    }
    const rebuilt = remoteFor(&slot);
    try t.expectEqualStrings(custom, rebuilt.agents.hermes.home.?);
}

test "Hermes remote starts its metadata reconciler" {
    var slot: Slot = .{};
    slot.kinds[0] = .hermes;
    slot.kind_count = 1;
    const action = watcherOrToken(&slot, 0, ".");
    switch (action) {
        .spawn => |spec| {
            try t.expectEqual(Op.watcher, spec.op);
            try t.expect(!spec.watch_codex);
            try t.expect(spec.watch_hermes);
        },
        else => try t.expect(false),
    }
}

test "invalid remote profile output falls back to the default Hermes home" {
    var slot: Slot = .{};
    setHermesProfile(&slot, "petdex-hermes-profile=../../other\n");
    try t.expectEqual(@as(usize, 0), slot.hermes_profile_len);
    setHermesProfile(&slot, "petdex-hermes-profile=default\n");
    try t.expectEqual(@as(usize, 0), slot.hermes_profile_len);
}

test "key derivation round-trips and rejects foreign keys" {
    const key = keyFor(3, .push);
    const decoded = slotOpFromKey(key).?;
    try t.expectEqual(@as(usize, 3), decoded.slot);
    try t.expectEqual(Op.push, decoded.op);
    try t.expect(slotOpFromKey(42) == null);
    try t.expectEqual(@as(usize, 2), slotFromBackoffKey(backoffKey(2)).?);
    try t.expect(slotFromBackoffKey(keyFor(2, .tunnel)) == null);
}

test "fillFromConfig copies valid remotes and skips the rest" {
    var arena = std.heap.ArenaAllocator.init(t.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var remotes = std.array_list.Managed(remote_agents.Remote).init(a);
    var good: remote_agents.Remote = .{ .name = "rogue", .host = "h", .port = 2222 };
    good.agents.codex.enabled = true;
    remotes.append(good) catch unreachable;
    var bad: remote_agents.Remote = .{ .name = "has space", .host = "h" };
    bad.agents.codex.enabled = true;
    remotes.append(bad) catch unreachable;
    var off: remote_agents.Remote = .{ .name = "off", .host = "h", .enabled = false };
    off.agents.codex.enabled = true;
    remotes.append(off) catch unreachable;
    const cfg: remote_agents.Config = .{ .remotes = remotes.items };

    var slots: [max_remotes]Slot = .{ .{}, .{}, .{}, .{}, .{}, .{}, .{}, .{} };
    try t.expectEqual(@as(usize, 1), fillFromConfig(&slots, &cfg));
    try t.expectEqualStrings("rogue", slots[0].nameSlice());
    try t.expectEqual(@as(u16, 2222), slots[0].port);
    try t.expectEqual(@as(usize, 1), slots[0].kind_count);
    try t.expectEqual(AgentKind.codex, slots[0].kinds[0]);

    var duplicate_remotes = [_]remote_agents.Remote{
        .{ .name = "Rogue", .host = "one", .agents = .{ .codex = .{ .enabled = true } } },
        .{ .name = "rogue", .host = "two", .agents = .{ .codex = .{ .enabled = true } } },
    };
    var duplicate_cfg = remote_agents.Config{ .remotes = &duplicate_remotes };
    var duplicate_slots: [max_remotes]Slot = .{ .{}, .{}, .{}, .{}, .{}, .{}, .{}, .{} };
    try t.expectEqual(@as(usize, 1), fillFromConfig(&duplicate_slots, &duplicate_cfg));
}

test "fake staging identity includes slot and host" {
    var first = testSlot();
    var second = testSlot();
    @memcpy(second.host[0..8], "10.0.0.6");
    var a: [512]u8 = undefined;
    var b: [512]u8 = undefined;
    const path_a = fakeHome(&a, "/tmp/home", 0, &first).?;
    const path_b = fakeHome(&b, "/tmp/home", 1, &second).?;
    try t.expect(!std.mem.eql(u8, path_a, path_b));
}

test "driver gates feed until tunnel-ready patch pass completes" {
    const home = ".zig-cache/petdex-rt-home";
    plat.makeDir(home);
    plat.makeDir(home ++ "/.petdex/runtime");
    var tb: [512]u8 = undefined;
    const token_path = std.fmt.bufPrint(&tb, "{s}/.petdex/runtime/update-token", .{home}) catch unreachable;
    try t.expect(plat.writeFile(token_path, "tok-abc\n"));

    var slot = testSlot();
    const idx = 0;

    // Probe failure never starts a tunnel or opens the token gate.
    var probe_failed_slot = testSlot();
    _ = startAction(&probe_failed_slot);
    var act = onSpawnExit(&probe_failed_slot, idx, .probe, 255, "", home);
    try t.expect(act == .backoff and act.backoff == 5000);
    try t.expect(probe_failed_slot.probe_failed);
    try t.expect(!probe_failed_slot.tunnel_ready);

    // Happy path: probe -> gate old senders -> long-lived tunnel. No fetch
    // starts until the tunnel's remote health check publishes readiness.
    _ = startAction(&slot);
    act = onSpawnExit(&slot, idx, .probe, 0, "", home);
    try t.expect(act == .spawn and act.spawn.op == .quiesce);
    act = onSpawnExit(&slot, idx, .quiesce, 0, "", home);
    try t.expect(act == .spawn and act.spawn.op == .tunnel);
    act = onSpawnLine(&slot, .tunnel, "unrelated output");
    try t.expect(act == .none);
    act = onSpawnLine(&slot, .tunnel, remote_ssh.tunnel_ready_marker);
    try t.expect(act == .spawn and act.spawn.op == .profile);
    try t.expect(slot.tunnel_ready);
    try t.expect(!slot.sync_complete);
    act = onSpawnExit(&slot, idx, .profile, 0, "", home);
    try t.expect(act == .spawn and act.spawn.op == .fetch);
    try t.expectEqualStrings("~/.config/opencode/plugins/petdex.js", act.spawn.path);

    // A verified fetch miss stages nothing; opencode's last file moves
    // straight into push (installer runs inside the driver).
    act = onSpawnExit(&slot, idx, .fetch, remote_ssh.missing_file_exit_code, "", home);
    try t.expect(act == .spawn and act.spawn.op == .push);
    try t.expect(act.spawn.first_chunk);

    // Walk however many bounded chunks the generated plugin currently needs;
    // metadata fields may grow it without changing the state-machine contract.
    var plugin_guard: usize = 0;
    while (act == .spawn and act.spawn.op == .push and plugin_guard < 16) {
        act = onSpawnExit(&slot, idx, .push, 0, "", home);
        plugin_guard += 1;
    }
    try t.expect(act == .spawn and act.spawn.op == .fetch);
    try t.expectEqualStrings("~/.codex/hooks.json", act.spawn.path);

    // Codex: two fetches, then pushes (hooks.json, config.toml, hook
    // script), then starts watchers before atomically opening the token gate.
    act = onSpawnExit(&slot, idx, .fetch, remote_ssh.missing_file_exit_code, "", home);
    try t.expect(act == .spawn and act.spawn.op == .fetch);
    try t.expectEqualStrings("~/.codex/config.toml", act.spawn.path);
    act = onSpawnExit(&slot, idx, .fetch, remote_ssh.missing_file_exit_code, "", home);
    try t.expect(act == .spawn and act.spawn.op == .push);

    var guard: usize = 0;
    while (act == .spawn and act.spawn.op == .push and guard < 32) {
        act = onSpawnExit(&slot, idx, .push, 0, "", home);
        guard += 1;
    }
    try t.expect(act == .spawn and act.spawn.op == .watcher);
    act = onSpawnExit(&slot, idx, .watcher, 0, "", home);
    try t.expect(act == .spawn and act.spawn.op == .token);
    try t.expectEqualStrings("tok-abc", act.spawn.stdin);
    act = onSpawnExit(&slot, idx, .token, 0, "", home);
    try t.expect(act == .none);
    try t.expect(slot.tunnel_ready);
    try t.expect(slot.sync_complete);

    // Tunnel death closes runtime state and retries probe/quiesce first. A
    // connection that dies again before readiness increases the backoff.
    act = onSpawnExit(&slot, idx, .tunnel, 255, "", home);
    try t.expect(act == .backoff and act.backoff == 5000);
    act = onBackoff(&slot, idx, home);
    try t.expect(act == .spawn and act.spawn.op == .probe);
    act = onSpawnExit(&slot, idx, .probe, 0, "", home);
    try t.expect(act == .spawn and act.spawn.op == .quiesce);
    act = onSpawnExit(&slot, idx, .quiesce, 0, "", home);
    try t.expect(act == .spawn and act.spawn.op == .tunnel);
    act = onSpawnExit(&slot, idx, .tunnel, 255, "", home);
    try t.expect(act == .backoff and act.backoff == 15000);
    slot.backoff_ms = 30000;
    act = onSpawnExit(&slot, idx, .tunnel, 255, "", home);
    try t.expect(act == .backoff and act.backoff == 60000);
}

test "push failure keeps live tunnel gated and schedules patch retry" {
    const home = ".zig-cache/petdex-rt-home";
    var slot = testSlot();
    const idx = 1;
    _ = startAction(&slot);
    _ = onSpawnExit(&slot, idx, .probe, 0, "", home);
    _ = onSpawnExit(&slot, idx, .quiesce, 0, "", home);
    _ = onSpawnLine(&slot, .tunnel, remote_ssh.tunnel_ready_marker);
    _ = onSpawnExit(&slot, idx, .profile, 0, "", home);
    const act = onSpawnExit(&slot, idx, .fetch, remote_ssh.missing_file_exit_code, "", home);
    try t.expect(act == .spawn and act.spawn.op == .push);
    const after = onSpawnExit(&slot, idx, .push, 255, "", home);
    try t.expect(after == .backoff and after.backoff == 5000);
    try t.expect(slot.wb_failed);
    try t.expect(slot.tunnel_ready);
    try t.expect(!slot.sync_complete);
    try t.expect(slot.op == .none);
}

test "fetch truncation and read errors remain gated" {
    const home = ".zig-cache/petdex-rt-home";
    var slot = testSlot();
    const idx = 2;
    _ = startAction(&slot);
    _ = onSpawnExit(&slot, idx, .probe, 0, "", home);
    _ = onSpawnExit(&slot, idx, .quiesce, 0, "", home);
    _ = onSpawnLine(&slot, .tunnel, remote_ssh.tunnel_ready_marker);
    _ = onSpawnExit(&slot, idx, .profile, 0, "", home);

    var action = onSpawnExitDetailed(&slot, idx, .fetch, 0, "partial", true, home);
    try t.expect(action == .backoff);
    try t.expect(slot.wb_failed);
    try t.expect(!slot.sync_complete);

    action = onBackoff(&slot, idx, home);
    try t.expect(action == .spawn and action.spawn.op == .profile);
    _ = onSpawnExit(&slot, idx, .profile, 0, "", home);
    action = onSpawnExit(&slot, idx, .fetch, 1, "permission denied", home);
    try t.expect(action == .backoff);
    try t.expect(slot.wb_failed);
}

test "watcher startup failure never advances to the token gate" {
    const home = ".zig-cache/petdex-rt-home";
    var slot = testSlot();
    slot.tunnel_ready = true;
    slot.op = .watcher;
    const action = onSpawnExit(&slot, 3, .watcher, 69, "", home);
    try t.expect(action == .backoff);
    try t.expect(slot.wb_failed);
    try t.expect(!slot.sync_complete);
    try t.expect(slot.op == .none);
}

test "missing local update token schedules a gated retry" {
    var slot = testSlot();
    slot.tunnel_ready = true;
    const action = tokenAction(&slot, 4, ".zig-cache/petdex-no-token-home");
    try t.expect(action == .backoff);
    try t.expect(slot.wb_failed);
    try t.expect(!slot.sync_complete);
}

test "oversized local update token remains gated" {
    const home = ".zig-cache/petdex-oversized-token-home";
    plat.makeDir(home ++ "/.petdex/runtime");
    const oversized: [max_token_len + 2]u8 = @splat('a');
    try t.expect(plat.writeFile(home ++ "/.petdex/runtime/update-token", &oversized));
    var slot = testSlot();
    slot.tunnel_ready = true;
    const action = tokenAction(&slot, 5, home);
    try t.expect(action == .backoff);
    try t.expect(slot.wb_failed);
    try t.expect(!slot.sync_complete);
}
