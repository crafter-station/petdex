//! Agent hook detection and installation — the Agents section's engine.
//!
//! Detection is read-only and runs at boot and on settings-open: which
//! agents exist on this machine, and whether their configs carry our
//! hooks (and which runner generation they point at). Installation
//! writes the canonical hook command — the stable `petdex-hook`
//! symlink the app re-aims at itself every boot — and NEVER touches
//! anything that is not ours: Claude's settings.json is merged through
//! a std.json Value roundtrip that only filters/appends petdex
//! entries, and a one-time backup is written beside any file we edit.

const std = @import("std");
const plat = @import("plat.zig");

pub const AgentKind = enum(u8) {
    claude_code,
    codex,
    gemini,
    opencode,

    pub fn displayName(self: AgentKind) []const u8 {
        return switch (self) {
            .claude_code => "Claude Code",
            .codex => "Codex",
            .gemini => "Gemini CLI",
            .opencode => "opencode",
        };
    }

    pub fn hookAgentName(self: AgentKind) []const u8 {
        return switch (self) {
            .claude_code => "claude-code",
            .codex => "codex",
            .gemini => "gemini",
            .opencode => "opencode",
        };
    }
};

pub const HookStatus = enum(u8) {
    /// Agent not present on this machine.
    absent,
    /// Agent present, no petdex hooks.
    none,
    /// Hooks present but pointing at the legacy node runner.
    node,
    /// Hooks present, pointing at the in-binary runner.
    current,
};

pub const AgentInfo = struct {
    kind: AgentKind,
    status: HookStatus = .absent,
};

pub const agent_count = 4;

/// Claude Code keeps everything under ~/.claude unless CLAUDE_CONFIG_DIR
/// points elsewhere — that env var is how people run several fully
/// isolated Claude Code installs (separate settings, separate accounts)
/// on one machine. Resolving it here means detection, install, refresh,
/// and uninstall all target the instance the user actually launches
/// instead of always the default one (#601). Snapshot set once from
/// main()'s environ_map, the same pattern as env_home: Zig 0.16 has no
/// global getenv.
pub var env_claude_config_dir: ?[]const u8 = null;

fn claudeConfigDir(buf: []u8, home: []const u8) ?[]const u8 {
    if (env_claude_config_dir) |dir| {
        if (dir.len != 0) return std.fmt.bufPrint(buf, "{s}", .{dir}) catch null;
    }
    return std.fmt.bufPrint(buf, "{s}/.claude", .{home}) catch null;
}

fn claudeSettingsPath(buf: []u8, home: []const u8) ?[]const u8 {
    if (env_claude_config_dir) |dir| {
        if (dir.len != 0) return std.fmt.bufPrint(buf, "{s}/settings.json", .{dir}) catch null;
    }
    return std.fmt.bufPrint(buf, "{s}/.claude/settings.json", .{home}) catch null;
}

/// The five Claude-shaped hook events the bubble pipeline rides.
const claude_events = [_]HookEvent{
    .{ .event = "UserPromptSubmit", .phase = "user-prompt" },
    .{ .event = "PreToolUse", .phase = "pre" },
    .{ .event = "PostToolUse", .phase = "post" },
    .{ .event = "Notification", .phase = "notification" },
    .{ .event = "Stop", .phase = "stop" },
};

/// Canonical hook command: killswitch first, then the stable symlink;
/// silent exit when the app (and its symlink) is not installed.
pub fn canonicalCommand(buf: []u8, phase: []const u8, agent: []const u8) ?[]const u8 {
    return std.fmt.bufPrint(
        buf,
        "[ -f \"$HOME/.petdex/runtime/hooks-disabled\" ] && exit 0; [ -x \"$HOME/.petdex/bin/petdex-hook\" ] && exec \"$HOME/.petdex/bin/petdex-hook\" bubble {s} {s}; exit 0",
        .{ phase, agent },
    ) catch null;
}

// ----------------------------------------------------------- detection

fn classifyConfig(content: []const u8) HookStatus {
    if (std.mem.indexOf(u8, content, "petdex-hook") != null) return .current;
    if (std.mem.indexOf(u8, content, "petdex") != null) return .node;
    return .none;
}

const dirExists = plat.dirExists;
const fileExists = plat.fileExists;
const writeFile = plat.writeFile;

fn readFileAlloc(allocator: std.mem.Allocator, path: []const u8, max: usize) ?[]u8 {
    return plat.readFileAlloc(allocator, path, max);
}

/// One-time backup beside the file we are about to edit.
fn backupOnce(allocator: std.mem.Allocator, path: []const u8) void {
    var bak_buf: [512]u8 = undefined;
    const bak = std.fmt.bufPrint(&bak_buf, "{s}.pre-petdex-backup", .{path}) catch return;
    if (fileExists(bak)) return;
    const content = readFileAlloc(allocator, path, 1024 * 1024) orelse return;
    defer allocator.free(content);
    _ = writeFile(bak, content);
}

pub fn scan(allocator: std.mem.Allocator, home: []const u8) [agent_count]AgentInfo {
    var out: [agent_count]AgentInfo = .{
        .{ .kind = .claude_code },
        .{ .kind = .codex },
        .{ .kind = .gemini },
        .{ .kind = .opencode },
    };
    var path: [512]u8 = undefined;
    for (&out) |*info| {
        const dir = switch (info.kind) {
            .claude_code => claudeConfigDir(&path, home) orelse continue,
            .codex => std.fmt.bufPrint(&path, "{s}/.codex", .{home}) catch continue,
            .gemini => std.fmt.bufPrint(&path, "{s}/.gemini", .{home}) catch continue,
            .opencode => std.fmt.bufPrint(&path, "{s}/.config/opencode", .{home}) catch continue,
        };
        if (!dirExists(dir)) continue;
        info.status = .none;
        const cfg = switch (info.kind) {
            .claude_code => claudeSettingsPath(&path, home) orelse continue,
            .codex => std.fmt.bufPrint(&path, "{s}/.codex/hooks.json", .{home}) catch continue,
            .gemini => std.fmt.bufPrint(&path, "{s}/.gemini/settings.json", .{home}) catch continue,
            .opencode => std.fmt.bufPrint(&path, "{s}/.config/opencode/plugins/petdex.js", .{home}) catch continue,
        };
        if (readFileAlloc(allocator, cfg, 512 * 1024)) |content| {
            defer allocator.free(content);
            // The opencode plugin never touches a runner: a current
            // snapshot means connected, anything else shows as
            // outdated so Update can refresh it.
            if (info.kind == .opencode) {
                info.status = if (std.mem.eql(u8, std.mem.trim(u8, content, " \n"), std.mem.trim(u8, opencode_plugin, " \n"))) .current else .node;
            } else {
                info.status = classifyConfig(content);
            }
        }
    }
    return out;
}

// -------------------------------------------------------- installation

/// Install/refresh Claude Code hooks: std.json Value roundtrip of
/// settings.json that filters existing petdex entries per event and
/// appends the canonical one, touching nothing else.
fn emptyObject(a: std.mem.Allocator) std.json.Value {
    return .{ .object = std.json.ObjectMap.init(a, &.{}, &.{}) catch unreachable };
}

const HookEvent = struct { event: []const u8, phase: []const u8 };

pub fn installClaude(allocator: std.mem.Allocator, home: []const u8) bool {
    var path_buf: [512]u8 = undefined;
    const path = claudeSettingsPath(&path_buf, home) orelse return false;
    return installJsonHooks(allocator, path, &claude_events, "claude-code");
}

/// Gemini rides the exact same settings.json hook shape as Claude,
/// with its own event names.
const gemini_events = [_]HookEvent{
    .{ .event = "BeforeTool", .phase = "pre" },
    .{ .event = "AfterTool", .phase = "post" },
    .{ .event = "SessionEnd", .phase = "stop" },
};

pub fn installGemini(allocator: std.mem.Allocator, home: []const u8) bool {
    var path_buf: [512]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/.gemini/settings.json", .{home}) catch return false;
    return installJsonHooks(allocator, path, &gemini_events, "gemini");
}

/// opencode has no hooks: it loads a self-contained JS plugin that
/// posts straight to the sidecar from inside its own runtime. Install
/// is writing one file (a build-time snapshot of the CLI's template).
const opencode_plugin = @embedFile("assets/opencode-plugin.js");

pub fn installOpencode(allocator: std.mem.Allocator, home: []const u8) bool {
    var path_buf: [512]u8 = undefined;
    const dir = std.fmt.bufPrint(&path_buf, "{s}/.config/opencode/plugins", .{home}) catch return false;
    plat.makeDir(dir);
    const path = std.fmt.bufPrint(&path_buf, "{s}/.config/opencode/plugins/petdex.js", .{home}) catch return false;
    backupOnce(allocator, path);
    return writeFile(path, opencode_plugin);
}

/// JSON-hook agents (Claude Code, Gemini): std.json Value roundtrip of
/// settings.json that filters existing petdex entries per event and
/// appends the canonical one, touching nothing else.
fn installJsonHooks(allocator: std.mem.Allocator, path: []const u8, events: []const HookEvent, agent: []const u8) bool {
    const existing = readFileAlloc(allocator, path, 1024 * 1024);
    defer if (existing) |e| allocator.free(e);
    backupOnce(allocator, path);

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var root: std.json.Value = blk: {
        if (existing) |bytes| {
            const parsed = std.json.parseFromSliceLeaky(std.json.Value, a, bytes, .{}) catch break :blk emptyObject(a);
            if (parsed == .object) break :blk parsed;
        }
        break :blk emptyObject(a);
    };

    const hooks_entry = root.object.getOrPut(a, "hooks") catch return false;
    if (!hooks_entry.found_existing or hooks_entry.value_ptr.* != .object) {
        hooks_entry.value_ptr.* = .{ .object = std.json.ObjectMap.init(a, &.{}, &.{}) catch return false };
    }
    const hooks_obj = &hooks_entry.value_ptr.object;

    for (events) |ev| {
        const arr_entry = hooks_obj.getOrPut(a, ev.event) catch return false;
        if (!arr_entry.found_existing or arr_entry.value_ptr.* != .array) {
            arr_entry.value_ptr.* = .{ .array = std.json.Array.init(a) };
        }
        const arr = &arr_entry.value_ptr.array;
        // Drop any existing petdex entry for this event.
        var i: usize = 0;
        while (i < arr.items.len) {
            if (entryIsPetdex(arr.items[i])) {
                _ = arr.orderedRemove(i);
            } else {
                i += 1;
            }
        }
        var cmd_buf: [512]u8 = undefined;
        const cmd = canonicalCommand(&cmd_buf, ev.phase, agent) orelse return false;
        var hook_obj = std.json.ObjectMap.init(a, &.{}, &.{}) catch return false;
        hook_obj.put(a, "type", .{ .string = "command" }) catch return false;
        hook_obj.put(a, "command", .{ .string = a.dupe(u8, cmd) catch return false }) catch return false;
        var inner = std.json.Array.init(a);
        inner.append(.{ .object = hook_obj }) catch return false;
        var entry_obj = std.json.ObjectMap.init(a, &.{}, &.{}) catch return false;
        entry_obj.put(a, "hooks", .{ .array = inner }) catch return false;
        arr.append(.{ .object = entry_obj }) catch return false;
    }

    const serialized = std.json.Stringify.valueAlloc(a, root, .{ .whitespace = .indent_2 }) catch return false;
    return writeFile(path, serialized);
}

fn entryIsPetdex(entry: std.json.Value) bool {
    if (entry != .object) return false;
    const hooks = entry.object.get("hooks") orelse return false;
    if (hooks != .array) return false;
    for (hooks.array.items) |h| {
        if (h != .object) continue;
        const cmd = h.object.get("command") orelse continue;
        if (cmd == .string and std.mem.indexOf(u8, cmd.string, "petdex") != null) return true;
    }
    return false;
}

/// Install/refresh Codex hooks: hooks.json is wholly ours (canonical
/// content), and config.toml gains `hooks = true` under [features]
/// without disturbing the rest.
pub fn installCodex(allocator: std.mem.Allocator, home: []const u8) bool {
    var path_buf: [512]u8 = undefined;
    const hooks_path = std.fmt.bufPrint(&path_buf, "{s}/.codex/hooks.json", .{home}) catch return false;
    backupOnce(allocator, hooks_path);

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var out = std.array_list.Managed(u8).init(a);
    out.appendSlice("{\n  \"hooks\": {\n") catch return false;
    const codex_events = [_]struct { event: []const u8, phase: []const u8 }{
        .{ .event = "UserPromptSubmit", .phase = "user-prompt" },
        .{ .event = "PreToolUse", .phase = "pre" },
        .{ .event = "PostToolUse", .phase = "post" },
        .{ .event = "PermissionRequest", .phase = "notification" },
        .{ .event = "Stop", .phase = "stop" },
    };
    inline for (codex_events, 0..) |ev, idx| {
        var cmd_buf: [512]u8 = undefined;
        const cmd = canonicalCommand(&cmd_buf, ev.phase, "codex") orelse return false;
        var esc = std.array_list.Managed(u8).init(a);
        for (cmd) |c| {
            if (c == '"' or c == '\\') esc.append('\\') catch return false;
            esc.append(c) catch return false;
        }
        var line_buf: [1024]u8 = undefined;
        const line = std.fmt.bufPrint(&line_buf, "    \"{s}\": [{{ \"hooks\": [{{ \"type\": \"command\", \"command\": \"{s}\" }}] }}]{s}\n", .{ ev.event, esc.items, if (idx + 1 < codex_events.len) "," else "" }) catch return false;
        out.appendSlice(line) catch return false;
    }
    out.appendSlice("  }\n}\n") catch return false;
    if (!writeFile(hooks_path, out.items)) return false;

    // config.toml: ensure [features] hooks = true.
    const toml_path = std.fmt.bufPrint(&path_buf, "{s}/.codex/config.toml", .{home}) catch return false;
    const toml = readFileAlloc(allocator, toml_path, 1024 * 1024);
    defer if (toml) |tm| allocator.free(tm);
    if (toml) |content| {
        if (hasFeatureHooks(content)) return true;
        backupOnce(allocator, toml_path);
        var new_toml = std.array_list.Managed(u8).init(a);
        if (std.mem.indexOf(u8, content, "[features]")) |at| {
            const line_end = std.mem.indexOfScalarPos(u8, content, at, '\n') orelse content.len;
            new_toml.appendSlice(content[0 .. line_end + 1]) catch return false;
            new_toml.appendSlice("hooks = true\n") catch return false;
            if (line_end + 1 < content.len) new_toml.appendSlice(content[line_end + 1 ..]) catch return false;
        } else {
            new_toml.appendSlice(content) catch return false;
            new_toml.appendSlice("\n[features]\nhooks = true\n") catch return false;
        }
        return writeFile(toml_path, new_toml.items);
    }
    return writeFile(toml_path, "[features]\nhooks = true\n");
}

fn hasFeatureHooks(toml: []const u8) bool {
    const at = std.mem.indexOf(u8, toml, "[features]") orelse return false;
    const section_end = std.mem.indexOfPos(u8, toml, at + 10, "\n[") orelse toml.len;
    const section = toml[at..section_end];
    var it = std.mem.tokenizeScalar(u8, section, '\n');
    while (it.next()) |line| {
        const trimmed = std.mem.trim(u8, line, " \t");
        if (std.mem.startsWith(u8, trimmed, "hooks") and std.mem.indexOf(u8, trimmed, "true") != null) return true;
    }
    return false;
}

// ------------------------------------------------------------ removal

/// Disconnect a JSON-hook agent: filter our entries out of every
/// event, leave everything else exactly as found.
fn uninstallJsonHooks(allocator: std.mem.Allocator, path: []const u8) bool {
    const existing = readFileAlloc(allocator, path, 1024 * 1024) orelse return true;
    defer allocator.free(existing);
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const root = std.json.parseFromSliceLeaky(std.json.Value, a, existing, .{}) catch return false;
    if (root != .object) return false;
    const hooks_val = root.object.get("hooks") orelse return true;
    if (hooks_val != .object) return true;
    var it = hooks_val.object.iterator();
    while (it.next()) |entry| {
        if (entry.value_ptr.* != .array) continue;
        const arr = &entry.value_ptr.array;
        var i: usize = 0;
        while (i < arr.items.len) {
            if (entryIsPetdex(arr.items[i])) {
                _ = arr.orderedRemove(i);
            } else {
                i += 1;
            }
        }
    }
    const serialized = std.json.Stringify.valueAlloc(a, root, .{ .whitespace = .indent_2 }) catch return false;
    return writeFile(path, serialized);
}

pub fn uninstall(allocator: std.mem.Allocator, home: []const u8, kind: AgentKind) bool {
    var path_buf: [512]u8 = undefined;
    switch (kind) {
        .claude_code => {
            const path = claudeSettingsPath(&path_buf, home) orelse return false;
            return uninstallJsonHooks(allocator, path);
        },
        .gemini => {
            const path = std.fmt.bufPrint(&path_buf, "{s}/.gemini/settings.json", .{home}) catch return false;
            return uninstallJsonHooks(allocator, path);
        },
        .codex => {
            // hooks.json is wholly ours; the config.toml feature flag
            // stays (harmless without the file).
            const p = std.fmt.bufPrint(&path_buf, "{s}/.codex/hooks.json", .{home}) catch return false;
            plat.deleteFile(p);
            return true;
        },
        .opencode => {
            const p = std.fmt.bufPrint(&path_buf, "{s}/.config/opencode/plugins/petdex.js", .{home}) catch return false;
            plat.deleteFile(p);
            return true;
        },
    }
}

// -------------------------------------------------------------- tests

const t = std.testing;

test "claude merge preserves foreign keys and hooks, replaces petdex entries" {
    // Build a fixture settings.json with a user hook and an old petdex
    // node hook, run the merge logic pieces on it via Value.
    const fixture =
        \\{"model":"opus","hooks":{"PreToolUse":[
        \\ {"matcher":"Bash","hooks":[{"type":"command","command":"my-own-thing"}]},
        \\ {"hooks":[{"type":"command","command":"node $HOME/.petdex/bin/petdex.js bubble pre claude-code"}]}
        \\]},"statusLine":{"type":"command"}}
    ;
    var arena = std.heap.ArenaAllocator.init(t.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const root = try std.json.parseFromSliceLeaky(std.json.Value, a, fixture, .{});
    try t.expect(root == .object);
    const arr = root.object.get("hooks").?.object.get("PreToolUse").?.array;
    try t.expectEqual(@as(usize, 2), arr.items.len);
    try t.expect(!entryIsPetdex(arr.items[0]));
    try t.expect(entryIsPetdex(arr.items[1]));
}

test "installClaude merges into a real fixture home non-destructively" {
    const home = "/tmp/petdex-agenthooks-fixture";
    plat.makeDir(home ++ "/.claude");
    const fixture =
        \\{"model":"opus","hooks":{"PreToolUse":[
        \\ {"matcher":"Bash","hooks":[{"type":"command","command":"my-own-thing"}]},
        \\ {"hooks":[{"type":"command","command":"node $HOME/.petdex/bin/petdex.js bubble pre claude-code"}]}
        \\]},"statusLine":{"type":"command"}}
    ;
    var pb: [512]u8 = undefined;
    const cfg = std.fmt.bufPrint(&pb, "{s}/.claude/settings.json", .{home}) catch unreachable;
    try t.expect(writeFile(cfg, fixture));
    try t.expect(installClaude(t.allocator, home));
    const merged = readFileAlloc(t.allocator, cfg, 1024 * 1024).?;
    defer t.allocator.free(merged);
    // Foreign keys and the user's own hook survive.
    try t.expect(std.mem.indexOf(u8, merged, "\"model\"") != null);
    try t.expect(std.mem.indexOf(u8, merged, "statusLine") != null);
    try t.expect(std.mem.indexOf(u8, merged, "my-own-thing") != null);
    // The node entry is gone, the canonical one is in, all five events.
    try t.expect(std.mem.indexOf(u8, merged, "petdex.js") == null);
    try t.expect(std.mem.indexOf(u8, merged, "petdex-hook") != null);
    try t.expect(std.mem.indexOf(u8, merged, "UserPromptSubmit") != null);
    try t.expect(std.mem.indexOf(u8, merged, "Stop") != null);
    // Idempotent: run again, still exactly one petdex entry per event.
    try t.expect(installClaude(t.allocator, home));
    const merged2 = readFileAlloc(t.allocator, cfg, 1024 * 1024).?;
    defer t.allocator.free(merged2);
    try t.expectEqual(@as(usize, 1), std.mem.count(u8, merged2, "bubble pre claude-code"));
    // Backup exists.
    const bak = std.fmt.bufPrint(&pb, "{s}/.claude/settings.json.pre-petdex-backup", .{home}) catch unreachable;
    try t.expect(fileExists(bak));
}

test "installCodex writes hooks.json and feature flag" {
    const home = "/tmp/petdex-agenthooks-fixture";
    plat.makeDir(home ++ "/.codex");
    var pb: [512]u8 = undefined;
    const toml = std.fmt.bufPrint(&pb, "{s}/.codex/config.toml", .{home}) catch unreachable;
    try t.expect(writeFile(toml, "model = \"gpt\"\n[features]\nmemories = true\n"));
    try t.expect(installCodex(t.allocator, home));
    var pb2: [512]u8 = undefined;
    const hooks = readFileAlloc(t.allocator, std.fmt.bufPrint(&pb2, "{s}/.codex/hooks.json", .{home}) catch unreachable, 64 * 1024).?;
    defer t.allocator.free(hooks);
    try t.expect(std.mem.indexOf(u8, hooks, "bubble stop codex") != null);
    try t.expect(std.mem.indexOf(u8, hooks, "PermissionRequest") != null);
    const toml_after = readFileAlloc(t.allocator, toml, 64 * 1024).?;
    defer t.allocator.free(toml_after);
    try t.expect(std.mem.indexOf(u8, toml_after, "hooks = true") != null);
    try t.expect(std.mem.indexOf(u8, toml_after, "memories = true") != null);
    try t.expect(std.mem.indexOf(u8, toml_after, "model = \"gpt\"") != null);
}

test "CLAUDE_CONFIG_DIR redirects install, scan and uninstall" {
    const saved = env_claude_config_dir;
    defer env_claude_config_dir = saved;

    // A home with NO ~/.claude at all: only the override dir exists,
    // exactly the machine #601 describes.
    const home = "/tmp/petdex-claude-cfgdir-home";
    const alt = "/tmp/petdex-claude-cfgdir-alt";
    plat.makeDir(home);
    plat.makeDir(alt);
    var pb: [512]u8 = undefined;
    const alt_cfg = std.fmt.bufPrint(&pb, "{s}/settings.json", .{alt}) catch unreachable;
    plat.deleteFile(alt_cfg);

    env_claude_config_dir = alt;
    try t.expect(installClaude(t.allocator, home));
    const written = readFileAlloc(t.allocator, alt_cfg, 1024 * 1024).?;
    defer t.allocator.free(written);
    try t.expect(std.mem.indexOf(u8, written, "petdex-hook") != null);
    // Nothing leaked into the default location.
    var def_pb: [512]u8 = undefined;
    const default_cfg = std.fmt.bufPrint(&def_pb, "{s}/.claude/settings.json", .{home}) catch unreachable;
    try t.expect(!fileExists(default_cfg));

    // Detection reads the same override: connected there, even though
    // ~/.claude does not exist.
    const agents = scan(t.allocator, home);
    try t.expectEqual(HookStatus.current, agents[0].status);

    // Uninstall clears the override config, not ~/.claude.
    try t.expect(uninstall(t.allocator, home, .claude_code));
    const cleared = readFileAlloc(t.allocator, alt_cfg, 1024 * 1024).?;
    defer t.allocator.free(cleared);
    try t.expect(std.mem.indexOf(u8, cleared, "petdex-hook") == null);

    // Unset (and empty, the "set but blank" shell case) falls back to
    // ~/.claude: without the dir the agent scans as absent.
    env_claude_config_dir = null;
    const fallback = scan(t.allocator, home);
    try t.expectEqual(HookStatus.absent, fallback[0].status);
    env_claude_config_dir = "";
    const blank = scan(t.allocator, home);
    try t.expectEqual(HookStatus.absent, blank[0].status);
}

test "canonical command carries killswitch, symlink, phase and agent" {
    var buf: [512]u8 = undefined;
    const cmd = canonicalCommand(&buf, "pre", "claude-code").?;
    try t.expect(std.mem.indexOf(u8, cmd, "hooks-disabled") != null);
    try t.expect(std.mem.indexOf(u8, cmd, "petdex-hook\" bubble pre claude-code") != null);
}

test "toml feature detection" {
    try t.expect(hasFeatureHooks("[features]\nhooks = true\n"));
    try t.expect(hasFeatureHooks("[core]\nx=1\n[features]\nmemories = true\nhooks = true\n"));
    try t.expect(!hasFeatureHooks("[features]\nmemories = true\n[other]\nhooks = true\n"));
    try t.expect(!hasFeatureHooks("hooks = true\n"));
}
