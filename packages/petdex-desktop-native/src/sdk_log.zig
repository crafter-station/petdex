const std = @import("std");
const native_sdk = @import("native_sdk");
const plat = @import("plat.zig");

const max_bytes: u64 = 32 * 1024 * 1024;
const check_interval_ms: i64 = 10 * 60 * 1000;

var path_buffers: native_sdk.debug.LogPathBuffers = .{};
var retention: ?Retention = null;

pub fn init(env: *std.process.Environ.Map) void {
    retention = null;
    if (env.get("NATIVE_SDK_LOG_DIR") != null) return;
    const paths = native_sdk.debug.resolveLogPaths(
        &path_buffers,
        "dev.petdex.desktop-native",
        native_sdk.debug.envFromMap(env),
        null,
    ) catch return;
    if (!std.fs.path.isAbsolute(paths.log_file)) return;
    retention = Retention.init(paths.log_file, plat.nowMs());
}

pub fn tick(now_ms: i64) void {
    if (retention) |*active| active.tick(now_ms);
}

const Retention = struct {
    path: []const u8,
    last_check_ms: i64,

    fn init(path: []const u8, now_ms: i64) Retention {
        _ = enforceCap(path, max_bytes);
        return .{ .path = path, .last_check_ms = now_ms };
    }

    fn tick(self: *Retention, now_ms: i64) void {
        if (now_ms >= self.last_check_ms and now_ms -| self.last_check_ms < check_interval_ms) return;
        self.last_check_ms = now_ms;
        _ = enforceCap(self.path, max_bytes);
    }
};

fn enforceCap(path: []const u8, limit: u64) bool {
    var scope = plat.Scope.init();
    defer scope.deinit();
    const io = scope.io();
    const cwd = std.Io.Dir.cwd();
    const stat = cwd.statFile(io, path, .{ .follow_symlinks = false }) catch return false;
    if (stat.kind != .file or stat.size <= limit) return false;
    cwd.deleteFile(io, path) catch return false;
    return true;
}

fn writeSizedFile(dir: std.Io.Dir, name: []const u8, size: u64) !void {
    const io = std.testing.io;
    const file = try dir.createFile(io, name, .{});
    defer file.close(io);
    try file.setLength(io, size);
}

test "retention removes only an oversized regular log" {
    const t = std.testing;
    const io = t.io;
    var dir = t.tmpDir(.{});
    defer dir.cleanup();
    var buf: [256]u8 = undefined;
    const path = try std.fmt.bufPrint(&buf, ".zig-cache/tmp/{s}/native-sdk.jsonl", .{dir.sub_path});
    try dir.dir.writeFile(io, .{ .sub_path = "last-panic.txt", .data = "keep" });
    try t.expect(!enforceCap(path, max_bytes));
    try writeSizedFile(dir.dir, "native-sdk.jsonl", max_bytes);
    try t.expect(!enforceCap(path, max_bytes));
    try t.expectEqual(max_bytes, (try dir.dir.statFile(io, "native-sdk.jsonl", .{})).size);
    try writeSizedFile(dir.dir, "native-sdk.jsonl", max_bytes + 1);
    try t.expect(enforceCap(path, max_bytes));
    try t.expectError(error.FileNotFound, dir.dir.statFile(io, "native-sdk.jsonl", .{}));
    try t.expectEqual(@as(u64, 4), (try dir.dir.statFile(io, "last-panic.txt", .{})).size);
    try dir.dir.createDir(io, "native-sdk.jsonl", .default_dir);
    try t.expect(!enforceCap(path, 0));
}

test "retention reclaims legacy logs and repeated growth after each interval" {
    const t = std.testing;
    const io = t.io;
    var dir = t.tmpDir(.{});
    defer dir.cleanup();
    var buf: [256]u8 = undefined;
    const path = try std.fmt.bufPrint(&buf, ".zig-cache/tmp/{s}/native-sdk.jsonl", .{dir.sub_path});
    try writeSizedFile(dir.dir, "native-sdk.jsonl", 33 * 1024 * 1024);
    var active = Retention.init(path, 1000);
    try t.expectError(error.FileNotFound, dir.dir.statFile(io, "native-sdk.jsonl", .{}));
    try writeSizedFile(dir.dir, "native-sdk.jsonl", max_bytes + 1);
    active.tick(1000 + check_interval_ms - 1);
    try t.expectEqual(max_bytes + 1, (try dir.dir.statFile(io, "native-sdk.jsonl", .{})).size);
    active.tick(1000 + check_interval_ms);
    try t.expectError(error.FileNotFound, dir.dir.statFile(io, "native-sdk.jsonl", .{}));
    try writeSizedFile(dir.dir, "native-sdk.jsonl", max_bytes + 1);
    active.tick(1000 + check_interval_ms * 2);
    try t.expectError(error.FileNotFound, dir.dir.statFile(io, "native-sdk.jsonl", .{}));
    try writeSizedFile(dir.dir, "native-sdk.jsonl", max_bytes + 1);
    active.tick(0);
    try t.expectError(error.FileNotFound, dir.dir.statFile(io, "native-sdk.jsonl", .{}));
}

test "retention leaves symlinks and their targets intact" {
    if (@import("builtin").os.tag == .windows) return error.SkipZigTest;
    const t = std.testing;
    const io = t.io;
    var dir = t.tmpDir(.{});
    defer dir.cleanup();
    var buf: [256]u8 = undefined;
    const path = try std.fmt.bufPrint(&buf, ".zig-cache/tmp/{s}/native-sdk.jsonl", .{dir.sub_path});
    try writeSizedFile(dir.dir, "diagnostic.jsonl", max_bytes + 1);
    try dir.dir.symLink(io, "diagnostic.jsonl", "native-sdk.jsonl", .{});
    try t.expect(!enforceCap(path, max_bytes));
    try t.expectEqual(std.Io.File.Kind.sym_link, (try dir.dir.statFile(io, "native-sdk.jsonl", .{ .follow_symlinks = false })).kind);
    try t.expectEqual(max_bytes + 1, (try dir.dir.statFile(io, "diagnostic.jsonl", .{})).size);
}

test "retention leaves user-directed log directories unmanaged" {
    var env: std.process.Environ.Map = .init(std.testing.allocator);
    defer env.deinit();
    try env.put("NATIVE_SDK_LOG_DIR", "");
    init(&env);
    try std.testing.expect(retention == null);
    try env.put("NATIVE_SDK_LOG_DIR", "/tmp/custom-diagnostics");
    init(&env);
    try std.testing.expect(retention == null);
}
