//! Flock model: one body per live agent instead of one pet for all of them.
//!
//! The mailbox already keeps a bubble per conversation, keyed by session id
//! and carrying the Herdr pane that produced it. Until now the app folded
//! that set into a single `model.state`, so eight agents shared one mascot
//! and one aggregate state. This module keeps the set intact and gives each
//! member a body, a slot, and a state of its own.
//!
//! Pure data: no allocator, no effects, no platform. `reconcile` maps the
//! drained bubbles onto members, `layout` places them in a grid, and both
//! are directly testable without a window.

const std = @import("std");
const hook_server = @import("hook_server.zig");
const sprite = @import("sprite.zig");

pub const max_members = hook_server.max_bubbles;

/// One agent's body. `session` is copied rather than referenced because the
/// mailbox reuses its slots: a member has to survive the next drain that
/// compacts the array underneath it.
pub const Member = struct {
    session: [64]u8 = @splat(0),
    session_len: usize = 0,
    label: [24]u8 = @splat(0),
    label_len: usize = 0,
    herdr_pane: [64]u8 = @splat(0),
    herdr_pane_len: usize = 0,
    state: sprite.State = .idle,
    busy: bool = false,

    pub fn sessionSlice(self: *const Member) []const u8 {
        return self.session[0..self.session_len];
    }
    pub fn labelSlice(self: *const Member) []const u8 {
        return self.label[0..self.label_len];
    }
    pub fn herdrPaneSlice(self: *const Member) []const u8 {
        return self.herdr_pane[0..self.herdr_pane_len];
    }
};

pub const Model = struct {
    members: [max_members]Member = @splat(.{}),
    len: usize = 0,
    open: bool = false,

    pub fn slice(self: *const Model) []const Member {
        return self.members[0..self.len];
    }
};

fn copyInto(dest: []u8, dest_len: *usize, source: []const u8) void {
    const n = @min(dest.len, source.len);
    @memcpy(dest[0..n], source[0..n]);
    @memset(dest[n..], 0);
    dest_len.* = n;
}

/// This agent's body state. The mailbox carries a per-agent attention
/// string when the sender knows one, so a blocked agent reads apart from
/// a working one instead of both collapsing into "busy". Senders that do
/// not report it fall back to the boolean, which is what every existing
/// hook produces.
///
/// The names accepted here are the vocabulary the senders already speak:
/// Herdr's four statuses and the richer set the direct hooks produce.
pub fn stateForBubble(bubble: *const hook_server.Bubble) sprite.State {
    const reported = bubble.agentStateSlice();
    if (reported.len != 0) {
        // Herdr's vocabulary: four statuses, all it can see.
        if (std.mem.eql(u8, reported, "blocked")) return .waiting;
        if (std.mem.eql(u8, reported, "working")) return .running;
        if (std.mem.eql(u8, reported, "done")) return .idle;
        // What the direct hooks add on top, and the reason a body can say
        // more than "busy": a failed tool call, a read-only pass, the end
        // of a turn. None of these cross Herdr's plugin API.
        if (std.mem.eql(u8, reported, "failed")) return .failed;
        if (std.mem.eql(u8, reported, "review")) return .review;
        if (std.mem.eql(u8, reported, "waving")) return .waving;
        if (std.mem.eql(u8, reported, "jumping")) return .jumping;
        if (std.mem.eql(u8, reported, "waiting")) return .waiting;
        if (std.mem.eql(u8, reported, "running")) return .running;
        if (std.mem.eql(u8, reported, "idle")) return .idle;
        // An unknown name is not a reason to lie about the agent: fall
        // through to the boolean rather than inventing a state.
    }
    return if (bubble.busy) .running else .idle;
}

/// Rebuild the member set from the live bubbles, preserving each member's
/// slot across drains so a body does not jump position when an unrelated
/// agent above it goes away. Members whose session is gone are dropped.
pub fn reconcile(model: *Model, bubbles: []const hook_server.Bubble) void {
    var next: [max_members]Member = @splat(.{});
    var taken: [max_members]bool = @splat(false);
    var next_len: usize = 0;

    // First pass: sessions we already had keep their existing slot.
    for (bubbles) |*bubble| {
        const session = bubble.sessionSlice();
        for (model.members[0..model.len], 0..) |*existing, slot| {
            if (existing.session_len == 0) continue;
            if (!std.mem.eql(u8, existing.sessionSlice(), session)) continue;
            if (slot >= max_members or taken[slot]) break;
            next[slot] = existing.*;
            next[slot].state = stateForBubble(bubble);
            next[slot].busy = bubble.busy;
            copyInto(&next[slot].label, &next[slot].label_len, bubble.agent[0..bubble.agent_len]);
            copyInto(&next[slot].herdr_pane, &next[slot].herdr_pane_len, bubble.herdrPaneSlice());
            taken[slot] = true;
            if (slot + 1 > next_len) next_len = slot + 1;
            break;
        }
    }

    // Second pass: new sessions fill the lowest free slot.
    for (bubbles) |*bubble| {
        const session = bubble.sessionSlice();
        var seen = false;
        for (next[0..], 0..) |*member, slot| {
            if (!taken[slot]) continue;
            if (std.mem.eql(u8, member.sessionSlice(), session)) {
                seen = true;
                break;
            }
        }
        if (seen) continue;
        var slot: usize = 0;
        while (slot < max_members and taken[slot]) slot += 1;
        if (slot == max_members) break;
        var member: Member = .{};
        copyInto(&member.session, &member.session_len, session);
        copyInto(&member.label, &member.label_len, bubble.agent[0..bubble.agent_len]);
        copyInto(&member.herdr_pane, &member.herdr_pane_len, bubble.herdrPaneSlice());
        member.state = stateForBubble(bubble);
        member.busy = bubble.busy;
        next[slot] = member;
        taken[slot] = true;
        if (slot + 1 > next_len) next_len = slot + 1;
    }

    // Compact so the renderer walks a dense prefix, keeping relative order.
    var compact: [max_members]Member = @splat(.{});
    var compact_len: usize = 0;
    for (next[0..next_len], 0..) |member, slot| {
        if (!taken[slot]) continue;
        compact[compact_len] = member;
        compact_len += 1;
    }
    model.members = compact;
    model.len = compact_len;
}

pub const Cell = struct {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
};

pub const LayoutSpec = struct {
    cell_w: f32,
    cell_h: f32,
    gap: f32,
    columns: usize,
    /// Height of the agent label under each body. Charged once per row,
    /// not once per window: a second row needs its own strip or the last
    /// bodies render clipped.
    label_h: f32 = 0,
};

/// Grid geometry for `count` bodies. Columns are capped so a single agent
/// does not render in a wide empty row, and the caller sizes its window
/// from `windowSize` with the same spec.
pub fn columnsFor(count: usize, max_columns: usize) usize {
    if (count == 0) return 1;
    if (max_columns == 0) return 1;
    return @min(count, max_columns);
}

pub fn cellFor(index: usize, spec: LayoutSpec) Cell {
    const cols = if (spec.columns == 0) 1 else spec.columns;
    const col = index % cols;
    const row = index / cols;
    return .{
        .x = @as(f32, @floatFromInt(col)) * (spec.cell_w + spec.gap),
        .y = @as(f32, @floatFromInt(row)) * (spec.cell_h + spec.gap),
        .w = spec.cell_w,
        .h = spec.cell_h,
    };
}

pub fn rowsFor(count: usize, columns: usize) usize {
    const cols = if (columns == 0) 1 else columns;
    if (count == 0) return 1;
    return (count + cols - 1) / cols;
}

pub fn windowSize(count: usize, spec: LayoutSpec) struct { w: f32, h: f32 } {
    const cols = if (spec.columns == 0) 1 else spec.columns;
    const rows = rowsFor(count, cols);
    const shown_cols = if (count == 0) 1 else @min(count, cols);
    const rows_f: f32 = @floatFromInt(rows);
    return .{
        .w = @as(f32, @floatFromInt(shown_cols)) * spec.cell_w + @as(f32, @floatFromInt(shown_cols -| 1)) * spec.gap,
        .h = rows_f * (spec.cell_h + spec.label_h) + @as(f32, @floatFromInt(rows -| 1)) * spec.gap,
    };
}

fn testBubbleWithState(session: []const u8, agent: []const u8, busy: bool, state: []const u8) hook_server.Bubble {
    var bubble = testBubble(session, agent, "", busy);
    copyInto(&bubble.agent_state, &bubble.agent_state_len, state);
    return bubble;
}

fn testBubble(session: []const u8, agent: []const u8, pane: []const u8, busy: bool) hook_server.Bubble {
    var bubble: hook_server.Bubble = .{};
    copyInto(&bubble.session, &bubble.session_len, session);
    copyInto(&bubble.agent, &bubble.agent_len, agent);
    copyInto(&bubble.herdr_pane, &bubble.herdr_pane_len, pane);
    bubble.busy = busy;
    return bubble;
}

test "each live session gets its own body" {
    var model: Model = .{};
    const bubbles = [_]hook_server.Bubble{
        testBubble("s1", "claude", "w1:p1", true),
        testBubble("s2", "codex", "w1:p2", false),
    };
    reconcile(&model, &bubbles);
    try std.testing.expectEqual(@as(usize, 2), model.len);
    try std.testing.expectEqualStrings("s1", model.members[0].sessionSlice());
    try std.testing.expectEqualStrings("s2", model.members[1].sessionSlice());
}

test "a busy agent runs while an idle one does not" {
    var model: Model = .{};
    const bubbles = [_]hook_server.Bubble{
        testBubble("s1", "claude", "", true),
        testBubble("s2", "codex", "", false),
    };
    reconcile(&model, &bubbles);
    try std.testing.expectEqual(sprite.State.running, model.members[0].state);
    try std.testing.expectEqual(sprite.State.idle, model.members[1].state);
}

test "a session keeps its body when its state changes" {
    var model: Model = .{};
    reconcile(&model, &[_]hook_server.Bubble{
        testBubble("s1", "claude", "w1:p1", false),
        testBubble("s2", "codex", "w1:p2", false),
    });
    reconcile(&model, &[_]hook_server.Bubble{
        testBubble("s1", "claude", "w1:p1", true),
        testBubble("s2", "codex", "w1:p2", false),
    });
    try std.testing.expectEqual(@as(usize, 2), model.len);
    try std.testing.expectEqualStrings("s1", model.members[0].sessionSlice());
    try std.testing.expectEqual(sprite.State.running, model.members[0].state);
    try std.testing.expectEqual(sprite.State.idle, model.members[1].state);
}

test "a departed session leaves and the survivor keeps its identity" {
    var model: Model = .{};
    reconcile(&model, &[_]hook_server.Bubble{
        testBubble("s1", "claude", "", false),
        testBubble("s2", "codex", "", true),
    });
    reconcile(&model, &[_]hook_server.Bubble{testBubble("s2", "codex", "", true)});
    try std.testing.expectEqual(@as(usize, 1), model.len);
    try std.testing.expectEqualStrings("s2", model.members[0].sessionSlice());
    try std.testing.expectEqual(sprite.State.running, model.members[0].state);
}

test "the pane id survives so a click can reach the session" {
    var model: Model = .{};
    reconcile(&model, &[_]hook_server.Bubble{testBubble("s1", "claude", "w3:pW", true)});
    try std.testing.expectEqualStrings("w3:pW", model.members[0].herdrPaneSlice());
}

test "no live session leaves the flock empty" {
    var model: Model = .{};
    reconcile(&model, &[_]hook_server.Bubble{testBubble("s1", "claude", "", true)});
    reconcile(&model, &[_]hook_server.Bubble{});
    try std.testing.expectEqual(@as(usize, 0), model.len);
}

test "the flock never exceeds the mailbox it reads from" {
    var model: Model = .{};
    var bubbles: [max_members]hook_server.Bubble = undefined;
    var buf: [8]u8 = undefined;
    for (&bubbles, 0..) |*bubble, i| {
        const session = std.fmt.bufPrint(&buf, "s{d}", .{i}) catch unreachable;
        bubble.* = testBubble(session, "claude", "", i % 2 == 0);
    }
    reconcile(&model, &bubbles);
    try std.testing.expectEqual(max_members, model.len);
}

test "bodies tile without overlapping" {
    const spec: LayoutSpec = .{ .cell_w = 100, .cell_h = 80, .gap = 10, .columns = 3 };
    const a = cellFor(0, spec);
    const b = cellFor(1, spec);
    const c = cellFor(3, spec);
    try std.testing.expectEqual(@as(f32, 0), a.x);
    try std.testing.expectEqual(@as(f32, 110), b.x);
    try std.testing.expectEqual(@as(f32, 0), c.x);
    try std.testing.expectEqual(@as(f32, 90), c.y);
    try std.testing.expect(a.x + a.w <= b.x);
}

test "the window grows with the flock and never collapses" {
    const spec: LayoutSpec = .{ .cell_w = 100, .cell_h = 80, .gap = 10, .columns = 3 };
    const one = windowSize(1, spec);
    const four = windowSize(4, spec);
    const empty = windowSize(0, spec);
    try std.testing.expectEqual(@as(f32, 100), one.w);
    try std.testing.expectEqual(@as(f32, 80), one.h);
    try std.testing.expectEqual(@as(f32, 320), four.w);
    try std.testing.expectEqual(@as(f32, 170), four.h);
    try std.testing.expect(empty.w > 0 and empty.h > 0);
}

test "a second row gets its own label strip" {
    // The fifth body wraps. Charging the label once per window instead of
    // once per row clipped it: the window was one row tall while the
    // content was two.
    const spec: LayoutSpec = .{ .cell_w = 100, .cell_h = 80, .gap = 10, .columns = 4, .label_h = 18 };
    const four = windowSize(4, spec);
    const five = windowSize(5, spec);
    try std.testing.expectEqual(@as(f32, 98), four.h);
    try std.testing.expectEqual(@as(f32, 206), five.h);
    try std.testing.expect(five.h > four.h);
}

test "columns never exceed the bodies on screen" {
    try std.testing.expectEqual(@as(usize, 1), columnsFor(1, 4));
    try std.testing.expectEqual(@as(usize, 4), columnsFor(6, 4));
    try std.testing.expectEqual(@as(usize, 1), columnsFor(0, 4));
    try std.testing.expectEqual(@as(usize, 2), rowsFor(6, 4));
    try std.testing.expectEqual(@as(usize, 1), rowsFor(0, 4));
}

test "a blocked agent reads apart from a working one" {
    var model: Model = .{};
    reconcile(&model, &[_]hook_server.Bubble{
        testBubbleWithState("s1", "claude", true, "blocked"),
        testBubbleWithState("s2", "codex", true, "working"),
    });
    try std.testing.expectEqual(sprite.State.waiting, model.members[0].state);
    try std.testing.expectEqual(sprite.State.running, model.members[1].state);
}

test "one agent changing state leaves the others alone" {
    // The aggregate the pet window shows would move every body at once.
    // Here only the session that reported a change moves.
    var model: Model = .{};
    const before = [_]hook_server.Bubble{
        testBubbleWithState("s1", "claude", true, "working"),
        testBubbleWithState("s2", "codex", true, "working"),
    };
    reconcile(&model, &before);
    try std.testing.expectEqual(sprite.State.running, model.members[1].state);

    reconcile(&model, &[_]hook_server.Bubble{
        testBubbleWithState("s1", "claude", true, "blocked"),
        testBubbleWithState("s2", "codex", true, "working"),
    });
    try std.testing.expectEqual(sprite.State.waiting, model.members[0].state);
    try std.testing.expectEqual(sprite.State.running, model.members[1].state);
}

test "a sender that reports no state keeps the busy behaviour" {
    var model: Model = .{};
    reconcile(&model, &[_]hook_server.Bubble{
        testBubble("s1", "claude", "", true),
        testBubble("s2", "codex", "", false),
    });
    try std.testing.expectEqual(sprite.State.running, model.members[0].state);
    try std.testing.expectEqual(sprite.State.idle, model.members[1].state);
}

test "an unknown state name falls back instead of inventing one" {
    var model: Model = .{};
    reconcile(&model, &[_]hook_server.Bubble{
        testBubbleWithState("s1", "claude", true, "quantum"),
        testBubbleWithState("s2", "codex", false, "quantum"),
    });
    try std.testing.expectEqual(sprite.State.running, model.members[0].state);
    try std.testing.expectEqual(sprite.State.idle, model.members[1].state);
}

test "Herdr done means idle, not verified completion" {
    var model: Model = .{};
    reconcile(&model, &[_]hook_server.Bubble{testBubbleWithState("s1", "claude", true, "done")});
    try std.testing.expectEqual(sprite.State.idle, model.members[0].state);
}

test "a failed tool call shows as failure, not as idle" {
    // The whole competitive claim: Herdr's plugin API carries four
    // statuses and none of them is "that tool call errored". The direct
    // hooks compute it, so a body can show it.
    var model: Model = .{};
    reconcile(&model, &[_]hook_server.Bubble{testBubbleWithState("s1", "claude", true, "failed")});
    try std.testing.expectEqual(sprite.State.failed, model.members[0].state);
}

test "a read-only pass reads apart from an edit" {
    var model: Model = .{};
    reconcile(&model, &[_]hook_server.Bubble{
        testBubbleWithState("s1", "claude", true, "review"),
        testBubbleWithState("s2", "codex", true, "working"),
    });
    try std.testing.expectEqual(sprite.State.review, model.members[0].state);
    try std.testing.expectEqual(sprite.State.running, model.members[1].state);
}

test "the states Herdr cannot express all survive the trip" {
    // Each of these comes from a direct hook and has no equivalent in
    // Herdr's working/blocked/idle/done.
    const cases = [_]struct { reported: []const u8, want: sprite.State }{
        .{ .reported = "failed", .want = .failed },
        .{ .reported = "review", .want = .review },
        .{ .reported = "waving", .want = .waving },
        .{ .reported = "jumping", .want = .jumping },
    };
    for (cases) |case| {
        var model: Model = .{};
        reconcile(&model, &[_]hook_server.Bubble{testBubbleWithState("s1", "claude", true, case.reported)});
        try std.testing.expectEqual(case.want, model.members[0].state);
    }
}

test "a body without a pane offers no jump" {
    // Direct hooks outside Herdr carry no pane. Such a body must stay
    // inert rather than presenting a click that would reach nothing.
    var model: Model = .{};
    reconcile(&model, &[_]hook_server.Bubble{
        testBubble("s1", "claude", "", true),
        testBubble("s2", "codex", "w1:p9", true),
    });
    try std.testing.expectEqual(@as(usize, 0), model.members[0].herdrPaneSlice().len);
    try std.testing.expectEqualStrings("w1:p9", model.members[1].herdrPaneSlice());
}

test "each body keeps its own pane, so a click cannot reach the wrong session" {
    var model: Model = .{};
    reconcile(&model, &[_]hook_server.Bubble{
        testBubble("s1", "claude", "w1:pA", true),
        testBubble("s2", "codex", "w1:pB", true),
        testBubble("s3", "gemini", "w1:pC", true),
    });
    try std.testing.expectEqualStrings("w1:pA", model.members[0].herdrPaneSlice());
    try std.testing.expectEqualStrings("w1:pB", model.members[1].herdrPaneSlice());
    try std.testing.expectEqualStrings("w1:pC", model.members[2].herdrPaneSlice());
}
