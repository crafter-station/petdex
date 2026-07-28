//! Agent hook detection and installation - the Agents section's engine.
//!
//! Detection is read-only and runs at boot and on settings-open: which
//! agents exist on this machine, and whether their configs carry our
//! hooks (and which runner generation they point at). A separate,
//! narrow migration updates only recognized legacy Petdex hook entries.
//! Installation writes the canonical hook command - the stable
//! `petdex-hook` symlink the app re-aims at itself every boot - and
//! never touches non-Petdex hook entries. JSON config files are merged
//! through a std.json Value roundtrip and a one-time backup is written
//! beside any file we edit.

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

const codex_events = [_]HookEvent{
    .{ .event = "UserPromptSubmit", .phase = "user-prompt" },
    .{ .event = "PreToolUse", .phase = "pre" },
    .{ .event = "PostToolUse", .phase = "post" },
    .{ .event = "PermissionRequest", .phase = "notification" },
    .{ .event = "Stop", .phase = "stop" },
};

/// Canonical hook command: pass live payloads to the stable symlink. The
/// disabled and missing-runner paths still drain stdin before exiting so an
/// agent host never sees EPIPE while it is writing a hook payload.
pub fn canonicalCommand(buf: []u8, phase: []const u8, agent: []const u8) ?[]const u8 {
    return std.fmt.bufPrint(
        buf,
        "if [ -f \"$HOME/.petdex/runtime/hooks-disabled\" ]; then [ -t 0 ] || cat >/dev/null; exit 0; fi; if [ -x \"$HOME/.petdex/bin/petdex-hook\" ]; then exec \"$HOME/.petdex/bin/petdex-hook\" bubble {s} {s}; fi; [ -t 0 ] || cat >/dev/null; exit 0",
        .{ phase, agent },
    ) catch null;
}

// ----------------------------------------------------------- detection

const ManagedHookGeneration = enum {
    none,
    legacy,
    current,
};

fn containsCommandPath(command: []const u8, path: []const u8) bool {
    var offset: usize = 0;
    while (std.mem.indexOfPos(u8, command, offset, path)) |start| {
        const end = start + path.len;
        const has_left_boundary = start == 0 or switch (command[start - 1]) {
            ' ', '\t', '\r', '\n', '\'', '"', '(', '=', '/', '\\' => true,
            else => false,
        };
        const has_right_boundary = end == command.len or switch (command[end]) {
            ' ', '\t', '\r', '\n', '\'', '"', ';', ')', '&', '|' => true,
            else => false,
        };
        if (has_left_boundary and has_right_boundary) return true;
        offset = end;
    }
    return false;
}

fn containsPetdexHomePath(command: []const u8, relative_path: []const u8) bool {
    const homes = [_][]const u8{
        "$HOME/.petdex",
        "${HOME}/.petdex",
        "$HOME\\.petdex",
        "${HOME}\\.petdex",
    };
    var path_buf: [128]u8 = undefined;
    for (homes) |home| {
        const path = std.fmt.bufPrint(&path_buf, "{s}{s}", .{ home, relative_path }) catch continue;
        if (containsCommandPath(command, path)) return true;
    }
    return false;
}

fn commandGeneration(command: []const u8) ManagedHookGeneration {
    // Old CLI-generated hooks invoked the persisted Node bundle or posted
    // directly with the old token-based curl command. Match those exact
    // ownership markers rather than every incidental mention of Petdex.
    const has_legacy_bundle = (containsPetdexHomePath(command, "/bin/petdex.js") or
        containsPetdexHomePath(command, "\\bin\\petdex.js")) and
        std.mem.indexOf(u8, command, " bubble ") != null;
    const has_legacy_curl = containsPetdexHomePath(command, "/runtime/update-token") and
        std.mem.indexOf(u8, command, "X-Petdex-Update-Token") != null and
        std.mem.indexOf(u8, command, "http://127.0.0.1:7777/state") != null and
        std.mem.indexOf(u8, command, "curl") != null;
    if (has_legacy_bundle or has_legacy_curl) return .legacy;
    if ((containsPetdexHomePath(command, "/bin/petdex-hook") or
        containsPetdexHomePath(command, "\\bin\\petdex-hook")) and
        std.mem.indexOf(u8, command, " bubble ") != null) return .current;
    return .none;
}

fn hookGeneration(hook: std.json.Value) ManagedHookGeneration {
    if (hook != .object) return .none;
    const command = hook.object.get("command") orelse return .none;
    if (command != .string) return .none;
    return commandGeneration(command.string);
}

fn entryGeneration(entry: std.json.Value) ManagedHookGeneration {
    if (entry != .object) return .none;
    const hooks = entry.object.get("hooks") orelse return .none;
    if (hooks != .array) return .none;
    var current = false;
    for (hooks.array.items) |hook| {
        switch (hookGeneration(hook)) {
            .legacy => return .legacy,
            .current => current = true,
            .none => {},
        }
    }
    return if (current) .current else .none;
}

fn classifyConfig(allocator: std.mem.Allocator, content: []const u8) HookStatus {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const root = std.json.parseFromSliceLeaky(std.json.Value, arena.allocator(), content, .{}) catch return .none;
    if (root != .object) return .none;
    const hooks = root.object.get("hooks") orelse return .none;
    if (hooks != .object) return .none;

    var current = false;
    var events = hooks.object.iterator();
    while (events.next()) |event| {
        if (event.value_ptr.* != .array) continue;
        for (event.value_ptr.array.items) |entry| {
            switch (entryGeneration(entry)) {
                .legacy => return .node,
                .current => current = true,
                .none => {},
            }
        }
    }
    return if (current) .current else .none;
}

const dirExists = plat.dirExists;
const fileExists = plat.fileExists;
const writeFile = plat.writeFile;

fn readFileAlloc(allocator: std.mem.Allocator, path: []const u8, max: usize) ?[]u8 {
    return plat.readFileAlloc(allocator, path, max);
}

/// One-time backup beside the file we are about to edit.
fn backupOnce(allocator: std.mem.Allocator, path: []const u8) bool {
    var bak_buf: [512]u8 = undefined;
    const bak = std.fmt.bufPrint(&bak_buf, "{s}.pre-petdex-backup", .{path}) catch return false;
    if (fileExists(bak)) return true;
    const content = readFileAlloc(allocator, path, 1024 * 1024) orelse return !fileExists(path);
    defer allocator.free(content);
    return writeFile(bak, content);
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
                info.status = classifyConfig(allocator, content);
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
    return installJsonHooks(allocator, path, &claude_events, "claude-code", 2, false);
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
    return installJsonHooks(allocator, path, &gemini_events, "gemini", 2000, true);
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
    if (!backupOnce(allocator, path)) return false;
    return writeFile(path, opencode_plugin);
}

/// JSON-hook agents (Claude Code, Gemini): std.json Value roundtrip of
/// settings.json that filters existing petdex entries per event and
/// appends the canonical one, touching nothing else.
fn installJsonHooks(
    allocator: std.mem.Allocator,
    path: []const u8,
    events: []const HookEvent,
    agent: []const u8,
    timeout: i64,
    enable_hooks_config: bool,
) bool {
    const existing = readFileAlloc(allocator, path, 1024 * 1024);
    defer if (existing) |e| allocator.free(e);
    // An empty, unreadable, or malformed user config is not a safe
    // starting point. Refuse to overwrite it so the user can repair the
    // real problem instead of losing their settings.
    if (existing == null and fileExists(path)) return false;

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var root: std.json.Value = blk: {
        if (existing) |bytes| {
            const parsed = std.json.parseFromSliceLeaky(std.json.Value, a, bytes, .{}) catch return false;
            if (parsed != .object) return false;
            break :blk parsed;
        }
        break :blk emptyObject(a);
    };

    if (existing != null and !backupOnce(allocator, path)) return false;

    if (enable_hooks_config and !ensureHooksConfigEnabled(&root, a)) return false;

    const hooks_entry = root.object.getOrPut(a, "hooks") catch return false;
    if (!hooks_entry.found_existing) {
        hooks_entry.value_ptr.* = .{ .object = std.json.ObjectMap.init(a, &.{}, &.{}) catch return false };
    } else if (hooks_entry.value_ptr.* != .object) {
        return false;
    }
    const hooks_obj = &hooks_entry.value_ptr.object;

    // A legacy install may have written events that no longer belong to
    // the current event list. Remove only Petdex-owned commands from every
    // event before appending the canonical entries below.
    removeManagedHooks(hooks_obj);

    for (events) |ev| {
        const arr_entry = hooks_obj.getOrPut(a, ev.event) catch return false;
        if (!arr_entry.found_existing) {
            arr_entry.value_ptr.* = .{ .array = std.json.Array.init(a) };
        } else if (arr_entry.value_ptr.* != .array) {
            return false;
        }
        const arr = &arr_entry.value_ptr.array;
        var cmd_buf: [512]u8 = undefined;
        const cmd = canonicalCommand(&cmd_buf, ev.phase, agent) orelse return false;
        var hook_obj = std.json.ObjectMap.init(a, &.{}, &.{}) catch return false;
        hook_obj.put(a, "type", .{ .string = "command" }) catch return false;
        hook_obj.put(a, "command", .{ .string = a.dupe(u8, cmd) catch return false }) catch return false;
        hook_obj.put(a, "timeout", .{ .integer = timeout }) catch return false;
        var inner = std.json.Array.init(a);
        inner.append(.{ .object = hook_obj }) catch return false;
        var entry_obj = std.json.ObjectMap.init(a, &.{}, &.{}) catch return false;
        entry_obj.put(a, "hooks", .{ .array = inner }) catch return false;
        arr.append(.{ .object = entry_obj }) catch return false;
    }

    const serialized = std.json.Stringify.valueAlloc(a, root, .{ .whitespace = .indent_2 }) catch return false;
    return writeFile(path, serialized);
}

/// Verify every shape installJsonHooks depends on without changing the file.
/// Codex uses this before its separate config.toml update so a malformed
/// hooks.json cannot leave an otherwise unrelated configuration half-updated.
fn canInstallJsonHooks(allocator: std.mem.Allocator, path: []const u8, events: []const HookEvent) bool {
    const existing = readFileAlloc(allocator, path, 1024 * 1024);
    defer if (existing) |bytes| allocator.free(bytes);
    if (existing == null) return !fileExists(path);

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const root = std.json.parseFromSliceLeaky(std.json.Value, arena.allocator(), existing.?, .{}) catch return false;
    if (root != .object) return false;
    const hooks = root.object.get("hooks") orelse return true;
    if (hooks != .object) return false;
    for (events) |event| {
        const entries = hooks.object.get(event.event) orelse continue;
        if (entries != .array) return false;
    }
    return true;
}

fn ensureHooksConfigEnabled(root: *std.json.Value, allocator: std.mem.Allocator) bool {
    const config_entry = root.object.getOrPut(allocator, "hooksConfig") catch return false;
    if (!config_entry.found_existing) {
        config_entry.value_ptr.* = .{ .object = std.json.ObjectMap.init(allocator, &.{}, &.{}) catch return false };
    } else if (config_entry.value_ptr.* != .object) {
        return false;
    }
    config_entry.value_ptr.object.put(allocator, "enabled", .{ .bool = true }) catch return false;
    return true;
}

fn entryIsPetdex(entry: std.json.Value) bool {
    return entryGeneration(entry) != .none;
}

/// Remove Petdex commands in-place without deleting a hook group that also
/// carries a user-owned command.
fn stripManagedHooks(entry: *std.json.Value) bool {
    if (entry.* != .object) return false;
    const hooks = entry.object.getPtr("hooks") orelse return false;
    if (hooks.* != .array) return false;
    var removed = false;
    var i: usize = 0;
    while (i < hooks.array.items.len) {
        if (hookGeneration(hooks.array.items[i]) != .none) {
            _ = hooks.array.orderedRemove(i);
            removed = true;
        } else {
            i += 1;
        }
    }
    return removed and hooks.array.items.len == 0;
}

fn removeManagedHooks(hooks_obj: *std.json.ObjectMap) void {
    var events = hooks_obj.iterator();
    while (events.next()) |event| {
        if (event.value_ptr.* != .array) continue;
        const entries = &event.value_ptr.array;
        var i: usize = 0;
        while (i < entries.items.len) {
            if (stripManagedHooks(&entries.items[i])) {
                _ = entries.orderedRemove(i);
            } else {
                i += 1;
            }
        }
    }
}

/// Install/refresh Codex hooks, preserving non-Petdex hooks in hooks.json
/// and enabling the required feature flag in config.toml.
pub fn installCodex(allocator: std.mem.Allocator, home: []const u8) bool {
    var hooks_path_buf: [512]u8 = undefined;
    const hooks_path = std.fmt.bufPrint(&hooks_path_buf, "{s}/.codex/hooks.json", .{home}) catch return false;
    var toml_path_buf: [512]u8 = undefined;
    const toml_path = std.fmt.bufPrint(&toml_path_buf, "{s}/.codex/config.toml", .{home}) catch return false;
    const toml = readFileAlloc(allocator, toml_path, 1024 * 1024);
    defer if (toml) |tm| allocator.free(tm);
    if (toml) |content| {
        if (inspectFeatureHooks(content).state == .unsafe) return false;
    } else if (fileExists(toml_path)) return false;

    // Validate both files before changing either one. Write hooks first so a
    // later config.toml failure can only leave the new runner disabled, never
    // keep an enabled legacy runner on the hook hot path.
    if (!canInstallJsonHooks(allocator, hooks_path, &codex_events)) return false;
    if (!installJsonHooks(allocator, hooks_path, &codex_events, "codex", 2, false)) return false;

    if (toml) |content| return ensureFeatureHooks(allocator, toml_path, content);
    return writeFile(toml_path, "[features]\nhooks = true\n");
}

const FeatureHooksState = enum {
    enabled,
    insert_after_features,
    replace_line,
    append_features,
    unsafe,
};

const FeatureHooksInspection = struct {
    state: FeatureHooksState,
    offset: usize = 0,
    line_end: usize = 0,
};

fn inspectFeatureHooks(toml: []const u8) FeatureHooksInspection {
    var line_start: usize = 0;
    var features_insert_offset: ?usize = null;
    var current_features = false;
    var at_root = true;
    var hook_count: usize = 0;
    var hook_is_enabled = false;
    var hook_offset: usize = 0;
    var hook_line_end: usize = 0;
    while (line_start <= toml.len) {
        const relative_end = std.mem.indexOfScalar(u8, toml[line_start..], '\n');
        const line_end = if (relative_end) |end| line_start + end else toml.len;
        const line = toml[line_start..line_end];
        const trimmed = std.mem.trim(u8, line, " \t\r");
        if (trimmed.len > 0 and trimmed[0] == '[') {
            const name = sectionName(trimmed) orelse return .{ .state = .unsafe };
            if (std.mem.startsWith(u8, name, "features.")) return .{ .state = .unsafe };
            current_features = std.mem.eql(u8, name, "features");
            at_root = false;
            if (current_features) {
                if (features_insert_offset != null) return .{ .state = .unsafe };
                features_insert_offset = if (relative_end == null) line_end else line_end + 1;
            }
        } else if (at_root and isFeaturesNamespaceAssignment(trimmed)) {
            return .{ .state = .unsafe };
        } else if (current_features) {
            switch (hooksAssignment(trimmed)) {
                .other => {},
                .unsafe => return .{ .state = .unsafe },
                .value => |value_with_comment| {
                    const comment = std.mem.indexOfScalar(u8, value_with_comment, '#') orelse value_with_comment.len;
                    const value = std.mem.trim(u8, value_with_comment[0..comment], " \t");
                    const enabled = if (std.mem.eql(u8, value, "true")) true else if (std.mem.eql(u8, value, "false")) false else return .{ .state = .unsafe };
                    hook_count += 1;
                    if (hook_count > 1) return .{ .state = .unsafe };
                    hook_is_enabled = enabled;
                    hook_offset = line_start;
                    hook_line_end = line_end;
                },
            }
        }
        if (relative_end == null) break;
        line_start = line_end + 1;
    }
    if (hook_count == 1) {
        return if (hook_is_enabled)
            .{ .state = .enabled }
        else
            .{ .state = .replace_line, .offset = hook_offset, .line_end = hook_line_end };
    }
    if (features_insert_offset) |offset| return .{ .state = .insert_after_features, .offset = offset };
    return .{ .state = .append_features };
}

fn isFeaturesNamespaceAssignment(line: []const u8) bool {
    if (line.len == 0 or line[0] == '#') return false;
    const equals = std.mem.indexOfScalar(u8, line, '=') orelse return false;
    const key = std.mem.trim(u8, line[0..equals], " \t");
    return std.mem.eql(u8, key, "features") or std.mem.startsWith(u8, key, "features.");
}

fn sectionName(line: []const u8) ?[]const u8 {
    if (line.len < 3 or line[0] != '[' or line[1] == '[') return null;
    const close = std.mem.indexOfScalar(u8, line[1..], ']') orelse return null;
    const close_index = close + 1;
    const suffix = std.mem.trim(u8, line[close_index + 1 ..], " \t");
    if (suffix.len > 0 and suffix[0] != '#') return null;
    return std.mem.trim(u8, line[1..close_index], " \t");
}

const HooksAssignment = union(enum) {
    other,
    unsafe,
    value: []const u8,
};

fn hooksAssignment(line: []const u8) HooksAssignment {
    if (line.len == 0 or line[0] == '#') return .other;
    const equals = std.mem.indexOfScalar(u8, line, '=') orelse return .other;
    const key = std.mem.trim(u8, line[0..equals], " \t");
    if (!std.mem.eql(u8, key, "hooks")) return .other;
    const value = std.mem.trim(u8, line[equals + 1 ..], " \t");
    if (value.len == 0) return .unsafe;
    return .{ .value = value };
}

fn ensureFeatureHooks(allocator: std.mem.Allocator, path: []const u8, content: []const u8) bool {
    const inspection = inspectFeatureHooks(content);
    if (inspection.state == .enabled) return true;
    if (inspection.state == .unsafe) return false;

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var updated = std.array_list.Managed(u8).init(a);
    switch (inspection.state) {
        .enabled => unreachable,
        .unsafe => unreachable,
        .append_features => {
            updated.appendSlice(content) catch return false;
            if (content.len > 0 and content[content.len - 1] != '\n') updated.append('\n') catch return false;
            updated.appendSlice("\n[features]\nhooks = true\n") catch return false;
        },
        .insert_after_features => {
            updated.appendSlice(content[0..inspection.offset]) catch return false;
            if (inspection.offset > 0 and content[inspection.offset - 1] != '\n') updated.append('\n') catch return false;
            updated.appendSlice("hooks = true\n") catch return false;
            updated.appendSlice(content[inspection.offset..]) catch return false;
        },
        .replace_line => {
            const original = content[inspection.offset..inspection.line_end];
            const leading_len = original.len - std.mem.trimStart(u8, original, " \t").len;
            updated.appendSlice(content[0..inspection.offset]) catch return false;
            updated.appendSlice(original[0..leading_len]) catch return false;
            updated.appendSlice("hooks = true") catch return false;
            if (std.mem.indexOfScalar(u8, original, '#')) |comment| {
                updated.append(' ') catch return false;
                updated.appendSlice(original[comment..]) catch return false;
            }
            updated.appendSlice(content[inspection.line_end..]) catch return false;
        },
    }

    if (!backupOnce(allocator, path)) return false;
    return writeFile(path, updated.items);
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
    var root = std.json.parseFromSliceLeaky(std.json.Value, a, existing, .{}) catch return false;
    if (root != .object) return false;
    const hooks_val = root.object.getPtr("hooks") orelse return true;
    if (hooks_val.* != .object) return true;
    removeManagedHooks(&hooks_val.object);
    const serialized = std.json.Stringify.valueAlloc(a, root, .{ .whitespace = .indent_2 }) catch return false;
    return writeFile(path, serialized);
}

pub const LegacyMigration = struct {
    migrated: usize = 0,
    failed: usize = 0,
};

/// Update only recognized legacy CLI hook commands when the desktop app
/// starts. This closes the gap for users who upgrade the app but never open
/// Settings to press Update; unrelated hooks and configurations are left
/// untouched.
pub fn migrateLegacyHooks(allocator: std.mem.Allocator, home: []const u8) LegacyMigration {
    const agents = scan(allocator, home);
    var result: LegacyMigration = .{};
    for (agents) |info| {
        if (info.status != .node) continue;
        const migrated = switch (info.kind) {
            .claude_code => installClaude(allocator, home),
            .codex => installCodex(allocator, home),
            .gemini => installGemini(allocator, home),
            // An outdated OpenCode plugin has no subprocess stdin path.
            // Keep its existing explicit Update action rather than changing
            // it as part of this bubble-runner migration.
            .opencode => continue,
        };
        if (migrated) result.migrated += 1 else result.failed += 1;
    }
    return result;
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
            // The config.toml feature flag stays harmless without the file.
            const p = std.fmt.bufPrint(&path_buf, "{s}/.codex/hooks.json", .{home}) catch return false;
            return uninstallJsonHooks(allocator, p);
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

test "installCodex migrates legacy hooks without dropping a foreign hook" {
    const home = "/tmp/petdex-agenthooks-codex-fixture";
    plat.makeDir(home ++ "/.codex");
    var pb: [512]u8 = undefined;
    const toml = std.fmt.bufPrint(&pb, "{s}/.codex/config.toml", .{home}) catch unreachable;
    try t.expect(writeFile(toml, "model = \"gpt\"\n[features]\nmemories = true\n"));
    var hooks_path_buf: [512]u8 = undefined;
    const hooks_path = std.fmt.bufPrint(&hooks_path_buf, "{s}/.codex/hooks.json", .{home}) catch unreachable;
    const legacy =
        \\{"hooks":{"PreToolUse":[
        \\ {"matcher":"Read","hooks":[{"type":"command","command":"my-own-hook"}]},
        \\ {"hooks":[{"type":"command","command":"node $HOME/.petdex/bin/petdex.js bubble pre codex"}]}
        \\]}}
    ;
    try t.expect(writeFile(hooks_path, legacy));
    try t.expect(installCodex(t.allocator, home));
    const hooks = readFileAlloc(t.allocator, hooks_path, 64 * 1024).?;
    defer t.allocator.free(hooks);
    try t.expect(std.mem.indexOf(u8, hooks, "bubble stop codex") != null);
    try t.expect(std.mem.indexOf(u8, hooks, "PermissionRequest") != null);
    try t.expect(std.mem.indexOf(u8, hooks, "\"timeout\": 2") != null);
    try t.expect(std.mem.indexOf(u8, hooks, "my-own-hook") != null);
    try t.expect(std.mem.indexOf(u8, hooks, "petdex.js") == null);
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

test "installClaude removes only its command from a mixed hook group" {
    const home = "/tmp/petdex-agenthooks-mixed-group-fixture";
    plat.makeDir(home ++ "/.claude");
    var path_buf: [512]u8 = undefined;
    const config = std.fmt.bufPrint(&path_buf, "{s}/.claude/settings.json", .{home}) catch unreachable;
    const mixed =
        \\{"hooks":{"PreToolUse":[{"hooks":[
        \\ {"type":"command","command":"my-own-hook"},
        \\ {"type":"command","command":"node $HOME/.petdex/bin/petdex.js bubble pre claude-code"}
        \\]}]}}
    ;
    try t.expect(writeFile(config, mixed));
    try t.expect(installClaude(t.allocator, home));
    const after = readFileAlloc(t.allocator, config, 64 * 1024).?;
    defer t.allocator.free(after);
    try t.expect(std.mem.indexOf(u8, after, "my-own-hook") != null);
    try t.expect(std.mem.indexOf(u8, after, "petdex.js") == null);
    try t.expect(std.mem.indexOf(u8, after, "petdex-hook") != null);
}

test "migration ignores similarly named user scripts" {
    const home = "/tmp/petdex-agenthooks-user-script-fixture";
    plat.makeDir(home ++ "/.claude");
    var path_buf: [512]u8 = undefined;
    const config = std.fmt.bufPrint(&path_buf, "{s}/.claude/settings.json", .{home}) catch unreachable;
    const user_script =
        \\{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"node $HOME/.petdex/bin/petdex.js-custom bubble pre claude-code"}]}]}}
    ;
    try t.expect(writeFile(config, user_script));
    const migration = migrateLegacyHooks(t.allocator, home);
    try t.expectEqual(@as(usize, 0), migration.migrated);
    try t.expectEqual(@as(usize, 0), migration.failed);
    const after = readFileAlloc(t.allocator, config, 64 * 1024).?;
    defer t.allocator.free(after);
    try t.expectEqualStrings(user_script, after);
}

test "migrateLegacyHooks rewrites recognized legacy configs at startup" {
    const home = "/tmp/petdex-agenthooks-migrate-fixture";
    plat.makeDir(home ++ "/.claude");
    plat.makeDir(home ++ "/.codex");
    plat.makeDir(home ++ "/.gemini");
    var claude_path_buf: [512]u8 = undefined;
    const claude = std.fmt.bufPrint(&claude_path_buf, "{s}/.claude/settings.json", .{home}) catch unreachable;
    const legacy_claude =
        \\{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"node $HOME/.petdex/bin/petdex.js bubble pre claude-code"}]}]}}
    ;
    try t.expect(writeFile(claude, legacy_claude));
    var codex_path_buf: [512]u8 = undefined;
    const codex = std.fmt.bufPrint(&codex_path_buf, "{s}/.codex/hooks.json", .{home}) catch unreachable;
    const legacy_codex =
        \\{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"T=\"$(cat $HOME/.petdex/runtime/update-token 2>/dev/null)\"; [ -n \"$T\" ] && curl -s -m 0.3 -X POST http://127.0.0.1:7777/state -H \"X-Petdex-Update-Token: $T\""}]}]}}
    ;
    try t.expect(writeFile(codex, legacy_codex));
    var gemini_path_buf: [512]u8 = undefined;
    const gemini = std.fmt.bufPrint(&gemini_path_buf, "{s}/.gemini/settings.json", .{home}) catch unreachable;
    const legacy_gemini =
        \\{"hooks":{"BeforeTool":[{"hooks":[{"type":"command","command":"node ${HOME}/.petdex/bin/petdex.js bubble pre gemini"}]}]}}
    ;
    try t.expect(writeFile(gemini, legacy_gemini));

    const migration = migrateLegacyHooks(t.allocator, home);
    try t.expectEqual(@as(usize, 3), migration.migrated);
    try t.expectEqual(@as(usize, 0), migration.failed);

    const claude_after = readFileAlloc(t.allocator, claude, 64 * 1024).?;
    defer t.allocator.free(claude_after);
    try t.expect(std.mem.indexOf(u8, claude_after, "petdex.js") == null);
    try t.expect(std.mem.indexOf(u8, claude_after, "petdex-hook") != null);
    const codex_after = readFileAlloc(t.allocator, codex, 64 * 1024).?;
    defer t.allocator.free(codex_after);
    try t.expect(std.mem.indexOf(u8, codex_after, "update-token") == null);
    try t.expect(std.mem.indexOf(u8, codex_after, "petdex-hook") != null);
    const gemini_after = readFileAlloc(t.allocator, gemini, 64 * 1024).?;
    defer t.allocator.free(gemini_after);
    try t.expect(std.mem.indexOf(u8, gemini_after, "petdex.js") == null);
    try t.expect(std.mem.indexOf(u8, gemini_after, "petdex-hook") != null);
}

test "installJsonHooks refuses malformed configs without overwriting them" {
    const home = "/tmp/petdex-agenthooks-invalid-json";
    plat.makeDir(home ++ "/.claude");
    var path_buf: [512]u8 = undefined;
    const config = std.fmt.bufPrint(&path_buf, "{s}/.claude/settings.json", .{home}) catch unreachable;
    const invalid = "{ invalid json";
    try t.expect(writeFile(config, invalid));
    try t.expect(!installClaude(t.allocator, home));
    const after = readFileAlloc(t.allocator, config, 64 * 1024).?;
    defer t.allocator.free(after);
    try t.expectEqualStrings(invalid, after);
}

test "canonical command carries killswitch, symlink, phase and agent" {
    var buf: [512]u8 = undefined;
    const cmd = canonicalCommand(&buf, "pre", "claude-code").?;
    try t.expect(std.mem.indexOf(u8, cmd, "hooks-disabled") != null);
    try t.expect(std.mem.indexOf(u8, cmd, "petdex-hook\" bubble pre claude-code") != null);
    try t.expectEqual(@as(usize, 2), std.mem.count(u8, cmd, "cat >/dev/null"));
}

test "installGemini enables hooks and uses a millisecond timeout" {
    const home = "/tmp/petdex-agenthooks-gemini-fixture";
    plat.makeDir(home ++ "/.gemini");
    var path_buf: [512]u8 = undefined;
    const config = std.fmt.bufPrint(&path_buf, "{s}/.gemini/settings.json", .{home}) catch unreachable;
    try t.expect(writeFile(config, "{\"hooksConfig\":{\"keep\":true}}"));
    try t.expect(installGemini(t.allocator, home));
    const written = readFileAlloc(t.allocator, config, 64 * 1024).?;
    defer t.allocator.free(written);
    try t.expect(std.mem.indexOf(u8, written, "\"timeout\": 2000") != null);
    try t.expect(std.mem.indexOf(u8, written, "\"enabled\": true") != null);
    try t.expect(std.mem.indexOf(u8, written, "\"keep\": true") != null);
}

test "legacy curl migration requires the complete Petdex command signature" {
    const command = "T=\"$(cat $HOME/.petdex/runtime/update-token 2>/dev/null)\"; [ -n \"$T\" ] && curl -s -m 0.3 -X POST http://127.0.0.1:7777/state -H \"X-Petdex-Update-Token: $T\"";
    try t.expectEqual(ManagedHookGeneration.legacy, commandGeneration(command));
    try t.expectEqual(ManagedHookGeneration.none, commandGeneration("curl -H \"X-Petdex-Update-Token: $T\" http://127.0.0.1:7777/state"));
    try t.expectEqual(ManagedHookGeneration.none, commandGeneration("cat $HOME/.petdex/runtime/update-token; curl http://127.0.0.1:7777/other -H \"X-Petdex-Update-Token: $T\""));
}

test "command path detection requires both boundaries" {
    try t.expectEqual(ManagedHookGeneration.legacy, commandGeneration("node $HOME/.petdex/bin/petdex.js bubble pre codex"));
    try t.expectEqual(ManagedHookGeneration.legacy, commandGeneration("node ${HOME}/.petdex/bin/petdex.js bubble pre codex"));
    try t.expectEqual(ManagedHookGeneration.none, commandGeneration("node $HOME/.petdex/bin/petdex.js-custom bubble pre codex"));
    try t.expectEqual(ManagedHookGeneration.none, commandGeneration("node /tmp/.petdex/bin/petdex.js bubble pre codex"));
    try t.expectEqual(ManagedHookGeneration.none, commandGeneration("node /tmp/not-petdex/bin/petdex.js bubble pre codex"));
    try t.expectEqual(ManagedHookGeneration.none, commandGeneration("node $HOME/.petdex/bin/petdex.js status"));
}

test "codex feature inspection is section-aware and conservative" {
    try t.expectEqual(FeatureHooksState.enabled, inspectFeatureHooks("[features]\nhooks = true # keep\n").state);
    try t.expectEqual(FeatureHooksState.replace_line, inspectFeatureHooks("[features]\nhooks = false\n").state);
    try t.expectEqual(FeatureHooksState.insert_after_features, inspectFeatureHooks("[features]\nmemories = true\n").state);
    try t.expectEqual(FeatureHooksState.append_features, inspectFeatureHooks("[other]\nhooks = true\n").state);
    try t.expectEqual(FeatureHooksState.unsafe, inspectFeatureHooks("[features]\nhooks =\n").state);
    try t.expectEqual(FeatureHooksState.unsafe, inspectFeatureHooks("[features]\nhooks = true\nhooks = false\n").state);
    try t.expectEqual(FeatureHooksState.unsafe, inspectFeatureHooks("[features]\nhooks = true\n[features]\n").state);
    try t.expectEqual(FeatureHooksState.unsafe, inspectFeatureHooks("[features\nhooks = true\n").state);
    try t.expectEqual(FeatureHooksState.unsafe, inspectFeatureHooks("[features.extra]\nvalue = true\n").state);
    try t.expectEqual(FeatureHooksState.unsafe, inspectFeatureHooks("features.hooks = true\n").state);
    try t.expectEqual(FeatureHooksState.unsafe, inspectFeatureHooks("features = { hooks = true }\n").state);
}

test "installCodex replaces a false feature flag without duplicating it" {
    const home = "/tmp/petdex-agenthooks-codex-false-feature";
    plat.makeDir(home ++ "/.codex");
    var path_buf: [512]u8 = undefined;
    const toml = std.fmt.bufPrint(&path_buf, "{s}/.codex/config.toml", .{home}) catch unreachable;
    try t.expect(writeFile(toml, "[features]\nhooks = false # previous value\n"));
    try t.expect(installCodex(t.allocator, home));
    const after = readFileAlloc(t.allocator, toml, 64 * 1024).?;
    defer t.allocator.free(after);
    try t.expectEqual(@as(usize, 1), std.mem.count(u8, after, "hooks ="));
    try t.expect(std.mem.indexOf(u8, after, "hooks = true # previous value") != null);
}

test "installCodex does not update hooks when its feature config is unsafe" {
    const home = "/tmp/petdex-agenthooks-codex-unsafe-feature";
    plat.makeDir(home ++ "/.codex");
    var path_buf: [512]u8 = undefined;
    const toml = std.fmt.bufPrint(&path_buf, "{s}/.codex/config.toml", .{home}) catch unreachable;
    try t.expect(writeFile(toml, "[features]\nhooks =\n"));
    var hooks_path_buf: [512]u8 = undefined;
    const hooks = std.fmt.bufPrint(&hooks_path_buf, "{s}/.codex/hooks.json", .{home}) catch unreachable;
    const legacy = "{\"hooks\":{\"PreToolUse\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"node $HOME/.petdex/bin/petdex.js bubble pre codex\"}]}]}}";
    try t.expect(writeFile(hooks, legacy));
    try t.expect(!installCodex(t.allocator, home));
    const after = readFileAlloc(t.allocator, hooks, 64 * 1024).?;
    defer t.allocator.free(after);
    try t.expectEqualStrings(legacy, after);
}

test "installCodex does not update its feature config when hooks json is malformed" {
    const home = "/tmp/petdex-agenthooks-codex-invalid-hooks";
    plat.makeDir(home ++ "/.codex");
    var path_buf: [512]u8 = undefined;
    const toml = std.fmt.bufPrint(&path_buf, "{s}/.codex/config.toml", .{home}) catch unreachable;
    const toml_before = "[features]\nhooks = false\n";
    try t.expect(writeFile(toml, toml_before));
    var hooks_path_buf: [512]u8 = undefined;
    const hooks = std.fmt.bufPrint(&hooks_path_buf, "{s}/.codex/hooks.json", .{home}) catch unreachable;
    try t.expect(writeFile(hooks, "{ invalid json"));
    try t.expect(!installCodex(t.allocator, home));
    const after = readFileAlloc(t.allocator, toml, 64 * 1024).?;
    defer t.allocator.free(after);
    try t.expectEqualStrings(toml_before, after);
}

test "uninstallCodex preserves foreign hooks in a mixed config" {
    const home = "/tmp/petdex-agenthooks-codex-uninstall-fixture";
    plat.makeDir(home ++ "/.codex");
    var hooks_path_buf: [512]u8 = undefined;
    const hooks = std.fmt.bufPrint(&hooks_path_buf, "{s}/.codex/hooks.json", .{home}) catch unreachable;
    const mixed =
        \\{"hooks":{"PreToolUse":[{"hooks":[
        \\ {"type":"command","command":"my-own-hook"},
        \\ {"type":"command","command":"node $HOME/.petdex/bin/petdex.js bubble pre codex"}
        \\]}]}}
    ;
    try t.expect(writeFile(hooks, mixed));
    try t.expect(uninstall(t.allocator, home, .codex));
    const after = readFileAlloc(t.allocator, hooks, 64 * 1024).?;
    defer t.allocator.free(after);
    try t.expect(std.mem.indexOf(u8, after, "my-own-hook") != null);
    try t.expect(std.mem.indexOf(u8, after, "petdex.js") == null);
}
