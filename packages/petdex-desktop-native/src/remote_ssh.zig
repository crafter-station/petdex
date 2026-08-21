//! SSH transport for remote agents: pure argv builders for every ssh
//! invocation the tunnel supervisor and the writeback installer need.
//!
//! Everything here returns argv for `fx.spawn`; nothing spawns, so the
//! whole module is unit-testable without a network. The rules that keep
//! the transport safe live here exactly once:
//!
//!   - BatchMode=yes: ssh must never block on a password prompt inside
//!     an effect worker; auth failure is an exit code, not a hang.
//!   - The destination is one argv element and every remote path is
//!     quoted inside the remote command string, so a hostile config
//!     value cannot become a remote shell injection.
//!   - Remote `~/` paths become `"$HOME"/'...'`: the home prefix expands
//!     safely while the path suffix remains literal. Quoting the entire
//!     `~/...` string would suppress expansion and create a directory
//!     literally named `~`.
//!
//! fx.spawn budget (16 argv elements / 2048 argv bytes / 4096 stdin
//! bytes) shapes the write path: chunks accumulate in a private sibling
//! temporary file and only the final chunk atomically replaces the target.

const std = @import("std");
const builtin = @import("builtin");
const remote_agents = @import("remote_agents.zig");
const plat = @import("plat.zig");

const Remote = remote_agents.Remote;

pub const max_argv = 16;

/// Largest stdin payload one write spawn carries. Under the fx.spawn
/// 4096 cap with margin; the caller sequences temporary-file writes.
pub const stdin_chunk = 3072;

/// Remote-side locations, always `~/`-relative so the remote shell
/// resolves them against the account that actually logged in.
///
/// The remote hook script deliberately lands at the SAME path the
/// desktop's hook binary occupies locally: the merged hook configs
/// (codex hooks.json, hermes config.yaml) name this path, so one
/// config works on both sides of the tunnel. A symlinked Zig binary
/// on the desktop, a POSIX sh script on the remote.
pub const remote_hook_script = "~/.petdex/bin/petdex-hook";
pub const remote_codex_watcher = "~/.petdex/bin/petdex-codex-watch";
pub const remote_hermes_watcher = "~/.petdex/bin/petdex-hermes-watch";
pub const remote_token_file = "~/.petdex/runtime/update-token";
pub const remote_host_file = "~/.petdex/runtime/remote-host";
pub const remote_hermes_home_file = "~/.petdex/runtime/hermes-home";
pub const remote_lease_file = "~/.petdex/runtime/tunnel-lease";
pub const missing_file_exit_code: i32 = 44;
pub const remote_opencode_plugin = "~/.config/opencode/plugins/petdex.js";
pub const remote_codex_hooks = "~/.codex/hooks.json";
pub const remote_hermes_config = "~/.hermes/config.yaml";
pub const remote_hermes_allowlist = "~/.hermes/shell-hooks-allowlist.json";
pub const remote_hermes_plugin_manifest = "~/.hermes/plugins/petdex-desktop/plugin.yaml";
pub const remote_hermes_plugin_init = "~/.hermes/plugins/petdex-desktop/__init__.py";

const tunnel_supervisor_rel = ".petdex/runtime/ssh-tunnel-supervisor.sh";
pub const tunnel_supervisor_script: []const u8 = @embedFile("assets/petdex-ssh-tunnel-supervisor.sh");

/// The desktop hook server the tunnel exposes on the remote's
/// loopback. Remote hook payloads post to 127.0.0.1:7777 there and ssh
/// delivers them to 127.0.0.1:7777 here.
pub const tunnel_spec = "127.0.0.1:7777:127.0.0.1:7777";

/// The long-lived ssh command emits this only after the reverse forward can
/// reach the desktop hook server. The runtime keeps the remote token absent
/// until this marker arrives and the post-tunnel writeback completes.
pub const tunnel_ready_marker = "petdex-tunnel-ready";

/// Absolute paths first so a hijacked PATH cannot substitute ssh,
/// matching installer's downloader probing.
const ssh_candidates = [_][]const u8{ "/usr/bin/ssh", "/bin/ssh" };

/// Path to a usable ssh client, null when none exists (Windows remotes
/// are out of scope for v1; a desktop without ssh cannot manage
/// remotes at all).
pub fn detect() ?[]const u8 {
    if (builtin.os.tag == .windows) return null;
    for (ssh_candidates) |path| {
        if (plat.fileExists(path)) return path;
    }
    return null;
}

/// Scratch storage for formatted port numbers, quoted paths, and the
/// remote command string. One per spawn; builders null on overflow.
pub const Scratch = struct {
    port: [12]u8 = undefined,
    identity: [384]u8 = undefined,
    supervisor: [512]u8 = undefined,
    parent_pid: [16]u8 = undefined,
    reverse: [128]u8 = undefined,
    quote_a: [512]u8 = undefined,
    quote_b: [512]u8 = undefined,
    quote_c: [512]u8 = undefined,
    quote_d: [512]u8 = undefined,
    quote_e: [512]u8 = undefined,
    cmd: [4096]u8 = undefined,
};

/// Install the small local wrapper that keeps a tunnel bounded by the
/// desktop pid. Native's normal effects teardown already kills spawned
/// children, but SIGTERM/crash paths cannot run it; without the wrapper,
/// ssh is reparented to launchd and holds the remote port forever.
pub fn installTunnelSupervisor(home: []const u8) bool {
    var dir_buf: [512]u8 = undefined;
    const dir = std.fmt.bufPrint(&dir_buf, "{s}/.petdex/runtime", .{home}) catch return false;
    plat.makeDir(dir);
    var path_buf: [512]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ home, tunnel_supervisor_rel }) catch return false;
    return plat.writeFileMode(path, tunnel_supervisor_script, 0o700);
}

/// Quote one path for the remote shell. A leading `~/` becomes
/// `"$HOME"/'...'` so the remote account's home expands without leaving
/// the suffix unquoted. Other paths are wrapped in single quotes, with
/// embedded quotes using the classic '\'' sequence. Paths we invent
/// never contain quotes, but a config-provided prefix could, and an
/// unquoted metacharacter here is a remote command injection.
pub fn shQuote(buf: []u8, path: []const u8) ?[]const u8 {
    var n: usize = 0;
    var literal = path;
    if (std.mem.startsWith(u8, path, "~/")) {
        const home_prefix = "\"$HOME\"/";
        if (home_prefix.len > buf.len) return null;
        @memcpy(buf[0..home_prefix.len], home_prefix);
        n = home_prefix.len;
        literal = path[2..];
    }
    if (n >= buf.len) return null;
    buf[n] = '\'';
    n += 1;
    for (literal) |c| {
        if (c == '\'') {
            if (n + 4 > buf.len) return null;
            buf[n .. n + 4][0..4].* = "'\\''".*;
            n += 4;
        } else {
            if (n >= buf.len) return null;
            buf[n] = c;
            n += 1;
        }
    }
    if (n >= buf.len) return null;
    buf[n] = '\'';
    n += 1;
    return buf[0..n];
}

/// The directory part of a `~/a/b/c` path (`~/a/b`), for mkdir -p.
fn dirname(path: []const u8) []const u8 {
    const slash = std.mem.lastIndexOfScalar(u8, path, '/') orelse return path;
    return path[0..slash];
}

/// Shared connection prefix: ssh, safety flags, optional port and
/// identity, destination. Returns the next free argv index. The
/// destination is always the element right before any remote command,
/// never embedded in it. Flags use ssh's attached form (-oX, -pN, -iP)
/// because fx.spawn caps argv at 16 elements and the tunnel adds six.
fn appendBase(buf: *[max_argv][]const u8, scratch: *Scratch, remote: *const Remote) ?usize {
    const ssh = detect() orelse return null;
    var n: usize = 0;
    buf[n] = ssh;
    n += 1;
    for ([_][]const u8{
        "-oBatchMode=yes",
        "-oConnectTimeout=8",
        "-oServerAliveInterval=15",
        "-oServerAliveCountMax=3",
        // TOFU: a never-seen host key is accepted and pinned; a CHANGED
        // one still hard-fails. Bare BatchMode would fail every first
        // connect on the host-key prompt nobody can answer.
        "-oStrictHostKeyChecking=accept-new",
    }) |arg| {
        buf[n] = arg;
        n += 1;
    }
    if (remote.port != 22) {
        buf[n] = std.fmt.bufPrint(&scratch.port, "-p{d}", .{remote.port}) catch return null;
        n += 1;
    }
    if (remote.identity_file) |identity| {
        buf[n] = std.fmt.bufPrint(scratch.identity[0..], "-i{s}", .{identity}) catch return null;
        n += 1;
    }
    buf[n] = "--";
    n += 1;
    buf[n] = remote.host;
    n += 1;
    return n;
}

/// Long-lived reverse tunnel: remote 127.0.0.1:7777 back to the desktop hook
/// server. The remote command probes `/health`, emits `tunnel_ready_marker`,
/// and keeps probing while it owns the lease. Repeated health failures revoke
/// the remote feed even if a hard desktop crash leaves a local ssh process
/// orphaned. OpenSSH starts that command only after it has requested the
/// reverse forward; ExitOnForwardFailure makes a rejected bind a fast failure
/// rather than a false-ready connection.
pub fn tunnelArgv(
    buf: *[max_argv][]const u8,
    scratch: *Scratch,
    remote: *const Remote,
    home: []const u8,
    parent_pid: u32,
) ?[]const []const u8 {
    const n = appendBase(buf, scratch, remote) orelse return null;
    if (n + 6 > max_argv) return null;
    // appendBase ends with `-- <destination>`. Tunnel switches are ssh
    // options, so insert them before that pair; the readiness/hold command is
    // the sole argument after the destination. Attached -o/-R forms preserve
    // three argv slots for the local supervisor wrapper while remaining
    // inside fx.spawn's 16-arg cap.
    const destination_idx = n - 2;
    const separator = buf[destination_idx];
    const destination = buf[destination_idx + 1];
    buf[destination_idx] = "-oExitOnForwardFailure=yes";
    buf[destination_idx + 1] = std.fmt.bufPrint(&scratch.reverse, "-R{s}", .{tunnel_spec}) catch return null;
    buf[destination_idx + 2] = separator;
    buf[destination_idx + 3] = destination;
    buf[destination_idx + 4] = std.fmt.bufPrint(&scratch.cmd, "umask 077; runtime=\"$HOME/.petdex/runtime\"; lease=\"$runtime/tunnel-lease\"; token=\"$runtime/update-token\"; mkdir -p \"$runtime\" || exit; command -v ps >/dev/null 2>&1 || exit 69; if command -v curl >/dev/null 2>&1; then healthy() {{ curl -fsS --max-time 1 http://127.0.0.1:7777/health >/dev/null 2>&1; }}; elif command -v python3 >/dev/null 2>&1; then healthy() {{ python3 -c 'import urllib.request; urllib.request.urlopen(\"http://127.0.0.1:7777/health\",timeout=1).read()' >/dev/null 2>&1; }}; else exit 69; fi; owner=$PPID; owner_alive() {{ kill -0 \"$owner\" 2>/dev/null || return 1; state=$(ps -o stat= -p \"$owner\" 2>/dev/null) || return 1; case \"$state\" in *Z*) return 1 ;; esac; return 0; }}; rm -f \"$lease\"; trap 'rm -f \"$lease\" \"$token\"' 0; trap 'trap - 0 1 2 15; rm -f \"$lease\" \"$token\"; exit 143' 1 2 15; i=0; until healthy; do owner_alive || exit 75; i=$((i+1)); test \"$i\" -ge 20 && exit 75; sleep 1; done; owner_alive || exit 75; : > \"$lease\" || exit; printf '{s}\\n'; missed=0; while owner_alive; do if healthy; then missed=0; : > \"$lease\" || exit; else missed=$((missed+1)); test \"$missed\" -ge 3 && exit 75; fi; sleep 2; done", .{tunnel_ready_marker}) catch return null;

    const ssh_len = n + 3;
    var i = ssh_len;
    while (i > 0) {
        i -= 1;
        buf[i + 3] = buf[i];
    }
    buf[0] = "/bin/sh";
    buf[1] = std.fmt.bufPrint(&scratch.supervisor, "{s}/{s}", .{ home, tunnel_supervisor_rel }) catch return null;
    buf[2] = std.fmt.bufPrint(&scratch.parent_pid, "{d}", .{parent_pid}) catch return null;
    return buf[0 .. n + 6];
}

/// Close the remote feed gate before a tunnel is allowed to start. Every
/// remote sender reads `update-token` for each post, so removing it blocks old
/// hooks immediately. Reconciler pid files are stopped as well; fresh ones are
/// started only after the post-tunnel patch pass succeeds. The bounded drain
/// covers a shell hook that read the old token just before its removal (the
/// remote hook's HTTP timeout is two seconds).
pub fn quiesceArgv(buf: *[max_argv][]const u8, scratch: *Scratch, remote: *const Remote) ?[]const []const u8 {
    const n = appendBase(buf, scratch, remote) orelse return null;
    if (n + 1 > max_argv) return null;
    buf[n] = "umask 077; runtime=\"$HOME/.petdex/runtime\"; mkdir -p \"$runtime\" || exit; rm -f \"$runtime/update-token\" \"$runtime/tunnel-lease\"; is_owned() { old=$1; needle=$2; case \"$old\" in ''|*[!0-9]*) return 1 ;; esac; command=$(ps -ww -p \"$old\" -o command= 2>/dev/null) || return 1; case \"$command\" in *\"$needle\"*) return 0 ;; *) return 1 ;; esac; }; stop_one() { p=$1; needle=$2; if test -r \"$p\"; then old=$(cat \"$p\"); if is_owned \"$old\" \"$needle\"; then kill \"$old\" 2>/dev/null || true; fi; fi; }; stop_one \"$runtime/codex-watch.pid\" \"$HOME/.petdex/bin/petdex-codex-watch\"; stop_one \"$runtime/hermes-watch.pid\" \"$HOME/.petdex/bin/petdex-hermes-watch\"; sleep 2";
    return buf[0 .. n + 1];
}

/// Cheap reachability check: auth, network, and shell in one round
/// trip. It also emits a named Hermes active profile when one exists, so
/// writeback can merge into that profile's isolated home. Exit 0 means the
/// remote is manageable even when Hermes is not installed.
pub fn probeArgv(buf: *[max_argv][]const u8, scratch: *Scratch, remote: *const Remote) ?[]const []const u8 {
    const n = appendBase(buf, scratch, remote) orelse return null;
    if (n + 1 > max_argv) return null;
    const hermes_home = remote.agents.hermes.home orelse remote_agents.default_hermes_home;
    const quoted = shQuote(&scratch.quote_a, hermes_home) orelse return null;
    buf[n] = std.fmt.bufPrint(&scratch.cmd, "hermes_home={s}; if test -r \"$hermes_home/active_profile\"; then printf 'petdex-hermes-profile='; head -n 1 \"$hermes_home/active_profile\"; fi; true", .{quoted}) catch return null;
    return buf[0 .. n + 1];
}

/// `cat` reads the quoted path on the remote; stdout is collected by the spawn.
pub fn readArgv(buf: *[max_argv][]const u8, scratch: *Scratch, remote: *const Remote, path: []const u8) ?[]const []const u8 {
    const n = appendBase(buf, scratch, remote) orelse return null;
    if (n + 1 > max_argv) return null;
    const quoted = shQuote(&scratch.quote_a, path) orelse return null;
    buf[n] = std.fmt.bufPrint(&scratch.cmd, "target={s}; if test ! -e \"$target\" && test ! -L \"$target\"; then exit {d}; fi; cat -- \"$target\"", .{ quoted, missing_file_exit_code }) catch return null;
    return buf[0 .. n + 1];
}

/// Write one chunk into a private sibling temporary. The last chunk sets the
/// final mode and atomically renames it over the live path. Existing symlink
/// targets are resolved first so writeback preserves user-managed relocation.
pub fn writeArgv(
    buf: *[max_argv][]const u8,
    scratch: *Scratch,
    remote: *const Remote,
    path: []const u8,
    first_chunk: bool,
    last_chunk: bool,
    executable: bool,
) ?[]const []const u8 {
    const n = appendBase(buf, scratch, remote) orelse return null;
    if (n + 1 > max_argv) return null;
    const quoted = shQuote(&scratch.quote_a, path) orelse return null;
    const remote_name = shQuote(&scratch.quote_b, remote.name) orelse return null;
    const write = if (first_chunk)
        "cat > \"$tmp\""
    else
        "test -f \"$tmp\" && cat >> \"$tmp\"";
    const finish = if (last_chunk)
        (if (executable)
            "chmod 755 \"$tmp\" && mv -f \"$tmp\" \"$target\""
        else
            "chmod 600 \"$tmp\" && mv -f \"$tmp\" \"$target\"")
    else
        ":";
    buf[n] = std.fmt.bufPrint(&scratch.cmd, "umask 077; target={s}; remote_name={s}; if test -L \"$target\"; then link=$(readlink \"$target\") || exit; case \"$link\" in /*) target=$link ;; *) target=$(dirname \"$target\")/$link ;; esac; fi; dir=$(dirname \"$target\") || exit; mkdir -p \"$dir\" || exit; tmp=\"${{target}}.petdex-tmp-${{remote_name}}\"; trap 'rm -f \"$tmp\"; exit 1' 1 2 15; {s} || {{ rm -f \"$tmp\"; exit 1; }}; {s} || {{ rm -f \"$tmp\"; exit 1; }}", .{ quoted, remote_name, write, finish }) catch return null;
    return buf[0 .. n + 1];
}

/// Open the remote feed gate after every successful post-tunnel patch pass.
/// The token is written to a private temporary file and atomically renamed
/// last, so an interrupted SSH write cannot expose a partial credential.
pub fn tokenArgv(buf: *[max_argv][]const u8, scratch: *Scratch, remote: *const Remote) ?[]const []const u8 {
    const n = appendBase(buf, scratch, remote) orelse return null;
    if (n + 1 > max_argv) return null;
    const quoted = shQuote(&scratch.quote_a, remote_token_file) orelse return null;
    const dir = shQuote(&scratch.quote_b, dirname(remote_token_file)) orelse return null;
    const host_file = shQuote(&scratch.quote_c, remote_host_file) orelse return null;
    const hermes_home_file = shQuote(&scratch.quote_d, remote_hermes_home_file) orelse return null;
    const hermes_home = shQuote(&scratch.quote_e, remote.agents.hermes.home orelse remote_agents.default_hermes_home) orelse return null;
    buf[n] = std.fmt.bufPrint(&scratch.cmd, "umask 077; mkdir -p {s} || exit; tmp=\"$HOME/.petdex/runtime/update-token.tmp.$$\"; trap 'rm -f \"$tmp\"' 0 1 2 15; hermes_home={s}; cat > \"$tmp\" && chmod 600 \"$tmp\" && hostname > {s} && printf '%s\\n' \"$hermes_home\" > {s} && mv -f \"$tmp\" {s}", .{ dir, hermes_home, host_file, hermes_home_file, quoted }) catch return null;
    return buf[0 .. n + 1];
}

/// Start (or replace) the detached remote feed reconcilers. Each watcher owns
/// a flock as a second guard, and every descriptor is redirected so the short
/// SSH setup process can exit instead of holding an effects worker.
pub fn watcherArgv(
    buf: *[max_argv][]const u8,
    scratch: *Scratch,
    remote: *const Remote,
    start_codex: bool,
    start_hermes: bool,
) ?[]const []const u8 {
    if (!start_codex and !start_hermes) return null;
    const n = appendBase(buf, scratch, remote) orelse return null;
    if (n + 1 > max_argv) return null;
    const hermes_home = shQuote(&scratch.quote_a, remote.agents.hermes.home orelse remote_agents.default_hermes_home) orelse return null;
    const helper = "umask 077; for x in python3 curl ps; do command -v \"$x\" >/dev/null 2>&1 || exit 69; done; r=\"$HOME/.petdex/runtime\"; l=\"$r/tunnel-lease\"; mkdir -p \"$r\" || exit; test -f \"$l\" || exit 75; own() { q=$1; n=$2; case \"$q\" in ''|*[!0-9]*) return 1 ;; esac; c=$(ps -ww -p \"$q\" -o command= 2>/dev/null) || return 1; case \"$c\" in *\"$n\"*) return 0 ;; *) return 1 ;; esac; }; start_one() { p=$1; exe=$2; shift 2; if test -r \"$p\"; then old=$(cat \"$p\"); if own \"$old\" \"$exe\"; then kill \"$old\" 2>/dev/null || true; fi; fi; nohup \"$exe\" \"$@\" >/dev/null 2>&1 </dev/null & child=$!; i=0; stable=0; while test \"$i\" -lt 30; do if test -r \"$p\"; then actual=$(cat \"$p\"); if test \"$actual\" = \"$child\" && kill -0 \"$actual\" 2>/dev/null && own \"$actual\" \"$exe\"; then stable=$((stable+1)); test \"$stable\" -ge 3 && return 0; else stable=0; fi; fi; i=$((i+1)); sleep 0.1; done; if own \"$child\" \"$exe\"; then kill \"$child\" 2>/dev/null || true; fi; test \"$(cat \"$p\" 2>/dev/null)\" = \"$child\" && rm -f \"$p\"; return 1; }; ";
    if (start_codex and start_hermes) {
        const codex = shQuote(&scratch.quote_b, remote_codex_watcher) orelse return null;
        const codex_pid = shQuote(&scratch.quote_c, "~/.petdex/runtime/codex-watch.pid") orelse return null;
        const hermes = shQuote(&scratch.quote_d, remote_hermes_watcher) orelse return null;
        const hermes_pid = shQuote(&scratch.quote_e, "~/.petdex/runtime/hermes-watch.pid") orelse return null;
        buf[n] = std.fmt.bufPrint(&scratch.cmd, "{s}start_one {s} {s} && start_one {s} {s} {s}", .{ helper, codex_pid, codex, hermes_pid, hermes, hermes_home }) catch return null;
    } else if (start_codex) {
        const codex = shQuote(&scratch.quote_b, remote_codex_watcher) orelse return null;
        const codex_pid = shQuote(&scratch.quote_c, "~/.petdex/runtime/codex-watch.pid") orelse return null;
        buf[n] = std.fmt.bufPrint(&scratch.cmd, "{s}start_one {s} {s}", .{ helper, codex_pid, codex }) catch return null;
    } else {
        const hermes = shQuote(&scratch.quote_b, remote_hermes_watcher) orelse return null;
        const hermes_pid = shQuote(&scratch.quote_c, "~/.petdex/runtime/hermes-watch.pid") orelse return null;
        buf[n] = std.fmt.bufPrint(&scratch.cmd, "{s}start_one {s} {s} {s}", .{ helper, hermes_pid, hermes, hermes_home }) catch return null;
    }
    return buf[0 .. n + 1];
}

/// How many write spawns a file of `total` bytes needs.
pub fn chunkCount(total: usize) usize {
    if (total == 0) return 1;
    return (total + stdin_chunk - 1) / stdin_chunk;
}

// -------------------------------------------------------------- tests

const t = std.testing;

const test_remote = Remote{
    .name = "rogue",
    .host = "shakib@rogue.lan",
    .port = 2222,
    .identity_file = "~/.ssh/id_ed25519",
};

fn joined(argv: []const []const u8, buf: []u8) []const u8 {
    var n: usize = 0;
    for (argv) |arg| {
        if (n > 0) {
            buf[n] = ' ';
            n += 1;
        }
        @memcpy(buf[n .. n + arg.len], arg);
        n += arg.len;
    }
    return buf[0..n];
}

fn argvBytes(argv: []const []const u8) usize {
    var total: usize = 0;
    for (argv) |arg| total += arg.len;
    return total;
}

test "appendBase puts safety flags before a quoted-free destination" {
    if (detect() == null) return;
    var buf: [max_argv][]const u8 = undefined;
    var scratch: Scratch = .{};
    var line: [4096]u8 = undefined;
    const argv = probeArgv(&buf, &scratch, &test_remote).?;
    const text = joined(argv, &line);
    try t.expect(std.mem.indexOf(u8, text, "BatchMode=yes") != null);
    try t.expect(std.mem.indexOf(u8, text, "ConnectTimeout=8") != null);
    try t.expect(std.mem.indexOf(u8, text, "StrictHostKeyChecking=accept-new") != null);
    try t.expect(std.mem.indexOf(u8, text, "-p2222") != null);
    try t.expect(std.mem.indexOf(u8, text, "-i~/.ssh/id_ed25519") != null);
    try t.expect(std.mem.indexOf(u8, text, "active_profile") != null);
    // Destination is its own argv element, immediately before the
    // remote command, and never quoted into it.
    try t.expectEqualStrings("shakib@rogue.lan", argv[argv.len - 2]);
    try t.expect(std.mem.indexOf(u8, argv[argv.len - 1], "active_profile") != null);
}

test "appendBase omits -p and -i at their defaults" {
    if (detect() == null) return;
    const plain = Remote{ .name = "r", .host = "10.0.0.8" };
    var buf: [max_argv][]const u8 = undefined;
    var scratch: Scratch = .{};
    const argv = probeArgv(&buf, &scratch, &plain).?;
    for (argv) |arg| {
        try t.expect(!std.mem.startsWith(u8, arg, "-p"));
        try t.expect(!std.mem.startsWith(u8, arg, "-i"));
    }
}

test "probe and watcher honor a custom remote Hermes home" {
    if (detect() == null) return;
    const custom = Remote{
        .name = "hermes",
        .host = "host",
        .agents = .{ .hermes = .{ .enabled = true, .home = "/srv/hermes data" } },
    };
    var buf: [max_argv][]const u8 = undefined;
    var probe_scratch: Scratch = .{};
    const probe = probeArgv(&buf, &probe_scratch, &custom).?;
    try t.expect(std.mem.indexOf(u8, probe[probe.len - 1], "'/srv/hermes data'") != null);
    var watcher_scratch: Scratch = .{};
    const watcher = watcherArgv(&buf, &watcher_scratch, &custom, false, true).?;
    try t.expect(std.mem.indexOf(u8, watcher[watcher.len - 1], "'/srv/hermes data'") != null);
    var token_scratch: Scratch = .{};
    const token = tokenArgv(&buf, &token_scratch, &custom).?;
    try t.expect(std.mem.indexOf(u8, token[token.len - 1], "'/srv/hermes data'") != null);
    try t.expect(std.mem.indexOf(u8, token[token.len - 1], "hermes-home") != null);
}

test "tunnelArgv requests the reverse forward with fast failure" {
    if (detect() == null) return;
    var buf: [max_argv][]const u8 = undefined;
    var scratch: Scratch = .{};
    const argv = tunnelArgv(&buf, &scratch, &test_remote, "/tmp/petdex-home", 4242).?;
    try t.expectEqual(@as(usize, max_argv), argv.len);
    try t.expectEqualStrings("/bin/sh", argv[0]);
    try t.expectEqualStrings("/tmp/petdex-home/.petdex/runtime/ssh-tunnel-supervisor.sh", argv[1]);
    try t.expectEqualStrings("4242", argv[2]);
    try t.expectEqualStrings("/usr/bin/ssh", argv[3]);
    // All tunnel switches are parsed locally by ssh. The only remote command
    // probes the forwarded health endpoint before publishing readiness.
    try t.expectEqualStrings("--", argv[argv.len - 3]);
    try t.expectEqualStrings(test_remote.host, argv[argv.len - 2]);
    try t.expectEqualStrings("-R" ++ tunnel_spec, argv[argv.len - 4]);
    try t.expect(std.mem.indexOf(u8, argv[argv.len - 1], tunnel_ready_marker) != null);
    try t.expect(std.mem.indexOf(u8, argv[argv.len - 1], "/health") != null);
    try t.expect(std.mem.indexOf(u8, argv[argv.len - 1], "rm -f \"$lease\" \"$token\"") != null);
    try t.expect(std.mem.indexOf(u8, argv[argv.len - 1], "exit 143' 1 2 15") != null);
    try t.expect(std.mem.indexOf(u8, argv[argv.len - 1], "owner=$PPID") != null);
    try t.expect(std.mem.indexOf(u8, argv[argv.len - 1], "while owner_alive") != null);
    try t.expect(std.mem.indexOf(u8, argv[argv.len - 1], "until healthy") != null);
    try t.expect(std.mem.indexOf(u8, argv[argv.len - 1], "missed=$((missed+1))") != null);
    try t.expect(std.mem.indexOf(u8, argv[argv.len - 1], "test \"$missed\" -ge 3 && exit 75") != null);
    var line: [4096]u8 = undefined;
    const text = joined(argv, &line);
    try t.expect(std.mem.indexOf(u8, text, "-N") == null);
    try t.expect(std.mem.indexOf(u8, text, "ExitOnForwardFailure=yes") != null);
    try t.expect(std.mem.indexOf(u8, text, "-R") != null);
}

test "quiesceArgv removes token and stops both feed watchers" {
    if (detect() == null) return;
    var buf: [max_argv][]const u8 = undefined;
    var scratch: Scratch = .{};
    const argv = quiesceArgv(&buf, &scratch, &test_remote).?;
    const command = argv[argv.len - 1];
    try t.expect(std.mem.indexOf(u8, command, "rm -f \"$runtime/update-token\" \"$runtime/tunnel-lease\"") != null);
    try t.expect(std.mem.indexOf(u8, command, "codex-watch.pid") != null);
    try t.expect(std.mem.indexOf(u8, command, "hermes-watch.pid") != null);
    try t.expect(std.mem.indexOf(u8, command, "kill \"$old\"") != null);
    try t.expect(std.mem.indexOf(u8, command, "ps -ww -p \"$old\" -o command=") != null);
    try t.expect(std.mem.indexOf(u8, command, "rm -f \"$p\"") == null);
    try t.expect(std.mem.endsWith(u8, command, "sleep 2"));
}

test "tunnel supervisor is installed under the runtime directory" {
    const home = ".zig-cache/petdex-ssh-supervisor-home";
    try t.expect(installTunnelSupervisor(home));
    var bytes: [2048]u8 = undefined;
    const installed = plat.readFile(home ++ "/.petdex/runtime/ssh-tunnel-supervisor.sh", &bytes).?;
    try t.expectEqualStrings(tunnel_supervisor_script, installed);
}

test "read and write quote remote paths for the remote shell" {
    if (detect() == null) return;
    var buf: [max_argv][]const u8 = undefined;
    var scratch: Scratch = .{};
    const rd = readArgv(&buf, &scratch, &test_remote, remote_codex_hooks).?;
    try t.expect(std.mem.indexOf(u8, rd[rd.len - 1], "exit 44") != null);
    try t.expect(std.mem.indexOf(u8, rd[rd.len - 1], "cat -- \"$target\"") != null);

    var scratch2: Scratch = .{};
    const wr = writeArgv(&buf, &scratch2, &test_remote, remote_opencode_plugin, true, false, false).?;
    try t.expect(std.mem.indexOf(u8, wr[wr.len - 1], "cat > \"$tmp\"") != null);
    try t.expect(std.mem.indexOf(u8, wr[wr.len - 1], ".petdex-tmp-${remote_name}") != null);
    try t.expect(std.mem.indexOf(u8, wr[wr.len - 1], "mv -f") == null);

    var scratch3: Scratch = .{};
    const app = writeArgv(&buf, &scratch3, &test_remote, remote_opencode_plugin, false, true, false).?;
    try t.expect(std.mem.indexOf(u8, app[app.len - 1], "cat >> \"$tmp\"") != null);
    try t.expect(std.mem.indexOf(u8, app[app.len - 1], "chmod 600 \"$tmp\" && mv -f") != null);

    var scratch4: Scratch = .{};
    const exe = writeArgv(&buf, &scratch4, &test_remote, remote_hook_script, true, true, true).?;
    try t.expect(std.mem.indexOf(u8, exe[exe.len - 1], "chmod 755 \"$tmp\" && mv -f") != null);
    try t.expect(std.mem.indexOf(u8, exe[exe.len - 1], "readlink") != null);
}

test "shQuote escapes embedded quotes instead of trusting the path" {
    var qb: [512]u8 = undefined;
    try t.expectEqualStrings("\"$HOME\"/'x/y'", shQuote(&qb, "~/x/y").?);
    try t.expectEqualStrings("'a'\\''b'", shQuote(&qb, "a'b").?);
    // No silent truncation: an over-long path is null, not a cut string.
    try t.expect(shQuote(qb[0..4], "~/x/y") == null);
}

test "tokenArgv lands the token 0600 under ~/.petdex" {
    if (detect() == null) return;
    var buf: [max_argv][]const u8 = undefined;
    var scratch: Scratch = .{};
    const argv = tokenArgv(&buf, &scratch, &test_remote).?;
    const command = argv[argv.len - 1];
    try t.expect(std.mem.indexOf(u8, command, "update-token.tmp.$$") != null);
    try t.expect(std.mem.indexOf(u8, command, "chmod 600") != null);
    try t.expect(std.mem.indexOf(u8, command, "hostname > \"$HOME\"/'.petdex/runtime/remote-host'") != null);
    try t.expect(std.mem.indexOf(u8, command, "mv -f \"$tmp\" \"$HOME\"/'.petdex/runtime/update-token'") != null);
}

test "watcherArgv replaces the selected Petdesk watchers and detaches cleanly" {
    if (detect() == null) return;
    var buf: [max_argv][]const u8 = undefined;
    var scratch: Scratch = .{};
    const argv = watcherArgv(&buf, &scratch, &test_remote, true, false).?;
    const command = argv[argv.len - 1];
    try t.expect(std.mem.indexOf(u8, command, ".petdex/bin/petdex-codex-watch") != null);
    try t.expect(std.mem.indexOf(u8, command, ".petdex/runtime/codex-watch.pid") != null);
    try t.expect(std.mem.indexOf(u8, command, ".petdex/bin/petdex-hermes-watch") == null);
    try t.expect(std.mem.indexOf(u8, command, "nohup") != null);
    try t.expect(std.mem.indexOf(u8, command, "</dev/null &") != null);
    try t.expect(std.mem.indexOf(u8, command, "own() { q=$1;") != null);
    try t.expect(std.mem.indexOf(u8, command, "start_one() { p=$1;") != null);
    try t.expect(std.mem.indexOf(u8, command, "kill -0 \"$actual\"") != null);
    try t.expect(std.mem.indexOf(u8, command, "tunnel-lease") != null);

    var hermes_scratch: Scratch = .{};
    const hermes = watcherArgv(&buf, &hermes_scratch, &test_remote, false, true).?;
    const hermes_command = hermes[hermes.len - 1];
    try t.expect(std.mem.indexOf(u8, hermes_command, ".petdex/bin/petdex-hermes-watch") != null);
    try t.expect(std.mem.indexOf(u8, hermes_command, ".petdex/runtime/hermes-watch.pid") != null);
    try t.expect(std.mem.indexOf(u8, hermes_command, ".petdex/bin/petdex-codex-watch") == null);

    var both_scratch: Scratch = .{};
    const both = watcherArgv(&buf, &both_scratch, &test_remote, true, true).?;
    try t.expect(std.mem.indexOf(u8, both[both.len - 1], "petdex-codex-watch") != null);
    try t.expect(std.mem.indexOf(u8, both[both.len - 1], "petdex-hermes-watch") != null);
    try t.expect(argvBytes(both) <= 2048);
    try t.expect(watcherArgv(&buf, &scratch, &test_remote, false, false) == null);
}

test "remote argv builders stay inside the Native effect byte budget" {
    if (detect() == null) return;
    var host: [remote_agents.max_host_bytes]u8 = @splat('h');
    var identity: [remote_agents.max_identity_bytes]u8 = @splat('i');
    const home_len = remote_agents.max_transport_variable_bytes - host.len - identity.len;
    var hermes_home: [home_len]u8 = @splat('h');
    hermes_home[0] = '~';
    hermes_home[1] = '/';
    const largest = Remote{
        .name = "largest",
        .host = &host,
        .identity_file = &identity,
        .agents = .{ .hermes = .{ .enabled = true, .home = &hermes_home } },
    };
    try t.expect(remote_agents.validateRemote(&largest) == null);
    var buf: [max_argv][]const u8 = undefined;
    var scratch: Scratch = .{};
    const argv = watcherArgv(&buf, &scratch, &largest, true, true).?;
    try t.expect(argvBytes(argv) <= 2048);
    var tunnel_scratch: Scratch = .{};
    const tunnel = tunnelArgv(&buf, &tunnel_scratch, &largest, "/tmp/petdex-home", 4242).?;
    try t.expect(argvBytes(tunnel) <= 2048);
}

test "chunkCount splits at the stdin budget" {
    try t.expectEqual(@as(usize, 1), chunkCount(0));
    try t.expectEqual(@as(usize, 1), chunkCount(stdin_chunk));
    try t.expectEqual(@as(usize, 2), chunkCount(stdin_chunk + 1));
    // The opencode plugin must stay chunkable: the whole reason the
    // append form exists.
    try t.expectEqual(@as(usize, 3), chunkCount(8301));
}
