//! Coalescing directory-watch policy above the platform backends in plat.zig.
//! Native notifications are hints; bounded reconciliation scans remain the
//! authority, and a low-frequency sweep covers dropped/unsupported events.

const std = @import("std");
const plat = @import("plat.zig");

pub const safety_sweep_ms: i64 = 60_000;
pub const polling_fallback_ms: i64 = 2_000;

pub const Trigger = enum { none, changed, overflow, safety };

pub const Controller = struct {
    native: plat.DirectoryWatch,
    started: bool = false,
    last_sweep_ms: i64 = 0,
    cursor: u64 = 0,

    pub fn init(path: []const u8) ?Controller {
        return .{ .native = plat.DirectoryWatch.init(path) orelse return null };
    }

    pub fn start(self: *Controller) void {
        self.started = self.native.start();
    }

    pub fn root(self: *const Controller) []const u8 {
        return self.native.root();
    }

    /// Coalesces any number of native events into one reconciliation trigger.
    /// Overflow is explicit so callers reset their incremental scan cursor but
    /// still honor the same per-pass work/time budget.
    pub fn poll(self: *Controller, monotonic_now_ms: i64) Trigger {
        const signal = if (self.started) self.native.take() else .none;
        const interval = if (self.started) safety_sweep_ms else polling_fallback_ms;
        const trigger = decide(signal, self.last_sweep_ms, monotonic_now_ms, interval);
        if (trigger != .none) {
            self.last_sweep_ms = monotonic_now_ms;
            self.cursor +%= 1;
        }
        return trigger;
    }
};

fn decide(signal: plat.DirectoryWatchSignal, last_ms: i64, now_ms: i64, interval_ms: i64) Trigger {
    return switch (signal) {
        .overflow => .overflow,
        .dirty => .changed,
        .none => if (last_ms == 0 or now_ms - last_ms >= interval_ms) .safety else .none,
    };
}

test "watch policy prioritizes overflow and keeps bounded safety fallback" {
    std.testing.refAllDecls(plat.DirectoryWatch);
    try std.testing.expectEqual(Trigger.overflow, decide(.overflow, 1_000, 1_001, safety_sweep_ms));
    try std.testing.expectEqual(Trigger.changed, decide(.dirty, 1_000, 1_001, safety_sweep_ms));
    try std.testing.expectEqual(Trigger.none, decide(.none, 1_000, 1_999, polling_fallback_ms));
    try std.testing.expectEqual(Trigger.safety, decide(.none, 1_000, 3_000, polling_fallback_ms));
    try std.testing.expectEqual(Trigger.safety, decide(.none, 1_000, 61_000, safety_sweep_ms));
}

test "watch controller advances one cursor per coalesced scheduling decision" {
    var controller = Controller.init("safe-root").?;
    controller.started = true;
    controller.native.dirty.store(true, .release);
    controller.native.dirty.store(true, .release);
    try std.testing.expectEqual(Trigger.changed, controller.poll(10));
    try std.testing.expectEqual(@as(u64, 1), controller.cursor);
    try std.testing.expectEqual(Trigger.none, controller.poll(11));
    controller.native.overflow.store(true, .release);
    try std.testing.expectEqual(Trigger.overflow, controller.poll(12));
    try std.testing.expectEqual(@as(u64, 2), controller.cursor);
}
