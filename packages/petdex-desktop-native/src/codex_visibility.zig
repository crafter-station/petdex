const std = @import("std");
const plat = @import("plat.zig");

pub const Visibility = enum { unknown, visible, hidden };

fn field(value: std.json.Value, key: []const u8) ?std.json.Value {
    if (value != .object) return null;
    return value.object.get(key);
}

fn string(value: std.json.Value, key: []const u8) ?[]const u8 {
    const item = field(value, key) orelse return null;
    return if (item == .string) item.string else null;
}

pub fn metadata(value: std.json.Value) Visibility {
    if (field(value, "source")) |source| {
        if (string(source, "internal")) |internal| {
            if (std.mem.eql(u8, internal, "guardian") or std.mem.eql(u8, internal, "memory_consolidation")) return .hidden;
        }
    }
    const source = string(value, "thread_source") orelse return .unknown;
    for ([_][]const u8{ "ambient_suggestions", "chatgpt_hidden", "guardian_review", "memory_consolidation" }) |hidden| {
        if (std.mem.eql(u8, source, hidden)) return .hidden;
    }
    return if (std.mem.eql(u8, source, "user") or std.mem.eql(u8, source, "ambient_suggestion_task")) .visible else .unknown;
}

pub fn suggestionPrompt(prompt: []const u8) bool {
    const prefix = "# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in ";
    const trimmed = std.mem.trimStart(u8, prompt, " \t\r\n");
    if (!std.mem.startsWith(u8, trimmed, prefix)) return false;
    const context = trimmed[prefix.len..];
    return std.mem.startsWith(u8, context, "this Projectless task") or
        std.mem.startsWith(u8, context, "this local project: ");
}

pub fn classify(payload: []const u8) Visibility {
    const allocator = std.heap.page_allocator;
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, payload, .{}) catch return .unknown;
    defer parsed.deinit();
    const direct = metadata(parsed.value);
    if (direct != .unknown) return direct;
    if (string(parsed.value, "transcript_path")) |path| {
        if (string(parsed.value, "session_id")) |session| {
            var prefix: [64 * 1024]u8 = undefined;
            if (plat.readFile(path, &prefix)) |bytes| {
                var lines = std.mem.splitScalar(u8, bytes, '\n');
                while (lines.next()) |line| {
                    const record = std.json.parseFromSlice(std.json.Value, allocator, line, .{}) catch continue;
                    defer record.deinit();
                    const kind = string(record.value, "type") orelse continue;
                    if (!std.mem.eql(u8, kind, "session_meta")) continue;
                    const meta = field(record.value, "payload") orelse continue;
                    const id = string(meta, "id") orelse continue;
                    if (!std.mem.eql(u8, id, session)) continue;
                    const visibility = metadata(meta);
                    if (visibility != .unknown) return visibility;
                }
            }
        }
    }
    const prompt = string(parsed.value, "prompt") orelse string(parsed.value, "user_message") orelse return .unknown;
    return if (suggestionPrompt(prompt)) .hidden else .unknown;
}

test "Codex visibility uses provenance without hiding projectless user sessions" {
    for ([_][]const u8{
        "{\"thread_source\":\"ambient_suggestions\"}",
        "{\"thread_source\":\"chatgpt_hidden\",\"cwd\":\"/project\"}",
        "{\"thread_source\":\"guardian_review\"}",
        "{\"thread_source\":\"memory_consolidation\"}",
        "{\"source\":{\"internal\":\"guardian\"}}",
    }) |payload| try std.testing.expectEqual(.hidden, classify(payload));
    try std.testing.expectEqual(.visible, classify("{\"thread_source\":\"user\",\"cwd\":\"\",\"ephemeral\":true}"));
    try std.testing.expectEqual(.visible, classify("{\"thread_source\":\"ambient_suggestion_task\",\"cwd\":\"\"}"));
    for ([_][]const u8{
        "{\"cwd\":\"\",\"prompt\":\"Suggest improvements for my project\"}",
        "{\"cwd\":\"/project\",\"prompt\":\"Fix the build\"}",
        "{\"ephemeral\":true}",
        "{\"thread_source\":\"unrecognized_feature\"}",
        "{\"tool_input\":{\"thread_source\":\"ambient_suggestions\"}}",
        "{",
    }) |payload| try std.testing.expectEqual(.unknown, classify(payload));
}

test "Codex suggestion fallback matches only the observed internal prompt" {
    const prompt = "# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this Projectless task";
    const hidden = try std.json.Stringify.valueAlloc(std.testing.allocator, .{ .prompt = prompt }, .{});
    defer std.testing.allocator.free(hidden);
    try std.testing.expectEqual(.hidden, classify(hidden));
    const visible = try std.json.Stringify.valueAlloc(std.testing.allocator, .{ .thread_source = "user", .prompt = prompt }, .{});
    defer std.testing.allocator.free(visible);
    try std.testing.expectEqual(.visible, classify(visible));
    try std.testing.expect(!suggestionPrompt("Explain this prompt: " ++ prompt));
    try std.testing.expect(!suggestionPrompt("Generate personalized suggestions for this Projectless task"));
}

test "Codex transcript provenance must match the hook session" {
    const allocator = std.testing.allocator;
    const io = std.testing.io;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    try temp.dir.writeFile(io, .{
        .sub_path = "rollout.jsonl",
        .data = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"hidden\",\"thread_source\":\"ambient_suggestions\"}}\n",
    });
    const path = try temp.dir.realPathFileAlloc(io, "rollout.jsonl", allocator);
    defer allocator.free(path);
    const matching = try std.json.Stringify.valueAlloc(allocator, .{ .session_id = "hidden", .transcript_path = path }, .{});
    defer allocator.free(matching);
    const unrelated = try std.json.Stringify.valueAlloc(allocator, .{ .session_id = "visible", .transcript_path = path }, .{});
    defer allocator.free(unrelated);
    try std.testing.expectEqual(.hidden, classify(matching));
    try std.testing.expectEqual(.unknown, classify(unrelated));
}
