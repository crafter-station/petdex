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
    // One row for every Qoder config root (see qoder_roots). Appended, not
    // sorted in: agent_art is indexed by @intFromEnum and the icon strip is
    // read by the same index, so inserting would re-map every existing glyph.
    qoder,
    kimi_code,
    codebuddy,
    omp,

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

pub const agent_count = 8;

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

    fn push(self: *QoderPaths, path: []const u8) void {
        if (path.len > self.bufs[0].len or self.count == self.bufs.len) return;
        // Roots collapse to one file if both *_CONFIG_DIR point at one
        // directory. Writing twice is harmless; counting twice is not.
        for (0..self.count) |i| {
            if (std.mem.eql(u8, self.slice(i), path)) return;
        }
        @memcpy(self.bufs[self.count][0..path.len], path);
        self.lens[self.count] = path.len;
        self.count += 1;
    }
};

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
        out.push(path);
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
        .{ .kind = .qoder },
        .{ .kind = .kimi_code },
        .{ .kind = .codebuddy },
        .{ .kind = .omp },
    };
    // Several roots behind one row: cannot ride the single-dir/single-config
    // shape below, so it is resolved up front. The arms `continue` rather than
    // `unreachable` so dropping this line degrades to "not detected" instead of
    // panicking in release.
    out[@intFromEnum(AgentKind.qoder)].status = qoderStatus(allocator, home);
    var path: [512]u8 = undefined;
    for (&out) |*info| {
        const dir = switch (info.kind) {
            .claude_code => claudeConfigDir(&path, home) orelse continue,
            .codex => std.fmt.bufPrint(&path, "{s}/.codex", .{home}) catch continue,
            .gemini => std.fmt.bufPrint(&path, "{s}/.gemini", .{home}) catch continue,
            .opencode => std.fmt.bufPrint(&path, "{s}/.config/opencode", .{home}) catch continue,
            .qoder => continue,
            .kimi_code => kimiConfigDir(&path, home) orelse continue,
            .codebuddy => std.fmt.bufPrint(&path, "{s}/.codebuddy", .{home}) catch continue,
            .omp => ompAgentDir(&path, home) orelse continue,
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
    while (line_start <= toml.len) {
        const relative_end = std.mem.indexOfScalar(u8, toml[line_start..], '\n');
        const line_end = if (relative_end) |end| line_start + end else toml.len;
        const line = toml[line_start..line_end];
        const trimmed = std.mem.trim(u8, line, " \t\r\n");
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
            // Unreachable: no legacy runner ever wrote these hooks, so this
            // cannot scan as .node. Install is the consistent answer anyway.
            .qoder => installQoder(allocator, home),
            .kimi_code => installKimiCode(allocator, home),
            .codebuddy => installCodeBuddy(allocator, home),
            .omp => installOmp(allocator, home),
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

test "installQoder writes six events and stays out of the rest of the config" {
    const home = "/tmp/petdex-qoder-fixture";
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
    try t.expectEqual(@as(usize, 1), std.mem.count(u8, merged2, "bubble pre qoder"));
    try t.expectEqual(@as(usize, 1), std.mem.count(u8, merged2, "bubble tool-failure qoder"));

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
    const empty_home = "/tmp/petdex-qoder-neither";
    plat.makeDir(empty_home);
    try t.expectEqual(HookStatus.absent, scan(t.allocator, empty_home)[qoder_row].status);

    // Only the CN build present: one row, and Install reaches it.
    const cn_home = "/tmp/petdex-qoder-cn-only";
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
    const both_home = "/tmp/petdex-qoder-both";
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

    const home = "/tmp/petdex-qoder-partial";
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
    try t.expectEqual(@as(usize, 1), std.mem.count(u8, merged, "bubble pre qoder"));
}

test "a qoder root we could never write to is excluded, not counted as unhooked" {
    const saved = saveQoderEnv();
    defer restoreQoderEnv(saved);

    const home = "/tmp/petdex-qoder-broken-root";
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

    const home = "/tmp/petdex-qoder-samepath-home";
    const shared = "/tmp/petdex-qoder-samepath-shared";
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
    try t.expectEqual(@as(usize, 1), std.mem.count(u8, merged, "bubble pre qoder"));
    try t.expectEqual(HookStatus.current, scan(t.allocator, home)[qoder_row].status);
}

test "each qoder root honours only its own env overrides" {
    const saved = saveQoderEnv();
    defer restoreQoderEnv(saved);

    // A home with no ~/.qoder at all: only the override dir exists.
    const home = "/tmp/petdex-qoder-env-home";
    const alt = "/tmp/petdex-qoder-env-alt";
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
    env_qoder_cli_home = "/tmp/petdex-qoder-clihome";
    plat.makeDir("/tmp/petdex-qoder-clihome");
    plat.makeDir("/tmp/petdex-qoder-clihome/.qoder");
    try t.expect(installQoder(t.allocator, home));
    const cli_home_cfg = std.fmt.bufPrint(&pb, "/tmp/petdex-qoder-clihome/.qoder/settings.json", .{}) catch unreachable;
    try t.expect(fileExists(cli_home_cfg));
    try t.expectEqual(HookStatus.current, scan(t.allocator, home)[qoder_row].status);
}

test "installQoder removes only its command from a mixed hook group" {
    const home = "/tmp/petdex-qoder-mixed";
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
    const home = "/tmp/petdex-qoder-malformed";
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

test "kimi writes its hooks as TOML and keeps foreign config" {
    const saved = env_kimi_code_home;
    defer env_kimi_code_home = saved;
    const home = "/tmp/petdex-kimi-home";
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
    const home = "/tmp/petdex-kimi-nohome";
    const alt = "/tmp/petdex-kimi-alt";
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
    const home = "/tmp/petdex-codebuddy-home";
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

    const home = "/tmp/petdex-omp-home";
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

    const agents = scan(t.allocator, home);
    try t.expectEqual(HookStatus.current, agents[@intFromEnum(AgentKind.omp)].status);

    try t.expect(uninstall(t.allocator, home, .omp));
    try t.expect(!fileExists(ext));
}

test "PI_CODING_AGENT_DIR relocates the whole OMP agent base" {
    const saved = env_pi_coding_agent_dir;
    defer env_pi_coding_agent_dir = saved;

    const home = "/tmp/petdex-omp-nohome";
    const alt = "/tmp/petdex-omp-alt";
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
