const std = @import("std");
const builtin = @import("builtin");

pub const endpoint = "https://petdex.crafter.run/api/desktop/latest-release?format=json";
pub const release_page = "https://github.com/crafter-station/petdex/releases";
pub const brew_command = "brew upgrade --cask petdex";
pub const current_version = "0.9.0";

pub const Phase = enum { idle, checking, current, available, failed };
pub const InstallSource = enum { unknown, checking, direct, homebrew };

pub const Latest = struct {
    version: ?[]const u8 = null,
};

fn manifestVersion(source: []const u8) ?[]const u8 {
    const prefix = ".version = \"";
    const start = (std.mem.indexOf(u8, source, prefix) orelse return null) + prefix.len;
    const end = std.mem.indexOfPos(u8, source, start, "\"") orelse return null;
    const value = source[start..end];
    return if (parseVersion(value) == null) null else value;
}

pub fn parseLatest(allocator: std.mem.Allocator, body: []const u8) ?std.json.Parsed(Latest) {
    const parsed = std.json.parseFromSlice(Latest, allocator, body, .{ .ignore_unknown_fields = true }) catch return null;
    if (parsed.value.version) |version| {
        if (parseVersion(version) == null) {
            parsed.deinit();
            return null;
        }
    }
    return parsed;
}

const Version = struct { major: u32, minor: u32, patch: u32 };

fn parseVersion(value: []const u8) ?Version {
    var parts = std.mem.splitScalar(u8, value, '.');
    const major_text = parts.next() orelse return null;
    const minor_text = parts.next() orelse return null;
    const patch_text = parts.next() orelse return null;
    if (parts.next() != null or major_text.len == 0 or minor_text.len == 0 or patch_text.len == 0) return null;
    for (value) |byte| if (byte != '.' and !std.ascii.isDigit(byte)) return null;
    return .{
        .major = std.fmt.parseInt(u32, major_text, 10) catch return null,
        .minor = std.fmt.parseInt(u32, minor_text, 10) catch return null,
        .patch = std.fmt.parseInt(u32, patch_text, 10) catch return null,
    };
}

pub fn isValidVersion(value: []const u8) bool {
    return parseVersion(value) != null;
}

pub fn isNewer(latest: []const u8, current: []const u8) bool {
    const a = parseVersion(latest) orelse return false;
    const b = parseVersion(current) orelse return false;
    if (a.major != b.major) return a.major > b.major;
    if (a.minor != b.minor) return a.minor > b.minor;
    return a.patch > b.patch;
}

pub fn downloadUrl() []const u8 {
    return switch (builtin.os.tag) {
        .macos => switch (builtin.cpu.arch) {
            .aarch64 => "https://petdex.crafter.run/api/desktop/latest-release?asset=darwin-arm64",
            .x86_64 => "https://petdex.crafter.run/api/desktop/latest-release?asset=darwin-x64",
            else => release_page,
        },
        .windows => "https://petdex.crafter.run/api/desktop/latest-release?asset=win32-x64",
        .linux => switch (builtin.cpu.arch) {
            .aarch64 => "https://petdex.crafter.run/api/desktop/latest-release?asset=linux-arm64",
            .x86_64 => "https://petdex.crafter.run/api/desktop/latest-release?asset=linux-x64",
            else => release_page,
        },
        else => release_page,
    };
}

test "current version comes from app.zon" {
    var source_buf: [4096]u8 = undefined;
    const source = @import("plat.zig").readFile("app.zon", &source_buf).?;
    try std.testing.expectEqualStrings(manifestVersion(source).?, current_version);
}

test "semantic versions compare numerically" {
    try std.testing.expect(isNewer("0.10.0", "0.9.9"));
    try std.testing.expect(isNewer("1.0.0", "0.99.99"));
    try std.testing.expect(!isNewer("0.7.0", "0.7.0"));
    try std.testing.expect(!isNewer("0.6.9", "0.7.0"));
    try std.testing.expect(!isNewer("0.8.0-beta.1", "0.7.0"));
    try std.testing.expect(parseVersion("v0.8.0") == null);
    try std.testing.expect(parseVersion("0.8.0.1") == null);
    try std.testing.expect(parseVersion("4294967296.0.0") == null);
}

test "latest release payload accepts null and valid versions" {
    var parsed = parseLatest(std.testing.allocator, "{\"version\":\"0.8.0\",\"tag\":\"desktop-v0.8.0\"}").?;
    defer parsed.deinit();
    try std.testing.expectEqualStrings("0.8.0", parsed.value.version.?);

    var unknown = parseLatest(std.testing.allocator, "{\"version\":null}").?;
    defer unknown.deinit();
    try std.testing.expectEqual(@as(?[]const u8, null), unknown.value.version);

    try std.testing.expect(parseLatest(std.testing.allocator, "{\"version\":\"next\"}") == null);
}
