//! Remote-agent configuration: which SSH hosts run which agents.
//!
//! The desktop owns the hook server on 127.0.0.1:7777; a remote agent
//! reaches it through a reverse tunnel (`ssh -N -R`) that this app
//! supervises per remote. Everything the tunnel supervisor, the
//! writeback installer, and the Settings UI needs to know about a
//! remote lives in one file we own end to end:
//!
//!     ~/.petdex/remote-agents.json
//!
//! The file is a typed JSON document, not a merge target: nothing else
//! writes it, so load/save are a strict round trip and unknown fields
//! are ignored rather than preserved (forward compatibility for
//! downgrades is not a goal; forward compatibility for upgrades is,
//! hence ignore_unknown_fields).

const std = @import("std");
const builtin = @import("builtin");
const agent_hooks = @import("agent_hooks.zig");
const plat = @import("plat.zig");

const AgentKind = agent_hooks.AgentKind;

pub const max_name_bytes: usize = 32;
pub const max_host_bytes: usize = 255;
// remote_ssh prefixes identity paths with "-i" in a 384-byte argv scratch
// buffer, so the configured value must leave room for those two bytes.
pub const max_identity_bytes: usize = 382;
pub const max_agent_home_bytes: usize = 320;
// Native effects retain at most 2048 bytes of argv. The longest SSH command
// has about 1.27 KiB of fixed supervision logic, so keep a safety margin for
// the three config-controlled fields it carries.
pub const max_transport_variable_bytes: usize = 680;
pub const default_hermes_home = "~/.hermes";

fn shellExpansionBytes(value: []const u8) usize {
    var extra: usize = 0;
    for (value) |c| {
        // remote_ssh.shQuote expands one apostrophe to the four-byte '\''
        // sequence, three bytes more than the source character.
        if (c == '\'') extra += 3;
    }
    return value.len + extra;
}

/// Per-agent options for one remote. Today there is exactly one
/// option; the struct exists so each agent can grow its own knobs
/// (custom config dir, extra env) without a schema break.
pub const AgentOptions = struct {
    enabled: bool = false,
    /// Optional remote config root. Hermes uses this as its remote
    /// HERMES_HOME; other agents reserve it for future parity.
    home: ?[]const u8 = null,
};

/// The remote-capable agent set, as a struct so JSON field names pin
/// the wire spelling. Agents that cannot work over SSH (their hooks
/// live in processes the desktop cannot reach, or they have no hook
/// surface at all) simply have no field here.
pub const Agents = struct {
    opencode: AgentOptions = .{},
    codex: AgentOptions = .{},
    hermes: AgentOptions = .{},

    pub fn anyEnabled(self: Agents) bool {
        return self.opencode.enabled or self.codex.enabled or self.hermes.enabled;
    }

    pub fn optionsFor(self: *Agents, kind: AgentKind) ?*AgentOptions {
        return switch (kind) {
            .opencode => &self.opencode,
            .codex => &self.codex,
            .hermes => &self.hermes,
            else => null,
        };
    }

    pub fn optionsForConst(self: *const Agents, kind: AgentKind) ?*const AgentOptions {
        return switch (kind) {
            .opencode => &self.opencode,
            .codex => &self.codex,
            .hermes => &self.hermes,
            else => null,
        };
    }
};

pub const Remote = struct {
    /// Short label for logs, tunnel names, and the Settings list.
    /// [a-zA-Z0-9_-]{1,32}: it appears in file names and log lines.
    name: []const u8 = "",
    /// ssh destination, user@host or host. Passed to ssh as one argv
    /// element, never through a shell.
    host: []const u8 = "",
    port: u16 = 22,
    /// Optional -i identity file path on the desktop.
    identity_file: ?[]const u8 = null,
    /// Master switch: a disabled remote keeps its config but gets no
    /// tunnel and no writeback.
    enabled: bool = true,
    agents: Agents = .{},
};

pub const Config = struct {
    remotes: []Remote = &.{},

    pub fn find(self: *Config, name: []const u8) ?*Remote {
        for (self.remotes) |*r| {
            if (std.mem.eql(u8, r.name, name)) return r;
        }
        return null;
    }
};

/// Fill `out` with the enabled remote-capable kinds, in enum order.
/// Returns how many were written.
pub fn enabledAgents(remote: *const Remote, out: *[3]AgentKind) usize {
    var n: usize = 0;
    for ([_]AgentKind{ .opencode, .codex, .hermes }) |kind| {
        if (remote.agents.optionsForConst(kind).?.enabled) {
            out[n] = kind;
            n += 1;
        }
    }
    return n;
}

pub fn configPath(buf: []u8, home: []const u8) ?[]const u8 {
    return std.fmt.bufPrint(buf, "{s}/.petdex/remote-agents.json", .{home}) catch null;
}

/// Validation returns a static message on the first problem, null when
/// the remote is usable. Called by the Settings UI before saving and by
/// the tunnel supervisor before trusting a loaded config.
pub fn validateRemote(remote: *const Remote) ?[]const u8 {
    if (remote.name.len == 0) return "remote needs a name";
    if (remote.name.len > max_name_bytes) return "remote name is too long (max 32)";
    for (remote.name) |c| {
        const ok = (c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z') or
            (c >= '0' and c <= '9') or c == '_' or c == '-';
        if (!ok) return "remote name: letters, digits, '_' and '-' only";
    }
    if (remote.host.len == 0) return "remote needs a host (user@host or host)";
    if (remote.host.len > max_host_bytes) return "remote host is too long (max 255 bytes)";
    for (remote.host) |c| {
        if (c <= ' ' or c == 0x7f) return "host must not contain whitespace or control characters";
    }
    if (remote.port == 0) return "port must be 1-65535";
    if (remote.identity_file) |p| {
        if (p.len == 0) return "identity file path is empty";
        if (p.len > max_identity_bytes) return "identity file path is too long (max 382 bytes)";
        for (p) |c| {
            if (c < ' ' or c == 0x7f) return "identity file path must not contain control characters";
        }
    }
    if (remote.agents.hermes.home) |p| {
        if (p.len == 0) return "Hermes home path is empty";
        if (p.len > max_agent_home_bytes) return "Hermes home path is too long (max 320 bytes)";
        if (!std.mem.startsWith(u8, p, "~/") and !std.fs.path.isAbsolute(p)) {
            return "Hermes home must be absolute or start with ~/";
        }
        for (p) |c| {
            if (c < ' ' or c == 0x7f) return "Hermes home must not contain control characters";
        }
    }
    const identity_len = if (remote.identity_file) |p| p.len else 0;
    const hermes_home_len = shellExpansionBytes(remote.agents.hermes.home orelse default_hermes_home);
    if (remote.host.len + identity_len + hermes_home_len > max_transport_variable_bytes) {
        return "host, identity, and Hermes home are too long in combination";
    }
    if (remote.enabled and !remote.agents.anyEnabled()) return "enable at least one agent, or disable the remote";
    return null;
}

/// Load the config. A missing file is an empty config (first run is
/// not an error); a file that exists but does not parse is null, and
/// the caller decides whether to surface or overwrite it.
pub fn load(allocator: std.mem.Allocator, home: []const u8) ?Config {
    var path_buf: [512]u8 = undefined;
    const path = configPath(&path_buf, home) orelse return null;
    const bytes = plat.readFileAlloc(allocator, path, 1024 * 1024) orelse {
        if (!plat.fileExists(path)) return .{};
        return null;
    };
    defer allocator.free(bytes);
    // alloc_always: the file buffer is freed above, so every string the
    // parser hands out must own its bytes.
    return std.json.parseFromSliceLeaky(Config, allocator, bytes, .{
        .ignore_unknown_fields = true,
        .allocate = .alloc_always,
    }) catch null;
}

pub fn save(allocator: std.mem.Allocator, home: []const u8, config: *const Config) bool {
    var dir_buf: [512]u8 = undefined;
    const dir = std.fmt.bufPrint(&dir_buf, "{s}/.petdex", .{home}) catch return false;
    plat.makeDir(dir);
    var path_buf: [512]u8 = undefined;
    const path = configPath(&path_buf, home) orelse return false;
    const bytes = std.json.Stringify.valueAlloc(allocator, config.*, .{
        .whitespace = .indent_2,
        .emit_null_optional_fields = false,
    }) catch return false;
    defer allocator.free(bytes);
    return plat.writeFile(path, bytes);
}

// -------------------------------------------------------------- tests

const t = std.testing;

test "save/load round trip preserves remotes and per-agent options" {
    const home = ".zig-cache/petdex-remote-config";
    plat.makeDir(home);
    var pb: [512]u8 = undefined;
    const path = configPath(&pb, home).?;
    plat.deleteFile(path);

    var arena = std.heap.ArenaAllocator.init(t.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var cfg: Config = .{};
    var remotes = std.array_list.Managed(Remote).init(a);
    var r: Remote = .{
        .name = "rogue",
        .host = "shakib@rogue.lan",
        .port = 2222,
        .identity_file = "~/.ssh/id_ed25519",
        .agents = .{
            .opencode = .{ .enabled = true },
            .hermes = .{ .enabled = true, .home = "/srv/hermes" },
        },
    };
    remotes.append(r) catch unreachable;
    r = .{ .name = "nest1", .host = "10.0.0.8", .enabled = false };
    remotes.append(r) catch unreachable;
    cfg.remotes = remotes.items;

    try t.expect(save(a, home, &cfg));

    const loaded = load(a, home).?;
    try t.expectEqual(@as(usize, 2), loaded.remotes.len);
    const rogue = loaded.remotes[0];
    try t.expectEqualStrings("rogue", rogue.name);
    try t.expectEqualStrings("shakib@rogue.lan", rogue.host);
    try t.expectEqual(@as(u16, 2222), rogue.port);
    try t.expectEqualStrings("~/.ssh/id_ed25519", rogue.identity_file.?);
    try t.expect(rogue.enabled);
    try t.expect(rogue.agents.opencode.enabled);
    try t.expect(!rogue.agents.codex.enabled);
    try t.expect(rogue.agents.hermes.enabled);
    try t.expectEqualStrings("/srv/hermes", rogue.agents.hermes.home.?);
    try t.expect(!loaded.remotes[1].enabled);
    try t.expect(loaded.remotes[1].identity_file == null);
}

test "load treats a missing file as an empty config" {
    const home = ".zig-cache/petdex-remote-missing";
    plat.makeDir(home);
    var pb: [512]u8 = undefined;
    plat.deleteFile(configPath(&pb, home).?);
    const cfg = load(t.allocator, home).?;
    try t.expectEqual(@as(usize, 0), cfg.remotes.len);
}

test "load rejects invalid JSON instead of guessing" {
    const home = ".zig-cache/petdex-remote-bad";
    plat.makeDir(home);
    plat.makeDir(home ++ "/.petdex");
    var pb: [512]u8 = undefined;
    try t.expect(plat.writeFile(configPath(&pb, home).?, "{not json"));
    try t.expect(load(t.allocator, home) == null);
}

test "unknown fields are ignored for forward compatibility" {
    const home = ".zig-cache/petdex-remote-future";
    plat.makeDir(home);
    plat.makeDir(home ++ "/.petdex");
    var pb: [512]u8 = undefined;
    try t.expect(plat.writeFile(configPath(&pb, home).?,
        \\{"schema":2,"remotes":[{"name":"r1","host":"h","future_knob":{"x":1}}]}
    ));
    var arena = std.heap.ArenaAllocator.init(t.allocator);
    defer arena.deinit();
    const cfg = load(arena.allocator(), home).?;
    try t.expectEqual(@as(usize, 1), cfg.remotes.len);
    try t.expectEqualStrings("r1", cfg.remotes[0].name);
}

test "validateRemote rejects the shapes that would break ssh argv or logs" {
    var r: Remote = .{ .name = "ok-1", .host = "user@host" };
    r.agents.hermes.enabled = true;
    try t.expect(validateRemote(&r) == null);

    r.name = "";
    try t.expect(validateRemote(&r) != null);
    r.name = "has space";
    try t.expect(validateRemote(&r) != null);
    r.name = "ok-1";
    r.host = "";
    try t.expect(validateRemote(&r) != null);
    r.host = "bad host";
    try t.expect(validateRemote(&r) != null);
    r.host = "user@host";
    r.port = 0;
    try t.expect(validateRemote(&r) != null);
    r.port = 22;
    var long_host: [max_host_bytes + 1]u8 = @splat('h');
    r.host = &long_host;
    try t.expect(validateRemote(&r) != null);
    r.host = "user@host";
    var long_identity: [max_identity_bytes + 1]u8 = @splat('i');
    r.identity_file = &long_identity;
    try t.expect(validateRemote(&r) != null);
    r.identity_file = null;
    r.identity_file = "bad\nidentity";
    try t.expect(validateRemote(&r) != null);
    r.identity_file = null;
    r.agents.hermes.home = "relative/hermes";
    try t.expect(validateRemote(&r) != null);
    r.agents.hermes.home = "/srv/hermes data";
    try t.expect(validateRemote(&r) == null);
    var transport_host: [max_host_bytes]u8 = @splat('h');
    var transport_identity: [max_identity_bytes]u8 = @splat('i');
    r.host = &transport_host;
    r.identity_file = &transport_identity;
    var transport_home: [max_transport_variable_bytes - max_host_bytes - max_identity_bytes + 1]u8 = @splat('h');
    transport_home[0] = '/';
    r.agents.hermes.home = &transport_home;
    try t.expect(validateRemote(&r) != null);
    r.host = "host";
    r.identity_file = null;
    var quote_heavy_home: [max_agent_home_bytes]u8 = @splat('\'');
    quote_heavy_home[0] = '/';
    r.agents.hermes.home = &quote_heavy_home;
    try t.expect(validateRemote(&r) != null);
    r.agents.hermes.home = null;
    // An enabled remote with no agents would spin a tunnel for nothing.
    r.agents = .{};
    try t.expect(validateRemote(&r) != null);
    // ...unless the remote itself is disabled.
    r.enabled = false;
    try t.expect(validateRemote(&r) == null);
}

test "enabledAgents lists only the enabled remote-capable kinds" {
    var r: Remote = .{ .name = "r", .host = "h" };
    r.agents.opencode.enabled = true;
    r.agents.hermes.enabled = true;
    var out: [3]AgentKind = undefined;
    const n = enabledAgents(&r, &out);
    try t.expectEqual(@as(usize, 2), n);
    try t.expectEqual(AgentKind.opencode, out[0]);
    try t.expectEqual(AgentKind.hermes, out[1]);
    // Non-remote-capable kinds have no options slot.
    try t.expect(r.agents.optionsFor(.claude_code) == null);
}
