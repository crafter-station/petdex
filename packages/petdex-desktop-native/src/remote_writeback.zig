//! Fetch-merge-writeback staging for remote agents.
//!
//! The desktop cannot run its installers against a remote home, and a
//! blind overwrite would clobber the remote user's existing hooks. The
//! compromise: stage a FAKE HOME in a local temp dir, fetch the files
//! the installer merges (ssh cat, done by the caller via fx.spawn),
//! run the exact local installer against the fake home, then hand back
//! the list of files to push (ssh write spawns, also the caller's).
//! Merge logic stays in agent_hooks.zig, untwinned; this module only
//! knows which files each agent reads and writes.

const std = @import("std");
const agent_hooks = @import("agent_hooks.zig");
const remote_ssh = @import("remote_ssh.zig");
const plat = @import("plat.zig");

const AgentKind = agent_hooks.AgentKind;

/// The remote hook script, embedded like the opencode plugin. Pushed
/// to ~/.petdex/bin/petdex-hook on the remote for every shell-exec
/// agent (codex, hermes); opencode's plugin POSTs directly and never
/// execs it.
pub const hook_script: []const u8 = @embedFile("assets/petdex-remote-hook.sh");
pub const codex_watcher_script: []const u8 = @embedFile("assets/petdex-codex-watch.py");
pub const hermes_watcher_script: []const u8 = @embedFile("assets/petdex-hermes-watch.py");

/// One file to push: `rel` under the fake home, `remote` as the
/// `~/`-relative path on the remote, bytes read back after the
/// installer ran.
pub const Output = struct {
    rel: []const u8,
    remote: []const u8,
    bytes: []u8,
    executable: bool,
};

/// The files each remote-capable agent's installer reads (for merge)
/// and writes (for pushback), as fake-home-relative paths. The remote
/// path is always "~/" ++ rel, which is what keeps this table the
/// single place that mapping can drift.
const opencode_files = [_][]const u8{".config/opencode/plugins/petdex.js"};
const codex_files = [_][]const u8{ ".codex/hooks.json", ".codex/config.toml" };
const hermes_files = [_][]const u8{
    ".hermes/config.yaml",
    ".hermes/shell-hooks-allowlist.json",
    ".hermes/plugins/petdex-desktop/plugin.yaml",
    ".hermes/plugins/petdex-desktop/__init__.py",
};

fn filesFor(kind: AgentKind) ?[]const []const u8 {
    return switch (kind) {
        .opencode => &opencode_files,
        .codex => &codex_files,
        .hermes => &hermes_files,
        else => null,
    };
}

/// Public read view of the per-agent file table: the runtime fetch
/// loop walks these rel paths, one ssh cat each.
pub fn filesOf(kind: AgentKind) []const []const u8 {
    return filesFor(kind) orelse &.{};
}

/// Resolve an installer-relative file to the remote path that owns it.
/// Hermes profiles are isolated `$HERMES_HOME` trees, so a named active
/// profile must receive its own config, consent allowlist, and user plugin.
/// All other agents retain their conventional account-home locations.
pub fn remotePath(
    buf: []u8,
    kind: AgentKind,
    rel: []const u8,
    hermes_profile: []const u8,
    hermes_home: []const u8,
) ?[]const u8 {
    if (kind == .hermes) {
        const prefix = ".hermes/";
        if (!std.mem.startsWith(u8, rel, prefix)) return null;
        if (hermes_profile.len > 0) {
            return std.fmt.bufPrint(buf, "{s}/profiles/{s}/{s}", .{
                hermes_home,
                hermes_profile,
                rel[prefix.len..],
            }) catch null;
        }
        return std.fmt.bufPrint(buf, "{s}/{s}", .{ hermes_home, rel[prefix.len..] }) catch null;
    }
    return std.fmt.bufPrint(buf, "~/{s}", .{rel}) catch null;
}

/// True when this agent's remote config execs the hook binary, so the
/// sh script must be pushed alongside its files.
fn needsHookScript(kind: AgentKind) bool {
    return switch (kind) {
        .codex, .hermes => true,
        else => false,
    };
}

fn needsCodexWatcher(kind: AgentKind) bool {
    return kind == .codex;
}

fn needsHermesWatcher(kind: AgentKind) bool {
    return kind == .hermes;
}

/// Stage one fetched remote file into the fake home. Null bytes mean
/// the remote file does not exist (ssh cat failed), nothing staged,
/// and the installer treats it as a fresh install.
pub fn prepareStaging(fake_home: []const u8) bool {
    if (!plat.deleteTree(fake_home)) return false;
    return plat.makeDirMode(fake_home, 0o700);
}

pub fn cleanupStaging(fake_home: []const u8) void {
    _ = plat.deleteTree(fake_home);
}

pub fn cleanupStagingRoot(home: []const u8) void {
    var root_buf: [512]u8 = undefined;
    const root = std.fmt.bufPrint(&root_buf, "{s}/.petdex/runtime/remote-wb", .{home}) catch return;
    _ = plat.deleteTree(root);
}

pub fn stageFetched(fake_home: []const u8, rel: []const u8, bytes: ?[]const u8) bool {
    const content = bytes orelse return true;
    if (!safeRelativePath(rel)) return false;
    var path_buf: [512]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ fake_home, rel }) catch return false;
    var dir_buf: [512]u8 = undefined;
    const slash = std.mem.lastIndexOfScalar(u8, path, '/') orelse return false;
    const dir = std.fmt.bufPrint(&dir_buf, "{s}", .{path[0..slash]}) catch return false;
    plat.makeDir(dir);
    return plat.writeFileMode(path, content, 0o600);
}

fn safeRelativePath(rel: []const u8) bool {
    if (rel.len == 0 or rel[0] == '/') return false;
    var components = std.mem.splitScalar(u8, rel, '/');
    while (components.next()) |component| {
        if (component.len == 0 or std.mem.eql(u8, component, ".") or std.mem.eql(u8, component, "..")) return false;
    }
    return true;
}

/// Run the agent's own installer against the fake home. The same
/// merge, consent, and validation rules as a local connect. Parent
/// dirs are pre-created for every file the agent touches: locally the
/// agent's own install created them, but a fresh fake home (or a fresh
/// remote) has nothing, and not every installer mkdirs its own root.
pub fn runInstaller(allocator: std.mem.Allocator, kind: AgentKind, fake_home: []const u8) bool {
    for (filesOf(kind)) |rel| {
        var dir_buf: [512]u8 = undefined;
        const slash = std.mem.lastIndexOfScalar(u8, rel, '/') orelse continue;
        const dir = std.fmt.bufPrint(&dir_buf, "{s}/{s}", .{ fake_home, rel[0..slash] }) catch return false;
        plat.makeDir(dir);
    }
    return switch (kind) {
        .opencode => agent_hooks.installOpencode(allocator, fake_home),
        .codex => agent_hooks.installCodex(allocator, fake_home),
        .hermes => blk: {
            var hermes_buf: [512]u8 = undefined;
            const hermes_dir = std.fmt.bufPrint(&hermes_buf, "{s}/.hermes", .{fake_home}) catch break :blk false;
            break :blk agent_hooks.installHermesAt(allocator, hermes_dir);
        },
        else => false,
    };
}

fn stagedOutput(
    allocator: std.mem.Allocator,
    kind: AgentKind,
    fake_home: []const u8,
    rel: []const u8,
    hermes_profile: []const u8,
    hermes_home: []const u8,
) ?Output {
    var path_buf: [512]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ fake_home, rel }) catch return null;
    const bytes = plat.readFileAlloc(allocator, path, 1024 * 1024) orelse return null;
    var remote_buf: [512]u8 = undefined;
    const remote = remotePath(&remote_buf, kind, rel, hermes_profile, hermes_home) orelse return null;
    return .{
        .rel = allocator.dupe(u8, rel) catch return null,
        .remote = allocator.dupe(u8, remote) catch return null,
        .bytes = bytes,
        .executable = false,
    };
}

fn embeddedOutput(
    allocator: std.mem.Allocator,
    rel: []const u8,
    remote: []const u8,
    bytes: []const u8,
) ?Output {
    return .{
        .rel = rel,
        .remote = remote,
        .bytes = allocator.dupe(u8, bytes) catch return null,
        .executable = true,
    };
}

/// Read back everything a push must carry: the agent's files, plus the
/// hook script for shell-exec agents. Null on any read failure. A
/// partial push set would leave the remote half-configured.
///
/// Output order is also activation order. Dependencies are installed first;
/// the agent config that enables them is atomically renamed into place last.
/// That matters even while the feed token is closed: an already-running agent
/// can reload its config in the middle of a reconnect patch pass.
pub fn collectOutputs(
    allocator: std.mem.Allocator,
    kind: AgentKind,
    fake_home: []const u8,
    hermes_profile: []const u8,
    hermes_home: []const u8,
) ?[]Output {
    const files = filesFor(kind) orelse return null;
    const extra: usize = @as(usize, if (needsHookScript(kind)) 1 else 0) +
        @as(usize, if (needsCodexWatcher(kind)) 1 else 0) +
        @as(usize, if (needsHermesWatcher(kind)) 1 else 0);
    var out = allocator.alloc(Output, files.len + extra) catch return null;
    switch (kind) {
        .opencode => {
            out[0] = stagedOutput(allocator, kind, fake_home, opencode_files[0], hermes_profile, hermes_home) orelse return null;
        },
        .codex => {
            out[0] = embeddedOutput(allocator, ".petdex/bin/petdex-hook", remote_ssh.remote_hook_script, hook_script) orelse return null;
            out[1] = embeddedOutput(allocator, ".petdex/bin/petdex-codex-watch", remote_ssh.remote_codex_watcher, codex_watcher_script) orelse return null;
            // hooks.json is inert until config.toml enables hooks, so the
            // feature flag is the final activation write.
            out[2] = stagedOutput(allocator, kind, fake_home, codex_files[0], hermes_profile, hermes_home) orelse return null;
            out[3] = stagedOutput(allocator, kind, fake_home, codex_files[1], hermes_profile, hermes_home) orelse return null;
        },
        .hermes => {
            out[0] = embeddedOutput(allocator, ".petdex/bin/petdex-hook", remote_ssh.remote_hook_script, hook_script) orelse return null;
            out[1] = embeddedOutput(allocator, ".petdex/bin/petdex-hermes-watch", remote_ssh.remote_hermes_watcher, hermes_watcher_script) orelse return null;
            out[2] = stagedOutput(allocator, kind, fake_home, hermes_files[2], hermes_profile, hermes_home) orelse return null;
            out[3] = stagedOutput(allocator, kind, fake_home, hermes_files[3], hermes_profile, hermes_home) orelse return null;
            out[4] = stagedOutput(allocator, kind, fake_home, hermes_files[1], hermes_profile, hermes_home) orelse return null;
            // config.yaml enables both the shell hook and desktop plugin.
            out[5] = stagedOutput(allocator, kind, fake_home, hermes_files[0], hermes_profile, hermes_home) orelse return null;
        },
        else => return null,
    }
    return out;
}

// -------------------------------------------------------------- tests

const t = std.testing;

test "codex writeback merges a fetched remote hooks.json" {
    if (@import("builtin").os.tag == .windows) return;
    const fake = ".zig-cache/petdex-wb-codex";
    plat.makeDir(fake);

    // The remote already has a user hook; fetch staged it.
    try t.expect(stageFetched(fake, ".codex/hooks.json",
        \\{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"my-own"}]}]}}
    ));
    // config.toml absent remotely: stageFetched(null) stages nothing.
    try t.expect(stageFetched(fake, ".codex/config.toml", null));

    try t.expect(runInstaller(t.allocator, .codex, fake));

    var arena = std.heap.ArenaAllocator.init(t.allocator);
    defer arena.deinit();
    const outs = collectOutputs(arena.allocator(), .codex, fake, "", "~/.hermes").?;
    try t.expectEqual(@as(usize, 4), outs.len);
    // Dependencies first, hooks.json next, enabling config.toml last.
    try t.expectEqualStrings(remote_ssh.remote_hook_script, outs[0].remote);
    try t.expect(outs[0].executable);
    try t.expect(std.mem.indexOf(u8, outs[0].bytes, "petdex-update-token") != null);
    try t.expectEqualStrings(remote_ssh.remote_codex_watcher, outs[1].remote);
    try t.expect(outs[1].executable);
    try t.expect(std.mem.indexOf(u8, outs[1].bytes, "request_user_input") != null);
    try t.expect(std.mem.indexOf(u8, outs[1].bytes, "recent_rollouts(catalog)") != null);
    try t.expect(std.mem.indexOf(u8, outs[1].bytes, "title or state[\"fallback_title\"]") != null);
    try t.expect(std.mem.indexOf(u8, outs[1].bytes, "initial_publishable(event, path)") != null);
    try t.expect(std.mem.indexOf(u8, outs[1].bytes, "INITIAL_RUNNING_MAX_AGE_SECONDS") != null);
    try t.expectEqualStrings(".codex/hooks.json", outs[2].rel);
    try t.expectEqualStrings("~/.codex/hooks.json", outs[2].remote);
    try t.expect(std.mem.indexOf(u8, outs[2].bytes, "my-own") != null);
    try t.expect(std.mem.indexOf(u8, outs[2].bytes, "petdex-hook") != null);
    try t.expectEqualStrings(".codex/config.toml", outs[3].rel);
    try t.expect(std.mem.indexOf(u8, outs[3].bytes, "hooks = true") != null);
}

test "remote hook script accepts the shared desktop bubble CLI" {
    try t.expect(std.mem.indexOf(u8, hook_script, "[ \"${1:-}\" = \"bubble\" ]") != null);
    try t.expect(std.mem.indexOf(u8, hook_script, "phase=${2:-}") != null);
    try t.expect(std.mem.indexOf(u8, hook_script, "${3:-}") != null);
}

test "remote watcher initial reconciliation excludes stale unfinished work" {
    try t.expect(std.mem.indexOf(u8, codex_watcher_script, "if event.get(\"status\") == \"needs_input\"") != null);
    try t.expect(std.mem.indexOf(u8, codex_watcher_script, "if event.get(\"status\") != \"running\"") != null);
    try t.expect(std.mem.indexOf(u8, codex_watcher_script, "current - modified) <= INITIAL_RUNNING_MAX_AGE_SECONDS") != null);
    try t.expect(std.mem.indexOf(u8, codex_watcher_script, "should_publish = initial_publishable(event, path)") != null);
    try t.expect(std.mem.indexOf(u8, codex_watcher_script, "append_rollout_state") != null);
    try t.expect(std.mem.indexOf(u8, codex_watcher_script, "event_hash == previous.get(\"delivered_hash\")") != null);
    try t.expect(std.mem.indexOf(u8, codex_watcher_script, "is_subagent_metadata") != null);
    try t.expect(std.mem.indexOf(u8, codex_watcher_script, "discovery_paths(catalog, titles, watched)") != null);
}

test "Hermes watcher reconciles only current metadata" {
    try t.expect(std.mem.indexOf(u8, hermes_watcher_script, "state.db") != null);
    try t.expect(std.mem.indexOf(u8, hermes_watcher_script, "ACTIVE_RECONCILE_MAX_AGE_SECONDS") != null);
    try t.expect(std.mem.indexOf(u8, hermes_watcher_script, "not activity") != null);
    try t.expect(std.mem.indexOf(u8, hermes_watcher_script, "parent_session_id") != null);
    try t.expect(std.mem.indexOf(u8, hermes_watcher_script, "and not bool(") != null);
    try t.expect(std.mem.indexOf(u8, hermes_watcher_script, "str(session_key") != null);
    try t.expect(std.mem.indexOf(u8, hermes_watcher_script, "\"feed_source\": \"state-db\"") != null);
    try t.expect(std.mem.indexOf(u8, hermes_watcher_script, "SELECT content") == null);
    try t.expect(std.mem.indexOf(u8, hermes_watcher_script, "lease_alive") != null);
    try t.expect(std.mem.indexOf(u8, hermes_watcher_script, "\"status\": \"completed\" if ended else \"idle\"") != null);
}

test "remote hook preserves Codex conversation metadata and rich updates" {
    try t.expect(std.mem.indexOf(u8, hook_script, "text_field prompt 60") != null);
    try t.expectEqual(@as(usize, 2), std.mem.count(u8, hook_script, "ord(ch) < 32 or ord(ch) == 127"));
    try t.expect(std.mem.indexOf(u8, hook_script, "$session_id.title") != null);
    try t.expect(std.mem.indexOf(u8, hook_script, "last_assistant_message 960") != null);
    try t.expect(std.mem.indexOf(u8, hook_script, "pre|post)") != null);
    try t.expect(std.mem.indexOf(u8, hook_script, "\\\"title\\\"") != null);
    try t.expect(std.mem.indexOf(u8, hook_script, "\\\"source_cwd\\\"") != null);
    try t.expect(std.mem.indexOf(u8, hook_script, "session_index.jsonl") != null);
    try t.expect(std.mem.indexOf(u8, hook_script, "PRAGMA table_info(sessions)") != null);
    try t.expect(std.mem.indexOf(u8, hook_script, "text_field user_message 60") != null);
    try t.expect(std.mem.indexOf(u8, hook_script, "conversation_key") != null);
    try t.expect(std.mem.indexOf(u8, hook_script, "session_kind") != null);
    try t.expect(std.mem.indexOf(u8, hook_script, "approval-request") != null);
    try t.expect(std.mem.indexOf(u8, hook_script, "child_session_id") != null);
    try t.expect(std.mem.indexOf(u8, hook_script, "_delegate_from") != null);
    try t.expect(std.mem.indexOf(u8, hook_script, "kind = \"subagent\" if force_subagent == \"true\" else \"primary\"") != null);
    try t.expect(std.mem.indexOf(u8, hook_script, "session_id\\\":\\\"$conversation_key") != null);
    try t.expect(std.mem.indexOf(u8, hook_script, "not bool(row.get(\"session_key\"))") != null);
    try t.expect(std.mem.indexOf(u8, hook_script, "[ \"$session_kind\" = \"subagent\" ]") != null);
    try t.expect(std.mem.indexOf(u8, hook_script, "child_summary") != null);
    // A successful/terminal bubble following a tool failure must overwrite
    // the exact conversation's temporary failed Flock state.
    try t.expect(std.mem.indexOf(u8, hook_script, "agent_state=$state") != null);
}

test "hermes writeback preserves foreign YAML and allowlist entries" {
    if (@import("builtin").os.tag == .windows) return;
    const fake = ".zig-cache/petdex-wb-hermes";
    plat.makeDir(fake);

    try t.expect(stageFetched(fake, ".hermes/config.yaml",
        \\model: some-model
        \\hooks:
        \\  pre_tool_call:
        \\    - my-own-linter
        \\
    ));
    try t.expect(stageFetched(fake, ".hermes/shell-hooks-allowlist.json",
        \\{"approvals":[{"event":"pre_tool_call","command":"my-own-linter"}]}
    ));

    try t.expect(runInstaller(t.allocator, .hermes, fake));

    var arena = std.heap.ArenaAllocator.init(t.allocator);
    defer arena.deinit();
    const outs = collectOutputs(arena.allocator(), .hermes, fake, "", "~/.hermes").?;
    try t.expectEqual(@as(usize, 6), outs.len);
    try t.expectEqualStrings(remote_ssh.remote_hook_script, outs[0].remote);
    try t.expect(outs[0].executable);
    try t.expectEqualStrings(remote_ssh.remote_hermes_watcher, outs[1].remote);
    try t.expect(outs[1].executable);
    try t.expect(std.mem.indexOf(u8, outs[1].bytes, "metadata-only") != null);
    try t.expect(std.mem.indexOf(u8, outs[2].bytes, "name: petdex-desktop") != null);
    try t.expect(std.mem.indexOf(u8, outs[3].bytes, "ctx.register_hook") != null);
    try t.expect(std.mem.indexOf(u8, outs[4].bytes, "my-own-linter") != null);
    try t.expectEqualStrings(".hermes/config.yaml", outs[5].rel);
    try t.expect(std.mem.indexOf(u8, outs[5].bytes, "my-own-linter") != null);
    try t.expect(std.mem.indexOf(u8, outs[5].bytes, "petdex-hook") != null);
    try t.expect(std.mem.indexOf(u8, outs[5].bytes, "petdex-desktop") != null);
}

test "remote Hermes writeback ignores the local HERMES_HOME" {
    if (@import("builtin").os.tag == .windows) return;
    const fake = ".zig-cache/petdex-wb-hermes-isolated";
    const live = ".zig-cache/petdex-wb-hermes-live";
    cleanupStaging(fake);
    cleanupStaging(live);
    try t.expect(prepareStaging(fake));
    try t.expect(plat.makeDirMode(live, 0o700));
    const saved = agent_hooks.env_hermes_home;
    defer agent_hooks.env_hermes_home = saved;
    agent_hooks.env_hermes_home = live;

    try t.expect(runInstaller(t.allocator, .hermes, fake));
    try t.expect(plat.fileExists(fake ++ "/.hermes/config.yaml"));
    try t.expect(!plat.fileExists(live ++ "/config.yaml"));
}

test "Hermes writeback output is byte-idempotent across remote reconnects" {
    if (@import("builtin").os.tag == .windows) return;
    const first_fake = ".zig-cache/petdex-wb-hermes-reconnect-first";
    const second_fake = ".zig-cache/petdex-wb-hermes-reconnect-second";
    cleanupStaging(first_fake);
    cleanupStaging(second_fake);
    try t.expect(prepareStaging(first_fake));
    try t.expect(stageFetched(first_fake, ".hermes/config.yaml",
        \\model: foreign-model
        \\hooks:
        \\  pre_tool_call:
        \\    - my-own-hermes-hook
        \\
    ));
    try t.expect(stageFetched(first_fake, ".hermes/shell-hooks-allowlist.json",
        \\{"approvals":[{"event":"pre_tool_call","command":"my-own-hermes-hook"}]}
    ));
    try t.expect(runInstaller(t.allocator, .hermes, first_fake));

    var first_arena = std.heap.ArenaAllocator.init(t.allocator);
    defer first_arena.deinit();
    const first = collectOutputs(first_arena.allocator(), .hermes, first_fake, "snoop", "~/.hermes-ci").?;

    try t.expect(prepareStaging(second_fake));
    for (hermes_files) |rel| {
        const prior = for (first) |out| {
            if (std.mem.eql(u8, out.rel, rel)) break out.bytes;
        } else unreachable;
        try t.expect(stageFetched(second_fake, rel, prior));
    }
    try t.expect(runInstaller(t.allocator, .hermes, second_fake));

    var second_arena = std.heap.ArenaAllocator.init(t.allocator);
    defer second_arena.deinit();
    const second = collectOutputs(second_arena.allocator(), .hermes, second_fake, "snoop", "~/.hermes-ci").?;
    try t.expectEqual(first.len, second.len);
    for (first, second) |before, after| {
        try t.expectEqualStrings(before.rel, after.rel);
        try t.expectEqualStrings(before.remote, after.remote);
        try t.expectEqualStrings(before.bytes, after.bytes);
    }
}

test "staging rejects paths that escape the private fake home" {
    try t.expect(!stageFetched(".zig-cache/petdex-wb-safe", "../outside", "x"));
    try t.expect(!stageFetched(".zig-cache/petdex-wb-safe", "/absolute", "x"));
}

test "opencode writeback is the plugin alone, no hook script" {
    if (@import("builtin").os.tag == .windows) return;
    const fake = ".zig-cache/petdex-wb-opencode";
    plat.makeDir(fake);

    try t.expect(runInstaller(t.allocator, .opencode, fake));

    var arena = std.heap.ArenaAllocator.init(t.allocator);
    defer arena.deinit();
    const outs = collectOutputs(arena.allocator(), .opencode, fake, "", "~/.hermes").?;
    try t.expectEqual(@as(usize, 1), outs.len);
    try t.expectEqualStrings("~/.config/opencode/plugins/petdex.js", outs[0].remote);
    try t.expect(std.mem.indexOf(u8, outs[0].bytes, "HOOK_SERVER_URL") != null);
    try t.expect(!outs[0].executable);
}

test "Hermes writeback targets the active profile home" {
    if (@import("builtin").os.tag == .windows) return;
    const fake = ".zig-cache/petdex-wb-hermes-profile";
    plat.makeDir(fake);
    try t.expect(runInstaller(t.allocator, .hermes, fake));

    var arena = std.heap.ArenaAllocator.init(t.allocator);
    defer arena.deinit();
    const outs = collectOutputs(arena.allocator(), .hermes, fake, "snoop", "~/.hermes").?;
    try t.expectEqualStrings(remote_ssh.remote_hook_script, outs[0].remote);
    try t.expectEqualStrings(remote_ssh.remote_hermes_watcher, outs[1].remote);
    try t.expectEqualStrings("~/.hermes/profiles/snoop/plugins/petdex-desktop/plugin.yaml", outs[2].remote);
    try t.expectEqualStrings("~/.hermes/profiles/snoop/shell-hooks-allowlist.json", outs[4].remote);
    try t.expectEqualStrings("~/.hermes/profiles/snoop/config.yaml", outs[5].remote);
}

test "non-remote-capable kinds stage nothing" {
    try t.expect(filesFor(.claude_code) == null);
    try t.expect(!needsHookScript(.opencode));
    try t.expect(!needsHermesWatcher(.opencode));
    try t.expect(!runInstaller(t.allocator, .claude_code, ".zig-cache/petdex-wb-none"));
}
