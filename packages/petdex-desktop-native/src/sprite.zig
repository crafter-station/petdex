//! Sprite sheet geometry: which row of the atlas each mascot state
//! lives on, and how long each of its frames holds.
//!
//! Extracted from main.zig (#613). Pure data plus two comptime helpers,
//! no model and no effects, so the animation tables can change without
//! touching the app loop.

const std = @import("std");

pub const State = enum(u8) {
    idle,
    @"running-right",
    @"running-left",
    waving,
    jumping,
    failed,
    waiting,
    running,
    review,

    pub fn next(self: State) State {
        const n = (@intFromEnum(self) + 1) % 9;
        return @enumFromInt(n);
    }
};

pub const FrameSpec = struct { col: u64, dur_ms: u32 };

fn uniform(comptime count: u64, comptime dur: u32, comptime last: u32) [count]FrameSpec {
    var frames: [count]FrameSpec = undefined;
    for (&frames, 0..) |*f, i| {
        f.* = .{ .col = i, .dur_ms = if (i == count - 1) last else dur };
    }
    return frames;
}

const idle_frames = [_]FrameSpec{
    .{ .col = 0, .dur_ms = 280 }, .{ .col = 1, .dur_ms = 110 },
    .{ .col = 2, .dur_ms = 110 }, .{ .col = 3, .dur_ms = 140 },
    .{ .col = 4, .dur_ms = 140 }, .{ .col = 5, .dur_ms = 320 },
};
const running_right_frames = uniform(8, 120, 220);
const running_left_frames = uniform(8, 120, 220);
const waving_frames = uniform(4, 140, 280);
const jumping_frames = uniform(5, 140, 280);
const failed_frames = uniform(8, 140, 240);
const waiting_frames = uniform(6, 150, 260);
const running_frames = uniform(6, 120, 220);
const review_frames = uniform(6, 150, 280);

pub const StateDef = struct { row: u64, frames: []const FrameSpec };

pub fn stateDef(state: State) StateDef {
    return switch (state) {
        .idle => .{ .row = 0, .frames = &idle_frames },
        .@"running-right" => .{ .row = 1, .frames = &running_right_frames },
        .@"running-left" => .{ .row = 2, .frames = &running_left_frames },
        .waving => .{ .row = 3, .frames = &waving_frames },
        .jumping => .{ .row = 4, .frames = &jumping_frames },
        .failed => .{ .row = 5, .frames = &failed_frames },
        .waiting => .{ .row = 6, .frames = &waiting_frames },
        .running => .{ .row = 7, .frames = &running_frames },
        .review => .{ .row = 8, .frames = &review_frames },
    };
}

