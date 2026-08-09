//! The Settings window's view tree: the pet picker, the Agents rows,
//! the install banner, and every Appearance control.
//!
//! Extracted from main.zig (#613). Six of the last seven PRs to touch
//! main.zig added a row here, so this was the busiest contended region
//! in the file. It reads the model and returns nodes; it owns no state
//! and runs no effects, which is what makes it separable at all.
//!
//! The agent-icon atlas is the one exception: those globals live in
//! main.zig beside the registration that fills them, so they arrive as
//! `IconAtlas` rather than being reached across the module boundary.

const std = @import("std");
const builtin = @import("builtin");
const native_sdk = @import("native_sdk");
const canvas = native_sdk.canvas;
const geometry = native_sdk.geometry;

const app = @import("main.zig");
const Model = app.Model;
const Msg = app.Msg;
const AppUi = app.AppUi;
const custom_font_active = &app.custom_font_active;
const bubble_text_min_px = app.bubble_text_min_px;
const bubble_text_max_px = app.bubble_text_max_px;
const bubble_columns_min = app.bubble_columns_min;
const bubble_columns_max = app.bubble_columns_max;
const bubble_answer_lines_min = app.bubble_answer_lines_min;
const bubble_answer_lines_max = app.bubble_answer_lines_max;
const catalog_mod = @import("catalog.zig");
const catalog = &catalog_mod.catalog;
const catalog_len = &catalog_mod.catalog_len;
const max_catalog = catalog_mod.max_catalog;
const agent_hooks = @import("agent_hooks.zig");
const settingsBackground = app.settingsBackground;

/// Where the agent logos are, handed in so this file does not reach into
/// main.zig's registration state.
pub const IconAtlas = struct {
    ready: bool,
    image: u64,
    rect: *const fn (usize) geometry.RectF,
};

/// The pet thumbnail atlas, same reasoning as IconAtlas: the pixels and
/// the per-pet ready flags are filled incrementally by main.zig's poll
/// timer, so the view reads them rather than owning them.
pub const ThumbAtlas = struct {
    image: u64,
    ready: []const bool,
    cell_w: f32,
    cell_h: f32,
};

/// Secondary copy in a settings row. A plain `ui.text` leaf is always
/// single-line and elides when the trailing control narrows its column.
/// Span paragraphs word-wrap and make the row reserve the resulting
/// height, so the default window width remains fully readable.
fn mutedParagraph(ui: *AppUi, content: []const u8) AppUi.Node {
    return ui.paragraph(.{
        .size = .sm,
        .style_tokens = .{ .foreground = .text_muted },
    }, &.{.{ .text = content }});
}

fn agentStatusCaption(info: agent_hooks.AgentInfo, codex_note: bool) []const u8 {
    if (info.kind == .codex and codex_note) return "Installed - restart Codex and approve its hooks once";
    if (info.kind == .opencode) {
        return switch (info.status) {
            .absent => "Not detected",
            .none => "Plugin not installed",
            .node => "Plugin outdated",
            .current => "Connected",
        };
    }
    return switch (info.status) {
        .absent => "Not detected",
        .none => "Hooks not installed",
        .node => "Hooks outdated (CLI runner)",
        .current => "Connected",
    };
}

var more_label_buf: [48]u8 = undefined;

var install_label_buf: [128]u8 = undefined;

fn petMatchesFilter(name: []const u8, filter: []const u8) bool {
    if (filter.len == 0) return true;
    if (name.len < filter.len) return false;
    var i: usize = 0;
    while (i + filter.len <= name.len) : (i += 1) {
        var match = true;
        for (filter, 0..) |c, j| {
            if (std.ascii.toLower(name[i + j]) != std.ascii.toLower(c)) {
                match = false;
                break;
            }
        }
        if (match) return true;
    }
    return false;
}

fn moreLabel(total: usize) []const u8 {
    return std.fmt.bufPrint(&more_label_buf, "Show all ({d})", .{total}) catch "Show all";
}

/// Download progress and the last failure, in the Settings page the app
/// already has. A deep-link install is otherwise invisible: the pet just
/// appears seconds later with no indication anything was happening.
fn installBanner(ui: *AppUi, model: *const Model) AppUi.Node {
    if (model.install.busy()) {
        const slug = model.install.currentSlug();
        const label = switch (model.install.phase) {
            .manifest => std.fmt.bufPrint(&install_label_buf, "Looking up pets\u{2026}", .{}) catch "Looking up pets",
            // The pet.json leg is a few hundred bytes and flashes past,
            // so both download legs read as one "Downloading" step
            // rather than flickering between two labels.
            .pet_json, .spritesheet => std.fmt.bufPrint(&install_label_buf, "Downloading {s}\u{2026}", .{slug}) catch "Downloading pet",
            .idle => unreachable,
        };
        return ui.el(.panel, .{ .padding = 12, .style_tokens = .{ .background = .surface, .radius = .md } }, .{
            ui.row(.{ .gap = 10, .cross = .center }, .{
                ui.el(.spinner, .{ .width = 16, .height = 16, .semantics = .{ .label = "Installing" } }, .{}),
                ui.text(.{ .size = .sm }, label),
            }),
        });
    }
    if (model.install.error_len > 0) {
        var message = ui.text(.{ .size = .sm }, model.install.errorSlice());
        message.widget.style.foreground = canvas.Color.rgb8(250, 105, 94);
        return ui.el(.panel, .{ .padding = 12, .style_tokens = .{ .background = .surface, .radius = .md } }, .{
            ui.row(.{ .gap = 10, .cross = .center }, .{
                ui.column(.{ .grow = 1 }, .{message}),
                ui.button(.{ .size = .sm, .variant = .secondary, .on_press = .dismiss_install_error }, "Dismiss"),
            }),
        });
    }
    return ui.el(.stack, .{}, .{});
}

fn agentsSection(ui: *AppUi, model: *const Model, icons: IconAtlas) AppUi.Node {
    var rows: [agent_hooks.agent_count]AppUi.Node = undefined;
    var count: usize = 0;
    for (model.agents, 0..) |info, i| {
        if (info.status == .absent) continue;
        const trailing = if (info.status == .current)
            ui.button(.{
                .size = .sm,
                .variant = .secondary,
                .on_press = Msg{ .uninstall_agent = @intCast(i) },
            }, "Disconnect")
        else
            ui.button(.{
                .size = .sm,
                .variant = .primary,
                .on_press = Msg{ .install_agent = @intCast(i) },
            }, if (info.status == .node) "Update" else "Install");
        var logo = ui.image(.{
            .width = 24,
            .height = 24,
            .image = if (icons.ready) icons.image else 0,
            .semantics = .{ .label = info.kind.displayName() },
        });
        logo.widget.image_src = icons.rect(@intFromEnum(info.kind));
        logo.widget.image_fit = .contain;
        rows[count] = ui.el(.panel, .{
            .padding = 12,
            .gap = 12,
            .cross = .center,
            .style_tokens = .{ .background = .surface, .radius = .md },
            .semantics = .{ .label = info.kind.displayName() },
        }, .{
            ui.row(.{ .gap = 12, .cross = .center }, .{
                logo,
                ui.column(.{ .grow = 1, .main = .center }, .{
                    ui.text(.{}, info.kind.displayName()),
                    mutedParagraph(ui, agentStatusCaption(info, model.codex_trust_note)),
                }),
                trailing,
            }),
        });
        count += 1;
    }
    if (count == 0) {
        return ui.el(.panel, .{ .padding = 12, .style_tokens = .{ .background = .surface, .radius = .md } }, .{
            ui.text(.{ .size = .sm, .style_tokens = .{ .foreground = .text_muted } }, "No coding agents detected on this machine"),
        });
    }
    return ui.column(.{ .gap = 12 }, @as([]const AppUi.Node, rows[0..count]));
}

pub fn settingsView(ui: *AppUi, model: *const Model, icons: IconAtlas, thumbs: ThumbAtlas) AppUi.Node {
    var rows: [max_catalog]AppUi.Node = undefined;
    var shown: usize = 0;
    var matches: usize = 0;
    const max_visible: usize = if (model.pets_expanded) max_catalog else 6;
    const filter = model.pet_filter[0..model.pet_filter_len];
    for (catalog[0..@min(catalog_mod.catalog_len, max_catalog)], 0..) |*entry, i| {
        if (!petMatchesFilter(entry.slice(), filter)) continue;
        matches += 1;
        if (shown >= max_visible) continue;
        const active = i == model.active_pet;
        var thumb = ui.image(.{
            .width = 40,
            .height = 44,
            .image = if (thumbs.ready[i]) thumbs.image else 0,
            .semantics = .{ .label = entry.slice() },
        });
        thumb.widget.image_src = geometry.RectF.init(
            @as(f32, @floatFromInt(i)) * thumbs.cell_w,
            0,
            thumbs.cell_w,
            thumbs.cell_h,
        );
        thumb.widget.image_fit = .contain;
        thumb.widget.image_sampling = .nearest;
        rows[shown] = ui.el(.list_item, .{
            .height = 56,
            .padding = 8,
            .gap = 12,
            .cross = .center,
            .on_press = Msg{ .select_pet = @intCast(i) },
            .selected = active,
            .style_tokens = .{ .background = .surface, .radius = .md },
            .semantics = .{ .label = entry.slice() },
        }, .{
            thumb,
            ui.column(.{ .grow = 1, .main = .center }, .{
                ui.text(.{}, entry.slice()),
                ui.text(.{ .size = .sm, .style_tokens = .{ .foreground = .text_muted } }, entry.rootSlice()),
            }),
            if (active)
                ui.button(.{ .size = .sm, .width = 64, .variant = .primary, .disabled = true }, "Active")
            else
                ui.button(.{ .size = .sm, .width = 64, .variant = .primary, .on_press = Msg{ .select_pet = @intCast(i) } }, "Select"),
            ui.button(.{ .size = .sm, .variant = .secondary, .on_press = Msg{ .open_pet_page = @intCast(i) } }, "Open"),
        });
        shown += 1;
    }
    const scale_fraction: f32 = (model.scale - 0.4) / 0.8;
    const bubble_text_fraction: f32 = (model.bubble_text_px - bubble_text_min_px) / (bubble_text_max_px - bubble_text_min_px);
    // One scrollable page: the root scroll takes the window frame and
    // everything - full pet catalog included - flows inside it. No
    // more per-section band budgets.
    var page = ui.scroll(.{ .grow = 1 }, .{ui.column(.{ .padding = 16, .gap = 12 }, .{
        ui.text(.{ .size = .lg }, "Pets"),
        installBanner(ui, model),
        ui.el(.search_field, .{
            .height = 34,
            .text = filter,
            .on_input = AppUi.inputMsg(.pet_filter),
            .placeholder = "Search pets",
            .semantics = .{ .label = "Search pets" },
        }, .{}),
        // Search-first catalog: six rows collapsed, the whole catalog
        // expanded - the page itself scrolls, so no nested scroll and
        // the extent stays exact.
        ui.column(.{ .gap = 6 }, @as([]const AppUi.Node, rows[0..shown])),
        if (matches > shown)
            ui.button(.{ .size = .sm, .variant = .secondary, .on_press = .toggle_pets_expanded }, moreLabel(matches))
        else if (model.pets_expanded and matches > 6)
            ui.button(.{ .size = .sm, .variant = .secondary, .on_press = .toggle_pets_expanded }, "Show less")
        else if (matches == 0)
            ui.text(.{ .size = .sm, .style_tokens = .{ .foreground = .text_muted } }, "No pets match your search")
        else
            ui.el(.stack, .{}, .{}),
        ui.el(.stack, .{ .height = 10 }, .{}),
        ui.text(.{ .size = .lg }, "Agents"),
        agentsSection(ui, model, icons),
        ui.el(.stack, .{ .height = 10 }, .{}),
        ui.text(.{ .size = .lg }, "Appearance"),
        ui.el(.panel, .{ .style_tokens = .{ .background = .surface, .radius = .md } }, .{
            ui.row(.{ .padding = 12, .cross = .center, .gap = 12 }, .{
                ui.column(.{ .grow = 1 }, .{
                    ui.text(.{}, "Pet size"),
                    mutedParagraph(ui, "Adjust the size of your pet"),
                }),
                ui.el(.slider, .{ .width = 150, .value = scale_fraction, .on_value = AppUi.valueMsg(.set_scale), .semantics = .{ .label = "Pet size" } }, .{}),
            }),
        }),
        ui.el(.panel, .{ .style_tokens = .{ .background = .surface, .radius = .md } }, .{
            ui.row(.{ .padding = 12, .cross = .center, .gap = 12 }, .{
                ui.column(.{ .grow = 1 }, .{
                    ui.text(.{}, "Bubble text size"),
                    mutedParagraph(ui, "Size of the bubble text"),
                }),
                ui.el(.slider, .{ .width = 150, .value = bubble_text_fraction, .on_value = AppUi.valueMsg(.set_bubble_text_size), .semantics = .{ .label = "Bubble text size" } }, .{}),
            }),
        }),
        ui.el(.panel, .{ .style_tokens = .{ .background = .surface, .radius = .md } }, .{
            ui.row(.{ .padding = 12, .cross = .center, .gap = 12 }, .{
                ui.column(.{ .grow = 1 }, .{
                    ui.text(.{}, "Characters per line"),
                    mutedParagraph(ui, "8–120; maximum characters before wrapping"),
                }),
                ui.el(.input, .{
                    .width = 72,
                    .height = 34,
                    .text = model.bubble_columns_text[0..model.bubble_columns_text_len],
                    .on_input = AppUi.inputMsg(.bubble_columns_input),
                    .semantics = .{ .label = "Characters per line" },
                }, .{}),
            }),
        }),
        ui.el(.panel, .{ .style_tokens = .{ .background = .surface, .radius = .md } }, .{
            ui.row(.{ .padding = 12, .cross = .center, .gap = 12 }, .{
                ui.column(.{ .grow = 1 }, .{
                    ui.text(.{}, "Answer lines"),
                    mutedParagraph(ui, "1–8 answer rows; title uses one additional row"),
                }),
                ui.el(.input, .{
                    .width = 72,
                    .height = 34,
                    .text = model.bubble_answer_lines_text[0..model.bubble_answer_lines_text_len],
                    .on_input = AppUi.inputMsg(.bubble_answer_lines_input),
                    .semantics = .{ .label = "Answer lines" },
                }, .{}),
            }),
        }),
        ui.el(.panel, .{ .style_tokens = .{ .background = .surface, .radius = .md } }, .{
            ui.column(.{ .padding = 12, .gap = 8 }, .{
                ui.text(.{}, "Custom font file"),
                mutedParagraph(ui, if (model.font_load_failed)
                    "Could not load this TrueType font; the default font is active"
                else if (model.font_path_dirty)
                    "Saved; restart Petdex to apply"
                else if (custom_font_active.*)
                    "Applied to all app text; restart after changing the path"
                else
                    "Optional local .ttf path; leave empty for the default font"),
                ui.el(.input, .{
                    .height = 34,
                    .text = model.font_path[0..model.font_path_len],
                    .on_input = AppUi.inputMsg(.font_path_input),
                    .placeholder = "/path/to/font.ttf",
                    .semantics = .{ .label = "Custom font file path" },
                }, .{}),
            }),
        }),
        ui.el(.panel, .{ .style_tokens = .{ .background = .surface, .radius = .md } }, .{
            ui.row(.{ .padding = 12, .cross = .center, .gap = 12 }, .{
                ui.column(.{ .grow = 1 }, .{
                    ui.text(.{}, "Show messages"),
                    mutedParagraph(ui, "Agent activity bubbles over the pet"),
                }),
                ui.el(.switch_control, .{
                    .selected = model.bubbles_enabled,
                    .on_toggle = .toggle_bubbles,
                    .semantics = .{ .label = "Show messages" },
                }, .{}),
            }),
        }),
        ui.el(.panel, .{ .style_tokens = .{ .background = .surface, .radius = .md } }, .{
            ui.row(.{ .padding = 12, .cross = .center, .gap = 12 }, .{
                ui.column(.{ .grow = 1 }, .{
                    ui.text(.{}, "One bubble per conversation"),
                    mutedParagraph(ui, "Stack a card per agent; off shows one bubble at a time"),
                }),
                ui.el(.switch_control, .{
                    .selected = model.bubbles_per_conversation,
                    .on_toggle = .toggle_bubbles_per_conversation,
                    .semantics = .{ .label = "One bubble per conversation" },
                }, .{}),
            }),
        }),
        ui.el(.panel, .{ .style_tokens = .{ .background = .surface, .radius = .md } }, .{
            ui.row(.{ .padding = 12, .cross = .center, .gap = 12 }, .{
                ui.column(.{ .grow = 1 }, .{
                    ui.text(.{}, "Bubble lifetime"),
                    mutedParagraph(ui, "0 keeps bubbles visible; 1–60 seconds enables expiry"),
                }),
                ui.el(.input, .{
                    .width = 72,
                    .height = 34,
                    .text = model.bubble_lifetime_text[0..model.bubble_lifetime_text_len],
                    .on_input = AppUi.inputMsg(.bubble_lifetime_input),
                    .semantics = .{ .label = "Bubble lifetime in seconds" },
                }, .{}),
            }),
        }),
        ui.el(.panel, .{ .style_tokens = .{ .background = .surface, .radius = .md } }, .{
            ui.row(.{ .padding = 12, .cross = .center, .gap = 12 }, .{
                ui.column(.{ .grow = 1 }, .{
                    ui.text(.{}, "Rotate pet daily"),
                    mutedParagraph(ui, "Wake up to a different pet each day"),
                }),
                ui.el(.switch_control, .{
                    .selected = model.rotate_pets,
                    .on_toggle = .toggle_rotate_pets,
                    .semantics = .{ .label = "Rotate pet daily" },
                }, .{}),
            }),
        }),
        // Login items ride SMAppService, so like the Dock row this one
        // only exists on macOS.
        if (builtin.os.tag == .macos)
            ui.el(.panel, .{ .style_tokens = .{ .background = .surface, .radius = .md } }, .{
                ui.row(.{ .padding = 12, .cross = .center, .gap = 12 }, .{
                    ui.column(.{ .grow = 1 }, .{
                        ui.text(.{}, "Launch at login"),
                        mutedParagraph(ui, "Start Petdex when you log in"),
                    }),
                    ui.el(.switch_control, .{
                        .selected = model.launch_at_login,
                        .on_toggle = .toggle_launch_at_login,
                        .semantics = .{ .label = "Launch at login" },
                    }, .{}),
                }),
            })
        else
            ui.el(.stack, .{}, .{}),
        // Dock presence is an AppKit concept; other platforms have no
        // equivalent toggle to offer, so the row only exists on macOS.
        if (builtin.os.tag == .macos)
            ui.el(.panel, .{ .style_tokens = .{ .background = .surface, .radius = .md } }, .{
                ui.row(.{ .padding = 12, .cross = .center, .gap = 12 }, .{
                    ui.column(.{ .grow = 1 }, .{
                        ui.text(.{}, "Hide Dock icon"),
                        mutedParagraph(ui, "Petdex lives in the menu bar only"),
                    }),
                    ui.el(.switch_control, .{
                        .selected = model.hide_dock,
                        .on_toggle = .toggle_hide_dock,
                        .semantics = .{ .label = "Hide Dock icon" },
                    }, .{}),
                }),
            })
        else
            ui.el(.stack, .{}, .{}),
        ui.el(.panel, .{ .style_tokens = .{ .background = .surface, .radius = .md } }, .{
            ui.row(.{ .padding = 12, .cross = .center, .gap = 12 }, .{
                ui.column(.{ .grow = 1 }, .{
                    ui.text(.{}, "Waiting sound"),
                    mutedParagraph(ui, "Play a chime when your agent is waiting for your input"),
                }),
                ui.el(.switch_control, .{
                    .selected = model.waiting_sound,
                    .on_toggle = .toggle_waiting_sound,
                    .semantics = .{ .label = "Waiting sound" },
                }, .{}),
            }),
        }),
        ui.el(.panel, .{ .style_tokens = .{ .background = .surface, .radius = .md } }, .{
            ui.row(.{ .padding = 12, .cross = .center, .gap = 12 }, .{
                ui.column(.{ .grow = 1 }, .{
                    ui.text(.{}, "Custom pets"),
                    ui.text(.{ .size = .sm, .style_tokens = .{ .foreground = .text_muted } }, "~/.petdex/pets"),
                }),
                ui.button(.{ .on_press = .open_pets_folder }, "Open folder"),
            }),
        }),
        // Trailing spacer: the column's own bottom padding is not part
        // of the scroll extent, so the last card needs explicit air.
        ui.el(.stack, .{ .height = 8 }, .{}),
    })});
    page.widget.style.background = settingsBackground(model);
    return page;
}

test "settings descriptions use wrapped paragraphs" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    var ui = AppUi.init(arena_state.allocator());

    const copy = "A description long enough to wrap beside a control";
    const node = mutedParagraph(&ui, copy);
    try std.testing.expectEqual(@as(usize, 1), node.widget.spans.len);
    try std.testing.expectEqualStrings(copy, node.widget.text);
    try std.testing.expect(!node.widget.text_no_wrap);
}
