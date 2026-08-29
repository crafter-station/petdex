const std = @import("std");
const plat = @import("plat.zig");

pub const package_name = "@petdex/dsh-plugin";
pub const integration_version = "0.1.0";
pub const dsh_version = "0.1.0-rc.6";
pub const pnpm_version = "11.19.0";
const embedded_tarball = @embedFile("assets/petdex-dsh-plugin-0.1.0.tgz");
const expected_tarball_sha256 = "48611183ad50fc81aba136b979d5e5df08cdc419d51db1efe6ca033af5098250";

pub var env_dsh_home: ?[]const u8 = null;

pub const Status = enum {
    absent,
    not_installed,
    restart_required,
    connected,
};

pub const Argv = struct {
    items: [16][]const u8 = @splat(""),
    len: usize = 0,

    pub fn slice(self: *const Argv) []const []const u8 {
        return self.items[0..self.len];
    }
};

/// Finder-launched apps do not inherit the user's interactive PATH, while DSH
/// Web users commonly get both npx and pnpm from nvm/asdf initialization in
/// .zshrc. The fixed script forwards every command component as an argument;
/// no package path or profile value is interpolated into shell source.
pub fn macLoginShellArgv(command: []const []const u8) Argv {
    var out: Argv = .{};
    const prefix = [_][]const u8{ "/bin/zsh", "-lic", "exec \"$@\"", "petdex-dsh" };
    @memcpy(out.items[0..prefix.len], &prefix);
    const count = @min(command.len, out.items.len - prefix.len);
    @memcpy(out.items[prefix.len..][0..count], command[0..count]);
    out.len = prefix.len + count;
    return out;
}

pub fn stableTarballPath(buf: []u8, home: []const u8) ?[]const u8 {
    return std.fmt.bufPrint(
        buf,
        "{s}/.petdex/integrations/dsh/{s}/petdex-dsh-plugin-{s}.tgz",
        .{ home, integration_version, integration_version },
    ) catch null;
}

pub fn addArgv(tarball: []const u8) Argv {
    var out: Argv = .{};
    out.items[0..12].* = .{
        "npx",
        "--yes",
        "--package=@deepseek-ai/dsh@" ++ dsh_version,
        "--package=pnpm@" ++ pnpm_version,
        "--",
        "dsh",
        "plugin",
        "--profile",
        "web",
        "add",
        "--ignore-scripts",
        tarball,
    };
    out.len = 12;
    return out;
}

pub fn removeArgv() Argv {
    var out: Argv = .{};
    out.items[0..11].* = .{
        "npx",
        "--yes",
        "--package=@deepseek-ai/dsh@" ++ dsh_version,
        "--package=pnpm@" ++ pnpm_version,
        "--",
        "dsh",
        "plugin",
        "--profile",
        "web",
        "remove",
        package_name,
    };
    out.len = 11;
    return out;
}

pub fn embeddedTarballHash() [64]u8 {
    var digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(embedded_tarball, &digest, .{});
    return std.fmt.bytesToHex(digest, .lower);
}

pub fn materialize(allocator: std.mem.Allocator, home: []const u8, path_buf: []u8) ?[]const u8 {
    const digest = embeddedTarballHash();
    if (!std.mem.eql(u8, &digest, expected_tarball_sha256)) return null;

    var dir_buf: [512]u8 = undefined;
    const dir = std.fmt.bufPrint(
        &dir_buf,
        "{s}/.petdex/integrations/dsh/{s}",
        .{ home, integration_version },
    ) catch return null;
    if (!plat.makeDirMode(dir, 0o700)) return null;
    const path = stableTarballPath(path_buf, home) orelse return null;
    if (!plat.writeFileMode(path, embedded_tarball, 0o600)) return null;

    const written = plat.readFileAlloc(allocator, path, 64 * 1024) orelse return null;
    defer allocator.free(written);
    var written_digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(written, &written_digest, .{});
    const written_hex = std.fmt.bytesToHex(written_digest, .lower);
    if (!std.mem.eql(u8, &written_hex, expected_tarball_sha256)) return null;
    return path;
}

pub fn statusFromManifest(allocator: std.mem.Allocator, profile_exists: bool, manifest: []const u8, handshake: []const u8) Status {
    if (!profile_exists) return .absent;
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const root = std.json.parseFromSliceLeaky(std.json.Value, a, manifest, .{}) catch return .not_installed;
    if (root != .object) return .not_installed;

    const deps = root.object.get("dependencies") orelse return .not_installed;
    if (deps != .object or !deps.object.contains(package_name)) return .not_installed;
    const dsh = root.object.get("dsh") orelse return .not_installed;
    if (dsh != .object) return .not_installed;
    const profile = dsh.object.get("profile") orelse return .not_installed;
    if (profile != .object) return .not_installed;
    const bundles = profile.object.get("bundles") orelse return .not_installed;
    if (bundles != .array) return .not_installed;
    var found_bundle = false;
    for (bundles.array.items) |bundle| {
        if (bundle == .string and std.mem.eql(u8, bundle.string, package_name)) {
            found_bundle = true;
            break;
        }
    }
    if (!found_bundle) return .not_installed;

    const handshake_root = std.json.parseFromSliceLeaky(std.json.Value, a, handshake, .{}) catch return .restart_required;
    if (handshake_root != .object) return .restart_required;
    const version = handshake_root.object.get("integrationVersion") orelse return .restart_required;
    if (version != .string or !std.mem.eql(u8, version.string, integration_version)) return .restart_required;
    return .connected;
}

pub fn dshHome(buf: []u8, user_home: []const u8) ?[]const u8 {
    if (env_dsh_home) |configured| {
        if (configured.len > 0) return std.fmt.bufPrint(buf, "{s}", .{configured}) catch null;
    }
    return std.fmt.bufPrint(buf, "{s}/.dsh", .{user_home}) catch null;
}

pub fn detect(allocator: std.mem.Allocator, user_home: []const u8) Status {
    var dsh_buf: [512]u8 = undefined;
    const dsh_dir = dshHome(&dsh_buf, user_home) orelse return .absent;
    var manifest_buf: [768]u8 = undefined;
    const manifest_path = std.fmt.bufPrint(&manifest_buf, "{s}/profiles/web/package.json", .{dsh_dir}) catch return .absent;
    if (!plat.fileExists(manifest_path)) return .absent;
    const manifest = plat.readFileAlloc(allocator, manifest_path, 1024 * 1024) orelse return .not_installed;
    defer allocator.free(manifest);

    var handshake_buf: [768]u8 = undefined;
    const handshake_path = std.fmt.bufPrint(&handshake_buf, "{s}/.petdex/runtime/dsh-handshake.json", .{user_home}) catch return .not_installed;
    const handshake = plat.readFileAlloc(allocator, handshake_path, 4096);
    defer if (handshake) |bytes| allocator.free(bytes);
    return statusFromManifest(allocator, true, manifest, handshake orelse "");
}

pub fn clearHandshake(user_home: []const u8) void {
    var path_buf: [768]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/.petdex/runtime/dsh-handshake.json", .{user_home}) catch return;
    plat.deleteFile(path);
}

test "stable tarball path survives app updates" {
    var buf: [512]u8 = undefined;
    try std.testing.expectEqualStrings(
        "/Users/test/.petdex/integrations/dsh/0.1.0/petdex-dsh-plugin-0.1.0.tgz",
        stableTarballPath(&buf, "/Users/test").?,
    );
}

test "official add command pins DSH and provides an isolated pnpm" {
    const argv = addArgv("/stable/plugin.tgz");
    try std.testing.expectEqualSlices([]const u8, &.{
        "npx",
        "--yes",
        "--package=@deepseek-ai/dsh@0.1.0-rc.6",
        "--package=pnpm@11.19.0",
        "--",
        "dsh",
        "plugin",
        "--profile",
        "web",
        "add",
        "--ignore-scripts",
        "/stable/plugin.tgz",
    }, argv.slice());
}

test "official remove command names only the Petdex package" {
    const argv = removeArgv();
    try std.testing.expectEqualSlices([]const u8, &.{
        "npx",
        "--yes",
        "--package=@deepseek-ai/dsh@0.1.0-rc.6",
        "--package=pnpm@11.19.0",
        "--",
        "dsh",
        "plugin",
        "--profile",
        "web",
        "remove",
        "@petdex/dsh-plugin",
    }, argv.slice());
}

test "macOS login shell preserves official command arguments" {
    const command = addArgv("/stable/plugin.tgz");
    const argv = macLoginShellArgv(command.slice());
    try std.testing.expectEqualSlices([]const u8, &.{
        "/bin/zsh",
        "-lic",
        "exec \"$@\"",
        "petdex-dsh",
        "npx",
        "--yes",
        "--package=@deepseek-ai/dsh@0.1.0-rc.6",
        "--package=pnpm@11.19.0",
        "--",
        "dsh",
        "plugin",
        "--profile",
        "web",
        "add",
        "--ignore-scripts",
        "/stable/plugin.tgz",
    }, argv.slice());
}

test "installed plugin needs a current real-event handshake" {
    const manifest =
        \\{
        \\  "dependencies": {"@petdex/dsh-plugin": "file:/stable/plugin.tgz"},
        \\  "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "@petdex/dsh-plugin"]}}
        \\}
    ;
    try std.testing.expectEqual(Status.restart_required, statusFromManifest(std.testing.allocator, true, manifest, ""));
    try std.testing.expectEqual(Status.connected, statusFromManifest(
        std.testing.allocator,
        true,
        manifest,
        "{\"integrationVersion\":\"0.1.0\"}",
    ));
    try std.testing.expectEqual(Status.restart_required, statusFromManifest(
        std.testing.allocator,
        true,
        manifest,
        "{\"integrationVersion\":\"0.0.9\"}",
    ));
}

test "foreign profile dependencies never count as Petdex" {
    const manifest =
        \\{"dependencies":{"another-plugin":"1.0.0"},"dsh":{"profile":{"bundles":["another-plugin"]}}}
    ;
    try std.testing.expectEqual(Status.not_installed, statusFromManifest(std.testing.allocator, true, manifest, ""));
    try std.testing.expectEqual(Status.absent, statusFromManifest(std.testing.allocator, false, manifest, ""));
}

test "embedded plugin is hash pinned and materialized outside the app" {
    try std.testing.expectEqualStrings(
        "48611183ad50fc81aba136b979d5e5df08cdc419d51db1efe6ca033af5098250",
        &embeddedTarballHash(),
    );

    const home = ".zig-cache/petdex-dsh-materialize";
    defer _ = plat.deleteTree(home);
    var path_buf: [512]u8 = undefined;
    const path = materialize(std.testing.allocator, home, &path_buf) orelse return error.MaterializeFailed;
    const bytes = plat.readFileAlloc(std.testing.allocator, path, 64 * 1024) orelse return error.MaterializeReadFailed;
    defer std.testing.allocator.free(bytes);
    var digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    const actual = std.fmt.bytesToHex(digest, .lower);
    try std.testing.expectEqualStrings(&embeddedTarballHash(), &actual);
}

test "DSH_HOME redirects profile detection" {
    const saved = env_dsh_home;
    defer env_dsh_home = saved;
    env_dsh_home = "/custom/dsh";
    var buf: [512]u8 = undefined;
    try std.testing.expectEqualStrings("/custom/dsh", dshHome(&buf, "/Users/test").?);
    env_dsh_home = "";
    try std.testing.expectEqualStrings("/Users/test/.dsh", dshHome(&buf, "/Users/test").?);
}

test "filesystem detection distinguishes restart from real event connection" {
    // The production app populates this override from the process
    // environment. Tests must use their isolated fixture home instead of a
    // developer's real DSH_HOME, otherwise an installed host profile can
    // make this assertion report connected or not_installed nondeterministically.
    const saved_dsh_home = env_dsh_home;
    env_dsh_home = null;
    defer env_dsh_home = saved_dsh_home;

    var test_dir = std.testing.tmpDir(.{});
    defer test_dir.cleanup();
    var home_buf: [128]u8 = undefined;
    const home = std.fmt.bufPrint(
        &home_buf,
        ".zig-cache/tmp/{s}",
        .{test_dir.sub_path[0..]},
    ) catch unreachable;
    var manifest_path_buf: [512]u8 = undefined;
    const manifest_path = std.fmt.bufPrint(
        &manifest_path_buf,
        "{s}/.dsh/profiles/web/package.json",
        .{home},
    ) catch unreachable;
    var handshake_path_buf: [512]u8 = undefined;
    const handshake_path = std.fmt.bufPrint(
        &handshake_path_buf,
        "{s}/.petdex/runtime/dsh-handshake.json",
        .{home},
    ) catch unreachable;
    var manifest_dir_buf: [512]u8 = undefined;
    const manifest_dir = std.fmt.bufPrint(
        &manifest_dir_buf,
        "{s}/.dsh/profiles/web",
        .{home},
    ) catch unreachable;
    var handshake_dir_buf: [512]u8 = undefined;
    const handshake_dir = std.fmt.bufPrint(
        &handshake_dir_buf,
        "{s}/.petdex/runtime",
        .{home},
    ) catch unreachable;
    plat.makeDir(manifest_dir);
    plat.makeDir(handshake_dir);
    const manifest =
        \\{"dependencies":{"@petdex/dsh-plugin":"file:/stable/plugin.tgz"},"dsh":{"profile":{"bundles":["@petdex/dsh-plugin"]}}}
    ;
    try std.testing.expect(plat.writeFile(manifest_path, manifest));
    try std.testing.expectEqual(Status.restart_required, detect(std.testing.allocator, home));
    try std.testing.expect(plat.writeFile(
        handshake_path,
        "{\"integrationVersion\":\"0.1.0\"}",
    ));
    try std.testing.expectEqual(Status.connected, detect(std.testing.allocator, home));
    clearHandshake(home);
    try std.testing.expectEqual(Status.restart_required, detect(std.testing.allocator, home));
}
