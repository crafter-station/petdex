const std = @import("std");
const plat = @import("plat.zig");

pub const Status = enum(u8) {
    absent,
    available,
    connected,

    pub fn caption(self: Status) []const u8 {
        return switch (self) {
            .absent => "Not detected",
            .available => "Installed; Petdex plugin not connected",
            .connected => "Petdex plugin connected",
        };
    }
};

pub fn detect(allocator: std.mem.Allocator, home: []const u8) Status {
    if (!plat.herdrAvailable(home)) return .absent;
    var path_buf: [768]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/.config/herdr/plugins.json", .{home}) catch return .available;
    const source = plat.readFileAlloc(allocator, path, 1024 * 1024) orelse return .available;
    defer allocator.free(source);
    return if (petdexPluginEnabled(allocator, source)) .connected else .available;
}

fn petdexPluginEnabled(allocator: std.mem.Allocator, source: []const u8) bool {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, source, .{}) catch return false;
    defer parsed.deinit();
    if (parsed.value != .array) return false;
    for (parsed.value.array.items) |entry| {
        if (entry != .object) continue;
        const id = entry.object.get("plugin_id") orelse continue;
        if (id != .string or !std.mem.eql(u8, id.string, "dev.petdex.bridge")) continue;
        const enabled = entry.object.get("enabled") orelse return false;
        return enabled == .bool and enabled.bool;
    }
    return false;
}

test "Petdex Herdr plugin status follows its enabled field" {
    const allocator = std.testing.allocator;
    try std.testing.expect(petdexPluginEnabled(allocator, "[{\"plugin_id\":\"dev.petdex.bridge\",\"enabled\":true}]"));
    try std.testing.expect(!petdexPluginEnabled(allocator, "[{\"plugin_id\":\"dev.petdex.bridge\",\"enabled\":false}]"));
    try std.testing.expect(!petdexPluginEnabled(allocator, "[{\"plugin_id\":\"other\",\"enabled\":true}]"));
}
