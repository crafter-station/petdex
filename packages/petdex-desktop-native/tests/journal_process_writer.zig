const std = @import("std");
const plat = @import("plat");

pub fn main(init: std.process.Init) !void {
    const args = try init.minimal.args.toSlice(std.heap.page_allocator);
    if (args.len != 3 or args[2].len != 1) return error.InvalidArguments;
    const writer = args[2][0];
    for (0..3) |sequence| {
        var record_buf: [6]u8 = undefined;
        const record = try std.fmt.bufPrint(&record_buf, "{c}:{d}xx\n", .{ writer, sequence });
        if (!plat.appendFileModeRotating(args[1], record, 0o600, 64)) return error.AppendFailed;
    }
}
