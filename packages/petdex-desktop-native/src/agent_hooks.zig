//! Agent hook detection and installation - the Agents section's engine.
//!
//! Detection is read-only and runs at boot and on settings-open: which
//! agents exist on this machine, and whether their configs carry our
//! hooks (and which runner generation they point at). A separate,
//! narrow migration updates only recognized legacy Petdex hook entries.
//! Installation writes the canonical hook command - a stable executable
//! entry the app refreshes every boot - and
//! never touches non-Petdex hook entries. JSON config files are merged
//! through a std.json Value roundtrip and a one-time backup is written
//! beside any file we edit.

const std = @import("std");
const builtin = @import("builtin");
const plat = @import("plat.zig");

pub const AgentKind = enum(u8) {
    claude_code,
    codex,
    gemini,
    opencode,
    // One row for every Qoder config root (see qoder_roots). Appended, not
    // sorted in: agent_art is indexed by @intFromEnum and the icon strip is
    // read by the same index, so inserting would re-map every existing glyph.
    qoder,
    kimi_code,
    codebuddy,
    omp,
    // Appended last for the same reason as qoder: agent_art and the icon
    // strip are indexed by @intFromEnum, so inserting anywhere earlier
    // would re-map every existing glyph.
    hermes,

    pub fn displayName(self: AgentKind) []const u8 {
        return switch (self) {
            .claude_code => "Claude Code",
            .codex => "Codex",
            .gemini => "Gemini CLI",
            .opencode => "opencode",
            .qoder => "Qoder",
            .kimi_code => "Kimi Code",
            .codebuddy => "CodeBuddy",
            .omp => "OMP",
            .hermes => "Hermes",
        };
    }

    pub fn hookAgentName(self: AgentKind) []const u8 {
        return switch (self) {
            .claude_code => "claude-code",
            .codex => "codex",
            .gemini => "gemini",
            .opencode => "opencode",
            .qoder => "qoder",
            .kimi_code => "kimi-code",
            .codebuddy => "codebuddy",
            .omp => "omp",
            .hermes => "hermes",
        };
    }
};

pub const HookStatus = enum(u8) {
    /// Agent not present on this machine.
    absent,
    /// Agent present, no petdex hooks.
    none,
    /// Hooks present but pointing at a legacy runner.
    node,
    /// Hooks present, pointing at the in-binary runner.
    current,
};

pub const AgentInfo = struct {
    kind: AgentKind,
    status: HookStatus = .absent,
};

pub const agent_count = 9;

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

/// `*_CONFIG_DIR` is a complete root path, like CLAUDE_CONFIG_DIR; `*_CLI_HOME`
/// replaces the home directory instead, so the root becomes `$CLI_HOME/<leaf>`.
/// Missing either writes hooks where that install never reads. Snapshotted once
/// from main()'s environ_map, same pattern as env_claude_config_dir.
/// `*_CONFIG_DIR_NAME` is out of scope: it renames only the leaf, and its
/// absence degrades to a visible "Not detected" rather than a wrong-root write.
pub var env_qoder_config_dir: ?[]const u8 = null;
pub var env_qoder_cn_config_dir: ?[]const u8 = null;
pub var env_qoder_cli_home: ?[]const u8 = null;
pub var env_qoder_cn_cli_home: ?[]const u8 = null;

fn nonEmpty(value: ?[]const u8) ?[]const u8 {
    const v = value orelse return null;
    return if (v.len == 0) null else v;
}

/// One row, N config roots. A table rather than a `cn` boolean so resolve,
/// scan, install and uninstall are all the same loop.
const QoderRoot = struct {
    leaf: []const u8,
    config_dir: *const ?[]const u8,
    cli_home: *const ?[]const u8,
};

const qoder_roots = [_]QoderRoot{
    .{ .leaf = ".qoder", .config_dir = &env_qoder_config_dir, .cli_home = &env_qoder_cli_home },
    .{ .leaf = ".qoder-cn", .config_dir = &env_qoder_cn_config_dir, .cli_home = &env_qoder_cn_cli_home },
};

fn qoderRootDir(buf: []u8, home: []const u8, root: QoderRoot) ?[]const u8 {
    if (nonEmpty(root.config_dir.*)) |dir| return std.fmt.bufPrint(buf, "{s}", .{dir}) catch null;
    const base = nonEmpty(root.cli_home.*) orelse home;
    return std.fmt.bufPrint(buf, "{s}/{s}", .{ base, root.leaf }) catch null;
}

fn qoderRootSettings(buf: []u8, home: []const u8, root: QoderRoot) ?[]const u8 {
    if (nonEmpty(root.config_dir.*)) |dir| return std.fmt.bufPrint(buf, "{s}/settings.json", .{dir}) catch null;
    const base = nonEmpty(root.cli_home.*) orelse home;
    return std.fmt.bufPrint(buf, "{s}/{s}/settings.json", .{ base, root.leaf }) catch null;
}

/// The settings files this row is willing to act on, deduplicated.
const QoderPaths = struct {
    bufs: [qoder_roots.len][512]u8 = undefined,
    lens: [qoder_roots.len]usize = @splat(0),
    count: usize = 0,

    fn slice(self: *const QoderPaths, i: usize) []const u8 {
        return self.bufs[i][0..self.lens[i]];
    }

    fn push(self: *QoderPaths, allocator: std.mem.Allocator, path: []const u8) void {
        if (path.len > self.bufs[0].len or self.count == self.bufs.len) return;
        // Roots collapse to one file if both *_CONFIG_DIR point at one
        // directory. Writing twice is harmless; counting twice is not.
        for (0..self.count) |i| {
            if (samePath(allocator, self.slice(i), path)) return;
        }
        @memcpy(self.bufs[self.count][0..path.len], path);
        self.lens[self.count] = path.len;
        self.count += 1;
    }
};

/// Compare config paths using the host filesystem's lexical rules. Windows
/// accepts either slash spelling and treats ASCII case as insignificant, so
/// two environment overrides can name one file without being byte-identical.
/// Resolving also folds `.` and `..` on every host; if a malformed path cannot
/// be resolved, the exact spelling remains the conservative fallback.
fn samePath(allocator: std.mem.Allocator, left: []const u8, right: []const u8) bool {
    if (std.mem.eql(u8, left, right)) return true;
    const left_resolved = std.fs.path.resolve(allocator, &.{left}) catch return false;
    defer allocator.free(left_resolved);
    const right_resolved = std.fs.path.resolve(allocator, &.{right}) catch return false;
    defer allocator.free(right_resolved);
    if (builtin.os.tag == .windows) {
        return std.os.windows.eqlIgnoreCaseWtf8(left_resolved, right_resolved);
    }
    return std.mem.eql(u8, left_resolved, right_resolved);
}

/// Roots that exist and whose settings.json we could actually merge into. An
/// unreadable or malformed config is skipped, not reported as "no hooks":
/// installJsonHooks refuses those every time, so counting one would peg the row
/// at "not installed" behind a button that can never succeed.
fn qoderActionablePaths(allocator: std.mem.Allocator, home: []const u8) QoderPaths {
    var out: QoderPaths = .{};
    for (qoder_roots) |root| {
        var dir_buf: [512]u8 = undefined;
        const dir = qoderRootDir(&dir_buf, home, root) orelse continue;
        if (!dirExists(dir)) continue;
        var path_buf: [512]u8 = undefined;
        const path = qoderRootSettings(&path_buf, home, root) orelse continue;
        if (!canInstallJsonHooks(allocator, path, &qoder_events)) continue;
        out.push(allocator, path);
    }
    return out;
}

/// Whichever root still needs a press decides the button. `.node` is
/// unreachable here today (no legacy runner ever wrote these hooks) but folding
/// it keeps the rule total.
fn worseStatus(a: HookStatus, b: HookStatus) HookStatus {
    if (a == .none or b == .none) return .none;
    if (a == .node or b == .node) return .node;
    return .current;
}

fn qoderStatus(allocator: std.mem.Allocator, home: []const u8) HookStatus {
    const paths = qoderActionablePaths(allocator, home);
    var folded: ?HookStatus = null;
    for (0..paths.count) |i| {
        const path = paths.slice(i);
        const status = blk: {
            const content = readFileAlloc(allocator, path, 512 * 1024) orelse break :blk HookStatus.none;
            defer allocator.free(content);
            break :blk classifyConfig(allocator, content);
        };
        folded = if (folded) |f| worseStatus(f, status) else status;
    }
    return folded orelse .absent;
}

/// The five Claude-shaped hook events the bubble pipeline rides.
const claude_events = [_]HookEvent{
    .{ .event = "UserPromptSubmit", .phase = "user-prompt" },
    .{ .event = "PreToolUse", .phase = "pre" },
    .{ .event = "PostToolUse", .phase = "post" },
    .{ .event = "Notification", .phase = "notification" },
    .{ .event = "Stop", .phase = "stop" },
};

/// The Claude five plus PostToolUseFailure, the one event no other wired agent
/// reports — it is what lights the `failed` sprite row. The two Post* events are
/// mutually exclusive per tool call (coreToolHookTriggers.ts:288 gates
/// PostToolUse on `!toolResult.error`), so no trailing `idle` stomps it.
const qoder_events = [_]HookEvent{
    .{ .event = "UserPromptSubmit", .phase = "user-prompt" },
    .{ .event = "PreToolUse", .phase = "pre" },
    .{ .event = "PostToolUse", .phase = "post" },
    .{ .event = "PostToolUseFailure", .phase = "tool-failure" },
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

/// Build the canonical hook command for one shell family. Unix keeps the
/// bounded stdin drain in the shell wrapper; Windows delegates that work to
/// the native runner through a regular .cmd launcher, because cmd.exe cannot
/// parse POSIX tests, redirections, or `exec`.
fn canonicalCommandForTarget(buf: []u8, phase: []const u8, agent: []const u8, windows: bool) ?[]const u8 {
    if (windows) {
        return std.fmt.bufPrint(
            buf,
            "if exist \"%HOME%\\.petdex\\bin\\petdex-hook.cmd\" (call \"%HOME%\\.petdex\\bin\\petdex-hook.cmd\" bubble {s} {s}) else if exist \"%USERPROFILE%\\.petdex\\bin\\petdex-hook.cmd\" (call \"%USERPROFILE%\\.petdex\\bin\\petdex-hook.cmd\" bubble {s} {s}) & exit /b 0",
            .{ phase, agent, phase, agent },
        ) catch null;
    }
    return std.fmt.bufPrint(
        buf,
        "if [ -f \"$HOME/.petdex/runtime/hooks-disabled\" ]; then [ -t 0 ] || cat >/dev/null; exit 0; fi; if [ -x \"$HOME/.petdex/bin/petdex-hook\" ]; then exec \"$HOME/.petdex/bin/petdex-hook\" bubble {s} {s}; fi; [ -t 0 ] || cat >/dev/null; exit 0",
        .{ phase, agent },
    ) catch null;
}

pub fn canonicalCommand(buf: []u8, phase: []const u8, agent: []const u8) ?[]const u8 {
    return canonicalCommandForTarget(buf, phase, agent, builtin.os.tag == .windows);
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
        "%HOME%/.petdex",
        "%HOME%\\.petdex",
        "%USERPROFILE%/.petdex",
        "%USERPROFILE%\\.petdex",
        "%HOMEDRIVE%%HOMEPATH%\\.petdex",
    };
    var path_buf: [128]u8 = undefined;
    for (homes) |home| {
        const path = std.fmt.bufPrint(&path_buf, "{s}{s}", .{ home, relative_path }) catch continue;
        if (containsCommandPath(command, path)) return true;
    }
    return false;
}

fn containsWindowsPetdexHomePath(command: []const u8, relative_path: []const u8) bool {
    const homes = [_][]const u8{
        "%HOME%/.petdex",
        "%HOME%\\.petdex",
        "%USERPROFILE%/.petdex",
        "%USERPROFILE%\\.petdex",
        "%HOMEDRIVE%%HOMEPATH%\\.petdex",
    };
    var path_buf: [128]u8 = undefined;
    for (homes) |home| {
        const path = std.fmt.bufPrint(&path_buf, "{s}{s}", .{ home, relative_path }) catch continue;
        if (containsCommandPath(command, path)) return true;
    }
    return false;
}

fn shellSeparator(byte: u8) bool {
    return byte == ';' or byte == '&' or byte == '|' or byte == '(' or byte == ')' or byte == '\n';
}

fn isLegacyStateInvocation(command: []const u8, path: []const u8) bool {
    var offset: usize = 0;
    while (std.mem.indexOfPos(u8, command, offset, path)) |path_at| {
        const end = path_at + path.len;
        const has_left_boundary = path_at == 0 or switch (command[path_at - 1]) {
            ' ', '\t', '\r', '\n', '\'', '"', '(', '=', '/', '\\' => true,
            else => false,
        };
        const has_right_boundary = end == command.len or switch (command[end]) {
            ' ', '\t', '\r', '\n', '\'', '"', ';', ')', '&', '|' => true,
            else => false,
        };
        if (has_left_boundary and has_right_boundary) {
            var segment_start = path_at;
            while (segment_start > 0 and !shellSeparator(command[segment_start - 1])) segment_start -= 1;
            const prefix = std.mem.trim(u8, command[segment_start..path_at], " \t\r\n\"'");
            var words = std.mem.tokenizeAny(u8, prefix, " \t\r\n");
            const first = words.next() orelse return true;
            if (std.mem.eql(u8, first, "exec") or std.mem.eql(u8, first, "command") or std.mem.eql(u8, first, "env")) return true;
            if (std.mem.eql(u8, first, "then")) {
                if (words.next()) |second| {
                    if (std.mem.eql(u8, second, "exec")) return true;
                }
            }
        }
        offset = end;
    }
    return false;
}

fn containsPetdexStateInvocation(command: []const u8) bool {
    const homes = [_][]const u8{
        "$HOME/.petdex",
        "${HOME}/.petdex",
        "$HOME\\.petdex",
        "${HOME}\\.petdex",
        "%HOME%/.petdex",
        "%HOME%\\.petdex",
        "%USERPROFILE%/.petdex",
        "%USERPROFILE%\\.petdex",
        "%HOMEDRIVE%%HOMEPATH%\\.petdex",
    };
    var path_buf: [128]u8 = undefined;
    for (homes) |home| {
        const unix_path = std.fmt.bufPrint(&path_buf, "{s}/bin/petdex-hook-state", .{home}) catch continue;
        if (isLegacyStateInvocation(command, unix_path)) return true;
        const windows_path = std.fmt.bufPrint(&path_buf, "{s}\\bin\\petdex-hook-state", .{home}) catch continue;
        if (isLegacyStateInvocation(command, windows_path)) return true;
    }
    return false;
}

fn commandGenerationForTarget(command: []const u8, windows: bool) ManagedHookGeneration {
    // Old CLI-generated hooks invoked the persisted Node bundle, the shell
    // state wrapper, or posted directly with the old token-based curl
    // command. Match those exact ownership markers rather than every
    // incidental mention of Petdex.
    const has_legacy_bundle = (containsPetdexHomePath(command, "/bin/petdex.js") or
        containsPetdexHomePath(command, "\\bin\\petdex.js")) and
        std.mem.indexOf(u8, command, " bubble ") != null;
    const has_legacy_state = containsPetdexStateInvocation(command);
    const has_legacy_curl = containsPetdexHomePath(command, "/runtime/update-token") and
        std.mem.indexOf(u8, command, "X-Petdex-Update-Token") != null and
        std.mem.indexOf(u8, command, "http://127.0.0.1:7777/state") != null and
        std.mem.indexOf(u8, command, "curl") != null;
    if (has_legacy_bundle or has_legacy_state or has_legacy_curl) return .legacy;

    const has_posix_current = (std.mem.indexOf(u8, command, "$HOME") != null or
        std.mem.indexOf(u8, command, "${HOME}") != null) and
        (containsPetdexHomePath(command, "/bin/petdex-hook") or
            containsPetdexHomePath(command, "\\bin\\petdex-hook")) and
        std.mem.indexOf(u8, command, " bubble ") != null;
    const has_windows_current = (containsWindowsPetdexHomePath(command, "/bin/petdex-hook.cmd") or
        containsWindowsPetdexHomePath(command, "\\bin\\petdex-hook.cmd")) and
        std.mem.indexOf(u8, command, " bubble ") != null;

    if (windows) {
        if (has_windows_current) return .current;
        if (has_posix_current) return .legacy;
    } else {
        if (has_posix_current) return .current;
        if (has_windows_current) return .legacy;
    }
    return .none;
}

fn commandGeneration(command: []const u8) ManagedHookGeneration {
    return commandGenerationForTarget(command, builtin.os.tag == .windows);
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
        .{ .kind = .qoder },
        .{ .kind = .kimi_code },
        .{ .kind = .codebuddy },
        .{ .kind = .omp },
        .{ .kind = .hermes },
    };
    // Several roots behind one row: cannot ride the single-dir/single-config
    // shape below, so it is resolved up front. The arms `continue` rather than
    // `unreachable` so dropping this line degrades to "not detected" instead of
    // panicking in release.
    out[@intFromEnum(AgentKind.qoder)].status = qoderStatus(allocator, home);
    var path: [512]u8 = undefined;
    for (&out) |*info| {
        if (info.kind == .hermes and builtin.os.tag == .windows) continue;
        const dir = switch (info.kind) {
            .claude_code => claudeConfigDir(&path, home) orelse continue,
            .codex => std.fmt.bufPrint(&path, "{s}/.codex", .{home}) catch continue,
            .gemini => std.fmt.bufPrint(&path, "{s}/.gemini", .{home}) catch continue,
            .opencode => std.fmt.bufPrint(&path, "{s}/.config/opencode", .{home}) catch continue,
            .qoder => continue,
            .kimi_code => kimiConfigDir(&path, home) orelse continue,
            .codebuddy => std.fmt.bufPrint(&path, "{s}/.codebuddy", .{home}) catch continue,
            .omp => ompAgentDir(&path, home) orelse continue,
            .hermes => hermesHome(&path, home) orelse continue,
        };
        if (!dirExists(dir)) continue;
        info.status = .none;
        const cfg = switch (info.kind) {
            .claude_code => claudeSettingsPath(&path, home) orelse continue,
            .codex => std.fmt.bufPrint(&path, "{s}/.codex/hooks.json", .{home}) catch continue,
            .gemini => std.fmt.bufPrint(&path, "{s}/.gemini/settings.json", .{home}) catch continue,
            .opencode => std.fmt.bufPrint(&path, "{s}/.config/opencode/plugins/petdex.js", .{home}) catch continue,
            .qoder => continue,
            .kimi_code => kimiConfigPath(&path, home) orelse continue,
            .codebuddy => std.fmt.bufPrint(&path, "{s}/.codebuddy/settings.json", .{home}) catch continue,
            .omp => ompExtensionPath(&path, home) orelse continue,
            .hermes => hermesConfigPath(&path, home) orelse continue,
        };
        if (readFileAlloc(allocator, cfg, 512 * 1024)) |content| {
            defer allocator.free(content);
            // The opencode plugin never touches a runner: a current
            // snapshot means connected, anything else shows as
            // outdated so Update can refresh it.
            if (info.kind == .opencode) {
                info.status = if (std.mem.eql(u8, std.mem.trim(u8, content, " \n"), std.mem.trim(u8, opencode_plugin, " \n"))) .current else .node;
            } else if (info.kind == .omp) {
                // Same rule as the opencode plugin: this is a whole file we
                // own, so a byte-identical copy is connected and anything
                // else is an older build that Update refreshes.
                info.status = if (std.mem.eql(u8, std.mem.trim(u8, content, " \n"), std.mem.trim(u8, omp_extension, " \n"))) .current else .node;
            } else if (info.kind == .kimi_code) {
                // TOML, so the JSON classifier cannot read it. Substring
                // matching is enough here: `petdex-hook` is the current
                // runner and `petdex.js` is the legacy node one, and both
                // only ever appear inside a command we wrote.
                info.status = if (std.mem.indexOf(u8, content, "petdex-hook") != null)
                    .current
                else if (std.mem.indexOf(u8, content, "petdex") != null)
                    .node
                else
                    .none;
            } else if (info.kind == .hermes) {
                const hooks = scanHermesHooks(content);
                const plugin_enabled = isHermesDesktopPluginEnabled(content);
                if (!hooks.any and !plugin_enabled) continue;
                info.status = .node;
                if (!hooks.current or !plugin_enabled) continue;

                var allow_path_buf: [512]u8 = undefined;
                const allow_path = hermesAllowlistPath(&allow_path_buf, home) orelse continue;
                if (!hermesAllowlistCurrent(allocator, allow_path)) continue;

                var manifest_path_buf: [512]u8 = undefined;
                const manifest_path = hermesDesktopPluginPath(&manifest_path_buf, home, "plugin.yaml") orelse continue;
                const manifest = readFileAlloc(allocator, manifest_path, 512 * 1024) orelse continue;
                defer allocator.free(manifest);
                if (!std.mem.eql(u8, std.mem.trim(u8, manifest, " \n"), std.mem.trim(u8, hermes_desktop_plugin_manifest, " \n"))) continue;

                var plugin_path_buf: [512]u8 = undefined;
                const plugin_path = hermesDesktopPluginPath(&plugin_path_buf, home, "__init__.py") orelse continue;
                const installed = readFileAlloc(allocator, plugin_path, 512 * 1024) orelse continue;
                defer allocator.free(installed);
                if (!std.mem.eql(u8, std.mem.trim(u8, installed, " \n"), std.mem.trim(u8, hermes_desktop_plugin_init, " \n"))) continue;
                info.status = .current;
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

/// Pure settings.json: no feature flag like Codex, and no hooksConfig write
/// like Gemini — `hooksConfig.enabled` already defaults to true upstream, so
/// writing it could only clobber a deliberate opt-out. Timeout is in seconds.
pub fn installQoder(allocator: std.mem.Allocator, home: []const u8) bool {
    const paths = qoderActionablePaths(allocator, home);
    if (paths.count == 0) return false;
    var ok = true;
    for (0..paths.count) |i| {
        if (!installJsonHooks(allocator, paths.slice(i), &qoder_events, "qoder", 2, false)) ok = false;
    }
    return ok;
}

fn uninstallQoder(allocator: std.mem.Allocator, home: []const u8) bool {
    const paths = qoderActionablePaths(allocator, home);
    var ok = true;
    for (0..paths.count) |i| {
        if (!uninstallJsonHooks(allocator, paths.slice(i))) ok = false;
    }
    return ok;
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

// ------------------------------------------------------------------ omp

/// OMP (Oh My Pi) has no shell-command hooks. Its docs call that
/// subsystem legacy and point at an in-process extension API, so install
/// here writes one TypeScript module rather than editing a config, the
/// same shape as the opencode plugin.
///
/// Discovery needs no manifest: a single `.ts` file dropped into the
/// extensions directory is loaded, with the default export taken as the
/// factory (docs/extension-loading.md).
const omp_extension = @embedFile("assets/omp-extension.ts");

/// `$PI_CODING_AGENT_DIR` relocates the whole agent base, so it wins over
/// the default `~/.omp/agent`. Named profiles
/// (`~/.omp/profiles/<name>/agent`) are a third root, but nothing on disk
/// says which profile is active without OMP's own `--profile` flag, so
/// this targets the default and lets a profile user point the env var.
pub var env_pi_coding_agent_dir: ?[]const u8 = null;

fn ompAgentDir(buf: []u8, home: []const u8) ?[]const u8 {
    if (env_pi_coding_agent_dir) |dir| {
        if (dir.len != 0) return std.fmt.bufPrint(buf, "{s}", .{dir}) catch null;
    }
    return std.fmt.bufPrint(buf, "{s}/.omp/agent", .{home}) catch null;
}

fn ompExtensionPath(buf: []u8, home: []const u8) ?[]const u8 {
    var dir_buf: [512]u8 = undefined;
    const dir = ompAgentDir(&dir_buf, home) orelse return null;
    return std.fmt.bufPrint(buf, "{s}/extensions/petdex.ts", .{dir}) catch null;
}

pub fn installOmp(allocator: std.mem.Allocator, home: []const u8) bool {
    var dir_buf: [512]u8 = undefined;
    const agent_dir = ompAgentDir(&dir_buf, home) orelse return false;
    plat.makeDir(agent_dir);
    var ext_dir_buf: [512]u8 = undefined;
    const ext_dir = std.fmt.bufPrint(&ext_dir_buf, "{s}/extensions", .{agent_dir}) catch return false;
    plat.makeDir(ext_dir);

    var path_buf: [512]u8 = undefined;
    const path = ompExtensionPath(&path_buf, home) orelse return false;
    if (!backupOnce(allocator, path)) return false;
    return writeFile(path, omp_extension);
}

// ------------------------------------------------------------ codebuddy

/// CodeBuddy is derived from Claude Code rather than compatible with it:
/// it reads `~/.codebuddy/settings.json` in the same `hooks.<Event>`
/// shape but never Claude's own file, so it needs its own row instead of
/// a second config root on the Claude one.
///
/// It declares 27+ events, of which only the Claude-shaped core has
/// documented payload schemas. Wiring the long tail (Elicitation,
/// TeammateIdle, WorktreeCreate, and friends) would mean guessing at
/// field names, so this stays on the documented set.
///
/// No tool-failure event: unlike Kimi and Qoder, a failed call surfaces
/// as the `tool_response` field on PostToolUse. Reading that would mean
/// pattern-matching prose to decide what "failed" looks like, and a pet
/// that flashes `failed` on a successful grep is worse than one that
/// never flashes it at all. So `failed` stays dark here until CodeBuddy
/// grows a distinct event, and `post` reports plain `idle`.
const codebuddy_events = [_]HookEvent{
    .{ .event = "UserPromptSubmit", .phase = "user-prompt" },
    .{ .event = "PreToolUse", .phase = "pre" },
    .{ .event = "PostToolUse", .phase = "post" },
    .{ .event = "Notification", .phase = "notification" },
    .{ .event = "Stop", .phase = "stop" },
};

pub fn installCodeBuddy(allocator: std.mem.Allocator, home: []const u8) bool {
    var dir_buf: [512]u8 = undefined;
    const dir = std.fmt.bufPrint(&dir_buf, "{s}/.codebuddy", .{home}) catch return false;
    plat.makeDir(dir);
    var path_buf: [512]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/.codebuddy/settings.json", .{home}) catch return false;
    return installJsonHooks(allocator, path, &codebuddy_events, "codebuddy", 2, false);
}

// ------------------------------------------------------------ kimi code

/// Kimi Code declares hooks as a TOML array of tables inside its single
/// config file, one `[[hooks]]` entry per event, rather than a JSON tree
/// like the Claude-shaped agents. Fields are fixed: an unknown key fails
/// the whole config load, so the writer emits exactly event/command and
/// nothing else.
///
/// `PostToolUseFailure` is its own event (PostToolUse only fires on
/// success), so the `failed` sprite row lights up the same way Qoder's
/// does, with no trailing `idle` to stomp it.
const kimi_events = [_]HookEvent{
    .{ .event = "UserPromptSubmit", .phase = "user-prompt" },
    .{ .event = "PreToolUse", .phase = "pre" },
    .{ .event = "PostToolUse", .phase = "post" },
    .{ .event = "PostToolUseFailure", .phase = "tool-failure" },
    .{ .event = "Notification", .phase = "notification" },
    .{ .event = "Stop", .phase = "stop" },
};

/// `$KIMI_CODE_HOME/config.toml` when the variable is set and non-empty,
/// `~/.kimi-code/config.toml` otherwise. Snapshotted once in main() from
/// environ_map, the same `env_home` pattern the Claude override uses:
/// Zig 0.16 has no global getenv.
///
/// The deprecated predecessor (`kimi-cli`, Python, `~/.kimi/`) is
/// deliberately not probed. It is being wound down upstream and writing
/// to it would install hooks into a CLI the user is migrating off.
pub var env_kimi_code_home: ?[]const u8 = null;

fn kimiConfigDir(buf: []u8, home: []const u8) ?[]const u8 {
    if (env_kimi_code_home) |dir| {
        if (dir.len != 0) return std.fmt.bufPrint(buf, "{s}", .{dir}) catch null;
    }
    return std.fmt.bufPrint(buf, "{s}/.kimi-code", .{home}) catch null;
}

fn kimiConfigPath(buf: []u8, home: []const u8) ?[]const u8 {
    if (env_kimi_code_home) |dir| {
        if (dir.len != 0) return std.fmt.bufPrint(buf, "{s}/config.toml", .{dir}) catch null;
    }
    return std.fmt.bufPrint(buf, "{s}/.kimi-code/config.toml", .{home}) catch null;
}

/// True when `line` opens a `[[hooks]]` table, tolerating the whitespace
/// TOML allows inside the brackets.
fn isKimiHookHeader(line: []const u8) bool {
    const trimmed = std.mem.trim(u8, line, " \t\r\n");
    if (!std.mem.startsWith(u8, trimmed, "[[") or !std.mem.endsWith(u8, trimmed, "]]")) return false;
    return std.mem.eql(u8, std.mem.trim(u8, trimmed[2 .. trimmed.len - 2], " \t"), "hooks");
}

/// Copy `content` minus every `[[hooks]]` block whose command mentions
/// petdex, leaving foreign hooks and all other config untouched. A block
/// runs from its header to the next table header or end of file.
fn stripKimiPetdexHooks(out: *std.array_list.Managed(u8), content: []const u8) bool {
    var i: usize = 0;
    while (i < content.len) {
        const nl = std.mem.indexOfScalarPos(u8, content, i, '\n');
        const line_end = if (nl) |n| n + 1 else content.len;
        const line = content[i..line_end];

        if (!isKimiHookHeader(line)) {
            out.appendSlice(line) catch return false;
            i = line_end;
            continue;
        }

        // Header of a hook block: find where it ends, then decide whether
        // the whole span is ours.
        var cursor = line_end;
        var block_end = content.len;
        while (cursor < content.len) {
            const s_nl = std.mem.indexOfScalarPos(u8, content, cursor, '\n');
            const s_end = if (s_nl) |n| n + 1 else content.len;
            const s_line = std.mem.trim(u8, content[cursor..s_end], " \t\r\n");
            if (std.mem.startsWith(u8, s_line, "[")) {
                block_end = cursor;
                break;
            }
            cursor = s_end;
        }
        if (cursor >= content.len) block_end = content.len;

        const block = content[i..block_end];
        const ours = std.mem.indexOf(u8, block, "petdex") != null;
        if (!ours) out.appendSlice(block) catch return false;
        i = block_end;
    }
    return true;
}

/// Rewrite the hooks Petdex owns, preserving everything else in the file.
/// Existing petdex blocks are removed first so a re-install refreshes
/// rather than duplicating, which is what makes this idempotent.
fn writeKimiHooks(allocator: std.mem.Allocator, path: []const u8, install: bool) bool {
    const existing = readFileAlloc(allocator, path, 1024 * 1024);
    defer if (existing) |e| allocator.free(e);
    // Uninstall on a file that was never written is already done.
    if (existing == null and !install) return true;
    if (!backupOnce(allocator, path)) return false;

    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    var out = std.array_list.Managed(u8).init(arena.allocator());

    if (existing) |content| {
        if (!stripKimiPetdexHooks(&out, content)) return false;
        // Trailing newline so an appended table never lands on a
        // half-written last line.
        if (out.items.len > 0 and out.items[out.items.len - 1] != '\n') out.append('\n') catch return false;
    }
    if (!install) return writeFile(path, out.items);

    var cmd_buf: [512]u8 = undefined;
    for (kimi_events) |ev| {
        const command = canonicalCommand(&cmd_buf, ev.phase, "kimi-code") orelse return false;
        // Blank line AFTER the table, never before: a leading newline would
        // leave the separator attached to the previous block, so the strip
        // pass would not carry it away on re-install and the tables would
        // accumulate on every refresh.
        out.appendSlice("[[hooks]]\nevent = \"") catch return false;
        out.appendSlice(ev.event) catch return false;
        out.appendSlice("\"\ncommand = \"") catch return false;
        // TOML basic strings escape backslash and quote; the canonical
        // command carries quotes around $HOME paths.
        for (command) |c| {
            if (c == '\\' or c == '"') out.append('\\') catch return false;
            out.append(c) catch return false;
        }
        out.appendSlice("\"\n\n") catch return false;
    }
    return writeFile(path, out.items);
}

pub fn installKimiCode(allocator: std.mem.Allocator, home: []const u8) bool {
    var dir_buf: [512]u8 = undefined;
    const dir = kimiConfigDir(&dir_buf, home) orelse return false;
    plat.makeDir(dir);
    var path_buf: [512]u8 = undefined;
    const path = kimiConfigPath(&path_buf, home) orelse return false;
    return writeKimiHooks(allocator, path, true);
}

// ---------------------------------------------------------------- hermes

/// Hermes Agent has no Claude-style shell hooks file of its own: it reads a
/// `hooks:` block from its main config (`config.yaml`) and executes each
/// entry with `shlex.split(os.path.expanduser(command))`, `shell=False`
/// (agent/shell_hooks.py). Two consequences:
///
///   * The canonical shell snippet every other agent gets cannot parse here
///     because there is no shell, so hermes commands are direct executable
///     invocations. The killswitch and the bounded stdin drain both live in
///     the hook binary itself, so dropping the wrapper loses nothing.
///   * Every (event, command) pair needs consent from
///     ~/.hermes/shell-hooks-allowlist.json, or registration is silently
///     skipped on non-TTY runs. Install pre-records the approvals for the
///     exact strings it writes; uninstall removes them again.
///
/// `$HERMES_HOME` relocates the whole data dir (config, allowlist,
/// sessions), so it wins over the default `~/.hermes`, following the same env-snapshot
/// pattern as KIMI_CODE_HOME. Snapshotted once in main().
pub var env_hermes_home: ?[]const u8 = null;

const hermes_desktop_plugin_name = "petdex-desktop";
const hermes_desktop_plugin_manifest = @embedFile("assets/hermes-petdex-plugin/plugin.yaml");
const hermes_desktop_plugin_init = @embedFile("assets/hermes-petdex-plugin/__init__.py");

fn hermesHome(buf: []u8, home: []const u8) ?[]const u8 {
    if (env_hermes_home) |dir| {
        if (dir.len != 0) return std.fmt.bufPrint(buf, "{s}", .{dir}) catch null;
    }
    return std.fmt.bufPrint(buf, "{s}/.hermes", .{home}) catch null;
}

fn hermesConfigPath(buf: []u8, home: []const u8) ?[]const u8 {
    var dir_buf: [512]u8 = undefined;
    const dir = hermesHome(&dir_buf, home) orelse return null;
    return std.fmt.bufPrint(buf, "{s}/config.yaml", .{dir}) catch null;
}

fn hermesAllowlistPath(buf: []u8, home: []const u8) ?[]const u8 {
    var dir_buf: [512]u8 = undefined;
    const dir = hermesHome(&dir_buf, home) orelse return null;
    return std.fmt.bufPrint(buf, "{s}/shell-hooks-allowlist.json", .{dir}) catch null;
}

fn hermesDesktopPluginPath(buf: []u8, home: []const u8, file: []const u8) ?[]const u8 {
    var dir_buf: [512]u8 = undefined;
    const dir = hermesHome(&dir_buf, home) orelse return null;
    return std.fmt.bufPrint(buf, "{s}/plugins/{s}/{s}", .{ dir, hermes_desktop_plugin_name, file }) catch null;
}

/// Hermes lifecycle events mapped to Petdesk's provider-neutral feed. The
/// assistant callback carries actual prose, approval/clarify paths carry
/// attention state, and subagent lifecycle metadata lets the mailbox fold
/// meaningful child responses into the top-level conversation.
/// on_session_start
/// fires once when the agent loop opens (jumping), on_session_end at turn
/// end (waving + close-of-turn preview), pre/post_tool_call ride the tool
/// pipeline like every other agent, and pre_llm_call carries the user message
/// used as a title fallback until Hermes' server-generated title lands.
/// Hermes has no dedicated tool-failure
/// event: a failed tool arrives as post_tool_call with status="error" in
/// the payload's extra, which the runner does not read, so `failed` stays
/// dark here the same way it does for CodeBuddy.
const hermes_events = [_]HookEvent{
    .{ .event = "pre_tool_call", .phase = "pre" },
    .{ .event = "post_tool_call", .phase = "post" },
    .{ .event = "pre_llm_call", .phase = "user-prompt" },
    .{ .event = "post_llm_call", .phase = "assistant" },
    .{ .event = "pre_approval_request", .phase = "approval-request" },
    .{ .event = "post_approval_response", .phase = "approval-response" },
    .{ .event = "subagent_start", .phase = "subagent-start" },
    .{ .event = "subagent_stop", .phase = "subagent-stop" },
    .{ .event = "on_session_start", .phase = "session-start" },
    .{ .event = "on_session_end", .phase = "session-end" },
};

/// Direct-exec command for one phase. Hermes splits and expands the string
/// itself, so `~` is safe and no quoting is needed on POSIX. Windows is
/// out of scope for this agent in v1: shlex.split(posix=True) would mangle
/// the .cmd path, and every supported hermes install today is POSIX.
fn hermesCommand(buf: []u8, phase: []const u8) ?[]const u8 {
    return std.fmt.bufPrint(buf, "~/.petdex/bin/petdex-hook bubble {s} hermes", .{phase}) catch null;
}

fn hermesKeyRest(line: []const u8, key: []const u8) ?[]const u8 {
    const trimmed = std.mem.trim(u8, line, " \t\r");
    if (!std.mem.startsWith(u8, trimmed, key) or trimmed.len <= key.len or trimmed[key.len] != ':') return null;
    return std.mem.trim(u8, trimmed[key.len + 1 ..], " \t");
}

/// True when a YAML line opens the top-level `hooks:` mapping, tolerating
/// trailing comments. Anything with leading whitespace is a child.
fn isHermesHooksKey(line: []const u8) bool {
    if (line.len == 0 or line[0] == ' ' or line[0] == '\t' or line[0] == '#') return false;
    const rest = hermesKeyRest(line, "hooks") orelse return false;
    return rest.len == 0 or rest[0] == '#';
}

fn isHermesPluginsKey(line: []const u8) bool {
    if (line.len == 0 or line[0] == ' ' or line[0] == '\t' or line[0] == '#') return false;
    const rest = hermesKeyRest(line, "plugins") orelse return false;
    return rest.len == 0 or rest[0] == '#';
}

fn hermesEnabledRest(line: []const u8) ?[]const u8 {
    const indent = lineIndent(line);
    if (indent == 0 or indent > 4) return null;
    return hermesKeyRest(line, "enabled");
}

fn isHermesPluginListItem(line: []const u8) bool {
    const trimmed = std.mem.trim(u8, line, " \t\r");
    if (trimmed.len < 2 or trimmed[0] != '-') return false;
    var value = std.mem.trim(u8, trimmed[1..], " \t");
    if (std.mem.indexOfScalar(u8, value, '#')) |comment| value = std.mem.trim(u8, value[0..comment], " \t");
    if (value.len >= 2 and ((value[0] == '\'' and value[value.len - 1] == '\'') or (value[0] == '"' and value[value.len - 1] == '"')))
        value = value[1 .. value.len - 1];
    return std.mem.eql(u8, value, hermes_desktop_plugin_name);
}

const HermesHookScan = struct {
    any: bool = false,
    current: bool = false,
};

fn scanHermesHooks(content: []const u8) HermesHookScan {
    var found: [hermes_events.len]bool = @splat(false);
    var in_hooks = false;
    var active_event: ?usize = null;
    var active_indent: usize = 0;
    var it = std.mem.splitScalar(u8, content, '\n');
    while (it.next()) |line| {
        if (!in_hooks) {
            if (isHermesHooksKey(line)) in_hooks = true;
            continue;
        }
        if (line.len > 0 and isTopLevelKey(line)) break;
        if (hermesEventKey(line)) |name| {
            active_event = null;
            for (hermes_events, 0..) |event, index| {
                if (std.mem.eql(u8, event.event, name)) {
                    active_event = index;
                    active_indent = lineIndent(line);
                    break;
                }
            }
            continue;
        }
        const index = active_event orelse continue;
        if (lineIndent(line) <= active_indent) {
            active_event = null;
            continue;
        }
        var cmd_buf: [128]u8 = undefined;
        const command = hermesCommand(&cmd_buf, hermes_events[index].phase) orelse continue;
        var line_buf: [192]u8 = undefined;
        const expected = std.fmt.bufPrint(&line_buf, "- command: \"{s}\"", .{command}) catch continue;
        if (std.mem.eql(u8, std.mem.trim(u8, line, " \t\r"), expected)) found[index] = true;
    }
    var result: HermesHookScan = .{ .current = true };
    for (found) |present| {
        result.any = result.any or present;
        result.current = result.current and present;
    }
    return result;
}

fn isHermesDesktopPluginEnabled(content: []const u8) bool {
    var in_plugins = false;
    var enabled_indent: ?usize = null;
    var it = std.mem.splitScalar(u8, content, '\n');
    while (it.next()) |line| {
        if (!in_plugins) {
            if (isHermesPluginsKey(line)) in_plugins = true;
            continue;
        }
        if (line.len > 0 and isTopLevelKey(line)) break;
        if (enabled_indent == null) {
            if (hermesEnabledRest(line)) |_| enabled_indent = lineIndent(line);
            continue;
        }
        const trimmed = std.mem.trim(u8, line, " \t\r");
        if (trimmed.len == 0 or trimmed[0] == '#') continue;
        if (lineIndent(line) <= enabled_indent.?) break;
        if (isHermesPluginListItem(line)) return true;
    }
    return false;
}

fn hermesAllowlistCurrent(allocator: std.mem.Allocator, path: []const u8) bool {
    const content = readFileAlloc(allocator, path, 1024 * 1024) orelse return false;
    defer allocator.free(content);
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const root = std.json.parseFromSliceLeaky(std.json.Value, arena.allocator(), content, .{}) catch return false;
    if (root != .object) return false;
    const approvals = root.object.get("approvals") orelse return false;
    if (approvals != .array) return false;
    for (hermes_events) |event| {
        var cmd_buf: [128]u8 = undefined;
        const expected = hermesCommand(&cmd_buf, event.phase) orelse return false;
        var found = false;
        for (approvals.array.items) |approval| {
            if (approval != .object) continue;
            const approval_event = approval.object.get("event") orelse continue;
            const command = approval.object.get("command") orelse continue;
            if (approval_event == .string and command == .string and std.mem.eql(u8, approval_event.string, event.event) and std.mem.eql(u8, command.string, expected)) {
                found = true;
                break;
            }
        }
        if (!found) return false;
    }
    return true;
}

fn writeHermesYamlLines(allocator: std.mem.Allocator, path: []const u8, lines: []const []const u8) bool {
    var out = std.array_list.Managed(u8).init(allocator);
    defer out.deinit();
    for (lines, 0..) |line, i| {
        if (i > 0) out.append('\n') catch return false;
        out.appendSlice(line) catch return false;
    }
    if (out.items.len > 0) out.append('\n') catch return false;
    if (!backupOnce(allocator, path)) return false;
    return writeFile(path, out.items);
}

/// Hermes' Desktop backend loads enabled plugins but, in 0.20.x, does not
/// run the config.yaml shell-hook registration path used by CLI/gateway
/// commands. Keep a tiny compatibility plugin enabled without disturbing
/// foreign plugin entries. Flow-style non-empty lists are refused rather
/// than rewritten by a hand-rolled YAML parser.
fn writeHermesDesktopPluginEnabled(allocator: std.mem.Allocator, path: []const u8, install: bool) bool {
    const existing = readFileAlloc(allocator, path, 1024 * 1024);
    defer if (existing) |e| allocator.free(e);
    if (existing == null and fileExists(path)) return false;
    if (existing == null and !install) return true;
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var lines = std.array_list.Managed([]const u8).init(a);
    if (existing) |content| {
        var it = std.mem.splitScalar(u8, content, '\n');
        while (it.next()) |line| lines.append(line) catch return false;
        if (lines.items.len > 0 and lines.items[lines.items.len - 1].len == 0) _ = lines.pop();
    }

    var plugins_start: ?usize = null;
    var plugins_end = lines.items.len;
    for (lines.items, 0..) |line, i| {
        if (!isHermesPluginsKey(line)) {
            // A top-level plugins key with an inline/scalar value is real
            // config, not an absent block. Refuse instead of appending a
            // duplicate top-level key that would invalidate the YAML.
            if (lineIndent(line) == 0) {
                const trimmed = std.mem.trim(u8, line, " \t\r");
                if (hermesKeyRest(line, "plugins") != null or std.mem.startsWith(u8, trimmed, "\"plugins\":") or std.mem.startsWith(u8, trimmed, "'plugins':")) return false;
            }
            continue;
        }
        if (plugins_start != null) return false;
        plugins_start = i;
    }
    if (plugins_start) |start| {
        var j = start + 1;
        while (j < lines.items.len) : (j += 1) {
            if (lines.items[j].len > 0 and isTopLevelKey(lines.items[j])) {
                plugins_end = j;
                break;
            }
        }
    }

    if (plugins_start == null) {
        if (!install) return true;
        if (lines.items.len > 0) lines.append("") catch return false;
        lines.append("plugins:") catch return false;
        lines.append("  enabled:") catch return false;
        lines.append("    - " ++ hermes_desktop_plugin_name) catch return false;
        return writeHermesYamlLines(a, path, lines.items);
    }

    var enabled_index: ?usize = null;
    var enabled_rest: []const u8 = "";
    var i = plugins_start.? + 1;
    while (i < plugins_end) : (i += 1) {
        if (hermesEnabledRest(lines.items[i])) |rest| {
            enabled_index = i;
            enabled_rest = rest;
            break;
        }
    }
    if (enabled_index == null) {
        if (!install) return true;
        lines.insert(plugins_start.? + 1, "  enabled:") catch return false;
        lines.insert(plugins_start.? + 2, "    - " ++ hermes_desktop_plugin_name) catch return false;
        return writeHermesYamlLines(a, path, lines.items);
    }

    const comment_only = enabled_rest.len > 0 and enabled_rest[0] == '#';
    const empty_flow = std.mem.eql(u8, enabled_rest, "[]");
    if (enabled_rest.len > 0 and !comment_only and !empty_flow) return false;

    const key_index = enabled_index.?;
    const key_indent = lineIndent(lines.items[key_index]);
    if (empty_flow) {
        const spaces = "                ";
        if (key_indent > spaces.len) return false;
        lines.items[key_index] = std.fmt.allocPrint(a, "{s}enabled:", .{spaces[0..key_indent]}) catch return false;
    }

    var section_end = key_index + 1;
    var item_indent: ?usize = null;
    while (section_end < lines.items.len and section_end < plugins_end) : (section_end += 1) {
        const line = lines.items[section_end];
        const trimmed = std.mem.trim(u8, line, " \t\r");
        if (trimmed.len == 0 or trimmed[0] == '#') continue;
        const indent = lineIndent(line);
        const list_item = trimmed[0] == '-';
        if (indent < key_indent or (indent == key_indent and !list_item)) break;
        if (list_item and item_indent == null) item_indent = indent;
    }

    var changed = empty_flow;
    var cursor = key_index + 1;
    while (cursor < section_end) {
        if (isHermesPluginListItem(lines.items[cursor])) {
            _ = lines.orderedRemove(cursor);
            section_end -= 1;
            plugins_end -= 1;
            changed = true;
        } else {
            cursor += 1;
        }
    }

    const spaces = "                ";
    if (install) {
        const indent = item_indent orelse key_indent + 2;
        if (indent > spaces.len) return false;
        const item = std.fmt.allocPrint(a, "{s}- {s}", .{ spaces[0..indent], hermes_desktop_plugin_name }) catch return false;
        lines.insert(section_end, item) catch return false;
        changed = true;
    } else if (changed) {
        var has_items = false;
        cursor = key_index + 1;
        while (cursor < section_end) : (cursor += 1) {
            const trimmed = std.mem.trim(u8, lines.items[cursor], " \t\r");
            if (trimmed.len > 0 and trimmed[0] == '-') {
                has_items = true;
                break;
            }
        }
        if (!has_items) {
            if (key_indent > spaces.len) return false;
            lines.items[key_index] = std.fmt.allocPrint(a, "{s}enabled: []", .{spaces[0..key_indent]}) catch return false;
        }
    }

    if (!changed) return true;
    return writeHermesYamlLines(a, path, lines.items);
}

/// True when a line at column 0 begins a new top-level key (ends the
/// `hooks:` block). Comments and blanks never end the block.
fn isTopLevelKey(line: []const u8) bool {
    if (line.len == 0 or line[0] == ' ' or line[0] == '\t' or line[0] == '#') return false;
    return std.mem.indexOfScalar(u8, line, ':') != null;
}

/// Indent level in spaces of a YAML line (tabs count as one level each;
/// hermes configs in the wild are space-indented).
fn lineIndent(line: []const u8) usize {
    var n: usize = 0;
    while (n < line.len and (line[n] == ' ' or line[n] == '\t')) n += 1;
    return n;
}

/// True when `line` is an event key (`  pre_tool_call:`) under the hooks
/// block: indented, ends with ':', and names one of our events.
fn hermesEventKey(line: []const u8) ?[]const u8 {
    const indent = lineIndent(line);
    if (indent == 0 or indent > 4) return null;
    const trimmed = std.mem.trim(u8, line, " \t\r");
    if (!std.mem.endsWith(u8, trimmed, ":")) return null;
    const name = trimmed[0 .. trimmed.len - 1];
    for (hermes_events) |ev| {
        if (std.mem.eql(u8, name, ev.event)) return ev.event;
    }
    return null;
}

/// Rewrite the hermes hooks Petdex owns, preserving everything else in
/// config.yaml. Mirrors the Kimi TOML discipline: strip every line that is
/// ours, then append fresh entries when installing, so a re-install
/// refreshes rather than duplicates.
///
/// Strip rules, applied only inside the top-level `hooks:` block:
///   * any line mentioning petdex-hook or petdex.js (our command lines)
///   * any of our event keys left with an empty list as a result
///   * the `hooks:` key itself when the whole block became empty AND we
///     are uninstalling (on install it is refilled immediately)
///
/// Install inserts each missing event key at the end of the existing
/// hooks block (before the next top-level key), or appends a complete
/// block at EOF when the file has no `hooks:` key at all. Flow-style
/// `hooks: {...}` content is left untouched and refuses the install;
/// mangling exotic YAML is worse than asking the user to convert it.
fn writeHermesHooks(allocator: std.mem.Allocator, path: []const u8, install: bool) bool {
    const existing = readFileAlloc(allocator, path, 1024 * 1024);
    defer if (existing) |e| allocator.free(e);
    if (existing == null and fileExists(path)) return false;
    if (existing == null and !install) return true;
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var lines = std.array_list.Managed([]const u8).init(a);
    if (existing) |content| {
        var it = std.mem.splitScalar(u8, content, '\n');
        while (it.next()) |line| lines.append(line) catch return false;
        // split("") yields one empty piece; a file ending in '\n' yields a
        // trailing empty piece. Drop it so append positions stay exact.
        if (lines.items.len > 0 and lines.items[lines.items.len - 1].len == 0)
            _ = lines.pop();
    }

    // Locate the top-level hooks block [start, end).
    var hooks_start: ?usize = null;
    var hooks_end: usize = 0;
    for (lines.items, 0..) |line, i| {
        if (isHermesHooksKey(line)) {
            if (hooks_start != null) return false;
            hooks_start = i;
            continue;
        }
        if (lineIndent(line) != 0) continue;
        if (hermesKeyRest(line, "hooks")) |rest| {
            if (!std.mem.eql(u8, rest, "[]") or hooks_start != null) return false;
            lines.items[i] = "hooks:";
            hooks_start = i;
            continue;
        }
        const trimmed = std.mem.trim(u8, line, " \t\r");
        if (std.mem.startsWith(u8, trimmed, "\"hooks\":") or std.mem.startsWith(u8, trimmed, "'hooks':")) return false;
    }
    if (hooks_start) |start| {
        hooks_end = lines.items.len;
        var j = start + 1;
        while (j < lines.items.len) : (j += 1) {
            const l = lines.items[j];
            if (l.len > 0 and isTopLevelKey(l)) {
                hooks_end = j;
                break;
            }
        }
    }

    var kept = std.array_list.Managed([]const u8).init(a);
    if (hooks_start) |hs| {
        // Pass 1: copy everything, dropping petdex command lines inside
        // the block.
        kept.appendSlice(lines.items[0..hs]) catch return false;
        kept.append(lines.items[hs]) catch return false;
        var i = hs + 1;
        while (i < hooks_end) : (i += 1) {
            const l = lines.items[i];
            if ((containsCommandPath(l, "~/.petdex/bin/petdex-hook") or containsCommandPath(l, "~/.petdex/bin/petdex.js")) and std.mem.indexOf(u8, l, " bubble ") != null) continue;
            kept.append(l) catch return false;
        }
        kept.appendSlice(lines.items[hooks_end..]) catch return false;

        // Pass 2: drop our event keys whose list is now empty, and the
        // hooks key itself when nothing at all remains under it.
        var pass2 = std.array_list.Managed([]const u8).init(a);
        var k: usize = 0;
        while (k < kept.items.len) : (k += 1) {
            const l = kept.items[k];
            if (hermesEventKey(l)) |_| {
                // Empty iff the next non-blank line is not deeper indented.
                var next = k + 1;
                while (next < kept.items.len and std.mem.trim(u8, kept.items[next], " \t\r").len == 0) next += 1;
                const empty = next >= kept.items.len or lineIndent(kept.items[next]) <= lineIndent(l);
                if (empty) {
                    continue;
                }
            }
            if (isHermesHooksKey(l)) {
                // Empty iff no indented child line follows before a
                // top-level key or EOF (comments/blanks don't count).
                var next = k + 1;
                var has_child = false;
                while (next < kept.items.len) : (next += 1) {
                    const c = kept.items[next];
                    if (c.len > 0 and isTopLevelKey(c)) break;
                    if (lineIndent(c) > 0 and std.mem.trim(u8, c, " \t\r").len > 0) {
                        has_child = true;
                        break;
                    }
                }
                if (!has_child and !install) {
                    continue;
                }
            }
            pass2.append(l) catch return false;
        }
        kept = pass2;
    } else {
        kept.appendSlice(lines.items) catch return false;
    }

    if (install) {
        // Re-locate the hooks block in the stripped lines.
        var hs: ?usize = null;
        var he: usize = kept.items.len;
        for (kept.items, 0..) |line, i| {
            if (isHermesHooksKey(line)) {
                hs = i;
                he = kept.items.len;
                var j = i + 1;
                while (j < kept.items.len) : (j += 1) {
                    const l = kept.items[j];
                    if (l.len > 0 and isTopLevelKey(l)) {
                        he = j;
                        break;
                    }
                }
                break;
            }
        }

        var cmd_buf: [128]u8 = undefined;
        if (hs == null) {
            if (kept.items.len > 0) kept.append("") catch return false;
            kept.append("hooks:") catch return false;
            for (hermes_events) |ev| {
                const cmd = hermesCommand(&cmd_buf, ev.phase) orelse return false;
                kept.append(std.fmt.allocPrint(a, "  {s}:", .{ev.event}) catch return false) catch return false;
                kept.append(std.fmt.allocPrint(a, "    - command: \"{s}\"", .{cmd}) catch return false) catch return false;
            }
        } else {
            // Which events already carry a (non-petdex) entry? Those keys
            // get our line appended under them; the rest get a fresh key
            // at the end of the block.
            var present: [hermes_events.len]bool = @splat(false);
            var key_line: [hermes_events.len]?usize = @splat(null);
            var i = hs.? + 1;
            while (i < he) : (i += 1) {
                if (hermesEventKey(kept.items[i])) |event| {
                    for (hermes_events, 0..) |ev, idx| {
                        if (std.mem.eql(u8, ev.event, event)) {
                            // A bare `  pre_tool_call:` with an empty list
                            // still counts as present: we append under it.
                            present[idx] = true;
                            key_line[idx] = i;
                        }
                    }
                }
            }
            // Insert under existing keys first, walking backwards so the
            // indices captured above stay valid.
            var idx: usize = hermes_events.len;
            while (idx > 0) {
                idx -= 1;
                if (present[idx]) {
                    const cmd = hermesCommand(&cmd_buf, hermes_events[idx].phase) orelse return false;
                    const entry = std.fmt.allocPrint(a, "    - command: \"{s}\"", .{cmd}) catch return false;
                    kept.insert(key_line[idx].? + 1, entry) catch return false;
                }
            }
            // Then the missing events, appended just before the block end
            // (which shifted by however many lines we inserted).
            for (hermes_events, 0..) |ev, eidx| {
                if (present[eidx]) continue;
                const cmd = hermesCommand(&cmd_buf, ev.phase) orelse return false;
                const key = std.fmt.allocPrint(a, "  {s}:", .{ev.event}) catch return false;
                const entry = std.fmt.allocPrint(a, "    - command: \"{s}\"", .{cmd}) catch return false;
                // Find the current end of the hooks block.
                var end = kept.items.len;
                var j = hs.? + 1;
                while (j < kept.items.len) : (j += 1) {
                    const l = kept.items[j];
                    if (l.len > 0 and isTopLevelKey(l)) {
                        end = j;
                        break;
                    }
                }
                kept.insert(end, key) catch return false;
                kept.insert(end + 1, entry) catch return false;
            }
        }
    }

    var out = std.array_list.Managed(u8).init(a);
    for (kept.items, 0..) |line, i| {
        if (i > 0) out.append('\n') catch return false;
        out.appendSlice(line) catch return false;
    }
    if (out.items.len > 0) out.append('\n') catch return false;
    if (!backupOnce(allocator, path)) return false;
    return writeFile(path, out.items);
}

/// Merge our approvals into shell-hooks-allowlist.json (or strip them when
/// uninstalling). The allowlist is the consent record hermes checks before
/// registering any hook; without an entry per exact (event, command) pair
/// the config we just wrote would be silently ignored on non-TTY runs.
/// std.json Value roundtrip like installJsonHooks: foreign approvals are
/// preserved, ours are deduplicated on reinstall.
fn writeHermesAllowlist(allocator: std.mem.Allocator, path: []const u8, install: bool) bool {
    const existing = readFileAlloc(allocator, path, 1024 * 1024);
    defer if (existing) |e| allocator.free(e);
    if (existing == null and fileExists(path)) return false;
    if (existing == null and !install) return true;

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

    const approvals_entry = root.object.getOrPut(a, "approvals") catch return false;
    if (!approvals_entry.found_existing) {
        approvals_entry.value_ptr.* = .{ .array = std.json.Array.init(a) };
    } else if (approvals_entry.value_ptr.* != .array) {
        // A non-array approvals key is malformed; refuse rather than
        // clobber a file hermes might still read.
        return false;
    }
    const approvals = &approvals_entry.value_ptr.array;

    // Strip every approval whose command mentions petdex (ours, current or
    // legacy), keeping foreign approvals untouched.
    var kept = std.json.Array.init(a);
    for (approvals.items) |item| {
        if (item == .object) {
            if (item.object.get("command")) |cmd| {
                if (cmd == .string) {
                    var managed = false;
                    var cmd_buf: [128]u8 = undefined;
                    for (hermes_events) |ev| {
                        const expected = hermesCommand(&cmd_buf, ev.phase) orelse return false;
                        if (std.mem.eql(u8, cmd.string, expected)) {
                            managed = true;
                            break;
                        }
                    }
                    if (managed) continue;
                }
            }
        }
        kept.append(item) catch return false;
    }
    approvals.* = kept;

    if (install) {
        var cmd_buf: [128]u8 = undefined;
        for (hermes_events) |ev| {
            const cmd = hermesCommand(&cmd_buf, ev.phase) orelse return false;
            var obj = std.json.ObjectMap.init(a, &.{}, &.{}) catch return false;
            obj.put(a, "event", .{ .string = ev.event }) catch return false;
            obj.put(a, "command", .{ .string = a.dupe(u8, cmd) catch return false }) catch return false;
            approvals.append(.{ .object = obj }) catch return false;
        }
    }

    if (approvals.items.len == 0 and !install and existing == null) return true;
    if (!backupOnce(allocator, path)) return false;

    const serialized = std.json.Stringify.valueAlloc(a, root, .{ .whitespace = .indent_2 }) catch return false;
    var out = std.array_list.Managed(u8).init(a);
    out.appendSlice(serialized) catch return false;
    out.append('\n') catch return false;
    return writeFile(path, out.items);
}

const HermesFileSnapshot = struct {
    path: []const u8,
    existed: bool,
    content: ?[]u8,
    valid: bool,
};

fn snapshotHermesFile(allocator: std.mem.Allocator, path: []const u8) HermesFileSnapshot {
    const existed = fileExists(path);
    const content = readFileAlloc(allocator, path, 1024 * 1024);
    return .{
        .path = path,
        .existed = existed,
        .content = content,
        .valid = !existed or content != null,
    };
}

fn validHermesSnapshots(snapshots: []const HermesFileSnapshot) bool {
    for (snapshots) |snapshot| {
        if (!snapshot.valid) return false;
    }
    return true;
}

fn restoreHermesFiles(snapshots: []const HermesFileSnapshot) void {
    for (snapshots) |snapshot| {
        if (snapshot.existed) {
            _ = writeFile(snapshot.path, snapshot.content orelse "");
        } else {
            plat.deleteFile(snapshot.path);
        }
    }
}

pub fn installHermes(allocator: std.mem.Allocator, home: []const u8) bool {
    if (builtin.os.tag == .windows) return false;
    var dir_buf: [512]u8 = undefined;
    const dir = hermesHome(&dir_buf, home) orelse return false;
    var path_buf: [512]u8 = undefined;
    const config_path = hermesConfigPath(&path_buf, home) orelse return false;
    var allow_buf: [512]u8 = undefined;
    const allow_path = hermesAllowlistPath(&allow_buf, home) orelse return false;
    var manifest_buf: [512]u8 = undefined;
    const manifest_path = hermesDesktopPluginPath(&manifest_buf, home, "plugin.yaml") orelse return false;
    var init_buf: [512]u8 = undefined;
    const init_path = hermesDesktopPluginPath(&init_buf, home, "__init__.py") orelse return false;
    var plugin_dir_buf: [512]u8 = undefined;
    const slash = std.mem.lastIndexOfScalar(u8, manifest_path, '/') orelse return false;
    const plugin_dir = std.fmt.bufPrint(&plugin_dir_buf, "{s}", .{manifest_path[0..slash]}) catch return false;

    var snapshots = [_]HermesFileSnapshot{
        snapshotHermesFile(allocator, config_path),
        snapshotHermesFile(allocator, allow_path),
        snapshotHermesFile(allocator, manifest_path),
        snapshotHermesFile(allocator, init_path),
    };
    defer for (&snapshots) |*snapshot| {
        if (snapshot.content) |content| allocator.free(content);
    };
    if (!validHermesSnapshots(&snapshots)) return false;

    plat.makeDir(dir);
    if (!writeHermesHooks(allocator, config_path, true)) {
        restoreHermesFiles(&snapshots);
        return false;
    }
    if (!writeHermesDesktopPluginEnabled(allocator, config_path, true)) {
        restoreHermesFiles(&snapshots);
        return false;
    }
    if (!writeHermesAllowlist(allocator, allow_path, true)) {
        restoreHermesFiles(&snapshots);
        return false;
    }

    plat.makeDir(plugin_dir);
    if (!backupOnce(allocator, manifest_path) or !backupOnce(allocator, init_path) or !writeFile(manifest_path, hermes_desktop_plugin_manifest) or !writeFile(init_path, hermes_desktop_plugin_init)) {
        restoreHermesFiles(&snapshots);
        return false;
    }
    return true;
}

fn uninstallHermes(allocator: std.mem.Allocator, home: []const u8) bool {
    var path_buf: [512]u8 = undefined;
    const config_path = hermesConfigPath(&path_buf, home) orelse return false;
    var allow_buf: [512]u8 = undefined;
    const allow_path = hermesAllowlistPath(&allow_buf, home) orelse return false;
    var manifest_buf: [512]u8 = undefined;
    const manifest_path = hermesDesktopPluginPath(&manifest_buf, home, "plugin.yaml") orelse return false;
    var init_buf: [512]u8 = undefined;
    const init_path = hermesDesktopPluginPath(&init_buf, home, "__init__.py") orelse return false;

    var snapshots = [_]HermesFileSnapshot{
        snapshotHermesFile(allocator, config_path),
        snapshotHermesFile(allocator, allow_path),
        snapshotHermesFile(allocator, manifest_path),
        snapshotHermesFile(allocator, init_path),
    };
    defer for (&snapshots) |*snapshot| {
        if (snapshot.content) |content| allocator.free(content);
    };
    if (!validHermesSnapshots(&snapshots)) return false;
    if (snapshots[2].existed and !std.mem.eql(u8, snapshots[2].content.?, hermes_desktop_plugin_manifest)) return false;
    if (snapshots[3].existed and !std.mem.eql(u8, snapshots[3].content.?, hermes_desktop_plugin_init)) return false;

    if (!writeHermesHooks(allocator, config_path, false) or
        !writeHermesDesktopPluginEnabled(allocator, config_path, false) or
        !writeHermesAllowlist(allocator, allow_path, false))
    {
        restoreHermesFiles(&snapshots);
        return false;
    }
    plat.deleteFile(manifest_path);
    plat.deleteFile(init_path);
    return true;
}

/// opencode has no hooks: it loads a self-contained JS plugin that
/// posts straight to the in-process hook server from inside its own runtime. Install
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
    var nested_features_seen = false;
    while (line_start <= toml.len) {
        const relative_end = std.mem.indexOfScalar(u8, toml[line_start..], '\n');
        const line_end = if (relative_end) |end| line_start + end else toml.len;
        const line = toml[line_start..line_end];
        const trimmed = std.mem.trim(u8, line, " \t\r\n");
        if (trimmed.len > 0 and trimmed[0] == '[') {
            const name = sectionName(trimmed) orelse return .{ .state = .unsafe };
            if (std.mem.eql(u8, name, "features")) {
                // A child table before its parent makes an insertion at the
                // end ambiguous, so keep that layout conservative. Once the
                // parent is known, later [features.*] tables do not change
                // the top-level hooks key and are safe to ignore.
                if (features_insert_offset != null or nested_features_seen) return .{ .state = .unsafe };
                current_features = true;
            } else if (std.mem.startsWith(u8, name, "features.")) {
                nested_features_seen = true;
                current_features = false;
            } else {
                current_features = false;
            }
            at_root = false;
            if (current_features) {
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
    if (nested_features_seen) return .{ .state = .unsafe };
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
            // Unreachable: no legacy runner ever wrote these hooks, so this
            // cannot scan as .node. Install is the consistent answer anyway.
            .qoder => installQoder(allocator, home),
            .kimi_code => installKimiCode(allocator, home),
            .codebuddy => installCodeBuddy(allocator, home),
            .omp => installOmp(allocator, home),
            .hermes => continue,
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
        .qoder => return uninstallQoder(allocator, home),
        .kimi_code => {
            const p = kimiConfigPath(&path_buf, home) orelse return false;
            return writeKimiHooks(allocator, p, false);
        },
        .codebuddy => {
            const p = std.fmt.bufPrint(&path_buf, "{s}/.codebuddy/settings.json", .{home}) catch return false;
            return uninstallJsonHooks(allocator, p);
        },
        .omp => {
            const p = ompExtensionPath(&path_buf, home) orelse return false;
            plat.deleteFile(p);
            return true;
        },
        .hermes => return uninstallHermes(allocator, home),
    }
}

// -------------------------------------------------------------- tests

const t = std.testing;

/// The Windows command contains mutually exclusive HOME and USERPROFILE
/// branches, so its phase/agent text is present twice even though cmd.exe
/// executes at most one branch. Unix has one canonical invocation.
fn expectedCanonicalHookTextOccurrences() usize {
    return if (builtin.os.tag == .windows) 2 else 1;
}

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
    const home = ".zig-cache/petdex-agenthooks-fixture";
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
    try t.expectEqual(expectedCanonicalHookTextOccurrences(), std.mem.count(u8, merged2, "bubble pre claude-code"));
    // Backup exists.
    const bak = std.fmt.bufPrint(&pb, "{s}/.claude/settings.json.pre-petdex-backup", .{home}) catch unreachable;
    try t.expect(fileExists(bak));
}

test "installCodex migrates legacy hooks without dropping a foreign hook" {
    const home = ".zig-cache/petdex-agenthooks-codex-fixture";
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
    const home = ".zig-cache/petdex-claude-cfgdir-home";
    const alt = ".zig-cache/petdex-claude-cfgdir-alt";
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

test "installQoder writes six events and stays out of the rest of the config" {
    const home = ".zig-cache/petdex-qoder-fixture";
    plat.makeDir(home ++ "/.qoder");
    const fixture =
        \\{"model":"auto","hooksConfig":{"enabled":false},"hooks":{"PreToolUse":[
        \\ {"matcher":"Bash","hooks":[{"type":"command","command":"my-own-thing"}]}
        \\]},"statusLine":{"type":"command"}}
    ;
    var pb: [512]u8 = undefined;
    const cfg = std.fmt.bufPrint(&pb, "{s}/.qoder/settings.json", .{home}) catch unreachable;
    try t.expect(writeFile(cfg, fixture));
    try t.expect(installQoder(t.allocator, home));
    const merged = readFileAlloc(t.allocator, cfg, 1024 * 1024).?;
    defer t.allocator.free(merged);

    // All six events, including the one no other agent reports.
    for ([_][]const u8{ "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification", "Stop" }) |event| {
        try t.expect(std.mem.indexOf(u8, merged, event) != null);
    }
    try t.expect(std.mem.indexOf(u8, merged, "bubble tool-failure qoder") != null);
    try t.expect(std.mem.indexOf(u8, merged, "\"timeout\": 2") != null);
    // Foreign keys and the user's own hook survive untouched.
    try t.expect(std.mem.indexOf(u8, merged, "my-own-thing") != null);
    try t.expect(std.mem.indexOf(u8, merged, "statusLine") != null);
    // hooksConfig.enabled defaults true upstream, so a deliberate opt-out must
    // survive: install writes nothing outside the hooks object.
    try t.expect(std.mem.indexOf(u8, merged, "\"enabled\": false") != null);
    try t.expect(std.mem.indexOf(u8, merged, "disableAllHooks") == null);

    // Idempotent.
    try t.expect(installQoder(t.allocator, home));
    const merged2 = readFileAlloc(t.allocator, cfg, 1024 * 1024).?;
    defer t.allocator.free(merged2);
    try t.expectEqual(expectedCanonicalHookTextOccurrences(), std.mem.count(u8, merged2, "bubble pre qoder"));
    try t.expectEqual(expectedCanonicalHookTextOccurrences(), std.mem.count(u8, merged2, "bubble tool-failure qoder"));

    const bak = std.fmt.bufPrint(&pb, "{s}/.qoder/settings.json.pre-petdex-backup", .{home}) catch unreachable;
    try t.expect(fileExists(bak));
}

const qoder_row = @intFromEnum(AgentKind.qoder);

/// Clear every qoder env override and restore the caller's on scope exit.
fn saveQoderEnv() [4]?[]const u8 {
    const saved = [4]?[]const u8{ env_qoder_config_dir, env_qoder_cn_config_dir, env_qoder_cli_home, env_qoder_cn_cli_home };
    env_qoder_config_dir = null;
    env_qoder_cn_config_dir = null;
    env_qoder_cli_home = null;
    env_qoder_cn_cli_home = null;
    return saved;
}

fn restoreQoderEnv(saved: [4]?[]const u8) void {
    env_qoder_config_dir = saved[0];
    env_qoder_cn_config_dir = saved[1];
    env_qoder_cli_home = saved[2];
    env_qoder_cn_cli_home = saved[3];
}

test "qoderStatus folds the roots worst-first" {
    // Table over every pair the fold can see. `.absent` never reaches it —
    // qoderActionablePaths drops roots that are not there — so the matrix is
    // the three actionable states squared, and the rule has to be symmetric.
    const cases = [_]struct { a: HookStatus, b: HookStatus, want: HookStatus }{
        .{ .a = .current, .b = .current, .want = .current },
        .{ .a = .current, .b = .node, .want = .node },
        .{ .a = .current, .b = .none, .want = .none },
        .{ .a = .node, .b = .current, .want = .node },
        .{ .a = .node, .b = .node, .want = .node },
        .{ .a = .node, .b = .none, .want = .none },
        .{ .a = .none, .b = .current, .want = .none },
        .{ .a = .none, .b = .node, .want = .none },
        .{ .a = .none, .b = .none, .want = .none },
    };
    for (cases) |c| {
        try t.expectEqual(c.want, worseStatus(c.a, c.b));
        try t.expectEqual(c.want, worseStatus(c.b, c.a));
    }
}

test "one qoder row covers every root present" {
    const saved = saveQoderEnv();
    defer restoreQoderEnv(saved);

    // Each case gets its own fixture home. A single home mutated in place would
    // pass once and then fail on re-run, because plat has no recursive delete
    // and the "must be absent" assertions cannot un-create a directory.

    // Neither build installed: no row at all.
    const empty_home = ".zig-cache/petdex-qoder-neither";
    plat.makeDir(empty_home);
    try t.expectEqual(HookStatus.absent, scan(t.allocator, empty_home)[qoder_row].status);

    // Only the CN build present: one row, and Install reaches it.
    const cn_home = ".zig-cache/petdex-qoder-cn-only";
    plat.makeDir(cn_home);
    plat.makeDir(cn_home ++ "/.qoder-cn");
    // "present but not connected" is only reachable from a config this test has
    // not already installed into, so reset rather than depend on a fresh /tmp.
    plat.deleteFile(cn_home ++ "/.qoder-cn/settings.json");
    plat.deleteFile(cn_home ++ "/.qoder-cn/settings.json.pre-petdex-backup");
    try t.expectEqual(HookStatus.none, scan(t.allocator, cn_home)[qoder_row].status);
    try t.expect(installQoder(t.allocator, cn_home));
    try t.expectEqual(HookStatus.current, scan(t.allocator, cn_home)[qoder_row].status);

    // Both present: one Install covers both roots, one Disconnect clears both.
    const both_home = ".zig-cache/petdex-qoder-both";
    plat.makeDir(both_home);
    plat.makeDir(both_home ++ "/.qoder");
    plat.makeDir(both_home ++ "/.qoder-cn");
    plat.deleteFile(both_home ++ "/.qoder/settings.json");
    plat.deleteFile(both_home ++ "/.qoder-cn/settings.json");
    try t.expect(installQoder(t.allocator, both_home));
    try t.expectEqual(HookStatus.current, scan(t.allocator, both_home)[qoder_row].status);
    var pb: [512]u8 = undefined;
    for ([_][]const u8{ ".qoder", ".qoder-cn" }) |leaf| {
        const cfg = std.fmt.bufPrint(&pb, "{s}/{s}/settings.json", .{ both_home, leaf }) catch unreachable;
        const merged = readFileAlloc(t.allocator, cfg, 1024 * 1024).?;
        defer t.allocator.free(merged);
        try t.expect(std.mem.indexOf(u8, merged, "bubble tool-failure qoder") != null);
    }

    try t.expect(uninstall(t.allocator, both_home, .qoder));
    try t.expectEqual(HookStatus.none, scan(t.allocator, both_home)[qoder_row].status);
}

test "a partially connected qoder reads as not installed and one press completes it" {
    const saved = saveQoderEnv();
    defer restoreQoderEnv(saved);

    const home = ".zig-cache/petdex-qoder-partial";
    plat.makeDir(home);
    plat.makeDir(home ++ "/.qoder");
    plat.makeDir(home ++ "/.qoder-cn");
    plat.deleteFile(home ++ "/.qoder/settings.json");
    plat.deleteFile(home ++ "/.qoder-cn/settings.json");

    // Connect the global root only, by writing straight to its config.
    var pb: [512]u8 = undefined;
    const global_cfg = std.fmt.bufPrint(&pb, "{s}/.qoder/settings.json", .{home}) catch unreachable;
    try t.expect(installJsonHooks(t.allocator, global_cfg, &qoder_events, "qoder", 2, false));

    // Worst-first: the untouched CN root decides the button.
    try t.expectEqual(HookStatus.none, scan(t.allocator, home)[qoder_row].status);

    // One press completes it; the already-connected root stays at exactly one
    // entry per event rather than gaining a duplicate.
    try t.expect(installQoder(t.allocator, home));
    try t.expectEqual(HookStatus.current, scan(t.allocator, home)[qoder_row].status);
    const merged = readFileAlloc(t.allocator, global_cfg, 1024 * 1024).?;
    defer t.allocator.free(merged);
    try t.expectEqual(expectedCanonicalHookTextOccurrences(), std.mem.count(u8, merged, "bubble pre qoder"));
}

test "a qoder root we could never write to is excluded, not counted as unhooked" {
    const saved = saveQoderEnv();
    defer restoreQoderEnv(saved);

    const home = ".zig-cache/petdex-qoder-broken-root";
    plat.makeDir(home);
    plat.makeDir(home ++ "/.qoder");
    plat.makeDir(home ++ "/.qoder-cn");
    plat.deleteFile(home ++ "/.qoder/settings.json");

    // The CN root carries a config installJsonHooks would refuse forever.
    var pb: [512]u8 = undefined;
    const broken = std.fmt.bufPrint(&pb, "{s}/.qoder-cn/settings.json", .{home}) catch unreachable;
    const garbage = "{\"hooks\": {\"PreToolUse\": [ truncated";
    try t.expect(writeFile(broken, garbage));

    // Counting it would peg the row at .none behind a button that can never
    // succeed. It is dropped instead, so the row tracks the healthy root.
    try t.expectEqual(HookStatus.none, scan(t.allocator, home)[qoder_row].status);
    try t.expect(installQoder(t.allocator, home));
    try t.expectEqual(HookStatus.current, scan(t.allocator, home)[qoder_row].status);

    // And the refused config is still byte-for-byte untouched.
    const after = readFileAlloc(t.allocator, broken, 1024 * 1024).?;
    defer t.allocator.free(after);
    try t.expectEqualStrings(garbage, after);
}

test "qoder roots that resolve to the same path collapse to one" {
    const saved = saveQoderEnv();
    defer restoreQoderEnv(saved);

    const home = ".zig-cache/petdex-qoder-samepath-home";
    const shared = ".zig-cache/petdex-qoder-samepath-shared";
    plat.makeDir(home);
    plat.makeDir(shared);
    var pb: [512]u8 = undefined;
    const cfg = std.fmt.bufPrint(&pb, "{s}/settings.json", .{shared}) catch unreachable;
    plat.deleteFile(cfg);

    // Both builds pointed at one directory: a misconfiguration, but it must not
    // double-count or double-write.
    env_qoder_config_dir = shared;
    env_qoder_cn_config_dir = shared;
    try t.expectEqual(@as(usize, 1), qoderActionablePaths(t.allocator, home).count);
    try t.expect(installQoder(t.allocator, home));
    const merged = readFileAlloc(t.allocator, cfg, 1024 * 1024).?;
    defer t.allocator.free(merged);
    try t.expectEqual(expectedCanonicalHookTextOccurrences(), std.mem.count(u8, merged, "bubble pre qoder"));
    try t.expectEqual(HookStatus.current, scan(t.allocator, home)[qoder_row].status);
}

test "Windows qoder paths collapse across separator and case spelling" {
    if (builtin.os.tag != .windows) return;
    const saved = saveQoderEnv();
    defer restoreQoderEnv(saved);

    const home = ".zig-cache/petdex-qoder-equivalent-home";
    const shared = ".zig-cache/petdex-qoder-equivalent-shared";
    plat.makeDir(home);
    plat.makeDir(shared);

    // Windows paths are case-insensitive and accept both slash styles. The
    // two overrides therefore identify one settings.json despite differing
    // bytes, so install must not rewrite it once per Qoder build.
    env_qoder_config_dir = shared;
    env_qoder_cn_config_dir = ".\\ZIG-CACHE\\PETDEX-QODER-EQUIVALENT-SHARED";
    try t.expectEqual(@as(usize, 1), qoderActionablePaths(t.allocator, home).count);
}

test "each qoder root honours only its own env overrides" {
    const saved = saveQoderEnv();
    defer restoreQoderEnv(saved);

    // A home with no ~/.qoder at all: only the override dir exists.
    const home = ".zig-cache/petdex-qoder-env-home";
    const alt = ".zig-cache/petdex-qoder-env-alt";
    plat.makeDir(home);
    plat.makeDir(alt);
    var pb: [512]u8 = undefined;
    const alt_cfg = std.fmt.bufPrint(&pb, "{s}/settings.json", .{alt}) catch unreachable;
    plat.deleteFile(alt_cfg);

    // The global build's variable must move the global root and nothing else:
    // the CN root stays unresolved, so the row reflects the override alone.
    env_qoder_config_dir = alt;
    try t.expect(installQoder(t.allocator, home));
    const written = readFileAlloc(t.allocator, alt_cfg, 1024 * 1024).?;
    defer t.allocator.free(written);
    try t.expect(std.mem.indexOf(u8, written, "bubble pre qoder") != null);

    var def_pb: [512]u8 = undefined;
    const default_cfg = std.fmt.bufPrint(&def_pb, "{s}/.qoder/settings.json", .{home}) catch unreachable;
    try t.expect(!fileExists(default_cfg));
    try t.expectEqual(HookStatus.current, scan(t.allocator, home)[qoder_row].status);

    try t.expect(uninstall(t.allocator, home, .qoder));
    const cleared = readFileAlloc(t.allocator, alt_cfg, 1024 * 1024).?;
    defer t.allocator.free(cleared);
    try t.expect(std.mem.indexOf(u8, cleared, "petdex-hook") == null);

    // CLI_HOME relocates the home directory rather than the root, so the leaf
    // is still appended. Empty string reads as unset, matching Claude's rule.
    env_qoder_config_dir = "";
    env_qoder_cli_home = ".zig-cache/petdex-qoder-clihome";
    plat.makeDir(".zig-cache/petdex-qoder-clihome");
    plat.makeDir(".zig-cache/petdex-qoder-clihome/.qoder");
    try t.expect(installQoder(t.allocator, home));
    const cli_home_cfg = std.fmt.bufPrint(&pb, ".zig-cache/petdex-qoder-clihome/.qoder/settings.json", .{}) catch unreachable;
    try t.expect(fileExists(cli_home_cfg));
    try t.expectEqual(HookStatus.current, scan(t.allocator, home)[qoder_row].status);
}

test "installQoder removes only its command from a mixed hook group" {
    const home = ".zig-cache/petdex-qoder-mixed";
    plat.makeDir(home ++ "/.qoder");
    var path_buf: [512]u8 = undefined;
    const config = std.fmt.bufPrint(&path_buf, "{s}/.qoder/settings.json", .{home}) catch unreachable;
    const fixture =
        \\{"hooks":{"Stop":[{"hooks":[
        \\ {"type":"command","command":"my-own-stop-hook"},
        \\ {"type":"command","command":"node $HOME/.petdex/bin/petdex.js bubble stop qoder"}
        \\]}]}}
    ;
    try t.expect(writeFile(config, fixture));
    try t.expect(installQoder(t.allocator, home));
    const merged = readFileAlloc(t.allocator, config, 1024 * 1024).?;
    defer t.allocator.free(merged);
    try t.expect(std.mem.indexOf(u8, merged, "my-own-stop-hook") != null);
    try t.expect(std.mem.indexOf(u8, merged, "petdex.js") == null);

    try t.expect(uninstall(t.allocator, home, .qoder));
    const cleared = readFileAlloc(t.allocator, config, 1024 * 1024).?;
    defer t.allocator.free(cleared);
    try t.expect(std.mem.indexOf(u8, cleared, "my-own-stop-hook") != null);
    try t.expect(std.mem.indexOf(u8, cleared, "petdex-hook") == null);
}

test "installQoder refuses a malformed config without overwriting it" {
    const home = ".zig-cache/petdex-qoder-malformed";
    plat.makeDir(home ++ "/.qoder");
    var path_buf: [512]u8 = undefined;
    const config = std.fmt.bufPrint(&path_buf, "{s}/.qoder/settings.json", .{home}) catch unreachable;
    const broken = "{\"hooks\": {\"PreToolUse\": [ truncated";
    try t.expect(writeFile(config, broken));
    try t.expect(!installQoder(t.allocator, home));
    const after = readFileAlloc(t.allocator, config, 1024 * 1024).?;
    defer t.allocator.free(after);
    try t.expectEqualStrings(broken, after);
}

test "installClaude removes only its command from a mixed hook group" {
    const home = ".zig-cache/petdex-agenthooks-mixed-group-fixture";
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
    const home = ".zig-cache/petdex-agenthooks-user-script-fixture";
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
    const home = ".zig-cache/petdex-agenthooks-migrate-fixture";
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
        \\{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"exec \"$HOME/.petdex/bin/petdex-hook-state\" jumping codex 800 >/dev/null 2>&1 # legacy"}]}]}}
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
    try t.expect(std.mem.indexOf(u8, codex_after, "petdex-hook-state") == null);
    try t.expect(std.mem.indexOf(u8, codex_after, "update-token") == null);
    try t.expect(std.mem.indexOf(u8, codex_after, "petdex-hook") != null);
    const gemini_after = readFileAlloc(t.allocator, gemini, 64 * 1024).?;
    defer t.allocator.free(gemini_after);
    try t.expect(std.mem.indexOf(u8, gemini_after, "petdex.js") == null);
    try t.expect(std.mem.indexOf(u8, gemini_after, "petdex-hook") != null);
}

test "installJsonHooks refuses malformed configs without overwriting them" {
    const home = ".zig-cache/petdex-agenthooks-invalid-json";
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

test "canonical commands match the host shell contract" {
    var unix_buf: [512]u8 = undefined;
    const unix = canonicalCommandForTarget(&unix_buf, "pre", "claude-code", false).?;
    try t.expect(std.mem.indexOf(u8, unix, "hooks-disabled") != null);
    try t.expect(std.mem.indexOf(u8, unix, "petdex-hook\" bubble pre claude-code") != null);
    try t.expectEqual(@as(usize, 2), std.mem.count(u8, unix, "cat >/dev/null"));

    var windows_buf: [512]u8 = undefined;
    const windows = canonicalCommandForTarget(&windows_buf, "pre", "claude-code", true).?;
    try t.expect(std.mem.indexOf(u8, windows, "%USERPROFILE%\\.petdex\\bin\\petdex-hook.cmd") != null);
    try t.expect(std.mem.indexOf(u8, windows, "bubble pre claude-code") != null);
    try t.expect(std.mem.indexOf(u8, windows, "hooks-disabled") == null);
    try t.expect(std.mem.indexOf(u8, windows, "cat >/dev/null") == null);
    try t.expect(std.mem.indexOf(u8, windows, "exec ") == null);
}

test "installGemini enables hooks and uses a millisecond timeout" {
    const home = ".zig-cache/petdex-agenthooks-gemini-fixture";
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

test "legacy state wrapper is recognized by its exact Petdex path" {
    try t.expectEqual(
        ManagedHookGeneration.legacy,
        commandGeneration("exec \"$HOME/.petdex/bin/petdex-hook-state\" jumping codex 800 >/dev/null 2>&1"),
    );
    try t.expectEqual(
        ManagedHookGeneration.legacy,
        commandGeneration("exec \"${HOME}/.petdex/bin/petdex-hook-state\" running claude-code"),
    );
    try t.expectEqual(
        ManagedHookGeneration.none,
        commandGeneration("exec \"$HOME/.petdex/bin/petdex-hook-state-custom\" running codex"),
    );
    try t.expectEqual(
        ManagedHookGeneration.none,
        commandGeneration("exec /tmp/.petdex/bin/petdex-hook-state running codex"),
    );
    try t.expectEqual(
        ManagedHookGeneration.none,
        commandGeneration("echo \"$HOME/.petdex/bin/petdex-hook-state\" running codex"),
    );
    try t.expectEqual(
        ManagedHookGeneration.none,
        commandGeneration("# exec \"$HOME/.petdex/bin/petdex-hook-state\" running codex"),
    );
}

test "command path detection requires both boundaries" {
    try t.expectEqual(ManagedHookGeneration.legacy, commandGeneration("node $HOME/.petdex/bin/petdex.js bubble pre codex"));
    try t.expectEqual(ManagedHookGeneration.legacy, commandGeneration("node ${HOME}/.petdex/bin/petdex.js bubble pre codex"));
    try t.expectEqual(ManagedHookGeneration.none, commandGeneration("node $HOME/.petdex/bin/petdex.js-custom bubble pre codex"));
    try t.expectEqual(ManagedHookGeneration.none, commandGeneration("node /tmp/.petdex/bin/petdex.js bubble pre codex"));
    try t.expectEqual(ManagedHookGeneration.none, commandGeneration("node /tmp/not-petdex/bin/petdex.js bubble pre codex"));
    try t.expectEqual(ManagedHookGeneration.none, commandGeneration("node $HOME/.petdex/bin/petdex.js status"));
}

test "Windows launcher command is classified as current" {
    const command = "if exist \"%HOME%\\.petdex\\bin\\petdex-hook.cmd\" (call \"%HOME%\\.petdex\\bin\\petdex-hook.cmd\" bubble pre codex) else if exist \"%USERPROFILE%\\.petdex\\bin\\petdex-hook.cmd\" (call \"%USERPROFILE%\\.petdex\\bin\\petdex-hook.cmd\" bubble pre codex) & exit /b 0";
    try t.expectEqual(ManagedHookGeneration.current, commandGenerationForTarget(command, true));
    try t.expectEqual(ManagedHookGeneration.legacy, commandGenerationForTarget(command, false));
}

test "Windows upgrades the old POSIX runner instead of treating it as current" {
    const command = "if [ -x \"$HOME/.petdex/bin/petdex-hook\" ]; then exec \"$HOME/.petdex/bin/petdex-hook\" bubble pre codex; fi";
    try t.expectEqual(ManagedHookGeneration.legacy, commandGenerationForTarget(command, true));
    try t.expectEqual(ManagedHookGeneration.current, commandGenerationForTarget(command, false));
}

test "codex feature inspection is section-aware and conservative" {
    try t.expectEqual(FeatureHooksState.enabled, inspectFeatureHooks("[features]\nhooks = true # keep\n").state);
    try t.expectEqual(FeatureHooksState.enabled, inspectFeatureHooks("[features]\nhooks = true\n[features.multi_agent_v2]\nenabled = true\n").state);
    try t.expectEqual(FeatureHooksState.replace_line, inspectFeatureHooks("[features]\nhooks = false\n[features.multi_agent_v2]\nenabled = true\n").state);
    try t.expectEqual(FeatureHooksState.insert_after_features, inspectFeatureHooks("[features]\nmemories = true\n[features.multi_agent_v2]\nenabled = true\n").state);
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
    const home = ".zig-cache/petdex-agenthooks-codex-false-feature";
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
    const home = ".zig-cache/petdex-agenthooks-codex-unsafe-feature";
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
    const home = ".zig-cache/petdex-agenthooks-codex-invalid-hooks";
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
    const home = ".zig-cache/petdex-agenthooks-codex-uninstall-fixture";
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

test "kimi writes its hooks as TOML and keeps foreign config" {
    const saved = env_kimi_code_home;
    defer env_kimi_code_home = saved;
    const home = ".zig-cache/petdex-kimi-home";
    plat.makeDir(home);
    plat.makeDir(home ++ "/.kimi-code");
    var pb: [512]u8 = undefined;
    const cfg = std.fmt.bufPrint(&pb, "{s}/.kimi-code/config.toml", .{home}) catch unreachable;
    // A config the user already owns, including a hook of their own.
    try t.expect(writeFile(cfg,
        \\model = "kimi-k2"
        \\
        \\[[hooks]]
        \\event = "PreToolUse"
        \\command = "my-own-linter"
        \\
    ));

    try t.expect(installKimiCode(t.allocator, home));
    const written = readFileAlloc(t.allocator, cfg, 1024 * 1024).?;
    defer t.allocator.free(written);
    // Ours landed, one table per event.
    try t.expect(std.mem.indexOf(u8, written, "PostToolUseFailure") != null);
    try t.expect(std.mem.indexOf(u8, written, "petdex-hook") != null);
    // Theirs survived, untouched.
    try t.expect(std.mem.indexOf(u8, written, "my-own-linter") != null);
    try t.expect(std.mem.indexOf(u8, written, "model = \"kimi-k2\"") != null);

    // Re-install refreshes rather than duplicating.
    try t.expect(installKimiCode(t.allocator, home));
    const again = readFileAlloc(t.allocator, cfg, 1024 * 1024).?;
    defer t.allocator.free(again);
    try t.expectEqual(std.mem.count(u8, written, "petdex-hook"), std.mem.count(u8, again, "petdex-hook"));

    // Uninstall removes only ours.
    try t.expect(uninstall(t.allocator, home, .kimi_code));
    const cleared = readFileAlloc(t.allocator, cfg, 1024 * 1024).?;
    defer t.allocator.free(cleared);
    try t.expect(std.mem.indexOf(u8, cleared, "petdex") == null);
    try t.expect(std.mem.indexOf(u8, cleared, "my-own-linter") != null);
    try t.expect(std.mem.indexOf(u8, cleared, "model = \"kimi-k2\"") != null);
}

test "KIMI_CODE_HOME redirects install and detection" {
    const saved = env_kimi_code_home;
    defer env_kimi_code_home = saved;
    const home = ".zig-cache/petdex-kimi-nohome";
    const alt = ".zig-cache/petdex-kimi-alt";
    plat.makeDir(home);
    plat.makeDir(alt);
    var pb: [512]u8 = undefined;
    const alt_cfg = std.fmt.bufPrint(&pb, "{s}/config.toml", .{alt}) catch unreachable;
    plat.deleteFile(alt_cfg);

    env_kimi_code_home = alt;
    try t.expect(installKimiCode(t.allocator, home));
    try t.expect(fileExists(alt_cfg));
    // Nothing leaked into the default root.
    var db: [512]u8 = undefined;
    const default_cfg = std.fmt.bufPrint(&db, "{s}/.kimi-code/config.toml", .{home}) catch unreachable;
    try t.expect(!fileExists(default_cfg));

    const agents = scan(t.allocator, home);
    try t.expectEqual(HookStatus.current, agents[@intFromEnum(AgentKind.kimi_code)].status);

    // Blank and unset both fall back, so a shell exporting an empty var
    // does not silently write to a directory named "".
    env_kimi_code_home = "";
    const blank = scan(t.allocator, home);
    try t.expectEqual(HookStatus.absent, blank[@intFromEnum(AgentKind.kimi_code)].status);
}

test "kimi hook headers tolerate TOML whitespace" {
    try t.expect(isKimiHookHeader("[[hooks]]"));
    try t.expect(isKimiHookHeader("  [[hooks]]  "));
    try t.expect(isKimiHookHeader("[[ hooks ]]"));
    // Not ours: a different table, or a single-bracket table of the same name.
    try t.expect(!isKimiHookHeader("[[mcp_servers]]"));
    try t.expect(!isKimiHookHeader("[hooks]"));
    try t.expect(!isKimiHookHeader("command = \"[[hooks]]\""));
}

test "codebuddy merges into its own config and leaves Claude's alone" {
    const home = ".zig-cache/petdex-codebuddy-home";
    plat.makeDir(home);
    plat.makeDir(home ++ "/.codebuddy");
    plat.makeDir(home ++ "/.claude");
    var pb: [512]u8 = undefined;
    const cfg = std.fmt.bufPrint(&pb, "{s}/.codebuddy/settings.json", .{home}) catch unreachable;
    try t.expect(writeFile(cfg,
        \\{"model":"codebuddy-pro","hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"my-own-hook"}]}]}}
    ));
    // A Claude config that must not be touched: CodeBuddy is derived from
    // Claude Code, so writing to the wrong file is the plausible mistake.
    var cb: [512]u8 = undefined;
    const claude_cfg = std.fmt.bufPrint(&cb, "{s}/.claude/settings.json", .{home}) catch unreachable;
    try t.expect(writeFile(claude_cfg, "{\"untouched\":true}"));

    try t.expect(installCodeBuddy(t.allocator, home));
    const written = readFileAlloc(t.allocator, cfg, 1024 * 1024).?;
    defer t.allocator.free(written);
    try t.expect(std.mem.indexOf(u8, written, "petdex-hook") != null);
    try t.expect(std.mem.indexOf(u8, written, "my-own-hook") != null);
    try t.expect(std.mem.indexOf(u8, written, "codebuddy-pro") != null);

    const claude_after = readFileAlloc(t.allocator, claude_cfg, 1024 * 1024).?;
    defer t.allocator.free(claude_after);
    try t.expect(std.mem.indexOf(u8, claude_after, "petdex") == null);

    const agents = scan(t.allocator, home);
    try t.expectEqual(HookStatus.current, agents[@intFromEnum(AgentKind.codebuddy)].status);

    try t.expect(uninstall(t.allocator, home, .codebuddy));
    const cleared = readFileAlloc(t.allocator, cfg, 1024 * 1024).?;
    defer t.allocator.free(cleared);
    try t.expect(std.mem.indexOf(u8, cleared, "petdex-hook") == null);
    try t.expect(std.mem.indexOf(u8, cleared, "my-own-hook") != null);
}

test "codebuddy wires only events with documented payloads" {
    // It declares 27+ events; the long tail has no documented schema, so
    // guessing at field names is how an adapter starts reading garbage.
    for (codebuddy_events) |ev| {
        const documented = std.mem.eql(u8, ev.event, "UserPromptSubmit") or
            std.mem.eql(u8, ev.event, "PreToolUse") or
            std.mem.eql(u8, ev.event, "PostToolUse") or
            std.mem.eql(u8, ev.event, "Notification") or
            std.mem.eql(u8, ev.event, "Stop");
        try t.expect(documented);
    }
    // No tool-failure phase: CodeBuddy reports failure as a field on
    // PostToolUse rather than its own event, and inferring it from prose
    // would light `failed` on healthy calls. Deliberate, not an omission.
    for (codebuddy_events) |ev| {
        try t.expect(!std.mem.eql(u8, ev.phase, "tool-failure"));
    }
}

test "omp install writes the extension where OMP discovers it" {
    const saved = env_pi_coding_agent_dir;
    defer env_pi_coding_agent_dir = saved;
    env_pi_coding_agent_dir = null;

    const home = ".zig-cache/petdex-omp-home";
    plat.makeDir(home);
    plat.makeDir(home ++ "/.omp");
    plat.makeDir(home ++ "/.omp/agent");
    var pb: [512]u8 = undefined;
    const ext = std.fmt.bufPrint(&pb, "{s}/.omp/agent/extensions/petdex.ts", .{home}) catch unreachable;
    plat.deleteFile(ext);

    try t.expect(installOmp(t.allocator, home));
    const written = readFileAlloc(t.allocator, ext, 1024 * 1024).?;
    defer t.allocator.free(written);
    // A single .ts file with a default export is all OMP needs; no
    // manifest, so the file itself has to carry the factory.
    try t.expect(std.mem.indexOf(u8, written, "export default function") != null);
    // Failure comes from isError on tool_result, not from parsing text.
    try t.expect(std.mem.indexOf(u8, written, "isError") != null);
    // Each OMP event must identify its conversation so concurrent sessions
    // remain separate in the desktop mailbox.
    try t.expect(std.mem.indexOf(u8, written, "session_id") != null);
    try t.expect(std.mem.indexOf(u8, written, "getSessionId") != null);

    const agents = scan(t.allocator, home);
    try t.expectEqual(HookStatus.current, agents[@intFromEnum(AgentKind.omp)].status);

    try t.expect(uninstall(t.allocator, home, .omp));
    try t.expect(!fileExists(ext));
}

test "PI_CODING_AGENT_DIR relocates the whole OMP agent base" {
    const saved = env_pi_coding_agent_dir;
    defer env_pi_coding_agent_dir = saved;

    const home = ".zig-cache/petdex-omp-nohome";
    const alt = ".zig-cache/petdex-omp-alt";
    plat.makeDir(home);
    plat.makeDir(alt);

    env_pi_coding_agent_dir = alt;
    try t.expect(installOmp(t.allocator, home));
    var pb: [512]u8 = undefined;
    const alt_ext = std.fmt.bufPrint(&pb, "{s}/extensions/petdex.ts", .{alt}) catch unreachable;
    try t.expect(fileExists(alt_ext));
    // Nothing leaked into the default root.
    var db: [512]u8 = undefined;
    const default_ext = std.fmt.bufPrint(&db, "{s}/.omp/agent/extensions/petdex.ts", .{home}) catch unreachable;
    try t.expect(!fileExists(default_ext));

    // Blank falls back, so an empty export does not write to a directory
    // literally named "".
    env_pi_coding_agent_dir = "";
    var fb: [512]u8 = undefined;
    const fallback = ompExtensionPath(&fb, home).?;
    try t.expect(std.mem.indexOf(u8, fallback, "/.omp/agent/extensions/") != null);
}

test "omp extension maps every state the sprite sheet has" {
    // The generated file is the whole integration, so a missing state
    // here is a pet that never reaches that row.
    for ([_][]const u8{ "jumping", "review", "running", "idle", "failed", "waiting", "waving" }) |state| {
        try t.expect(std.mem.indexOf(u8, omp_extension, state) != null);
    }
    // Grep bubbles use typographic quotes: an ASCII quote closes the JSON
    // string early and the pattern vanishes (#628).
    try t.expect(std.mem.indexOf(u8, omp_extension, "\\\"") == null);
}

test "opencode plugin carries session ids for tools and lifecycle events" {
    try t.expect(std.mem.indexOf(u8, opencode_plugin, "input.sessionID") != null);
    try t.expect(std.mem.indexOf(u8, opencode_plugin, "event?.properties?.sessionID") != null);
    try t.expect(std.mem.indexOf(u8, opencode_plugin, "session_id") != null);
    try t.expect(std.mem.indexOf(u8, opencode_plugin, "const titleCache = new Map") != null);
}

test "hermesEventKey names only supported Hermes events" {
    try t.expectEqualStrings("pre_tool_call", hermesEventKey("  pre_tool_call:").?);
    try t.expectEqualStrings("pre_llm_call", hermesEventKey("  pre_llm_call:").?);
    try t.expectEqualStrings("on_session_end", hermesEventKey("    on_session_end:").?);
    try t.expect(hermesEventKey("pre_tool_call:") == null);
    try t.expect(hermesEventKey("  unknown_event:") == null);
    try t.expect(hermesEventKey("  - pre_tool_call") == null);
    try t.expect(hermesEventKey("  model: kimi") == null);
}

test "Hermes desktop plugin forwards authoritative titles and prompt events" {
    try t.expect(std.mem.indexOf(u8, hermes_desktop_plugin_init, "pre_llm_call") != null);
    try t.expect(std.mem.indexOf(u8, hermes_desktop_plugin_init, "PRAGMA table_info(sessions)") != null);
    try t.expect(std.mem.indexOf(u8, hermes_desktop_plugin_init, "petdex_session_title") != null);
    try t.expect(std.mem.indexOf(u8, hermes_desktop_plugin_init, "petdex_conversation_key") != null);
    try t.expect(std.mem.indexOf(u8, hermes_desktop_plugin_init, "post_llm_call") != null);
    try t.expect(std.mem.indexOf(u8, hermes_desktop_plugin_init, "pre_approval_request") != null);
    try t.expect(std.mem.indexOf(u8, hermes_desktop_plugin_init, "subagent_start") != null);
    try t.expect(std.mem.indexOf(u8, hermes_desktop_plugin_init, "child_session_id") != null);
    try t.expect(std.mem.indexOf(u8, hermes_desktop_plugin_init, "_delegate_from") != null);
    try t.expect(std.mem.indexOf(u8, hermes_desktop_plugin_init, "force_subagent") != null);
    try t.expect(std.mem.indexOf(u8, hermes_desktop_plugin_init, "\"kind\": \"subagent\"") != null);
    try t.expect(std.mem.indexOf(u8, hermes_desktop_plugin_init, "not bool(row.get(\"session_key\"))") != null);
    try t.expect(std.mem.indexOf(u8, hermes_desktop_plugin_init, "\"kind\": \"subagent\" if force_subagent else \"primary\"") != null);
    try t.expect(std.mem.indexOf(u8, hermes_desktop_plugin_init, "_conversation_key(conversation)") != null);
    try t.expect(std.mem.indexOf(u8, hermes_desktop_plugin_init, "payload.get(\"session_key\")") != null);
    try t.expect(std.mem.indexOf(u8, hermes_desktop_plugin_init, "child_session_id or parent_session_id") != null);
    try t.expect(std.mem.indexOf(u8, hermes_desktop_plugin_init, "context[\"kind\"] == \"subagent\" and not is_subagent_lifecycle") != null);
}

test "hermes YAML merge preserves foreign keys, refreshes ours" {
    if (builtin.os.tag == .windows) return;
    const home = ".zig-cache/petdex-hermes-home";
    plat.makeDir(home);
    plat.makeDir(home ++ "/.hermes");
    var pb: [512]u8 = undefined;
    const cfg = std.fmt.bufPrint(&pb, "{s}/.hermes/config.yaml", .{home}) catch unreachable;
    plat.deleteFile(cfg);
    try t.expect(writeFile(cfg,
        \\model: kimi-for-coding/k3-256k
        \\hooks:
        \\  pre_tool_call:
        \\    - my-own-hook --flag
        \\  post_tool_call:
        \\    - ~/.petdex/bin/petdex-hook bubble post hermes
        \\other: 42
        \\
    ));

    try t.expect(installHermes(t.allocator, home));
    const written = readFileAlloc(t.allocator, cfg, 1024 * 1024).?;
    defer t.allocator.free(written);
    // Foreign content survives: the user's hook, the other top-level keys.
    try t.expect(std.mem.indexOf(u8, written, "my-own-hook --flag") != null);
    try t.expect(std.mem.indexOf(u8, written, "model: kimi-for-coding/k3-256k") != null);
    try t.expect(std.mem.indexOf(u8, written, "other: 42") != null);
    // Every event is wired to the direct-exec hook binary.
    for (hermes_events) |ev| {
        try t.expect(std.mem.indexOf(u8, written, ev.event) != null);
        try t.expect(std.mem.indexOf(u8, written, ev.phase) != null);
    }
    // The legacy post entry was replaced, not duplicated: exactly one
    // petdex command per event.
    try t.expectEqual(hermes_events.len, std.mem.count(u8, written, "petdex-hook"));
    try t.expectEqual(@as(usize, 1), std.mem.count(u8, written, "petdex-desktop"));

    var manifest_buf: [512]u8 = undefined;
    const manifest = hermesDesktopPluginPath(&manifest_buf, home, "plugin.yaml").?;
    var init_buf: [512]u8 = undefined;
    const init_file = hermesDesktopPluginPath(&init_buf, home, "__init__.py").?;
    try t.expect(fileExists(manifest));
    try t.expect(fileExists(init_file));

    // Re-install is idempotent.
    try t.expect(installHermes(t.allocator, home));
    const again = readFileAlloc(t.allocator, cfg, 1024 * 1024).?;
    defer t.allocator.free(again);
    try t.expectEqual(std.mem.count(u8, written, "petdex-hook"), std.mem.count(u8, again, "petdex-hook"));

    const agents = scan(t.allocator, home);
    try t.expectEqual(HookStatus.current, agents[@intFromEnum(AgentKind.hermes)].status);

    // Uninstall strips ours and keeps the user's hook and keys.
    try t.expect(uninstall(t.allocator, home, .hermes));
    const cleared = readFileAlloc(t.allocator, cfg, 1024 * 1024).?;
    defer t.allocator.free(cleared);
    try t.expect(std.mem.indexOf(u8, cleared, "petdex") == null);
    try t.expect(std.mem.indexOf(u8, cleared, "my-own-hook --flag") != null);
    try t.expect(std.mem.indexOf(u8, cleared, "other: 42") != null);
}

test "hermes desktop plugin preserves existing enabled and disabled plugins" {
    if (builtin.os.tag == .windows) return;
    const home = ".zig-cache/petdex-hermes-desktop-plugin";
    plat.makeDir(home);
    plat.makeDir(home ++ "/.hermes");
    var pb: [512]u8 = undefined;
    const cfg = std.fmt.bufPrint(&pb, "{s}/.hermes/config.yaml", .{home}) catch unreachable;
    plat.deleteFile(cfg);
    try t.expect(writeFile(cfg,
        \\plugins:
        \\  enabled:
        \\  - basic
        \\  - disk-cleanup
        \\  disabled:
        \\  - browser-browser-use
        \\
    ));

    try t.expect(installHermes(t.allocator, home));
    const installed = readFileAlloc(t.allocator, cfg, 1024 * 1024).?;
    defer t.allocator.free(installed);
    try t.expect(std.mem.indexOf(u8, installed, "- basic") != null);
    try t.expect(std.mem.indexOf(u8, installed, "- disk-cleanup") != null);
    try t.expect(std.mem.indexOf(u8, installed, "- browser-browser-use") != null);
    try t.expectEqual(@as(usize, 1), std.mem.count(u8, installed, "petdex-desktop"));

    try t.expect(uninstallHermes(t.allocator, home));
    const removed = readFileAlloc(t.allocator, cfg, 1024 * 1024).?;
    defer t.allocator.free(removed);
    try t.expect(std.mem.indexOf(u8, removed, "petdex-desktop") == null);
    try t.expect(std.mem.indexOf(u8, removed, "- basic") != null);
    try t.expect(std.mem.indexOf(u8, removed, "- disk-cleanup") != null);
    try t.expect(std.mem.indexOf(u8, removed, "- browser-browser-use") != null);
}

test "hermes compatibility plugin is scoped to desktop backends" {
    try t.expect(std.mem.indexOf(u8, hermes_desktop_plugin_init, "{\"serve\", \"dashboard\"}") != null);
    try t.expect(std.mem.indexOf(u8, hermes_desktop_plugin_init, "ctx.register_hook") != null);
    try t.expect(std.mem.indexOf(u8, hermes_desktop_plugin_init, "petdex-hook") != null);
}

test "hermes allowlist pre-records consent, dedupes, uninstall strips" {
    if (builtin.os.tag == .windows) return;
    const home = ".zig-cache/petdex-hermes-allow";
    plat.makeDir(home);
    plat.makeDir(home ++ "/.hermes");
    var pb: [512]u8 = undefined;
    const allow = std.fmt.bufPrint(&pb, "{s}/.hermes/shell-hooks-allowlist.json", .{home}) catch unreachable;
    plat.deleteFile(allow);
    try t.expect(writeFile(allow,
        \\{"approvals":[{"event":"pre_tool_call","command":"my-own-thing"}]}
    ));

    try t.expect(installHermes(t.allocator, home));
    const written = readFileAlloc(t.allocator, allow, 1024 * 1024).?;
    defer t.allocator.free(written);
    try t.expect(std.mem.indexOf(u8, written, "my-own-thing") != null);
    // One approval per event, each carrying the exact command hermes
    // matches against before running a hook.
    try t.expectEqual(hermes_events.len, std.mem.count(u8, written, "petdex-hook"));

    try t.expect(installHermes(t.allocator, home));
    const again = readFileAlloc(t.allocator, allow, 1024 * 1024).?;
    defer t.allocator.free(again);
    try t.expectEqual(std.mem.count(u8, written, "petdex-hook"), std.mem.count(u8, again, "petdex-hook"));

    try t.expect(uninstall(t.allocator, home, .hermes));
    const cleared = readFileAlloc(t.allocator, allow, 1024 * 1024).?;
    defer t.allocator.free(cleared);
    try t.expect(std.mem.indexOf(u8, cleared, "petdex") == null);
    try t.expect(std.mem.indexOf(u8, cleared, "my-own-thing") != null);
}

test "HERMES_HOME redirects install and detection" {
    if (builtin.os.tag == .windows) return;
    const saved = env_hermes_home;
    defer env_hermes_home = saved;
    const home = ".zig-cache/petdex-hermes-nohome";
    const alt = ".zig-cache/petdex-hermes-alt";
    plat.makeDir(home);
    plat.makeDir(alt);
    var pb: [512]u8 = undefined;
    const alt_cfg = std.fmt.bufPrint(&pb, "{s}/config.yaml", .{alt}) catch unreachable;
    plat.deleteFile(alt_cfg);

    env_hermes_home = alt;
    try t.expect(installHermes(t.allocator, home));
    try t.expect(fileExists(alt_cfg));
    // Nothing leaked into the default root.
    var db: [512]u8 = undefined;
    const default_cfg = std.fmt.bufPrint(&db, "{s}/.hermes/config.yaml", .{home}) catch unreachable;
    try t.expect(!fileExists(default_cfg));

    const agents = scan(t.allocator, home);
    try t.expectEqual(HookStatus.current, agents[@intFromEnum(AgentKind.hermes)].status);

    // Blank and unset both fall back, so a shell exporting an empty var
    // does not silently write to a directory named "".
    env_hermes_home = "";
    const blank = scan(t.allocator, home);
    try t.expectEqual(HookStatus.absent, blank[@intFromEnum(AgentKind.hermes)].status);
}

test "Hermes empty flow hooks install without duplicate YAML keys" {
    if (builtin.os.tag == .windows) return;
    const home = ".zig-cache/petdex-hermes-empty-flow";
    plat.makeDir(home);
    plat.makeDir(home ++ "/.hermes");
    var pb: [512]u8 = undefined;
    const cfg = std.fmt.bufPrint(&pb, "{s}/.hermes/config.yaml", .{home}) catch unreachable;
    plat.deleteFile(cfg);
    try t.expect(writeFile(cfg, "hooks: []\nmodel: test\n"));

    try t.expect(installHermes(t.allocator, home));
    const installed = readFileAlloc(t.allocator, cfg, 1024 * 1024).?;
    defer t.allocator.free(installed);
    try t.expectEqual(@as(usize, 1), std.mem.count(u8, installed, "hooks:"));
    try t.expect(std.mem.indexOf(u8, installed, "model: test") != null);
}

test "Hermes unsupported plugin YAML fails without partial writes" {
    if (builtin.os.tag == .windows) return;
    const home = ".zig-cache/petdex-hermes-unsupported-plugin-yaml";
    plat.makeDir(home);
    plat.makeDir(home ++ "/.hermes");
    var pb: [512]u8 = undefined;
    const cfg = std.fmt.bufPrint(&pb, "{s}/.hermes/config.yaml", .{home}) catch unreachable;
    plat.deleteFile(cfg);
    const original = "plugins:\n  enabled: [basic]\n";
    try t.expect(writeFile(cfg, original));

    try t.expect(!installHermes(t.allocator, home));
    const after = readFileAlloc(t.allocator, cfg, 1024 * 1024).?;
    defer t.allocator.free(after);
    try t.expectEqualStrings(original, after);
}

test "Hermes malformed allowlist and foreign petdex names are preserved" {
    if (builtin.os.tag == .windows) return;
    const home = ".zig-cache/petdex-hermes-allow-safety";
    plat.makeDir(home);
    plat.makeDir(home ++ "/.hermes");
    var pb: [512]u8 = undefined;
    const allow = std.fmt.bufPrint(&pb, "{s}/.hermes/shell-hooks-allowlist.json", .{home}) catch unreachable;
    plat.deleteFile(allow);
    const malformed = "{not-json\n";
    try t.expect(writeFile(allow, malformed));
    try t.expect(!writeHermesAllowlist(t.allocator, allow, true));
    const unchanged = readFileAlloc(t.allocator, allow, 1024 * 1024).?;
    defer t.allocator.free(unchanged);
    try t.expectEqualStrings(malformed, unchanged);

    try t.expect(writeFile(allow,
        \\{"approvals":[{"event":"pre_tool_call","command":"petdex-audit-helper"}]}
    ));
    try t.expect(writeHermesAllowlist(t.allocator, allow, true));
    const merged = readFileAlloc(t.allocator, allow, 1024 * 1024).?;
    defer t.allocator.free(merged);
    try t.expect(std.mem.indexOf(u8, merged, "petdex-audit-helper") != null);
}

test "Hermes scan requires complete approvals and plugin assets" {
    if (builtin.os.tag == .windows) return;
    const home = ".zig-cache/petdex-hermes-scan-complete";
    plat.makeDir(home);
    plat.makeDir(home ++ "/.hermes");
    var pb: [512]u8 = undefined;
    const cfg = std.fmt.bufPrint(&pb, "{s}/.hermes/config.yaml", .{home}) catch unreachable;
    plat.deleteFile(cfg);
    try t.expect(installHermes(t.allocator, home));
    try t.expectEqual(HookStatus.current, scan(t.allocator, home)[@intFromEnum(AgentKind.hermes)].status);

    var ab: [512]u8 = undefined;
    const allow = std.fmt.bufPrint(&ab, "{s}/.hermes/shell-hooks-allowlist.json", .{home}) catch unreachable;
    try t.expect(writeFile(allow, "{\"approvals\":[]}\n"));
    try t.expectEqual(HookStatus.node, scan(t.allocator, home)[@intFromEnum(AgentKind.hermes)].status);

    try t.expect(installHermes(t.allocator, home));
    var mb: [512]u8 = undefined;
    const manifest = hermesDesktopPluginPath(&mb, home, "plugin.yaml").?;
    plat.deleteFile(manifest);
    try t.expectEqual(HookStatus.node, scan(t.allocator, home)[@intFromEnum(AgentKind.hermes)].status);
}

test "Hermes uninstall rolls back when user configuration cannot be preserved" {
    if (builtin.os.tag == .windows) return;
    const home = ".zig-cache/petdex-hermes-uninstall-rollback";
    plat.makeDir(home);
    plat.makeDir(home ++ "/.hermes");
    var config_buf: [512]u8 = undefined;
    const config = std.fmt.bufPrint(&config_buf, "{s}/.hermes/config.yaml", .{home}) catch unreachable;
    var allow_buf: [512]u8 = undefined;
    const allow = std.fmt.bufPrint(&allow_buf, "{s}/.hermes/shell-hooks-allowlist.json", .{home}) catch unreachable;
    plat.deleteFile(config);
    plat.deleteFile(allow);
    try t.expect(installHermes(t.allocator, home));
    const installed = readFileAlloc(t.allocator, config, 1024 * 1024).?;
    defer t.allocator.free(installed);
    try t.expect(writeFile(allow, "{broken-json\n"));

    try t.expect(!uninstallHermes(t.allocator, home));
    const after = readFileAlloc(t.allocator, config, 1024 * 1024).?;
    defer t.allocator.free(after);
    try t.expectEqualStrings(installed, after);
    const allow_after = readFileAlloc(t.allocator, allow, 1024 * 1024).?;
    defer t.allocator.free(allow_after);
    try t.expectEqualStrings("{broken-json\n", allow_after);
    var init_buf: [512]u8 = undefined;
    try t.expect(fileExists(hermesDesktopPluginPath(&init_buf, home, "__init__.py").?));
}

test "Hermes uninstall preserves a user-modified plugin" {
    if (builtin.os.tag == .windows) return;
    const home = ".zig-cache/petdex-hermes-uninstall-owned-files";
    plat.makeDir(home);
    plat.makeDir(home ++ "/.hermes");
    var config_buf: [512]u8 = undefined;
    const config = std.fmt.bufPrint(&config_buf, "{s}/.hermes/config.yaml", .{home}) catch unreachable;
    plat.deleteFile(config);
    try t.expect(installHermes(t.allocator, home));
    const installed = readFileAlloc(t.allocator, config, 1024 * 1024).?;
    defer t.allocator.free(installed);
    var init_buf: [512]u8 = undefined;
    const init_file = hermesDesktopPluginPath(&init_buf, home, "__init__.py").?;
    try t.expect(writeFile(init_file, "user-owned plugin\n"));

    try t.expect(!uninstallHermes(t.allocator, home));
    const after = readFileAlloc(t.allocator, config, 1024 * 1024).?;
    defer t.allocator.free(after);
    try t.expectEqualStrings(installed, after);
    const plugin_after = readFileAlloc(t.allocator, init_file, 1024 * 1024).?;
    defer t.allocator.free(plugin_after);
    try t.expectEqualStrings("user-owned plugin\n", plugin_after);
}
