//! Petdex on Native SDK, slice 1: a runtime-loaded pet animating its real
//! atlas in a chromeless window. No WebView, no Node sidecar.
//!
//! The atlas decodes app-side and each state's frames register into
//! slots 1..8, replaced in place on state switch (see Sheet for why
//! the full texture cannot ride registerImageBytes). The state table
//! is the canonical map ported from the WebView renderer
//! (petdex-desktop/src/main.zig STATES): 9 states, 8 columns,
//! per-frame durations with idle's irregular blink timing.
//!
//! V1 demo affordance: Space cycles states (replaced by the :7777 hook
//! server in V2).

const std = @import("std");
const builtin = @import("builtin");
const runner = @import("runner");

extern "c" fn system(command: [*:0]const u8) c_int;
const native_sdk = @import("native_sdk");
const hook_server = @import("hook_server.zig");
const hook_runner = @import("hook_runner.zig");
const agent_hooks = @import("agent_hooks.zig");
const dsh_integration = @import("dsh_integration.zig");
const session_reconcile = @import("session_reconcile.zig");
const plat = @import("plat.zig");
const installer = @import("installer.zig");
const remote_agents = @import("remote_agents.zig");
const remote_ssh = @import("remote_ssh.zig");
const remote_writeback = @import("remote_writeback.zig");
const remote_runtime = @import("remote_runtime.zig");
const herdr_status = @import("herdr_status.zig");
pub const updates = @import("updates.zig");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

const canvas = native_sdk.canvas;
const geometry = native_sdk.geometry;

// Thin Lucide line art selected through Better Icons. Agent identity is a
// vector glyph in the bubble header now; the colorful PNG marks remain in
// Settings where branding, rather than dense session scanning, is the job.
const bubble_icon_codex = canvas.svg_icon.parseComptime(@embedFile("assets/icons/agent-codex.svg"));
const bubble_icon_hermes = canvas.svg_icon.parseComptime(@embedFile("assets/icons/agent-hermes.svg"));
const bubble_icon_claude = canvas.svg_icon.parseComptime(@embedFile("assets/icons/agent-claude.svg"));
const bubble_icon_code = canvas.svg_icon.parseComptime(@embedFile("assets/icons/agent-code.svg"));
const bubble_icon_gemini = canvas.svg_icon.parseComptime(@embedFile("assets/icons/agent-gemini.svg"));
const bubble_icon_terminal = canvas.svg_icon.parseComptime(@embedFile("assets/icons/agent-terminal.svg"));
const bubble_icon_host_local = canvas.svg_icon.parseComptime(@embedFile("assets/icons/host-local.svg"));
const bubble_icon_host_remote = canvas.svg_icon.parseComptime(@embedFile("assets/icons/host-remote.svg"));
const bubble_icon_stop = canvas.svg_icon.parseComptime(@embedFile("assets/icons/action-stop.svg"));
const bubble_icon_send = canvas.svg_icon.parseComptime(@embedFile("assets/icons/action-send.svg"));
const bubble_icon_chat = canvas.svg_icon.parseComptime(@embedFile("assets/icons/action-chat.svg"));
const bubble_icon_pin = canvas.svg_icon.parseComptime(@embedFile("assets/icons/action-pin.svg"));
const bubble_icon_layers = canvas.svg_icon.parseComptime(@embedFile("assets/icons/action-layers.svg"));
const bubble_icon_recent = canvas.svg_icon.parseComptime(@embedFile("assets/icons/action-recent.svg"));
const bubble_icon_dismiss = canvas.svg_icon.parseComptime(@embedFile("assets/icons/action-dismiss.svg"));
const bubble_icon_branch = canvas.svg_icon.parseComptime(@embedFile("assets/icons/action-branch.svg"));
const bubble_icon_completed = canvas.svg_icon.parseComptime(@embedFile("assets/icons/status-completed.svg"));
const bubble_icon_needs_input = canvas.svg_icon.parseComptime(@embedFile("assets/icons/status-needs-input.svg"));

pub const app_icons = [_]canvas.icons.Entry{
    .{ .name = "bubble-codex", .icon = &bubble_icon_codex },
    .{ .name = "bubble-hermes", .icon = &bubble_icon_hermes },
    .{ .name = "bubble-claude", .icon = &bubble_icon_claude },
    .{ .name = "bubble-code", .icon = &bubble_icon_code },
    .{ .name = "bubble-gemini", .icon = &bubble_icon_gemini },
    .{ .name = "bubble-terminal", .icon = &bubble_icon_terminal },
    .{ .name = "bubble-host-local", .icon = &bubble_icon_host_local },
    .{ .name = "bubble-host-remote", .icon = &bubble_icon_host_remote },
    .{ .name = "bubble-stop", .icon = &bubble_icon_stop },
    .{ .name = "bubble-send", .icon = &bubble_icon_send },
    .{ .name = "bubble-chat", .icon = &bubble_icon_chat },
    .{ .name = "bubble-pin", .icon = &bubble_icon_pin },
    .{ .name = "bubble-layers", .icon = &bubble_icon_layers },
    .{ .name = "bubble-recent", .icon = &bubble_icon_recent },
    .{ .name = "bubble-dismiss", .icon = &bubble_icon_dismiss },
    .{ .name = "bubble-branch", .icon = &bubble_icon_branch },
    .{ .name = "bubble-completed", .icon = &bubble_icon_completed },
    .{ .name = "bubble-needs-input", .icon = &bubble_icon_needs_input },
};

const canvas_label = "pet-canvas";
const frame_w: f32 = 192;
const frame_h: f32 = 208;
const max_scale: f32 = 1.2;
const win_w: f32 = frame_w * max_scale;
const win_h: f32 = frame_h * max_scale;
const pet_edge_pad: f32 = 8;
const cols: u64 = 8;
const sheet_image_id: u64 = 1;
/// What a first run offers to download. Small, friendly, and already in
/// the public catalog, so the empty state resolves through the ordinary
/// install path rather than shipping ~2MB of sprite sheet inside every
/// binary on every platform.
const default_pet_slug = "boba";

const app_permissions = [_][]const u8{ native_sdk.security.permission_command, native_sdk.security.permission_view };
const shell_views = [_]native_sdk.ShellView{
    .{ .label = canvas_label, .kind = .gpu_surface, .fill = true, .role = "Pet canvas", .accessibility_label = "Petdex pet", .gpu_backend = if (builtin.target.os.tag == .linux) .software else .metal, .gpu_pixel_format = .bgra8_unorm, .gpu_present_mode = .timer, .gpu_alpha_mode = .premultiplied, .gpu_color_space = .srgb, .gpu_vsync = true },
};
const shell_windows = [_]native_sdk.ShellWindow{.{
    .label = "main",
    .title = "Petdex",
    .width = win_w,
    .height = win_h,
    .resizable = false,
    .restore_state = false,
    .titlebar = .chromeless,
    .floating = true,
    .fullscreen_overlay = true,
    .transparent = true,
    .views = &shell_views,
}};
const shell_scene: native_sdk.ShellConfig = .{ .windows = &shell_windows };

// ----------------------------------------------------------------- states

// Sprite tables live in sprite.zig (#613). Re-exported so the many
// `State` and `stateDef` references below read unchanged.
const sprite = @import("sprite.zig");
pub const State = sprite.State;
const FrameSpec = sprite.FrameSpec;
const StateDef = sprite.StateDef;
const stateDef = sprite.stateDef;

// ------------------------------------------------------------------ model

const FrameClockInput = struct {
    input_timestamp_ns: u64 = 0,
};

const NativeBubbleCommandAction = enum {
    toggle,
    open,
    pin,
    subagents,
    dismiss,
    activate,
    drag_started,
    drag_ended,
};

const NativeBubbleCommand = struct {
    action: NativeBubbleCommandAction,
    identity: u64,
};

pub const Msg = union(enum) {
    frame_tick: native_sdk.EffectTimer,
    poll_tick: native_sdk.EffectTimer,
    frame_clock: FrameClockInput,
    bubble_animation_tick: native_sdk.EffectTimer,
    bubble_presentation_tick: native_sdk.EffectTimer,
    cycle_state,
    open_settings,
    settings_closed,
    close_pet,
    select_pet: u32,
    set_scale: f32,
    open_pets_folder,
    open_pet_page: u32,
    appearance: native_sdk.platform.Appearance,
    toggle_bubbles,
    toggle_bubbles_per_conversation,
    toggle_waiting_sound,
    chime_done: native_sdk.EffectExit,
    set_bubble_text_size: f32,
    bubble_lifetime_input: canvas.TextInputEvent,
    bubble_columns_input: canvas.TextInputEvent,
    bubble_answer_lines_input: canvas.TextInputEvent,
    font_path_input: canvas.TextInputEvent,
    toggle_hide_dock,
    toggle_launch_at_login,
    toggle_focus_mode,
    toggle_rotate_pets,
    shuffle_pet,
    quit_app,
    install_agent: u32,
    uninstall_agent: u32,
    dsh_install_done: native_sdk.EffectExit,
    dsh_remove_done: native_sdk.EffectExit,
    pet_filter: canvas.TextInputEvent,
    toggle_pets_expanded,
    manifest_done: native_sdk.EffectExit,
    pet_json_done: native_sdk.EffectExit,
    spritesheet_done: native_sdk.EffectExit,
    dismiss_install_error,
    install_first_pet,
    native_drag_started: ?State,
    native_drag_ended,
    native_drag_watchdog: native_sdk.EffectTimer,
    native_bubble_command: NativeBubbleCommand,
    remote_line: native_sdk.EffectLine,
    remote_done: native_sdk.EffectExit,
    remote_backoff: native_sdk.EffectTimer,
    update_boot_check: native_sdk.EffectTimer,
    check_updates,
    toggle_update_checks,
    update_response: native_sdk.EffectResponse,
    homebrew_done: native_sdk.EffectExit,
    homebrew_timeout: native_sdk.EffectTimer,
    download_update,
    copy_brew_command,
    brew_command_copied: native_sdk.EffectClipboardResult,
    focus_bubble: u8,
    toggle_bubble_pin: u8,
    toggle_subagent_details: u8,
    toggle_bubble_visibility,
    dismiss_bubble: u8,
    noop,

    pub const view_unbound = .{ "frame_tick", "poll_tick", "physics_tick", "frame_clock", "bubble_animation_tick", "bubble_presentation_tick", "cycle_state", "native_drag_watchdog", "native_bubble_command", "chime_done", "quit_app", "toggle_focus_mode", "shuffle_pet", "dsh_install_done", "dsh_remove_done", "remote_line", "remote_done", "remote_backoff", "update_boot_check", "update_response", "homebrew_done", "homebrew_timeout", "brew_command_copied" };
};

/// One geometry clock for the whole card group. Every visible card, native
/// glass frame, hit region and window envelope reads these presentation values
/// so content and material cannot chase one another with separate springs.
const BubbleGroupSizeSpring = struct {
    initialized: bool = false,
    width: f32 = 0,
    width_target: f32 = 0,
    width_velocity: f32 = 0,
    height: f32 = 0,
    height_target: f32 = 0,
    height_velocity: f32 = 0,
};

/// Card heights are intrinsic and keyed by conversation identity. Reordering
/// or pinning therefore moves a spring with its session instead of handing the
/// old height to whatever happens to occupy the same array slot next.
const BubbleCardHeightSpring = struct {
    identity: u64 = 0,
    initialized: bool = false,
    height: f32 = 0,
    target: f32 = 0,
    velocity: f32 = 0,
};

const BubbleFoldPhase = enum(u8) {
    folded,
    materializing,
    unfolding,
    unfolded,
    collapsing,
};

/// The disclosure is deliberately a small finite-state control instead of a
/// boolean.  `recent` keeps one live conversation visible while still
/// tracking the whole feed; `hidden` keeps only the disclosure/status badge.
const BubbleDisplayMode = enum(u8) {
    all,
    recent,
    hidden,
};

/// Bubble changes arrive through several independent paths (mailbox, pointer
/// polling, springs, appearance and native controls). Keep their invalidation
/// explicit so a cheap poll cannot accidentally rebuild the whole AppKit
/// presentation.
const BubbleRenderInvalidation = struct {
    content: bool = false,
    geometry: bool = false,
    appearance: bool = false,
    urgent: bool = false,

    fn any(self: BubbleRenderInvalidation) bool {
        return self.content or self.geometry or self.appearance or self.urgent;
    }

    fn clear(self: *BubbleRenderInvalidation) void {
        self.* = .{};
    }
};

/// Debug/test counters intentionally live with the model rather than an
/// always-on telemetry pipeline. They let tests and local profiling prove
/// that settled cards do not keep rebuilding native glass.
const BubbleRenderStats = struct {
    layout_rebuilds: u64 = 0,
    snapshot_builds: u64 = 0,
    native_submissions: u64 = 0,
    portable_commits: u64 = 0,
    deferred_submissions: u64 = 0,
    stale_running_suppressions: u64 = 0,
};

/// The measured portion of a card never changes while its content, typography
/// and common group width stay the same.  Keep the slices backed by the
/// existing per-slot scratch buffers, then derive only the inexpensive
/// reveal-dependent vertical positions on pointer/animation paths.
const BubbleMeasuredLayout = struct {
    valid: bool = false,
    title_text: []const u8 = "",
    message_lines: [bubble_message_lines_max][]const u8 = @splat(""),
    metadata_left_x: f32 = 0,
    metadata_left_width: f32 = 0,
    metadata_height: f32 = 0,
    title_height: f32 = 0,
    message_line_height: f32 = 0,
    message_line_count: usize = 0,
    status_slot_width: f32 = 0,
    title_text_width: f32 = 0,
    nested_line_height: f32 = 0,
    nested_line_count: usize = 0,
    nested_message_count: usize = 0,
    nested_overflow_count: usize = 0,
    inner_width: f32 = 0,
    card_width: f32 = 0,
};

/// Width is shared by every card and is the expensive part of the text
/// measurement pass. Cache the complete measured card payload by the exact
/// fields that can affect wrapping; presentation and hit testing then reuse
/// the same group value without asking the text engine again.
const BubbleLayoutCache = struct {
    valid: bool = false,
    key: u64 = 0,
    common_width: f32 = 220,
    cards: [hook_server.max_bubbles]BubbleMeasuredLayout = @splat(.{}),
};

/// Manual dismissals are deliberately bounded and stored as stable hashes of
/// agent + locality/remote host + session id. The raw conversation metadata
/// never has to be copied into preferences, and a remote session cannot mute a
/// coincidentally equal local id. A fresh busy event removes the hash again.
const max_dismissed_sessions = 32;

pub const Model = struct {
    sheet_loaded: bool = false,
    pet_name: [64]u8 = @splat(0),
    pet_name_len: usize = 0,
    state: State = .idle,
    frame_index: usize = 0,
    // Sidecar dwell semantics (state-queue.ts): the displayed state
    // holds for its dwell before the next queued event applies, so
    // running/idle pinball under heavy tool calls never thrashes.
    shown_at_ms: i64 = 0,
    shown_dwell_ms: u32 = 0,
    /// One bubble per live conversation, mirrored from the mailbox and
    /// ordered oldest first: the view stacks them in this order, so the
    /// most recently updated sits at the bottom, next to the tail.
    bubbles: [hook_server.max_bubbles]hook_server.Bubble = @splat(.{}),
    bubbles_len: usize = 0,
    /// Per-bubble deadlines, parallel to `bubbles`. Kept alongside
    /// rather than inside hook_server.Bubble because expiry is a display
    /// decision the app owns; the server has no clock for it.
    bubble_expires_at_ms: [hook_server.max_bubbles]i64 = @splat(-1),
    /// Folded group: 0 is one front card, 1 is the separated uniform group.
    /// Everything the view needs for a frame is derived from this one
    /// number, so the animation has a single source of truth.
    bubble_expansion: f32 = 0,
    /// When the cursor entered the bubble window, or -1 while outside.
    /// Expanding waits `bubble_hover_delay_ms` from here so crossing the
    /// stack on the way somewhere else does not fan it open.
    bubble_hover_since_ms: i64 = -1,
    bubble_hover_exit_since_ms: i64 = -1,
    /// Where the expansion is heading, 1 while the hover is honored.
    /// Leaving drops it to 0 with no delay: sticky is worse than eager.
    bubble_expansion_target: f32 = 0,
    bubble_expansion_velocity: f32 = 0,
    /// Independent hover spring. Stack expansion and card lift share the
    /// cursor but not a timing curve: the card responds immediately while
    /// the fan still honors its intent delay.
    bubble_hover_amount: f32 = 0,
    bubble_hover_velocity: f32 = 0,
    bubble_hovered: bool = false,
    bubble_hovered_identity: u64 = 0,
    /// Explicit activity-scoped expansion. It survives pointer exit but is
    /// cleared as soon as every visible session settles.
    /// Manual pet-adjacent disclosure state for the current non-empty group.
    bubble_group_visible: bool = false,
    /// When visible, present only the most recently active conversation.
    /// Kept separate from `bubble_group_visible` so old persisted/test model
    /// fixtures remain source compatible. During a recent -> hidden collapse
    /// it also remembers which single glass surface owns the transition.
    bubble_show_recent_only: bool = false,
    bubble_group_manually_closed: bool = false,
    bubble_fold_phase: BubbleFoldPhase = .folded,
    /// Preferred front session. Presentation ordering may temporarily yield
    /// to the newest busy session; this is intentionally not persisted.
    pinned_bubble_identity: u64 = 0,
    /// A nested child digest can remain expanded after the cursor leaves.
    /// Zero means hover-preview only.
    expanded_subagent_identity: u64 = 0,
    dismissed_session_hashes: [max_dismissed_sessions]u64 = @splat(0),
    dismissed_sessions_len: usize = 0,
    bubble_anim_last_ms: i64 = 0,
    /// The retained GPU frame records the most recent input timestamp.  Keep
    /// the last one consumed so an idle surface can return null from onFrame
    /// without losing the first press that wakes it.
    last_gpu_input_timestamp_ns: u64 = 0,
    /// GPU-only activity-pulse phase; no widget spinner or duplicate glyphs.
    bubble_shimmer_phase: f32 = 0,
    bubble_render_dirty: BubbleRenderInvalidation = .{},
    bubble_render_last_content_ms: i64 = 0,
    bubble_render_last_geometry_ms: i64 = 0,
    bubble_window_last_geometry_sync_ms: i64 = 0,
    /// One-shot deadline for the coalesced native presentation commit.  It
    /// exists only while a dirty snapshot is rate-limited, never as a settled
    /// redraw loop.
    bubble_presentation_due_ms: i64 = 0,
    bubble_render_stats: BubbleRenderStats = .{},
    /// Secondary-window content generation. The runtime uses this to skip
    /// rebuilding a settled bubble for unrelated pet animation messages.
    /// Zero is reserved by the SDK for its legacy always-rebuild behavior.
    bubble_view_generation: u64 = 1,
    bubble_window_presentation_generation: u64 = 0,
    bubble_layout_cache: BubbleLayoutCache = .{},
    /// Uniform group width and height. Content changes retarget this one spring
    /// and every card follows it synchronously.
    bubble_group_size_spring: BubbleGroupSizeSpring = .{},
    /// Width remains group-wide, while each retained session owns its content-
    /// measured height spring.
    bubble_card_height_springs: [hook_server.max_bubbles]BubbleCardHeightSpring = @splat(.{}),
    /// Low-frequency reconciliation with agent-owned session catalogs. Hook
    /// events cover active work; this also catches a server/manual rename
    /// while the conversation is idle and emitting nothing.
    next_title_sync_ms: i64 = 0,
    /// Where the pet's center falls inside the bubble window, in the
    /// stack container's local coordinates. The window is centered on
    /// the pet until the screen edge clamps it; from then on the two
    /// diverge, and the cards follow this rather than the window so the
    /// stack stays anchored to the pet. Updated every frame from the real
    /// window origin the platform reports.
    bubble_pet_center_local: f32 = 0,
    /// Popover-style vertical flip: false puts the stack above the pet
    /// (the default), true below it, for when the pet sits too close to
    /// the top of the screen for the expanded height to fit. Flipped,
    /// the front card is the TOP one and the stack grows downward.
    bubble_flipped: bool = false,
    /// When neither vertical side can contain one full column, alternate
    /// sessions into a second outward column instead of clipping or scrolling.
    bubble_secondary_lane: bool = false,
    // Drag + momentum, the old desktop's "Codex parity" physics: the
    // frame clock samples the window origin and the primary button
    // through fx.moveWindow(0,0); a down->up edge computes the release
    // velocity from the last 100ms of samples and the physics timer
    // throws the window with friction until it slows or hits an edge.
    samples: [16]PosSample = @splat(.{}),
    sample_len: usize = 0,
    primary_was_down: bool = false,
    throwing: bool = false,
    vx: f64 = 0,
    vy: f64 = 0,
    throw_elapsed_ms: u32 = 0,
    last_physics_ms: i64 = 0,
    // App-owned drag (the old renderer's model, over the moveWindow
    // verb): grab offset from the window origin to the cursor at
    // press, followed every frame while the button holds. Native
    // performWindowDrag is deliberately not used: it swallows the
    // gesture where neither velocity nor tests can see it.
    dragging: bool = false,
    grab_dx: f64 = 0,
    grab_dy: f64 = 0,
    // Where and when the current grab began, for tap detection on
    // release; pat_flip alternates the reaction between two states.
    press_x: f64 = 0,
    press_y: f64 = 0,
    press_ms: i64 = 0,
    pat_flip: bool = false,
    settings_open: bool = false,
    /// Sprite scale, persisted. Codex parity: the settings slider maps
    /// 0.4..1.2 over this.
    scale: f32 = 0.7,
    active_pet: u32 = 0,
    window_fitted: bool = false,
    bubbles_enabled: bool = true,
    /// Whether each conversation gets its own bubble in a stack, or every
    /// agent shares one card the way it worked before the stack existed.
    ///
    /// On by default, and default-true when the key is missing, so an
    /// install that predates the setting rolls forward into the stack
    /// rather than silently opting out of it. Off restores the classic
    /// single bubble exactly: one card, newest update wins, with the
    /// tail, which is the path `bubbleStackable` already takes for a
    /// stack of one.
    bubbles_per_conversation: bool = true,
    /// Opt-in chime on the transition into `waiting`. Off by default,
    /// unlike the toggles around it: sound is intrusive in a way
    /// passive UI never is, so it has to be an explicit opt-in.
    waiting_sound: bool = false,
    /// When the current waiting spell began, and whether its single
    /// follow-up ping already fired (see waiting_escalation_ms).
    waiting_since_ms: i64 = 0,
    waiting_escalated: bool = false,
    /// Bubble text size in points, persisted. The bubble rendered at a
    /// fixed 13 (the `.sm` rung); this keeps 13 as the floor and lets
    /// the settings slider raise it to 20.
    bubble_text_px: f32 = bubble_text_default_px,
    /// Seconds a completed (non-busy) bubble remains visible. Zero
    /// disables automatic expiry.
    bubble_lifetime_secs: f32 = bubble_lifetime_default_secs,
    bubble_lifetime_text: [2]u8 = .{ '0', 0 },
    bubble_lifetime_text_len: usize = 1,
    /// Bubble layout is user-controlled on every platform: one title line
    /// plus this many answer lines, each with the configured column budget.
    bubble_columns: u16 = bubble_columns_default,
    bubble_answer_lines: u8 = bubble_answer_lines_default,
    bubble_columns_text: [4]u8 = .{ '4', '0', 0, 0 },
    bubble_columns_text_len: usize = 2,
    bubble_answer_lines_text: [2]u8 = .{ '3', 0 },
    bubble_answer_lines_text_len: usize = 1,
    font_path: [512]u8 = @splat(0),
    font_path_len: usize = 0,
    font_path_dirty: bool = false,
    font_load_failed: bool = false,
    /// macOS: run as a menu-bar app — no Dock icon, no app switcher
    /// entry. The status item stays either way, so Settings and Quit
    /// never lose their handle. Off by default.
    hide_dock: bool = false,
    /// Mirror of SMAppService's status, never a stored wish: boot and
    /// every toggle re-query, so a rejected registration (unbundled
    /// dev binary, user-declined approval) snaps visibly back.
    launch_at_login: bool = false,
    /// Session-only mute for the bubble (tray toggle): the sprite
    /// keeps reacting, the narration pauses. Deliberately not
    /// persisted — focus ends when the app restarts.
    focus_mode: bool = false,
    /// Daily pet rotation: when on, the pet advances round-robin
    /// through the catalog once per day (UTC epoch-day). Off by
    /// default; enabling never swaps on the spot — the current pet
    /// becomes today's, rotation starts tomorrow.
    rotate_pets: bool = false,
    /// The epoch-day the current pet was chosen for. A manual pick
    /// stamps today, pinning it until tomorrow.
    rotation_day: u32 = 0,
    /// Whether the persisted pet position was applied after the first
    /// window fit (it must land after the fit's bottom_center anchor).
    pos_restored: bool = false,
    pet_x: f64 = 0,
    pet_y: f64 = 0,
    agents: [agent_hooks.agent_count]agent_hooks.AgentInfo = .{
        .{ .kind = .claude_code },
        .{ .kind = .codex },
        .{ .kind = .gemini },
        .{ .kind = .opencode },
        .{ .kind = .qoder },
        .{ .kind = .kimi_code },
        .{ .kind = .codebuddy },
        .{ .kind = .omp },
        .{ .kind = .hermes },
        .{ .kind = .dsh },
    },
    dsh_busy: bool = false,
    dsh_error: bool = false,
    herdr_status: herdr_status.Status = .absent,
    update_checks_enabled: bool = true,
    update_phase: updates.Phase = .idle,
    update_manual: bool = false,
    latest_version: [32]u8 = @splat(0),
    latest_version_len: usize = 0,
    last_update_check_ms: i64 = 0,
    install_source: updates.InstallSource = .unknown,
    update_cancel_pending: bool = false,
    update_restart_after_cancel: bool = false,
    brew_command_copied: bool = false,
    agents_prompted: bool = false,
    codex_trust_note: bool = false,
    agent_install_failed: ?agent_hooks.AgentKind = null,
    pet_filter: [48]u8 = @splat(0),
    pet_filter_len: usize = 0,
    pets_expanded: bool = false,
    install: InstallState = .{},
    remotes: [remote_runtime.max_remotes]remote_runtime.Slot = .{ .{}, .{}, .{}, .{}, .{}, .{}, .{}, .{} },
    remote_count: usize = 0,
    dark: bool = true,
    high_contrast: bool = false,
    reduce_motion: bool = false,
};

/// Petdex web tokens (globals.css) translated from OKLCH: brand purple
/// #5266ea family, cool-tinted near-white light surfaces, stone-900
/// dark cards. High contrast keeps the stock loud register untouched.
fn petdexThemeTokens(model: *const Model) canvas.DesignTokens {
    const scheme: canvas.ColorScheme = if (model.dark) .dark else .light;
    var tokens = canvas.DesignTokens.theme(.{
        .color_scheme = scheme,
        .contrast = if (model.high_contrast) .high else .standard,
        .reduce_motion = model.reduce_motion,
    });
    // The heading rung is reserved for bubble body/metadata text and the
    // display rung for the larger one-line bubble title. Keeping both sizes
    // in tokens lets the title use the SDK's honest single-line `text` leaf;
    // a scaled span would become a wrapping paragraph even with wrap=false.
    tokens.typography.heading_size = model.bubble_text_px;
    tokens.typography.display_size = bubbleTitleFontSize(model);
    if (custom_font_active) tokens.typography.font_id = custom_font_id;
    // Linux's software presenter needs an alpha-zero clear all the way
    // into GTK's ARGB surface. Win32 and AppKit retain their upstream
    // platform-owned transparency paths and ordinary theme tokens.
    if (builtin.target.os.tag == .linux) {
        tokens.colors.background = canvas.Color.rgba8(0, 0, 0, 0);
    }
    if (model.high_contrast) return tokens;
    const c = &tokens.colors;
    if (model.dark) {
        if (builtin.target.os.tag != .linux) c.background = canvas.Color.rgb8(12, 12, 15);
        c.surface = canvas.Color.rgb8(25, 25, 28);
        c.surface_subtle = canvas.Color.rgb8(45, 45, 48);
        c.surface_pressed = canvas.Color.rgb8(22, 27, 67);
        c.text = canvas.Color.rgb8(237, 237, 238);
        c.text_muted = canvas.Color.rgb8(156, 158, 168);
        c.accent = canvas.Color.rgb8(137, 163, 255);
        c.destructive = canvas.Color.rgb8(250, 105, 94);
    } else {
        if (builtin.target.os.tag != .linux) c.background = canvas.Color.rgb8(247, 250, 255);
        c.surface = canvas.Color.rgb8(255, 255, 255);
        c.surface_subtle = canvas.Color.rgb8(236, 238, 244);
        c.surface_pressed = canvas.Color.rgb8(233, 238, 251);
        c.text = canvas.Color.rgb8(9, 9, 9);
        c.text_muted = canvas.Color.rgb8(88, 92, 106);
        c.accent = canvas.Color.rgb8(78, 98, 235);
        c.destructive = canvas.Color.rgb8(212, 12, 26);
    }
    return tokens.withOverrides(canvas.accentOverrides(c.accent, scheme));
}

fn petdexTokens(model: *const Model) canvas.DesignTokens {
    var tokens = petdexThemeTokens(model);
    // Transparent pet and bubble windows must clear to zero alpha. The
    // settings window paints its own opaque page background below.
    tokens.colors.background = canvas.Color.rgba8(0, 0, 0, 0);
    return tokens;
}

pub fn settingsBackground(model: *const Model) canvas.Color {
    return petdexThemeTokens(model).colors.background;
}

fn onAppearance(appearance: native_sdk.platform.Appearance) ?Msg {
    return .{ .appearance = appearance };
}

// Catalog table and slug lookup live in catalog.zig (#613).
const catalog_mod = @import("catalog.zig");
const settings_view = @import("settings_view.zig");

test {}
pub const max_catalog = catalog_mod.max_catalog;
pub const CatalogEntry = catalog_mod.CatalogEntry;
const catalogIndexOf = catalog_mod.catalogIndexOf;
// Aliases, not copies: `catalog` and `catalog_mod.catalog_len` are mutable state the
// install queue and the settings view both write, so they have to stay
// one storage location.
const catalog = &catalog_mod.catalog;

// ---------------------------------------------------------------- install
// `petdex://<slug>` for a pet that is not on disk downloads it first.
// The bytes ride `fx.spawn` (curl/wget), never `fx.fetch`: a buffered
// fetch caps at 256 KB and a streamed one frames by lines, while real
// spritesheets are 1 to 3 MB. See installer.zig.

/// Slugs waiting to be installed. A deep link can name several, and the
/// URL slices it arrives on are borrowed for the dispatch only, so each
/// slug is COPIED here before anything asynchronous starts.
const max_install_queue = 8;

const InstallPhase = enum { idle, manifest, pet_json, spritesheet };

pub const InstallState = struct {
    phase: InstallPhase = .idle,
    queue: [max_install_queue][64]u8 = @splat(@splat(0)),
    queue_len: [max_install_queue]usize = @splat(0),
    queued: usize = 0,
    /// Index into `queue` of the pet being downloaded right now.
    current: usize = 0,
    /// Set when the deep link was `petdex://<slug>` rather than
    /// `petdex://install?…`: that form means "use this pet", so the
    /// install activates it on completion.
    activate_when_done: bool = false,
    /// Chosen once per install so pet.json and the spritesheet land
    /// under matching names (`spritesheet.png` vs `.webp`).
    ext_png: bool = false,
    /// Last failure, shown in Settings until dismissed. Empty means the
    /// install either succeeded or never ran.
    error_text: [96]u8 = @splat(0),
    error_len: usize = 0,
    installed_ok: usize = 0,

    pub fn currentSlug(self: *const InstallState) []const u8 {
        if (self.current >= self.queued) return "";
        return self.queue[self.current][0..self.queue_len[self.current]];
    }

    pub fn errorSlice(self: *const InstallState) []const u8 {
        return self.error_text[0..self.error_len];
    }

    pub fn busy(self: *const InstallState) bool {
        return self.phase != .idle;
    }

    /// Copy a slug off a borrowed URL slice. Rejected slugs never enter
    /// the queue, so nothing downstream has to re-validate a path.
    pub fn enqueue(self: *InstallState, slug: []const u8) bool {
        if (self.queued >= max_install_queue) return false;
        if (!installer.slugOk(slug)) return false;
        for (0..self.queued) |i| {
            if (std.mem.eql(u8, self.queue[i][0..self.queue_len[i]], slug)) return false;
        }
        @memcpy(self.queue[self.queued][0..slug.len], slug);
        self.queue_len[self.queued] = slug.len;
        self.queued += 1;
        return true;
    }

    pub fn setError(self: *InstallState, comptime fmt: []const u8, args: anytype) void {
        const written = std.fmt.bufPrint(&self.error_text, fmt, args) catch {
            self.error_len = 0;
            return;
        };
        self.error_len = written.len;
    }
};

const manifest_key: u64 = 20;
const pet_json_key: u64 = 21;
const spritesheet_key: u64 = 22;

/// Where the manifest lands while a slug is resolved. It is 1.4 MB of
/// JSON for 4145 pets, so it is never held in the model — curl writes
/// it here, one pet's URLs are read out, and the file is deleted.
fn manifestTmpPath(buf: []u8) ?[]const u8 {
    const home = env_home orelse return null;
    return std.fmt.bufPrint(buf, "{s}/.petdex/manifest-download.json", .{home}) catch null;
}

/// Manifest read bound. The live manifest is 1.4 MB and grows with the
/// catalog, so this leaves headroom rather than tracking it exactly; a
/// manifest past the cap is read truncated and the slug simply is not
/// found, which surfaces as a normal "not in the manifest" error.
const max_manifest_bytes: usize = 8 * 1024 * 1024;

fn petdexDirsFor(slug: []const u8) void {
    const home = env_home orelse return;
    var buf: [512]u8 = undefined;
    for (installer.install_roots) |root| {
        const dir = installer.petDir(&buf, home, root, slug) orelse continue;
        plat.makeDir(dir);
    }
}

/// Start (or continue) the queue: fetch the manifest once, then walk the
/// pets. The manifest is re-fetched per install run rather than cached,
/// so a pet approved after the app launched is still installable.
fn startInstallQueue(model: *Model, fx: *Effects) void {
    if (model.install.busy() or model.install.queued == 0) return;
    if (installer.detect() == null) {
        std.debug.print("{s}", .{installer.missing_downloader_note});
        model.install.setError("No downloader: install curl", .{});
        model.install.queued = 0;
        return;
    }
    const home = env_home orelse return;
    _ = home;
    var path_buf: [512]u8 = undefined;
    const dest = manifestTmpPath(&path_buf) orelse return;
    const which = installer.detect() orelse return;
    var argv_buf: [installer.max_argv][]const u8 = undefined;
    model.install.phase = .manifest;
    model.install.current = 0;
    model.install.installed_ok = 0;
    model.install.error_len = 0;
    fx.spawn(.{
        .key = manifest_key,
        .argv = installer.downloadArgv(which, &argv_buf, installer.manifest_url, dest),
        .output = .collect,
        .on_exit = Effects.exitMsg(.manifest_done),
    });
}

/// Resolve the current slug against the downloaded manifest and start
/// its pet.json. Returns false when the pet cannot be installed, which
/// advances the queue rather than stalling it.
fn beginCurrentPet(model: *Model, fx: *Effects) bool {
    const home = env_home orelse return false;
    const slug = model.install.currentSlug();
    if (slug.len == 0) return false;

    var path_buf: [512]u8 = undefined;
    const manifest_path = manifestTmpPath(&path_buf) orelse return false;
    const manifest = plat.readFileAlloc(boot_allocator, manifest_path, max_manifest_bytes) orelse {
        model.install.setError("Manifest download failed", .{});
        return false;
    };
    defer boot_allocator.free(manifest);

    const urls = installer.findPetUrls(manifest, slug) orelse {
        model.install.setError("{s} is not in the catalog", .{slug});
        return false;
    };
    // The host check happens before a single byte is requested: an
    // approved-but-stale row could carry a URL off the asset origin,
    // and the app must not write those bytes to a pet directory.
    if (!installer.isTrustedAssetUrl(urls.pet_json) or !installer.isTrustedAssetUrl(urls.spritesheet)) {
        model.install.setError("{s} has an untrusted asset host", .{slug});
        return false;
    }
    model.install.ext_png = std.mem.eql(u8, urls.spritesheetExt(), "png");
    petdexDirsFor(slug);

    var dest_buf: [512]u8 = undefined;
    const dest = installer.petFile(&dest_buf, home, installer.install_roots[0], slug, "pet.json") orelse return false;
    const which = installer.detect() orelse return false;
    var argv_buf: [installer.max_argv][]const u8 = undefined;
    model.install.phase = .pet_json;
    fx.spawn(.{
        .key = pet_json_key,
        .argv = installer.downloadArgv(which, &argv_buf, urls.pet_json, dest),
        .output = .collect,
        .on_exit = Effects.exitMsg(.pet_json_done),
    });
    return true;
}

/// pet.json is down; pull the spritesheet into the same directory.
fn beginSpritesheet(model: *Model, fx: *Effects) bool {
    const home = env_home orelse return false;
    const slug = model.install.currentSlug();
    if (slug.len == 0) return false;

    var path_buf: [512]u8 = undefined;
    const manifest_path = manifestTmpPath(&path_buf) orelse return false;
    const manifest = plat.readFileAlloc(boot_allocator, manifest_path, max_manifest_bytes) orelse return false;
    defer boot_allocator.free(manifest);
    const urls = installer.findPetUrls(manifest, slug) orelse return false;
    if (!installer.isTrustedAssetUrl(urls.spritesheet)) return false;

    var name_buf: [32]u8 = undefined;
    const name = std.fmt.bufPrint(&name_buf, "spritesheet.{s}", .{urls.spritesheetExt()}) catch return false;
    var dest_buf: [512]u8 = undefined;
    const dest = installer.petFile(&dest_buf, home, installer.install_roots[0], slug, name) orelse return false;
    const which = installer.detect() orelse return false;
    var argv_buf: [installer.max_argv][]const u8 = undefined;
    model.install.phase = .spritesheet;
    fx.spawn(.{
        .key = spritesheet_key,
        .argv = installer.downloadArgv(which, &argv_buf, urls.spritesheet, dest),
        .output = .collect,
        .on_exit = Effects.exitMsg(.spritesheet_done),
    });
    return true;
}

/// Copy the finished pet into the second root. The CLI downloads each
/// asset twice; copying the bytes already on disk costs one read
/// instead of a second round trip over the network.
fn mirrorToCodexRoot(slug: []const u8, ext_png: bool) void {
    const home = env_home orelse return;
    var name_buf: [32]u8 = undefined;
    const sheet_name = std.fmt.bufPrint(&name_buf, "spritesheet.{s}", .{if (ext_png) "png" else "webp"}) catch return;
    for ([_][]const u8{ "pet.json", sheet_name }) |name| {
        var src_buf: [512]u8 = undefined;
        var dst_buf: [512]u8 = undefined;
        const src = installer.petFile(&src_buf, home, installer.install_roots[0], slug, name) orelse continue;
        const dst = installer.petFile(&dst_buf, home, installer.install_roots[1], slug, name) orelse continue;
        const bytes = plat.readFileAlloc(boot_allocator, src, max_sheet_file_bytes) orelse continue;
        defer boot_allocator.free(bytes);
        _ = plat.writeFile(dst, bytes);
    }
}

/// Add a freshly installed pet to the in-memory catalog. A rescan would
/// need a `std.Io`, and the only one the app holds belongs to the main
/// thread, so the entry is appended directly — same shape `scanCatalog`
/// writes.
///
/// The catalog holds `max_catalog` entries and `scanCatalog` fills it
/// from both roots at boot, so on a machine with more pets than slots
/// (49 here against 32) it is already full before any install runs.
/// Dropping the new pet would install it to disk and leave it
/// unselectable, so a full catalog evicts instead: the pet the user just
/// asked for by name outranks whichever one the boot scan happened to
/// land on last. The evicted entry is only a listing — its files stay on
/// disk and the next boot rescans them.
fn catalogAppend(slug: []const u8, active: usize) ?usize {
    if (catalogIndexOf(slug)) |existing| return existing;
    const root = installer.install_roots[0];
    const slot = if (catalog_mod.catalog_len < max_catalog) blk: {
        catalog_mod.catalog_len += 1;
        break :blk catalog_mod.catalog_len - 1;
    } else evict: {
        // Never evict the pet currently on screen: its decoded sheet is
        // live and the entry backs the name the window is showing.
        var victim: usize = max_catalog - 1;
        if (victim == active and max_catalog > 1) victim -= 1;
        break :evict victim;
    };
    var e = &catalog[slot];
    e.* = .{};
    @memcpy(e.name[0..slug.len], slug);
    e.len = slug.len;
    @memcpy(e.root[0..root.len], root);
    e.root_len = root.len;
    // A reused slot may still carry the evicted pet's thumbnail, so the
    // atlas cell has to be rebuilt before the row draws it.
    thumbs_ready[slot] = false;
    return slot;
}

/// Move to the next queued pet, or finish the run. Finishing deletes
/// the manifest scratch file: 1.4 MB is not worth keeping around, and a
/// stale copy would resolve slugs against an old catalog.
fn advanceInstallQueue(model: *Model, fx: *Effects) void {
    model.install.current += 1;
    while (model.install.current < model.install.queued) {
        if (beginCurrentPet(model, fx)) return;
        model.install.current += 1;
    }
    model.install.phase = .idle;
    model.install.queued = 0;
    var path_buf: [512]u8 = undefined;
    if (manifestTmpPath(&path_buf)) |path| plat.deleteFile(path);
}

const url_scheme_prefix = "petdex://";

/// Slugs a deep link asked for, staged for `update`.
///
/// `on_urls_opened` maps a URL to one Msg and gets no `fx`, but an
/// install needs to spawn effects, so the work cannot happen in the
/// callback. The URL slices are borrowed for the dispatch only — they
/// are dead by the time any download starts — so the slugs are copied
/// here and the returned Msg is only a signal to drain this.
var pending_install: InstallState = .{};
var pending_ready: bool = false;

/// `petdex://<slug>` selects a pet, installing it first when it is not
/// on disk; `petdex://install?slug=a&slug=b` installs without
/// selecting (petdex-desktop-link.ts builds both forms).
///
/// An already-installed pet still resolves to `select_pet` inside the
/// callback, so the common case keeps its immediate swap and never
/// touches the network.
fn onUrlsOpened(urls: []const []const u8) ?Msg {
    for (urls) |url| {
        if (!std.mem.startsWith(u8, url, url_scheme_prefix)) continue;
        const rest = url[url_scheme_prefix.len..];
        const host = rest[0 .. std.mem.indexOfAny(u8, rest, "/?#") orelse rest.len];

        if (std.mem.eql(u8, host, "install")) {
            const query = std.mem.indexOfScalar(u8, rest, '?') orelse continue;
            pending_install = .{};
            var it = std.mem.splitScalar(u8, rest[query + 1 ..], '&');
            while (it.next()) |pair| {
                if (!std.mem.startsWith(u8, pair, "slug=")) continue;
                var value = pair["slug=".len..];
                if (std.mem.indexOfScalar(u8, value, '#')) |cut| value = value[0..cut];
                _ = pending_install.enqueue(value);
            }
            if (pending_install.queued == 0) continue;
            pending_install.activate_when_done = false;
            pending_ready = true;
            return .noop;
        }

        // NSURL hands back the absoluteString, and a bare host round
        // trips as `petdex://slug/`.
        if (catalogIndexOf(host)) |index| return .{ .select_pet = @intCast(index) };
        pending_install = .{};
        if (!pending_install.enqueue(host)) continue;
        pending_install.activate_when_done = true;
        pending_ready = true;
        return .noop;
    }
    return null;
}

/// Move a staged deep link into the model and start it. Called from
/// `update`, the first place with an `fx` to spawn on.
fn drainPendingInstall(model: *Model, fx: *Effects) void {
    if (!pending_ready) return;
    pending_ready = false;
    if (model.install.busy()) return;
    const activate = pending_install.activate_when_done;
    model.install.queued = 0;
    for (0..pending_install.queued) |i| {
        _ = model.install.enqueue(pending_install.queue[i][0..pending_install.queue_len[i]]);
    }
    model.install.activate_when_done = activate;
    startInstallQueue(model, fx);
    // A deep-link install arrives from the browser with no Petdex window
    // in front of the user, so the progress banner would render into a
    // closed Settings page. Opening it is the whole feedback channel.
    if (model.install.busy() or model.install.error_len > 0) {
        if (!model.settings_open) {
            model.settings_open = true;
            loadAgentsAtlas(model.dark, fx);
        } else {
            fx.focusWindow(settings_window_label);
        }
    }
}

pub const PosSample = struct { x: f64 = 0, y: f64 = 0, t_ms: i64 = 0 };

// ---------------------------------------------------------------- petting

/// Tap tolerances: the window may jitter a device pixel under a
/// too-quick grab, and 400ms is the classic click ceiling — anything
/// longer reads as a held grab, not a pat.
const tap_max_ms: i64 = 400;
const tap_slop_px: f64 = 3;
/// How long the reaction plays before the dwell hands back to idle
/// (the throw-end waving uses the same figure).
const pat_react_ms: u32 = 1200;

fn isTap(held_ms: i64, dx: f64, dy: f64) bool {
    return held_ms <= tap_max_ms and @abs(dx) < tap_slop_px and @abs(dy) < tap_slop_px;
}

const physics_tick_ms: u32 = 16;
const physics_friction: f64 = 0.88;
const physics_min_vel: f64 = 65;
const physics_max_duration_ms: u32 = 900;
const sample_window_ms: i64 = 100;

pub const Effects = native_sdk.Effects(Msg);

const frame_timer_key: u64 = 1;
const native_drag_watchdog_key: u64 = 4;
const bubble_animation_timer_key: u64 = 5;
const bubble_presentation_timer_key: u64 = 6;
/// Bubble geometry is visually smooth at 30 Hz, while halving expensive
/// window/AppKit work compared with the old 16 ms path. Pet physics keeps its
/// own display-rate timer.
const bubble_animation_tick_ms: u32 = 33;
const bubble_content_commit_interval_ms: i64 = 67;
const bubble_geometry_commit_interval_ms: i64 = 33;
const bubble_stale_running_grace_ms: i64 = 30_000;
const native_drag_watchdog_ms: u32 = 5000;
const update_fetch_key: u64 = 30;
const homebrew_check_key: u64 = 31;
const brew_clipboard_key: u64 = 32;
const update_boot_timer_key: u64 = 33;
const homebrew_timeout_timer_key: u64 = 34;
const dsh_install_key: u64 = 35;
const dsh_remove_key: u64 = 36;
const update_boot_delay_ms: u32 = 5000;
const update_background_interval_ms: i64 = 24 * 60 * 60 * 1000;
const update_settings_interval_ms: i64 = 5 * 60 * 1000;
const update_failure_retry_ms: u64 = 60 * 60 * 1000;
const homebrew_timeout_ms: u64 = 8000;

fn updateCachePhase(model: *Model) void {
    if (model.latest_version_len == 0) {
        model.update_phase = .idle;
        return;
    }
    const latest = model.latest_version[0..model.latest_version_len];
    model.update_phase = if (updates.isNewer(latest, updates.current_version)) .available else .current;
}

fn updateCheckStale(last_check_ms: i64, now_ms: i64, interval_ms: i64) bool {
    return last_check_ms <= 0 or now_ms < last_check_ms or now_ms - last_check_ms >= interval_ms;
}

fn updateCheckDelay(last_check_ms: i64, now_ms: i64) u64 {
    if (updateCheckStale(last_check_ms, now_ms, update_background_interval_ms)) return update_boot_delay_ms;
    return @intCast(update_background_interval_ms - (now_ms - last_check_ms));
}

fn armNextUpdateCheck(model: *const Model, fx: *Effects) void {
    if (!model.update_checks_enabled) return;
    fx.startTimer(.{
        .key = update_boot_timer_key,
        .interval_ms = updateCheckDelay(model.last_update_check_ms, fx.wallMs()),
        .mode = .one_shot,
        .on_fire = Effects.timerMsg(.update_boot_check),
    });
}

fn armUpdateRetry(model: *const Model, fx: *Effects) void {
    if (!model.update_checks_enabled) return;
    fx.startTimer(.{
        .key = update_boot_timer_key,
        .interval_ms = update_failure_retry_ms,
        .mode = .one_shot,
        .on_fire = Effects.timerMsg(.update_boot_check),
    });
}

fn startUpdateCheck(model: *Model, manual: bool, fx: *Effects) void {
    if (model.update_phase == .checking or model.update_cancel_pending) return;
    model.update_manual = manual;
    model.update_phase = .checking;
    fx.fetch(.{
        .key = update_fetch_key,
        .url = updates.endpoint,
        .timeout_ms = 8000,
        .on_response = Effects.responseMsg(.update_response),
    });
}

fn finishUpdateFailure(model: *Model) void {
    if (model.update_manual) {
        model.update_phase = .failed;
    } else {
        updateCachePhase(model);
    }
    model.update_manual = false;
}

fn startHomebrewCheck(model: *Model, fx: *Effects) void {
    if (builtin.target.os.tag != .macos or model.install_source == .checking or model.install_source == .homebrew) return;
    const brew = if (plat.fileExists("/opt/homebrew/bin/brew"))
        "/opt/homebrew/bin/brew"
    else if (plat.fileExists("/usr/local/bin/brew"))
        "/usr/local/bin/brew"
    else {
        model.install_source = .direct;
        return;
    };
    model.install_source = .checking;
    fx.spawn(.{
        .key = homebrew_check_key,
        .argv = &.{ brew, "list", "--cask", "petdex" },
        .output = .collect,
        .on_exit = Effects.exitMsg(.homebrew_done),
    });
    fx.startTimer(.{
        .key = homebrew_timeout_timer_key,
        .interval_ms = homebrew_timeout_ms,
        .mode = .one_shot,
        .on_fire = Effects.timerMsg(.homebrew_timeout),
    });
}

/// Sprite animation still owns a real frame timer, but the steady mascot
/// states do not need to rebuild the complete retained desktop canvas at the
/// atlas's fastest cadence. Gesture physics and short reactions keep their
/// authored frame rate; idle and ongoing-agent motion cap at a calm 3–4 fps.
fn steadySpriteFrameDuration(model: *const Model, authored_ms: u32) u32 {
    if (model.dragging or model.throwing) return authored_ms;
    return switch (model.state) {
        .idle => @max(authored_ms, 350),
        .@"running-left", .@"running-right", .running, .review, .waiting => @max(authored_ms, 250),
        else => authored_ms,
    };
}

fn armFrameTimer(model: *const Model, fx: *Effects) void {
    const def = stateDef(model.state);
    const spec = def.frames[model.frame_index % def.frames.len];
    fx.startTimer(.{
        .key = frame_timer_key,
        .interval_ms = steadySpriteFrameDuration(model, spec.dur_ms),
        .mode = .one_shot,
        .on_fire = Effects.timerMsg(.frame_tick),
    });
}

fn armBubbleAnimationTimer(fx: *Effects) void {
    fx.startTimer(.{
        .key = bubble_animation_timer_key,
        .interval_ms = bubble_animation_tick_ms,
        .mode = .one_shot,
        .on_fire = Effects.timerMsg(.bubble_animation_tick),
    });
}

/// Schedule the next coalesced snapshot exactly when its 15/30 Hz budget
/// opens.  This is a one-shot retry, not a retained frame loop: it disappears
/// as soon as the dirty snapshot commits or is superseded.
fn armBubblePresentationTimer(model: *Model, fx: *Effects, now_ms: i64) void {
    if (!model.bubble_render_dirty.any()) return;
    const dirty = model.bubble_render_dirty;
    const interval = if (dirty.geometry or dirty.urgent)
        bubble_geometry_commit_interval_ms
    else
        bubble_content_commit_interval_ms;
    const last = if (dirty.geometry or dirty.urgent)
        model.bubble_render_last_geometry_ms
    else
        model.bubble_render_last_content_ms;
    const due = if (last > 0) last + interval else now_ms;
    if (model.bubble_presentation_due_ms != 0 and model.bubble_presentation_due_ms <= due) return;
    if (model.bubble_presentation_due_ms != 0) fx.cancelTimer(bubble_presentation_timer_key);
    const delta: i64 = @max(1, due - now_ms);
    const delay: u32 = @intCast(@min(delta, @as(i64, bubble_content_commit_interval_ms)));
    fx.startTimer(.{
        .key = bubble_presentation_timer_key,
        .interval_ms = delay,
        .mode = .one_shot,
        .on_fire = Effects.timerMsg(.bubble_presentation_tick),
    });
    model.bubble_presentation_due_ms = now_ms + delay;
}

fn invalidateBubblePresentation(model: *Model, invalidation: BubbleRenderInvalidation) void {
    if (!invalidation.any()) return;
    model.bubble_render_dirty.content = model.bubble_render_dirty.content or invalidation.content;
    model.bubble_render_dirty.geometry = model.bubble_render_dirty.geometry or invalidation.geometry;
    model.bubble_render_dirty.appearance = model.bubble_render_dirty.appearance or invalidation.appearance;
    model.bubble_render_dirty.urgent = model.bubble_render_dirty.urgent or invalidation.urgent;
    model.bubble_view_generation +%= 1;
    if (model.bubble_view_generation == 0) model.bubble_view_generation = 1;
}

fn bubblePresentationMayCommit(model: *Model, now_ms: i64) bool {
    const dirty = model.bubble_render_dirty;
    if (!dirty.any()) return false;
    const geometry_priority = dirty.geometry or dirty.urgent;
    const interval = if (geometry_priority) bubble_geometry_commit_interval_ms else bubble_content_commit_interval_ms;
    const last = if (geometry_priority) model.bubble_render_last_geometry_ms else model.bubble_render_last_content_ms;
    if (last > 0 and now_ms - last < interval) {
        model.bubble_render_stats.deferred_submissions += 1;
        return false;
    }
    return true;
}

/// Pure fallback for a portable-only Linux host. Production GTK builds now
/// submit the same bounded snapshot for keyboard/AT controls while the canvas
/// remains the visual renderer; keeping this helper pure preserves the dirty
/// snapshot scheduling contract in focused layout tests.
fn commitPortableBubblePresentationForPlatform(model: *Model, now_ms: i64, os: std.Target.Os.Tag) bool {
    if (os != .linux or !model.bubble_render_dirty.any()) return false;
    const dirty = model.bubble_render_dirty;
    model.bubble_render_stats.portable_commits += 1;
    if (dirty.geometry or dirty.urgent) model.bubble_render_last_geometry_ms = now_ms;
    if (dirty.content or dirty.appearance) model.bubble_render_last_content_ms = now_ms;
    model.bubble_render_dirty.clear();
    return true;
}

// ------------------------------------------------------------- pet loading

/// Decoded atlas kept app-side: the runtime's image registry caps one
/// image at 1MB of pixels and the platform decode scratch at 1.25MB,
/// so a full sheet (11.5MB RGBA) can never ride registerImageBytes.
/// We decode the sheet ourselves and register one 192x208 frame per
/// slot (160KB, 16 slots available), replacing in place per state.
/// The decode goes through `PlatformServices.decodeImage` with our own
/// buffer (see `decodeSheet`), so webp and png both ride the platform
/// codec on macOS, Linux and Windows with nothing vendored. Raising the
/// registry caps is on the upstream PR list.
const Sheet = struct {
    pixels: []u8 = &.{},
    width: usize = 0,
    height: usize = 0,
    rows: usize = 9,
};
var sheet: Sheet = .{};

/// Scan the petdex pet roots for the first usable pet, honoring
/// PETDEX_PET as a directory-name override. Returns the sheet bytes
/// (caller frees) and the display name.
/// Env snapshot taken in main() from init.environ_map (Zig 0.16 has no
/// global getenv; env rides std.process.Init).
var env_home: ?[]const u8 = null;
var env_wanted_pet: ?[]const u8 = null;
var env_perf_stats_path: ?[]const u8 = null;
var perf_stats_last: BubbleRenderStats = .{};
var perf_stats_last_generation: u64 = 0;
var perf_stats_written: bool = false;

fn bubblePerfStatsJson(model: *const Model, out: []u8) ?[]const u8 {
    return std.fmt.bufPrint(
        out,
        "{{\n  \"layoutRebuilds\": {d},\n  \"snapshotBuilds\": {d},\n  \"nativeSubmissions\": {d},\n  \"portableCommits\": {d},\n  \"deferredSubmissions\": {d},\n  \"staleRunningSuppressions\": {d},\n  \"viewGeneration\": {d}\n}}\n",
        .{
            model.bubble_render_stats.layout_rebuilds,
            model.bubble_render_stats.snapshot_builds,
            model.bubble_render_stats.native_submissions,
            model.bubble_render_stats.portable_commits,
            model.bubble_render_stats.deferred_submissions,
            model.bubble_render_stats.stale_running_suppressions,
            model.bubble_view_generation,
        },
    ) catch null;
}

/// Explicit local profiling seam. It is inert unless the harness supplies an
/// output path and writes only aggregate counters after the app loop exits.
fn writeBubblePerfStats(model: *const Model) void {
    const path = env_perf_stats_path orelse return;
    if (path.len == 0) return;
    if (perf_stats_written and std.meta.eql(perf_stats_last, model.bubble_render_stats) and
        perf_stats_last_generation == model.bubble_view_generation) return;
    var json_buf: [512]u8 = undefined;
    const json = bubblePerfStatsJson(model, &json_buf) orelse return;
    if (!plat.writeFile(path, json)) return;
    perf_stats_last = model.bubble_render_stats;
    perf_stats_last_generation = model.bubble_view_generation;
    perf_stats_written = true;
}

fn readFileAbsolute(io: std.Io, allocator: std.mem.Allocator, path: []const u8, max: usize) ![]u8 {
    var file = try std.Io.Dir.openFileAbsolute(io, path, .{});
    defer file.close(io);
    const stat = try file.stat(io);
    const size: usize = @intCast(stat.size);
    if (size == 0 or size > max) return error.FileTooLarge;
    const buf = try allocator.alloc(u8, size);
    errdefer allocator.free(buf);
    const read = try file.readPositionalAll(io, buf, 0);
    if (read != size) return error.ShortRead;
    return buf;
}

fn petNameOk(name: []const u8) bool {
    if (name.len == 0 or name.len > 63) return false;
    for (name) |c| {
        if (!(std.ascii.isAlphanumeric(c) or c == '-' or c == '_' or c == '.')) return false;
    }
    return true;
}

/// Scan both pet roots into the catalog (name + which root), sorted by
/// scan order. Runs once in main() with the io handle.
fn scanCatalog(io: std.Io, allocator: std.mem.Allocator) void {
    const home = env_home orelse return;
    const roots = [_][]const u8{ ".petdex/pets", ".codex/pets" };
    for (roots) |root| {
        const root_path = std.fs.path.join(allocator, &.{ home, root }) catch continue;
        defer allocator.free(root_path);
        var dir = std.Io.Dir.openDirAbsolute(io, root_path, .{ .iterate = true }) catch continue;
        defer dir.close(io);
        var it = dir.iterate();
        while (it.next(io) catch null) |entry| {
            if (entry.kind != .directory) continue;
            if (!petNameOk(entry.name)) continue;
            if (catalog_mod.catalog_len >= max_catalog) return;
            var duplicate = false;
            for (catalog[0..catalog_mod.catalog_len]) |*existing| {
                if (std.mem.eql(u8, existing.slice(), entry.name)) duplicate = true;
            }
            if (duplicate) continue;
            var e = &catalog[catalog_mod.catalog_len];
            @memcpy(e.name[0..entry.name.len], entry.name);
            e.len = entry.name.len;
            @memcpy(e.root[0..root.len], root);
            e.root_len = root.len;
            catalog_mod.catalog_len += 1;
        }
    }
}

var boot_allocator: std.mem.Allocator = std.heap.page_allocator;
var boot_io: ?std.Io = null;
var pet_display_name: []const u8 = "";

fn settingsPath(buf: []u8) ?[]const u8 {
    const home = env_home orelse return null;
    return std.fmt.bufPrint(buf, "{s}/.petdex/desktop-native-settings.json", .{home}) catch null;
}

fn dismissedSessionsPath(buf: []u8) ?[]const u8 {
    const home = env_home orelse return null;
    return std.fmt.bufPrint(buf, "{s}/.petdex/desktop-native-dismissed-sessions", .{home}) catch null;
}

fn bubbleDismissible(bubble: *const hook_server.Bubble) bool {
    return bubble.session_len > 0 and switch (bubble.status) {
        .idle, .completed, .failed => true,
        .running, .needs_input => false,
    };
}

fn bubbleIdentityHash(bubble: *const hook_server.Bubble) ?u64 {
    if (bubble.session_len == 0) return null;
    var hash: u64 = 1469598103934665603;
    const separator = struct {
        fn add(value: *u64) void {
            value.* = (value.* ^ 0xff) *% 1099511628211;
        }
    }.add;
    for (bubble.agent[0..bubble.agent_len]) |byte| {
        hash = (hash ^ std.ascii.toLower(byte)) *% 1099511628211;
    }
    separator(&hash);
    hash = (hash ^ @as(u8, if (bubble.remote) 1 else 0)) *% 1099511628211;
    separator(&hash);
    if (bubble.remote) {
        for (bubble.hostnameSlice()) |byte| {
            hash = (hash ^ std.ascii.toLower(byte)) *% 1099511628211;
        }
    } else {
        for ("local") |byte| hash = (hash ^ byte) *% 1099511628211;
    }
    separator(&hash);
    for (bubble.sessionSlice()) |byte| hash = (hash ^ byte) *% 1099511628211;
    return hash;
}

fn bubbleVisualIdentity(bubble: *const hook_server.Bubble) u64 {
    return bubbleIdentityHash(bubble) orelse (bubble.counter | 1);
}

fn bubbleSlotForVisualIdentity(model: *const Model, identity: u64) ?u8 {
    for (model.bubbles[0..model.bubbles_len], 0..) |*bubble, slot| {
        if (bubbleVisualIdentity(bubble) == identity) return @intCast(slot);
    }
    return null;
}

fn bubbleIsPinned(model: *const Model, bubble: *const hook_server.Bubble) bool {
    return model.pinned_bubble_identity != 0 and model.pinned_bubble_identity == bubbleVisualIdentity(bubble);
}

fn bubbleSubagentsPinned(model: *const Model, bubble: *const hook_server.Bubble) bool {
    return model.expanded_subagent_identity != 0 and model.expanded_subagent_identity == bubbleVisualIdentity(bubble);
}

fn dropMailboxBubble(bubble: *const hook_server.Bubble) void {
    hook_server.mailbox.dropBubbleIdentity(
        bubble.sessionSlice(),
        bubble.agent[0..bubble.agent_len],
        bubble.hostnameSlice(),
        bubble.remote,
        true,
    );
}

fn dismissedSessionIndex(model: *const Model, identity: u64) ?usize {
    for (model.dismissed_session_hashes[0..model.dismissed_sessions_len], 0..) |stored, i| {
        if (stored == identity) return i;
    }
    return null;
}

fn addDismissedSessionHash(model: *Model, identity: u64) bool {
    if (dismissedSessionIndex(model, identity) != null) return false;
    if (model.dismissed_sessions_len == model.dismissed_session_hashes.len) {
        std.mem.copyForwards(u64, model.dismissed_session_hashes[0 .. model.dismissed_sessions_len - 1], model.dismissed_session_hashes[1..model.dismissed_sessions_len]);
        model.dismissed_sessions_len -= 1;
    }
    model.dismissed_session_hashes[model.dismissed_sessions_len] = identity;
    model.dismissed_sessions_len += 1;
    return true;
}

fn removeDismissedSessionHash(model: *Model, identity: u64) bool {
    const index = dismissedSessionIndex(model, identity) orelse return false;
    std.mem.copyForwards(u64, model.dismissed_session_hashes[index .. model.dismissed_sessions_len - 1], model.dismissed_session_hashes[index + 1 .. model.dismissed_sessions_len]);
    model.dismissed_sessions_len -= 1;
    model.dismissed_session_hashes[model.dismissed_sessions_len] = 0;
    return true;
}

fn encodeDismissedSessions(model: *const Model, output: []u8) ?[]const u8 {
    var len: usize = 0;
    for (model.dismissed_session_hashes[0..model.dismissed_sessions_len]) |identity| {
        const line = std.fmt.bufPrint(output[len..], "{x}\n", .{identity}) catch return null;
        len += line.len;
    }
    return output[0..len];
}

fn decodeDismissedSessions(model: *Model, input: []const u8) void {
    model.dismissed_session_hashes = @splat(0);
    model.dismissed_sessions_len = 0;
    var lines = std.mem.splitScalar(u8, input, '\n');
    while (lines.next()) |raw_line| {
        const line = std.mem.trim(u8, raw_line, " \t\r");
        if (line.len == 0) continue;
        const identity = std.fmt.parseInt(u64, line, 16) catch continue;
        _ = addDismissedSessionHash(model, identity);
    }
}

fn saveDismissedSessions(model: *const Model) void {
    if (builtin.is_test) return;
    var path_buf: [512]u8 = undefined;
    const path = dismissedSessionsPath(&path_buf) orelse return;
    var data: [max_dismissed_sessions * 17]u8 = undefined;
    const encoded = encodeDismissedSessions(model, &data) orelse return;
    cWriteFile(path, encoded);
}

fn loadDismissedSessions(model: *Model) void {
    if (builtin.is_test) return;
    var path_buf: [512]u8 = undefined;
    const path = dismissedSessionsPath(&path_buf) orelse return;
    var data: [max_dismissed_sessions * 17]u8 = undefined;
    const encoded = cReadFile(path, &data) orelse return;
    decodeDismissedSessions(model, encoded);
}

const custom_font_id: canvas.FontId = canvas.min_registered_font_id;
const max_custom_font_bytes: usize = 24 * 1024 * 1024;
var initial_font_path: [512]u8 = @splat(0);
var initial_font_path_len: usize = 0;
var initial_font_load_failed: bool = false;
pub var custom_font_active: bool = false;

/// Tiny file helpers usable from the runtime thread. They carry their
/// own Io (see plat.zig), so the main thread's never leaks off-thread;
/// the invariant is enforced by the type now, not by this comment.
const cReadFile = plat.readFile;

fn cWriteFile(path: []const u8, bytes: []const u8) void {
    _ = plat.writeFile(path, bytes);
}

fn jsonEscapeString(value: []const u8, output: []u8) ?[]const u8 {
    var len: usize = 0;
    for (value) |byte| {
        const escape: ?u8 = switch (byte) {
            '"' => '"',
            '\\' => '\\',
            '\n' => 'n',
            '\r' => 'r',
            '\t' => 't',
            else => null,
        };
        if (escape) |escaped| {
            if (len + 2 > output.len) return null;
            output[len] = '\\';
            output[len + 1] = escaped;
            len += 2;
        } else {
            if (len >= output.len) return null;
            output[len] = byte;
            len += 1;
        }
    }
    return output[0..len];
}

fn jsonUnescapeString(value: []const u8, output: []u8) ?[]const u8 {
    var input_index: usize = 0;
    var len: usize = 0;
    while (input_index < value.len) {
        var byte = value[input_index];
        input_index += 1;
        if (byte == '\\') {
            if (input_index >= value.len) return null;
            byte = switch (value[input_index]) {
                '"' => '"',
                '\\' => '\\',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                else => return null,
            };
            input_index += 1;
        }
        if (len >= output.len) return null;
        output[len] = byte;
        len += 1;
    }
    return output[0..len];
}

fn saveSettings(model: *const Model) void {
    var path_buf: [512]u8 = undefined;
    const path = settingsPath(&path_buf) orelse return;
    // Headroom check (a bufPrint overflow here fails silently and
    // drops the whole save): keep room for the configurable bubble
    // fields, rotation state, a long slug, and negative coordinates.
    // Grown with every key added; `font_path` alone can escape to 1024.
    var buf: [2304]u8 = undefined;
    const active = if (model.active_pet < catalog_mod.catalog_len) catalog[model.active_pet].slice() else "";
    // The position keys only exist once the window has been fitted and
    // read: a save fired on the very first frame would otherwise
    // persist the (0,0) the model boots with and pin the pet to the
    // top-left corner on every launch after.
    var pos_buf: [64]u8 = undefined;
    const pos = if (model.window_fitted)
        std.fmt.bufPrint(&pos_buf, ",\"pet_x\":{d:.0},\"pet_y\":{d:.0}", .{ model.pet_x, model.pet_y }) catch ""
    else
        "";
    var escaped_font_buf: [1024]u8 = undefined;
    const font_path = std.mem.trim(u8, model.font_path[0..model.font_path_len], " \t\r\n");
    const escaped_font = jsonEscapeString(font_path, &escaped_font_buf) orelse return;
    const latest = model.latest_version[0..model.latest_version_len];
    const json = std.fmt.bufPrint(&buf, "{{\"active_pet\":\"{s}\",\"scale\":{d:.2},\"bubbles\":{},\"bubbles_per_conversation\":{},\"waiting_sound\":{},\"bubble_text\":{d:.1},\"bubble_lifetime\":{d:.0},\"bubble_columns\":{},\"bubble_answer_lines\":{},\"bubble_preview_version\":2,\"font_path\":\"{s}\",\"hide_dock\":{},\"rotate_pets\":{},\"rotation_day\":{d},\"update_checks\":{},\"last_update_check_ms\":{d},\"latest_desktop_version\":\"{s}\"{s},\"agents_prompted\":{}}}", .{ active, model.scale, model.bubbles_enabled, model.bubbles_per_conversation, model.waiting_sound, model.bubble_text_px, model.bubble_lifetime_secs, model.bubble_columns, model.bubble_answer_lines, escaped_font, model.hide_dock, model.rotate_pets, model.rotation_day, model.update_checks_enabled, model.last_update_check_ms, latest, pos, model.agents_prompted }) catch return;
    cWriteFile(path, json);
}

fn setUnsignedText(buffer: []u8, length: *usize, value: u16) void {
    const text = std.fmt.bufPrint(buffer, "{}", .{value}) catch return;
    length.* = text.len;
}

fn editUnsignedText(buffer: []u8, length: *usize, edit: canvas.TextInputEvent, min_value: u16, max_value: u16) ?u16 {
    switch (edit) {
        .insert_text => |text| {
            for (text) |byte| {
                if (!std.ascii.isDigit(byte) or length.* >= buffer.len) continue;
                buffer[length.*] = byte;
                length.* += 1;
            }
        },
        .delete_backward, .delete_word_backward => {
            if (length.* > 0) length.* -= 1;
        },
        .clear => length.* = 0,
        else => {},
    }
    if (length.* == 0) return null;
    const value = std.fmt.parseInt(u16, buffer[0..length.*], 10) catch return null;
    if (value < min_value or value > max_value) return null;
    return value;
}

fn editPathText(buffer: []u8, length: *usize, edit: canvas.TextInputEvent) void {
    switch (edit) {
        .insert_text => |text| {
            const available = buffer.len - length.*;
            const count = @min(available, text.len);
            @memcpy(buffer[length.* .. length.* + count], text[0..count]);
            length.* += count;
        },
        .delete_backward, .delete_word_backward => {
            if (length.* > 0) length.* -= 1;
            while (length.* > 0 and (buffer[length.*] & 0xC0) == 0x80) length.* -= 1;
        },
        .clear => length.* = 0,
        else => {},
    }
}

/// Read a pet's encoded sheet bytes into `buf`. Prefers pet.json's
/// spritesheetPath, then the standard names.
fn readPetSheetBytes(entry: *const CatalogEntry, buf: []u8) ?[]const u8 {
    const home = env_home orelse return null;

    var candidates_buf: [3][64]u8 = undefined;
    var candidates: [3][]const u8 = undefined;
    var candidate_count: usize = 0;
    var json_buf: [1024]u8 = undefined;
    var pj_path: [512]u8 = undefined;
    if (std.fmt.bufPrint(&pj_path, "{s}/{s}/{s}/pet.json", .{ home, entry.rootSlice(), entry.slice() })) |pjp| {
        if (cReadFile(pjp, &json_buf)) |json| {
            if (hook_server.jsonStringPub(json, "spritesheetPath")) |sp| {
                if (petNameOk(sp) and sp.len < 64) {
                    @memcpy(candidates_buf[candidate_count][0..sp.len], sp);
                    candidates[candidate_count] = candidates_buf[candidate_count][0..sp.len];
                    candidate_count += 1;
                }
            }
        }
    } else |_| {}
    candidates[candidate_count] = "spritesheet.webp";
    candidate_count += 1;
    candidates[candidate_count] = "spritesheet.png";
    candidate_count += 1;

    var path_buf: [512]u8 = undefined;
    for (candidates[0..candidate_count]) |name| {
        const path = std.fmt.bufPrint(&path_buf, "{s}/{s}/{s}/{s}", .{ home, entry.rootSlice(), entry.slice(), name }) catch continue;
        if (cReadFile(path, buf)) |bytes| return bytes;
    }
    return null;
}

/// Encoded sheets are well under a megabyte; the decoded RGBA is the
/// big side (1536x2288x4 = 13.4MB), so the decode buffer is sized for
/// the largest sheet the platform codecs accept at our aspect.
const max_sheet_file_bytes: usize = 4 * 1024 * 1024;
const max_sheet_pixel_bytes: usize = 16 * 1024 * 1024;

/// Decode a pet sheet through the platform image codec (CGImageSource
/// on macOS, gdk-pixbuf on Linux, WIC on Windows), the same seam
/// `fx.registerImageBytes` uses. We call `services.decodeImage` with our
/// own 16MB buffer instead of registering: the registry caps one image
/// at 1MB of pixels and its decode scratch at 1.25MB, but that bound
/// lives in the runtime's registry, not in the decoder, which honors
/// whatever buffer the caller hands it. Loop-thread only, per the
/// `PlatformServices.decodeImage` contract.
fn decodeSheet(fx: *Effects, entry: *const CatalogEntry) ?Sheet {
    const services = fx.services orelse return null;
    const file_buf = boot_allocator.alloc(u8, max_sheet_file_bytes) catch return null;
    defer boot_allocator.free(file_buf);
    const encoded = readPetSheetBytes(entry, file_buf) orelse return null;

    const pixel_buf = boot_allocator.alloc(u8, max_sheet_pixel_bytes) catch return null;
    var keep_pixels = false;
    defer if (!keep_pixels) boot_allocator.free(pixel_buf);

    const decoded = services.decodeImage(encoded, pixel_buf) catch return null;
    if (decoded.width == 0 or decoded.height == 0) return null;
    // The decoder slices the caller's buffer, so the pixels are already
    // at the front: keep the allocation and record the used length.
    keep_pixels = true;
    var out: Sheet = .{
        .pixels = pixel_buf[0 .. decoded.width * decoded.height * 4],
        .width = decoded.width,
        .height = decoded.height,
    };
    out.rows = if (out.height * 1536 >= out.width * 2288) 11 else 9;
    return out;
}

/// Swap the live sheet for `entry`'s. Runs on the loop thread (boot and
/// the pet-switch Msg), which is where `decodeImage` is legal.
fn loadSheetForPet(fx: *Effects, entry: *const CatalogEntry) bool {
    const decoded = decodeSheet(fx, entry) orelse return false;
    if (sheet.pixels.len > 0) freeSheet(&sheet);
    sheet = decoded;
    return true;
}

/// Sheet pixels are a slice into a `max_sheet_pixel_bytes` allocation,
/// so the free has to restore the original length.
fn freeSheet(s: *Sheet) void {
    if (s.pixels.len == 0) return;
    const base: []u8 = s.pixels.ptr[0..max_sheet_pixel_bytes];
    boot_allocator.free(base);
    s.* = .{};
}

var initial_scale: f32 = 0.7;
var initial_pet: u32 = 0;
var initial_bubbles: bool = true;
var initial_bubbles_per_conversation: bool = true;
var initial_waiting_sound: bool = false;
var initial_bubble_text_px: f32 = bubble_text_default_px;
var initial_bubble_lifetime_secs: f32 = bubble_lifetime_default_secs;
var initial_bubble_columns: u16 = bubble_columns_default;
var initial_bubble_answer_lines: u8 = bubble_answer_lines_default;
var initial_hide_dock: bool = false;
var initial_rotate_pets: bool = false;
var initial_rotation_day: u32 = 0;
var initial_agents_prompted: bool = false;
var initial_update_checks: bool = true;
var initial_last_update_check_ms: i64 = 0;
var initial_latest_version: [32]u8 = @splat(0);
var initial_latest_version_len: usize = 0;
/// Persisted pet window origin; null on first run (or a settings file
/// from before positions were saved), which keeps the platform's
/// default placement. Off-screen values from an unplugged monitor are
/// left to the platform's own clamping (the same edge handling the
/// throw physics rides).
var initial_pet_x: ?f64 = null;
var initial_pet_y: ?f64 = null;

// ------------------------------------------------------------- avatars
// One slot for the CURRENT bubble's agent avatar (claude-code, codex,
// gemini, opencode, antigravity), 40x40 PNGs committed under
// assets/agents/, re-registered only when the agent changes.
const avatar_image_id: u64 = 13;
// One slot for every agent logo plus fallback, packed side by side and read back with
// `image_src` (the thumbnail atlas above does the same). Previously each
// agent held its own registry id, which ran the app into the SDK's
// 16-slot ceiling (canvas_limits.max_registered_canvas_images): ids
// 1/9/10/11/13/14/15/16 were spoken for and Qoder took the last one, so
// a sixth agent had nowhere to register. Packing removes the ceiling
// instead of raising it — sixteen 40px logos are a 640x40 strip, far
// inside the 512x512 and 1MiB per-image bounds.
const agent_icon_atlas_id: u64 = 9;
const agent_icon_px: usize = 40;
var agents_icons_ready: bool = false;
var agents_icons_dark: bool = false;
var agent_icon_pixels: []u8 = &.{};

/// Where agent `index`'s logo sits in the packed strip.
fn agentIconRect(index: usize) geometry.RectF {
    return geometry.RectF.init(
        @as(f32, @floatFromInt(index * agent_icon_px)),
        0,
        @as(f32, @floatFromInt(agent_icon_px)),
        @as(f32, @floatFromInt(agent_icon_px)),
    );
}

/// Agent logo bytes, compiled in. The runtime decodes them through the
/// platform codec (CGImageSource, gdk-pixbuf, WIC), so these need no
/// file lookup and no macOS-only `sips` shim — which also means they
/// cannot go missing from a bundle or resolve against the wrong cwd.
/// opencode ships light and dark glyphs; the rest read on both.
const AgentArt = struct { light: []const u8, dark: []const u8 };
const agent_art = [agent_hooks.agent_count + 2]AgentArt{
    .{ .light = @embedFile("assets/agents/claude-code.png"), .dark = @embedFile("assets/agents/claude-code.png") },
    .{ .light = @embedFile("assets/agents/codex.png"), .dark = @embedFile("assets/agents/codex.png") },
    .{ .light = @embedFile("assets/agents/gemini.png"), .dark = @embedFile("assets/agents/gemini.png") },
    .{ .light = @embedFile("assets/agents/opencode-light.png"), .dark = @embedFile("assets/agents/opencode-dark.png") },
    .{ .light = @embedFile("assets/agents/qoder.png"), .dark = @embedFile("assets/agents/qoder.png") },
    .{ .light = @embedFile("assets/agents/kimi-code.png"), .dark = @embedFile("assets/agents/kimi-code.png") },
    .{ .light = @embedFile("assets/agents/codebuddy.png"), .dark = @embedFile("assets/agents/codebuddy.png") },
    .{ .light = @embedFile("assets/agents/omp.png"), .dark = @embedFile("assets/agents/omp.png") },
    .{ .light = @embedFile("assets/agents/hermes.png"), .dark = @embedFile("assets/agents/hermes.png") },
    // DSH has no bundled brand asset in this clean-room slice.
    .{ .light = @embedFile("assets/agents/fallback.png"), .dark = @embedFile("assets/agents/fallback.png") },
    .{ .light = @embedFile("assets/agents/herdr.png"), .dark = @embedFile("assets/agents/herdr.png") },
    .{ .light = @embedFile("assets/agents/fallback.png"), .dark = @embedFile("assets/agents/fallback.png") },
};
pub const herdr_icon_index = agent_hooks.agent_count;
const agent_fallback_index = agent_hooks.agent_count + 1;

/// Pack every settings agent logo into one registry slot, themed like the
/// bubble avatar and rebuilt on appearance flips. Each logo decodes
/// through the platform codec (the same path `registerImageBytes` takes
/// internally) and is copied into its own cell of the strip.
///
/// A logo that fails to decode leaves its cell transparent rather than
/// aborting the strip, so one bad asset costs one icon instead of all of
/// them. The row is only registered if at least one cell landed.
fn loadAgentsAtlas(dark: bool, fx: *Effects) void {
    if (agents_icons_ready and agents_icons_dark == dark) return;
    const services = fx.services orelse return;

    const atlas_w = agent_art.len * agent_icon_px;
    if (agent_icon_pixels.len == 0) {
        agent_icon_pixels = boot_allocator.alloc(u8, atlas_w * agent_icon_px * 4) catch return;
    }
    @memset(agent_icon_pixels, 0);

    // Decoding happens into a scratch buffer sized for one logo at the
    // per-image ceiling, reused across cells so the pack costs one
    // allocation rather than one per agent.
    const scratch = boot_allocator.alloc(u8, 512 * 512 * 4) catch return;
    defer boot_allocator.free(scratch);

    const atlas_row_len = atlas_w * 4;
    var packed_any = false;
    for (agent_art, 0..) |art, cell| {
        const decoded = services.decodeImage(if (dark) art.dark else art.light, scratch) catch continue;
        if (decoded.width == 0 or decoded.height == 0) continue;
        // Nearest-neighbour into the cell: the logos ship at 40px and the
        // view draws them at 24, so the scale here is identity in practice
        // and the sampling only matters if an asset is authored off-size.
        for (0..agent_icon_px) |y| {
            const src_y = y * decoded.height / agent_icon_px;
            for (0..agent_icon_px) |x| {
                const src_x = x * decoded.width / agent_icon_px;
                const src_off = (src_y * decoded.width + src_x) * 4;
                const dst_off = y * atlas_row_len + (cell * agent_icon_px + x) * 4;
                @memcpy(agent_icon_pixels[dst_off..][0..4], decoded.rgba8[src_off..][0..4]);
            }
        }
        packed_any = true;
    }
    if (!packed_any) return;

    fx.registerImage(agent_icon_atlas_id, atlas_w, agent_icon_px, agent_icon_pixels) catch return;
    agents_icons_dark = dark;
    agents_icons_ready = true;
}
var avatar_agent: [24]u8 = @splat(0);
var avatar_agent_len: usize = 0;
var avatar_ready: bool = false;
var avatar_theme_dark: bool = false;

/// The bubble names its agent at runtime (a hook payload), so the art
/// is looked up by name rather than by enum. An unknown name is the
/// normal case for an agent we do not ship a glyph for, not an error.
fn agentArtBytes(agent: []const u8, dark: bool) []const u8 {
    const index = if (std.mem.eql(u8, agent, "herdr")) herdr_icon_index else if (agentKindForName(agent)) |kind| @intFromEnum(kind) else agent_fallback_index;
    const art = agent_art[index];
    return if (dark) art.dark else art.light;
}

/// Which cell of the packed logo strip belongs to this agent.
fn agentIconIndex(agent: []const u8) usize {
    if (std.mem.eql(u8, agent, "herdr")) return herdr_icon_index;
    if (agentKindForName(agent)) |kind| return @intFromEnum(kind);
    return agent_fallback_index;
}

fn agentKindForName(agent: []const u8) ?agent_hooks.AgentKind {
    for (std.enums.values(agent_hooks.AgentKind)) |kind| {
        if (std.mem.eql(u8, kind.hookAgentName(), agent)) return kind;
    }
    if (std.mem.eql(u8, agent, "claude")) return .claude_code;
    if (std.mem.eql(u8, agent, "open-code")) return .opencode;
    if (std.mem.eql(u8, agent, "qodercli")) return .qoder;
    if (std.mem.eql(u8, agent, "kimi")) return .kimi_code;
    return null;
}

fn loadAgentAvatar(agent: []const u8, dark: bool, fx: *Effects) void {
    if (avatar_ready and avatar_theme_dark == dark and std.mem.eql(u8, avatar_agent[0..avatar_agent_len], agent)) return;
    if (agent.len > avatar_agent.len) return;
    _ = fx.registerImageBytes(avatar_image_id, agentArtBytes(agent, dark)) catch return;
    @memcpy(avatar_agent[0..agent.len], agent);
    avatar_agent_len = agent.len;
    avatar_theme_dark = dark;
    avatar_ready = true;
}

// ------------------------------------------------------------- thumbnails
// One atlas texture for every catalog thumbnail: the image registry
// caps at 16 slots, so 28+ per-pet images can never each own one. A
// 32-cell strip of 48x52 nearest-scaled idle frames is ~320KB, well
// inside the 1MB slot bound, and rows draw their cell via image_src.
const thumb_w: usize = 48;
const thumb_h: usize = 52;
const thumb_atlas_id: u64 = 12;
var thumbs_pixels: []u8 = &.{};
var thumbs_ready: [max_catalog]bool = @splat(false);
var thumbs_built: usize = 0;

/// Decode one pet's sheet without touching the live global (the pet
/// keeps animating from its own frames). Same platform-codec path.
fn decodeSheetForThumb(fx: *Effects, entry: *const CatalogEntry) ?Sheet {
    return decodeSheet(fx, entry);
}

/// Build one thumbnail into the atlas and re-register it. Incremental:
/// the poll timer builds one per tick while settings is open, so the
/// pet never freezes behind a 28-conversion batch.
fn buildNextThumb(fx: *Effects) void {
    if (thumbs_built >= catalog_mod.catalog_len) return;
    const index = thumbs_built;
    thumbs_built += 1;
    if (thumbs_pixels.len == 0) {
        thumbs_pixels = boot_allocator.alloc(u8, max_catalog * thumb_w * thumb_h * 4) catch return;
        @memset(thumbs_pixels, 0);
    }
    var decoded = decodeSheetForThumb(fx, &catalog[index]) orelse return;
    defer freeSheet(&decoded);
    const rows: usize = if (decoded.height * 1536 >= decoded.width * 2288) 11 else 9;
    const fw = decoded.width / cols;
    const fh = decoded.height / rows;
    const atlas_row_len = max_catalog * thumb_w * 4;
    for (0..thumb_h) |y| {
        const src_y = y * fh / thumb_h;
        for (0..thumb_w) |x| {
            const src_x = x * fw / thumb_w;
            const src_off = (src_y * decoded.width + src_x) * 4;
            const dst_off = y * atlas_row_len + (index * thumb_w + x) * 4;
            @memcpy(thumbs_pixels[dst_off..][0..4], decoded.pixels[src_off..][0..4]);
        }
    }
    thumbs_ready[index] = true;
    fx.registerImage(thumb_atlas_id, max_catalog * thumb_w, thumb_h, thumbs_pixels) catch {};
}

/// Boot-time resolve: scan the catalog and pick the initial pet
/// (PETDEX_PET env > persisted settings > first found). The sheet
/// decode itself waits for `boot`: `decodeImage` is a platform service
/// bound onto `fx` when the loop thread runs `init_fx`, and it is
/// loop-thread only, so main() has nothing to decode with yet.
fn resolveInitialPet(io: std.Io, allocator: std.mem.Allocator, environ_map: *std.process.Environ.Map) !void {
    _ = environ_map;
    scanCatalog(io, allocator);
    if (catalog_mod.catalog_len == 0) return error.NoPetInstalled;

    var wanted: []const u8 = "";
    var settings_buf: [3072]u8 = undefined;
    var path_buf: [512]u8 = undefined;
    if (env_wanted_pet) |w| {
        wanted = w;
    } else if (settingsPath(&path_buf)) |path| {
        if (cReadFile(path, &settings_buf)) |json| {
            if (hook_server.jsonStringPub(json, "active_pet")) |v| wanted = v;
            if (hook_server.jsonNumberPub(json, "scale")) |v| {
                if (v >= 0.3 and v <= 1.5) initial_scale = @floatCast(v);
            }
            if (hook_server.jsonNumberPub(json, "bubble_text")) |v| {
                if (v >= bubble_text_min_px and v <= bubble_text_max_px) initial_bubble_text_px = @floatCast(v);
            }
            if (hook_server.jsonNumberPub(json, "bubble_lifetime")) |v| {
                initial_bubble_lifetime_secs = clampBubbleLifetime(@floatCast(v));
            }
            if (hook_server.jsonNumberPub(json, "bubble_columns")) |v| {
                if (v >= bubble_columns_min and v <= bubble_columns_max) initial_bubble_columns = @intFromFloat(v);
            }
            if (hook_server.jsonNumberPub(json, "bubble_answer_lines")) |v| {
                if (v >= bubble_answer_lines_min and v <= bubble_answer_lines_max) initial_bubble_answer_lines = @intFromFloat(v);
            }
            if (hook_server.jsonNumberPub(json, "bubble_preview_version") == null and initial_bubble_answer_lines == 2) {
                initial_bubble_answer_lines = 3;
            }
            if (hook_server.jsonStringPub(json, "font_path")) |encoded| {
                if (jsonUnescapeString(encoded, &initial_font_path)) |value| {
                    initial_font_path_len = value.len;
                }
            }
            if (hook_server.jsonStringPub(json, "bubbles")) |_| {} else if (std.mem.indexOf(u8, json, "\"bubbles\":false") != null) {
                initial_bubbles = false;
            }
            // Default-true like `bubbles` above, and for the same reason:
            // a settings file written before this key existed must roll
            // forward into the stack, so only an explicit false opts out.
            // Note this has to be checked BEFORE the substring above
            // would match it: "bubbles_per_conversation":false does not
            // contain "bubbles":false, so the two cannot collide.
            if (std.mem.indexOf(u8, json, "\"bubbles_per_conversation\":false") != null) {
                initial_bubbles_per_conversation = false;
            }
            if (std.mem.indexOf(u8, json, "\"agents_prompted\":true") != null) {
                initial_agents_prompted = true;
            }
            // Opposite default from bubbles: the chime is opt-in, so
            // only an explicit true (never a missing key) enables it.
            if (std.mem.indexOf(u8, json, "\"waiting_sound\":true") != null) {
                initial_waiting_sound = true;
            }
            // Opt-in like the sound: only an explicit true hides the
            // Dock icon, a missing key keeps the stock behavior.
            if (std.mem.indexOf(u8, json, "\"hide_dock\":true") != null) {
                initial_hide_dock = true;
            }
            if (hook_server.jsonNumberPub(json, "pet_x")) |x| {
                if (hook_server.jsonNumberPub(json, "pet_y")) |y| {
                    initial_pet_x = x;
                    initial_pet_y = y;
                }
            }
            // Opt-in like the sound and the Dock toggle.
            if (std.mem.indexOf(u8, json, "\"rotate_pets\":true") != null) {
                initial_rotate_pets = true;
            }
            if (hook_server.jsonNumberPub(json, "rotation_day")) |v| {
                if (v >= 0) initial_rotation_day = @intFromFloat(v);
            }
            if (std.mem.indexOf(u8, json, "\"update_checks\":false") != null) {
                initial_update_checks = false;
            }
            if (hook_server.jsonNumberPub(json, "last_update_check_ms")) |v| {
                if (v >= 0) initial_last_update_check_ms = @intFromFloat(v);
            }
            if (hook_server.jsonStringPub(json, "latest_desktop_version")) |version| {
                if (version.len <= initial_latest_version.len and updates.isValidVersion(version)) {
                    @memcpy(initial_latest_version[0..version.len], version);
                    initial_latest_version_len = version.len;
                }
            }
        }
    }
    const index = catalogIndexOf(wanted) orelse 0;
    initial_pet = @intCast(index);
    pet_display_name = catalog[index].slice();
}

/// Register the active state's frames into slots 1..count (replace in
/// place: the registry caps at 16 slots of 1MB, one 192x208 frame is
/// 160KB, and no state has more than 8 frames).
fn registerStateFrames(state: State, fx: *Effects) void {
    if (sheet.pixels.len == 0) return;
    const def = stateDef(state);
    const fw = sheet.width / cols;
    const fh = sheet.height / sheet.rows;
    var scratch = boot_allocator.alloc(u8, fw * fh * 4) catch return;
    defer boot_allocator.free(scratch);
    for (def.frames, 0..) |spec, i| {
        const src_x = spec.col * fw;
        const src_y = def.row * fh;
        for (0..fh) |y| {
            const src_off = ((src_y + y) * sheet.width + src_x) * 4;
            @memcpy(scratch[y * fw * 4 ..][0 .. fw * 4], sheet.pixels[src_off..][0 .. fw * 4]);
        }
        fx.registerImage(i + 1, fw, fh, scratch) catch |err| {
            std.debug.print("petdex: frame register failed ({s})\n", .{@errorName(err)});
            return;
        };
    }
}

const poll_timer_key: u64 = 2;
/// The poll is a collector, not a frame clock.  Keep enough cadence for an
/// active rollout and native bubble controls, then back off once the pet and
/// sessions are settled so a transparent desktop companion is not rebuilding
/// its whole canvas ten times a second for no change.
/// Pointer/gesture sampling remains quick. Agent feeds use the active-session
/// follow cadence, and a fully settled desktop companion backs off
/// further; each tick rebuilds the SDK's retained canvas even when the
/// collector finds no changes.
const poll_interaction_interval_ms: u32 = 125;
const poll_agent_interval_ms: u32 = 250;
const poll_settled_interval_ms: u32 = 500;
const min_dwell_ms: u32 = 250;

fn pollInterval(model: *const Model) u32 {
    if (model.settings_open or model.dragging or model.throwing or model.bubble_hovered)
        return poll_interaction_interval_ms;
    if (anyBusyBubble(model) or anyNeedsInputBubble(model)) return poll_agent_interval_ms;
    return poll_settled_interval_ms;
}

fn armPollTimer(model: *const Model, fx: *Effects) void {
    fx.startTimer(.{
        .key = poll_timer_key,
        .interval_ms = pollInterval(model),
        .mode = .one_shot,
        .on_fire = Effects.timerMsg(.poll_tick),
    });
}

/// Transient states whose duration is intrinsic to the animation;
/// they revert to idle when their dwell expires and nothing is queued
/// (steady states persist until the hooks send the next event).
fn isDurationState(state: State) bool {
    return switch (state) {
        .waving, .failed, .review, .jumping => true,
        else => false,
    };
}

// ---------------------------------------------------------------- rotation

/// UTC epoch-day: the rotation only needs "did the calendar day
/// change", and epoch-day flips at UTC midnight — night hours for most
/// timezones — without dragging timezone math into the app.
fn dayFromWallMs(wall_ms: i64) u32 {
    return @intCast(@divTrunc(wall_ms, std.time.ms_per_day));
}

/// Advance to the next loadable pet, round-robin by catalog order:
/// deterministic (no repeats until the catalog wraps) and skipping
/// sheets the codec refuses, at most one full loop. Rides the same
/// select_pet Msg the settings list dispatches, so activation cannot
/// drift between a click, a rotation, and a shuffle.
fn advancePet(model: *Model, fx: *Effects) void {
    if (catalog_mod.catalog_len < 2) return;
    var offset: u32 = 1;
    while (offset < catalog_mod.catalog_len) : (offset += 1) {
        const idx: u32 = (model.active_pet + offset) % @as(u32, @intCast(catalog_mod.catalog_len));
        update(model, .{ .select_pet = idx }, fx);
        // select_pet only commits after a successful sheet load.
        if (model.active_pet == idx) return;
    }
}

/// Port of state-queue.ts dwellFor.
fn dwellFor(state: State, duration_ms: u32) u32 {
    if (isDurationState(state) and duration_ms > 0) return @max(duration_ms, min_dwell_ms);
    if (duration_ms > min_dwell_ms) return duration_ms;
    return min_dwell_ms;
}

const chime_key: u64 = 23;

/// Optional audible ping when the pet enters `waiting` (permission
/// prompts, idle alerts: the agent is blocked on the user). Playback
/// rides the platform's stock event sound through `fx.spawn` — no
/// bundled asset, no new dependency, and the exit Msg means the child
/// is always reaped. A machine without the player binary gets a
/// rejected exit on `chime_done` and quietly stays silent, as does a
/// chime posted while the previous one is still playing (same key,
/// spawn rejects the overlap).
fn playWaitingChime(fx: *Effects) void {
    const argv: []const []const u8 = switch (builtin.os.tag) {
        .macos => &.{ "/usr/bin/afplay", "/System/Library/Sounds/Glass.aiff" },
        .windows => &.{ "rundll32", "user32.dll,MessageBeep" },
        // The freedesktop `complete` event sound; canberra ships with
        // GNOME/KDE and this no-ops where it does not.
        else => &.{ "canberra-gtk-play", "--id", "complete" },
    };
    fx.spawn(.{
        .key = chime_key,
        .argv = argv,
        .output = .collect,
        .on_exit = Effects.exitMsg(.chime_done),
    });
}

/// Chime on the edge, not the level: `waiting` is often re-posted (one
/// Notification hook per permission prompt while the same prompt sits
/// unanswered, multiple agents), and a ping per re-post would train
/// users to turn the feature straight back off. The poll_tick dwell
/// path refreshes an already-waiting state without calling applyState,
/// so this sees real transitions only; once the user responds the
/// state leaves `waiting`, and the next prompt is a fresh edge that
/// chimes again.
fn shouldChime(previous: State, next: State) bool {
    return next == .waiting and previous != .waiting;
}

/// One follow-up ping when a prompt has sat unanswered this long: the
/// first chime is easy to miss mid-flow, and a prompt still up two
/// minutes later means it really was missed. Exactly one escalation
/// per waiting spell — a repeating ping is an alarm clock, not a pet.
const waiting_escalation_ms: i64 = 120_000;

fn shouldEscalate(state: State, waiting_since_ms: i64, escalated: bool, now: i64) bool {
    return state == .waiting and !escalated and now - waiting_since_ms >= waiting_escalation_ms;
}

fn applyState(model: *Model, state: State, duration_ms: u32, fx: *Effects) void {
    if (shouldChime(model.state, state)) {
        model.waiting_since_ms = fx.wallMs();
        model.waiting_escalated = false;
        if (model.waiting_sound) playWaitingChime(fx);
    }
    model.state = state;
    model.frame_index = 0;
    model.shown_at_ms = fx.wallMs();
    model.shown_dwell_ms = dwellFor(state, duration_ms);
    registerStateFrames(state, fx);
    armFrameTimer(model, fx);
}

/// Turn a remote runtime Action into an effect. Spawn argv comes from
/// the remote_ssh builders; the driver decides WHAT, this decides HOW
/// it reaches fx.
fn runRemoteAction(model: *Model, slot_idx: usize, action: remote_runtime.Action, fx: *Effects) void {
    switch (action) {
        .none => {},
        .backoff => |ms| {
            fx.startTimer(.{
                .key = remote_runtime.backoffKey(slot_idx),
                .interval_ms = ms,
                .mode = .one_shot,
                .on_fire = Effects.timerMsg(.remote_backoff),
            });
        },
        .spawn => |spec| {
            const slot = &model.remotes[slot_idx];
            const remote = remote_runtime.remoteFor(slot);
            var argv_buf: [remote_ssh.max_argv][]const u8 = undefined;
            var scratch: remote_ssh.Scratch = .{};
            const argv: ?[]const []const u8 = switch (spec.op) {
                .probe => remote_ssh.probeArgv(&argv_buf, &scratch, &remote),
                .quiesce => remote_ssh.quiesceArgv(&argv_buf, &scratch, &remote),
                .profile => remote_ssh.probeArgv(&argv_buf, &scratch, &remote),
                .fetch => remote_ssh.readArgv(&argv_buf, &scratch, &remote, spec.path),
                .push => remote_ssh.writeArgv(&argv_buf, &scratch, &remote, spec.path, spec.first_chunk, spec.last_chunk, spec.executable),
                .token => remote_ssh.tokenArgv(&argv_buf, &scratch, &remote),
                .watcher => remote_ssh.watcherArgv(&argv_buf, &scratch, &remote, spec.watch_codex, spec.watch_hermes),
                .tunnel => if (env_home) |home|
                    remote_ssh.tunnelArgv(&argv_buf, &scratch, &remote, home, plat.processId())
                else
                    null,
                .none => null,
            };
            const final_argv = argv orelse {
                std.debug.print("petdex: remote '{s}': could not build ssh argv\n", .{slot.nameSlice()});
                if (env_home) |home| {
                    const recovery = remote_runtime.onSpawnBuildFailure(slot, slot_idx, spec.op, home);
                    runRemoteAction(model, slot_idx, recovery, fx);
                }
                return;
            };
            const is_tunnel = spec.op == .tunnel;
            fx.spawn(.{
                .key = remote_runtime.keyFor(slot_idx, spec.op),
                .argv = final_argv,
                .stdin = if (spec.stdin.len > 0) spec.stdin else null,
                .output = if (is_tunnel) .lines else .collect,
                .on_line = if (is_tunnel) Effects.lineMsg(.remote_line) else null,
                .on_exit = Effects.exitMsg(.remote_done),
            });
        },
    }
}

/// Boot entry: load remote-agents.json, fill slots, and kick each
/// remote's probe. A missing or unparsable config is a no-op. Local
/// pets never depend on remotes.
fn startRemotes(model: *Model, fx: *Effects) void {
    const home = env_home orelse return;
    // A crash can strand private fetch snapshots; they are never inputs to a
    // later run, so remove them before reading any remote configuration.
    remote_writeback.cleanupStagingRoot(home);
    if (remote_ssh.detect() == null) return;
    if (!remote_ssh.installTunnelSupervisor(home)) {
        std.debug.print("petdex: could not install the ssh tunnel supervisor; remotes disabled\n", .{});
        return;
    }
    const cfg = remote_agents.load(boot_allocator, home) orelse {
        std.debug.print("petdex: ~/.petdex/remote-agents.json is not valid JSON; remotes disabled\n", .{});
        return;
    };
    model.remote_count = remote_runtime.fillFromConfig(&model.remotes, &cfg);
    for (0..model.remote_count) |i| {
        runRemoteAction(model, i, remote_runtime.startAction(&model.remotes[i]), fx);
    }
}

pub fn boot(model: *Model, fx: *Effects) void {
    if (env_home) |home| {
        // Upgrade old CLI-written hooks before any agent starts another
        // session. The migration recognizes only Petdex-owned legacy
        // commands and leaves malformed or foreign configs untouched.
        const migration = agent_hooks.migrateLegacyHooks(boot_allocator, home);
        if (migration.failed > 0) {
            std.debug.print("petdex: {d} legacy hook configuration(s) could not be migrated; repair the config and update the affected agent in Settings\n", .{migration.failed});
        }
        hook_server.start(boot_allocator, home) catch |err| {
            std.debug.print("petdex: hook server failed to start ({s})\n", .{@errorName(err)});
        };
        session_reconcile.start(boot_allocator, home) catch |err| {
            std.debug.print("petdex: local session recovery failed to start ({s})\n", .{@errorName(err)});
        };
        startRemotes(model, fx);
    }
    armPollTimer(model, fx);
    // Settings and agent state are independent of whether any sheet
    // decodes, so they land before the catalog work: a corrupt pet must
    // not cost the user their scale, their bubble preference, or the
    // Agents section.
    model.scale = initial_scale;
    model.bubbles_enabled = initial_bubbles;
    model.bubbles_per_conversation = initial_bubbles_per_conversation;
    model.waiting_sound = initial_waiting_sound;
    model.bubble_text_px = initial_bubble_text_px;
    model.bubble_lifetime_secs = initial_bubble_lifetime_secs;
    setUnsignedText(model.bubble_lifetime_text[0..], &model.bubble_lifetime_text_len, @intFromFloat(model.bubble_lifetime_secs));
    model.bubble_columns = initial_bubble_columns;
    model.bubble_answer_lines = initial_bubble_answer_lines;
    setUnsignedText(model.bubble_columns_text[0..], &model.bubble_columns_text_len, model.bubble_columns);
    setUnsignedText(model.bubble_answer_lines_text[0..], &model.bubble_answer_lines_text_len, model.bubble_answer_lines);
    @memcpy(model.font_path[0..initial_font_path_len], initial_font_path[0..initial_font_path_len]);
    model.font_path_len = initial_font_path_len;
    model.font_load_failed = initial_font_load_failed;
    model.agents_prompted = initial_agents_prompted;
    model.hide_dock = initial_hide_dock;
    model.rotate_pets = initial_rotate_pets;
    model.rotation_day = initial_rotation_day;
    model.update_checks_enabled = initial_update_checks;
    model.last_update_check_ms = initial_last_update_check_ms;
    @memcpy(model.latest_version[0..initial_latest_version_len], initial_latest_version[0..initial_latest_version_len]);
    model.latest_version_len = initial_latest_version_len;
    updateCachePhase(model);
    armNextUpdateCheck(model, fx);
    loadDismissedSessions(model);
    model.launch_at_login = plat.launchAtLoginEnabled();
    // Applied via the main queue, so the flip lands as soon as the
    // host's runloop spins up; a Regular-policy Dock icon may blink in
    // for the first frames of a hidden-dock boot, which beats holding
    // the setting hostage to an SDK boot hook that does not exist yet.
    plat.setDockIconHidden(model.hide_dock);
    if (env_home) |home| {
        model.agents = agent_hooks.scan(boot_allocator, home);
        model.herdr_status = herdr_status.detect(boot_allocator, home);
    }
    loadAgentsAtlas(model.dark, fx);

    // First point where the platform codec is reachable: `init_fx` runs
    // on the loop thread right after the runtime binds services onto fx.
    if (catalog_mod.catalog_len == 0) return;
    // A single unreadable sheet used to leave an empty window even with
    // a full catalog behind it (one shipped pet is a 3-byte stub), so
    // the chosen pet is a preference here, not a requirement.
    var chosen: ?usize = null;
    for (0..catalog_mod.catalog_len) |offset| {
        const index = (initial_pet + offset) % catalog_mod.catalog_len;
        if (loadSheetForPet(fx, &catalog[index])) {
            chosen = index;
            break;
        }
    }
    const active = chosen orelse {
        // Distinguish an empty catalog from a catalog the platform codec
        // cannot read: on Linux gdk-pixbuf needs a loader plugin per
        // format, and Ubuntu ships none for webp, so every pet decodes
        // to nothing while sitting right there on disk. Telling that
        // user to install a pet sends them in the wrong direction.
        if (builtin.os.tag == .linux) {
            std.debug.print("petdex: {d} pet(s) installed but none decoded; on Linux webp needs the gdk-pixbuf loader (apt install webp-pixbuf-loader)\n", .{catalog_mod.catalog_len});
        } else {
            std.debug.print("petdex: {d} pet(s) installed but none decoded; the sheet may be corrupt\n", .{catalog_mod.catalog_len});
        }
        return;
    };
    if (active != initial_pet) {
        std.debug.print("petdex: pet {s} failed to decode, fell back to {s}\n", .{ catalog[initial_pet].slice(), catalog[active].slice() });
    }
    model.active_pet = @intCast(active);
    // The name was resolved alongside the preferred pet, so a fallback
    // has to re-point it or the window would label the pet it could not
    // draw.
    pet_display_name = catalog[active].slice();
    registerStateFrames(model.state, fx);
    model.sheet_loaded = true;
    const n = @min(pet_display_name.len, model.pet_name.len);
    @memcpy(model.pet_name[0..n], pet_display_name[0..n]);
    model.pet_name_len = n;
    armFrameTimer(model, fx);
}

fn pushSample(model: *Model, x: f64, y: f64, now: i64) void {
    // Keep only samples inside the window, then append.
    var kept: usize = 0;
    for (model.samples[0..model.sample_len]) |sample| {
        if (now - sample.t_ms <= sample_window_ms) {
            model.samples[kept] = sample;
            kept += 1;
        }
    }
    if (kept == model.samples.len) {
        std.mem.copyForwards(PosSample, model.samples[0 .. kept - 1], model.samples[1..kept]);
        kept -= 1;
    }
    model.samples[kept] = .{ .x = x, .y = y, .t_ms = now };
    model.sample_len = kept + 1;
}

/// The old renderer's computeVelocity: last sample against the newest
/// one older than 16ms, in points per second.
fn releaseVelocity(model: *const Model) ?struct { x: f64, y: f64 } {
    if (model.sample_len < 2) return null;
    const last = model.samples[model.sample_len - 1];
    // Oldest sample in the window older than one tick, the old
    // renderer's anchor: velocity averages the whole 100ms gesture
    // tail instead of chasing the last two frames.
    var first: ?PosSample = null;
    for (model.samples[0..model.sample_len]) |sample| {
        if (last.t_ms - sample.t_ms > 16) {
            first = sample;
            break;
        }
    }
    const anchor = first orelse return null;
    const dt_sec = @as(f64, @floatFromInt(last.t_ms - anchor.t_ms)) / 1000.0;
    if (dt_sec <= 0) return null;
    return .{ .x = (last.x - anchor.x) / dt_sec, .y = (last.y - anchor.y) / dt_sec };
}

fn setThrowState(model: *Model, state: State, fx: *Effects) void {
    if (model.state == state) return;
    model.state = state;
    model.frame_index = 0;
    registerStateFrames(state, fx);
    armFrameTimer(model, fx);
}

pub fn update(model: *Model, msg: Msg, fx: *Effects) void {
    // Bubble springs are short-lived work.  Drive them from a one-shot timer
    // that rearms only while geometry is moving instead of keeping the Metal
    // presented-frame channel alive forever.  The latter rebuilds every
    // window and remeasures every line even when only native shimmer is live.
    defer {
        const now = fx.wallMs();
        if (bubblePresentationAnimationPending(model, now)) armBubbleAnimationTimer(fx);
        if (builtin.target.os.tag == .linux) {
            if (bubbleActive(model) and model.bubble_render_dirty.any())
                syncBubbleGlass(model, fx, bubbleWindowHeight(model), now);
        } else {
            _ = commitPortableBubblePresentationForPlatform(model, now, builtin.target.os.tag);
        }
        if (model.bubble_render_dirty.any()) {
            armBubblePresentationTimer(model, fx, now);
        } else if (model.bubble_presentation_due_ms != 0) {
            fx.cancelTimer(bubble_presentation_timer_key);
            model.bubble_presentation_due_ms = 0;
        }
    }

    switch (msg) {
        .frame_tick => |timer| {
            if (timer.outcome != .fired) return;
            if (!model.sheet_loaded) return;
            const def = stateDef(model.state);
            model.frame_index = (model.frame_index + 1) % def.frames.len;
            armFrameTimer(model, fx);
        },
        .cycle_state => {
            applyState(model, model.state.next(), 0, fx);
        },
        .toggle_pets_expanded => model.pets_expanded = !model.pets_expanded,
        .dismiss_install_error => model.install.error_len = 0,
        .install_first_pet => {
            // A fresh install has no pets, so the pet window renders an
            // empty panel: a grey rectangle with nothing in it and no way
            // to tell whether Petdex is broken or just unfurnished. This
            // is the one-click way out, riding the same queue a
            // `petdex://` deep link uses, so activation after download
            // takes the identical path.
            if (model.install.busy()) return;
            model.install.error_len = 0;
            _ = model.install.enqueue(default_pet_slug);
            model.install.activate_when_done = true;
            startInstallQueue(model, fx);
        },
        .manifest_done => |exit| {
            if (model.install.phase != .manifest) return;
            // A nonzero curl exit means no usable manifest on disk, so
            // there is nothing to resolve any slug against: the whole
            // queue ends here rather than failing pet by pet.
            if (exit.reason != .exited or exit.code != 0) {
                model.install.setError("Could not reach petdex.dev", .{});
                model.install.phase = .idle;
                model.install.queued = 0;
                return;
            }
            model.install.current = 0;
            if (!beginCurrentPet(model, fx)) advanceInstallQueue(model, fx);
        },
        .pet_json_done => |exit| {
            if (model.install.phase != .pet_json) return;
            if (exit.reason != .exited or exit.code != 0) {
                model.install.setError("{s}: pet.json download failed", .{model.install.currentSlug()});
                advanceInstallQueue(model, fx);
                return;
            }
            if (!beginSpritesheet(model, fx)) {
                model.install.setError("{s}: spritesheet unavailable", .{model.install.currentSlug()});
                advanceInstallQueue(model, fx);
            }
        },
        .spritesheet_done => |exit| {
            if (model.install.phase != .spritesheet) return;
            const slug = model.install.currentSlug();
            if (exit.reason != .exited or exit.code != 0) {
                model.install.setError("{s}: spritesheet download failed", .{slug});
                advanceInstallQueue(model, fx);
                return;
            }
            mirrorToCodexRoot(slug, model.install.ext_png);
            model.install.installed_ok += 1;
            // The pet is only usable once the catalog knows it; a fresh
            // thumbnail pass picks it up the next time settings is open.
            const index = catalogAppend(slug, model.active_pet);
            thumbs_built = @min(thumbs_built, catalog_mod.catalog_len);
            if (model.install.activate_when_done) {
                if (index) |i| {
                    // Deliberately routed through the same Msg the
                    // settings list uses, so activation after an install
                    // cannot drift from activation by click.
                    update(model, .{ .select_pet = @intCast(i) }, fx);
                }
            }
            advanceInstallQueue(model, fx);
        },
        .pet_filter => |edit| {
            switch (edit) {
                .insert_text => |txt| {
                    const room = model.pet_filter.len - model.pet_filter_len;
                    const n = @min(txt.len, room);
                    @memcpy(model.pet_filter[model.pet_filter_len..][0..n], txt[0..n]);
                    model.pet_filter_len += n;
                },
                .delete_backward, .delete_word_backward => {
                    while (model.pet_filter_len > 0) {
                        model.pet_filter_len -= 1;
                        if ((model.pet_filter[model.pet_filter_len] & 0xC0) != 0x80) break;
                    }
                },
                .clear => model.pet_filter_len = 0,
                else => {},
            }
        },
        .uninstall_agent => |index| {
            if (index >= agent_hooks.agent_count) return;
            const home = env_home orelse return;
            if (model.agents[index].kind == .dsh) {
                if (model.dsh_busy or builtin.os.tag != .macos) return;
                const official = dsh_integration.removeArgv();
                const command = dsh_integration.macLoginShellArgv(official.slice());
                model.dsh_busy = true;
                model.dsh_error = false;
                fx.spawn(.{
                    .key = dsh_remove_key,
                    .argv = command.slice(),
                    .output = .collect,
                    .on_exit = Effects.exitMsg(.dsh_remove_done),
                });
                return;
            }
            _ = agent_hooks.uninstall(boot_allocator, home, model.agents[index].kind);
            if (model.agents[index].kind == .codex) model.codex_trust_note = false;
            model.agent_install_failed = null;
            model.agents = agent_hooks.scan(boot_allocator, home);
        },
        .install_agent => |index| {
            if (index >= agent_hooks.agent_count) return;
            const kind = model.agents[index].kind;
            const home = env_home orelse return;
            if (kind == .dsh) {
                if (model.dsh_busy or builtin.os.tag != .macos) return;
                var path_buf: [768]u8 = undefined;
                const tarball = dsh_integration.materialize(boot_allocator, home, &path_buf) orelse {
                    model.dsh_error = true;
                    return;
                };
                dsh_integration.clearHandshake(home);
                const official = dsh_integration.addArgv(tarball);
                const command = dsh_integration.macLoginShellArgv(official.slice());
                model.dsh_busy = true;
                model.dsh_error = false;
                fx.spawn(.{
                    .key = dsh_install_key,
                    .argv = command.slice(),
                    .output = .collect,
                    .on_exit = Effects.exitMsg(.dsh_install_done),
                });
                return;
            }
            model.agent_install_failed = null;
            const ok = switch (kind) {
                .claude_code => agent_hooks.installClaude(boot_allocator, home),
                .codex => agent_hooks.installCodex(boot_allocator, home),
                .gemini => agent_hooks.installGemini(boot_allocator, home),
                .opencode => agent_hooks.installOpencode(boot_allocator, home),
                .qoder => agent_hooks.installQoder(boot_allocator, home),
                .kimi_code => agent_hooks.installKimiCode(boot_allocator, home),
                .codebuddy => agent_hooks.installCodeBuddy(boot_allocator, home),
                .omp => agent_hooks.installOmp(boot_allocator, home),
                .hermes => agent_hooks.installHermes(boot_allocator, home),
                .dsh => unreachable,
            };
            if (ok and kind == .codex) model.codex_trust_note = true;
            if (!ok) model.agent_install_failed = kind;
            model.agents = agent_hooks.scan(boot_allocator, home);
        },
        .dsh_install_done => |exit| {
            model.dsh_busy = false;
            model.dsh_error = exit.reason != .exited or exit.code != 0;
            if (model.dsh_error and exit.output.len > 0) {
                std.debug.print("petdex: DSH plugin install failed: {s}\n", .{exit.output});
            }
            if (env_home) |home| model.agents = agent_hooks.scan(boot_allocator, home);
        },
        .dsh_remove_done => |exit| {
            model.dsh_busy = false;
            model.dsh_error = exit.reason != .exited or exit.code != 0;
            if (env_home) |home| {
                if (!model.dsh_error) dsh_integration.clearHandshake(home);
                model.agents = agent_hooks.scan(boot_allocator, home);
            }
            if (model.dsh_error and exit.output.len > 0) {
                std.debug.print("petdex: DSH plugin removal failed: {s}\n", .{exit.output});
            }
        },
        .open_settings => {
            if (env_home) |home| {
                model.agents = agent_hooks.scan(boot_allocator, home);
                model.herdr_status = herdr_status.detect(boot_allocator, home);
            }
            startHomebrewCheck(model, fx);
            if (model.update_checks_enabled and updateCheckStale(model.last_update_check_ms, fx.wallMs(), update_settings_interval_ms)) {
                startUpdateCheck(model, false, fx);
            }
            loadAgentsAtlas(model.dark, fx);
            if (model.settings_open) {
                // Already open, likely buried behind other windows:
                // raise it instead of rebuilding an identical
                // descriptor (a no-op).
                fx.focusWindow(settings_window_label);
                return;
            }
            model.settings_open = true;
        },
        .settings_closed => model.settings_open = false,
        .update_boot_check => |timer| {
            if (timer.outcome == .fired and model.update_checks_enabled) startUpdateCheck(model, false, fx);
        },
        .check_updates => startUpdateCheck(model, true, fx),
        .toggle_update_checks => {
            model.update_checks_enabled = !model.update_checks_enabled;
            if (!model.update_checks_enabled) {
                fx.cancelTimer(update_boot_timer_key);
                if (model.update_phase == .checking and !model.update_manual) {
                    model.update_cancel_pending = true;
                    model.update_restart_after_cancel = false;
                    fx.cancel(update_fetch_key);
                    updateCachePhase(model);
                }
            } else if (model.update_cancel_pending) {
                model.update_restart_after_cancel = true;
            } else if (updateCheckStale(model.last_update_check_ms, fx.wallMs(), update_background_interval_ms)) {
                startUpdateCheck(model, false, fx);
            } else {
                armNextUpdateCheck(model, fx);
            }
            saveSettings(model);
        },
        .update_response => |response| {
            if (model.update_cancel_pending) {
                const restart = model.update_restart_after_cancel and model.update_checks_enabled;
                model.update_cancel_pending = false;
                model.update_restart_after_cancel = false;
                model.update_manual = false;
                updateCachePhase(model);
                if (restart) startUpdateCheck(model, false, fx);
                saveSettings(model);
                return;
            }
            if (response.outcome != .ok or response.status != 200 or response.truncated) {
                finishUpdateFailure(model);
                armUpdateRetry(model, fx);
                saveSettings(model);
                return;
            }
            var parsed = updates.parseLatest(boot_allocator, response.body) orelse {
                finishUpdateFailure(model);
                armUpdateRetry(model, fx);
                saveSettings(model);
                return;
            };
            defer parsed.deinit();
            const version = parsed.value.version orelse {
                finishUpdateFailure(model);
                armUpdateRetry(model, fx);
                saveSettings(model);
                return;
            };
            if (version.len > model.latest_version.len) {
                finishUpdateFailure(model);
                armUpdateRetry(model, fx);
                saveSettings(model);
                return;
            }
            @memcpy(model.latest_version[0..version.len], version);
            model.latest_version_len = version.len;
            model.last_update_check_ms = fx.wallMs();
            model.update_phase = if (updates.isNewer(version, updates.current_version)) .available else .current;
            model.update_manual = false;
            armNextUpdateCheck(model, fx);
            saveSettings(model);
        },
        .homebrew_done => |exit| {
            fx.cancelTimer(homebrew_timeout_timer_key);
            if (model.install_source == .checking) {
                model.install_source = if (exit.reason == .exited and exit.code == 0) .homebrew else .direct;
            }
        },
        .homebrew_timeout => |timer| {
            if (timer.outcome == .fired and model.install_source == .checking) {
                model.install_source = .direct;
                fx.cancel(homebrew_check_key);
            }
        },
        .download_update => plat.openExternal(updates.downloadUrl()),
        .copy_brew_command => {
            model.brew_command_copied = false;
            fx.writeClipboard(.{
                .key = brew_clipboard_key,
                .text = updates.brew_command,
                .on_result = Effects.clipboardMsg(.brew_command_copied),
            });
        },
        .brew_command_copied => |result| model.brew_command_copied = result.outcome == .ok,
        .close_pet => closePet(model, fx),
        .select_pet => |index| {
            if (index >= catalog_mod.catalog_len) return;
            // `index == active_pet` is a no-op only once a sheet is up.
            // On a first run active_pet is 0 and the pet just downloaded
            // lands at 0 too, so the early return skipped the very
            // activation the empty state exists to perform.
            if (index == model.active_pet and model.sheet_loaded) return;
            if (!loadSheetForPet(fx, &catalog[index])) return;
            model.active_pet = index;
            model.frame_index = 0;
            // First pet on a fresh install: the window was drawing the
            // empty state, and nothing else flips this back.
            if (!model.sheet_loaded) {
                model.sheet_loaded = true;
                pet_display_name = catalog[index].slice();
                const n = @min(pet_display_name.len, model.pet_name.len);
                @memcpy(model.pet_name[0..n], pet_display_name[0..n]);
                model.pet_name_len = n;
            }
            // A pick — manual or rotation, same Msg on purpose — is
            // today's pet: the daily rotation leaves it alone until
            // the next day.
            model.rotation_day = dayFromWallMs(fx.wallMs());
            registerStateFrames(model.state, fx);
            armFrameTimer(model, fx);
            saveSettings(model);
        },
        .toggle_bubbles => {
            model.bubbles_enabled = !model.bubbles_enabled;
            if (!model.bubbles_enabled) clearBubble(model);
            saveSettings(model);
        },
        .toggle_bubbles_per_conversation => {
            model.bubbles_per_conversation = !model.bubbles_per_conversation;
            // Turning it off has to act on what is ALREADY on screen, not
            // just on the next event: a visible stack would otherwise sit
            // there fanned out until some agent happened to speak. Fold
            // it now, close the fan, and resize the window to the single
            // card the view will draw.
            if (!model.bubbles_per_conversation and model.bubbles_len > 1) {
                collapseModelToNewest(model);
                retargetBubbleGroupSizeSpring(model);
                // The stacked view draws no tail, so switching to the
                // single card is the first moment this run may need one.
                syncBubbleWindow(model, fx);
            }
            saveSettings(model);
        },
        .toggle_waiting_sound => {
            model.waiting_sound = !model.waiting_sound;
            saveSettings(model);
            // Flipping it on plays the chime once: the only way to
            // judge a sound is to hear it, and hunting for a permission
            // prompt just to preview a volume level is busywork.
            if (model.waiting_sound) playWaitingChime(fx);
        },
        .chime_done => {},
        .remote_line => |line| {
            const decoded = remote_runtime.slotOpFromKey(line.key) orelse return;
            if (decoded.slot >= model.remote_count) return;
            const action = remote_runtime.onSpawnLine(&model.remotes[decoded.slot], decoded.op, line.line);
            runRemoteAction(model, decoded.slot, action, fx);
        },
        .remote_done => |exit| {
            const decoded = remote_runtime.slotOpFromKey(exit.key) orelse return;
            if (decoded.slot >= model.remote_count) return;
            const home = env_home orelse return;
            const slot = &model.remotes[decoded.slot];
            if (exit.reason == .cancelled) return;
            if (decoded.op == .tunnel) {
                // A tunnel can die while a short post-ready sync SSH process
                // is in flight. Cancel every gated phase before scheduling
                // reconnect so no stale completion can reopen the token.
                inline for (.{ remote_runtime.Op.profile, remote_runtime.Op.fetch, remote_runtime.Op.push, remote_runtime.Op.token, remote_runtime.Op.watcher }) |op| {
                    fx.cancel(remote_runtime.keyFor(decoded.slot, op));
                }
                fx.cancel(remote_runtime.backoffKey(decoded.slot));
            }
            const action = remote_runtime.onSpawnExitDetailed(slot, decoded.slot, decoded.op, exit.code, exit.output, exit.output_truncated, home);
            runRemoteAction(model, decoded.slot, action, fx);
        },
        .remote_backoff => |timer| {
            if (timer.outcome != .fired) return;
            const slot_idx = remote_runtime.slotFromBackoffKey(timer.key) orelse return;
            if (slot_idx >= model.remote_count) return;
            const home = env_home orelse return;
            const action = remote_runtime.onBackoff(&model.remotes[slot_idx], slot_idx, home);
            runRemoteAction(model, slot_idx, action, fx);
        },
        .set_bubble_text_size => |fraction| {
            model.bubble_text_px = bubble_text_min_px + fraction * (bubble_text_max_px - bubble_text_min_px);
            retargetBubbleGroupSizeSpring(model);
            _ = fitWindow(model, fx);
            syncBubbleWindow(model, fx);
            saveSettings(model);
        },
        .bubble_lifetime_input => |edit| {
            if (editUnsignedText(model.bubble_lifetime_text[0..], &model.bubble_lifetime_text_len, edit, 0, 60)) |value| {
                model.bubble_lifetime_secs = @floatFromInt(value);
                // Every settled bubble restarts on the new lifetime. Work
                // that is running or awaiting the user's answer remains
                // persistent, even when the protocol reports the latter as
                // not busy.
                const now = fx.wallMs();
                for (0..model.bubbles_len) |i| {
                    if (bubbleKeepsAlive(&model.bubbles[i])) continue;
                    model.bubble_expires_at_ms[i] = bubbleDeadlineMs(now, model.bubble_lifetime_secs);
                }
                saveSettings(model);
            }
        },
        .bubble_columns_input => |edit| {
            if (editUnsignedText(model.bubble_columns_text[0..], &model.bubble_columns_text_len, edit, bubble_columns_min, bubble_columns_max)) |value| {
                model.bubble_columns = value;
                retargetBubbleGroupSizeSpring(model);
                _ = fitWindow(model, fx);
                syncBubbleWindow(model, fx);
                saveSettings(model);
            }
        },
        .bubble_answer_lines_input => |edit| {
            if (editUnsignedText(model.bubble_answer_lines_text[0..], &model.bubble_answer_lines_text_len, edit, bubble_answer_lines_min, bubble_answer_lines_max)) |value| {
                model.bubble_answer_lines = @intCast(value);
                retargetBubbleGroupSizeSpring(model);
                _ = fitWindow(model, fx);
                syncBubbleWindow(model, fx);
                saveSettings(model);
            }
        },
        .font_path_input => |edit| {
            editPathText(model.font_path[0..], &model.font_path_len, edit);
            model.font_path_dirty = true;
            model.font_load_failed = false;
            saveSettings(model);
        },
        .toggle_hide_dock => {
            model.hide_dock = !model.hide_dock;
            plat.setDockIconHidden(model.hide_dock);
            saveSettings(model);
        },
        .toggle_launch_at_login => {
            _ = plat.setLaunchAtLogin(!model.launch_at_login);
            // SMAppService is the source of truth (see the model
            // field): reflect the status query, not the wish.
            model.launch_at_login = plat.launchAtLoginEnabled();
        },
        .toggle_focus_mode => {
            model.focus_mode = !model.focus_mode;
            if (model.focus_mode) clearBubble(model);
        },
        .toggle_rotate_pets => {
            model.rotate_pets = !model.rotate_pets;
            // Enabling never swaps on the spot: the pet on screen
            // becomes today's, and rotation starts tomorrow.
            model.rotation_day = dayFromWallMs(fx.wallMs());
            saveSettings(model);
        },
        .shuffle_pet => advancePet(model, fx),
        .quit_app => plat.requestQuit(),
        .set_scale => |fraction| {
            model.scale = 0.4 + fraction * 0.8;
            _ = fitWindow(model, fx);
            saveSettings(model);
        },
        .open_pet_page => |index| {
            if (index >= catalog_mod.catalog_len) return;
            var buf: [256]u8 = undefined;
            const url = std.fmt.bufPrint(&buf, "https://petdex.dev/pets/{s}", .{catalog[index].slice()}) catch return;
            plat.openExternal(url);
        },
        .appearance => |a| {
            model.dark = a.color_scheme == .dark;
            if (frontBubble(model)) |newest| {
                loadAgentAvatar(newest.agent[0..newest.agent_len], model.dark, fx);
            }
            // The strip is themed, so a stack drawing from it has to
            // re-pack on an appearance flip exactly like settings does.
            if (model.settings_open or model.bubbles_len > 1) loadAgentsAtlas(model.dark, fx);
            model.high_contrast = a.high_contrast;
            model.reduce_motion = a.reduce_motion;
            if (bubbleActive(model)) {
                invalidateBubblePresentation(model, .{ .appearance = true, .urgent = true });
                syncBubbleWindow(model, fx);
            }
        },
        .native_drag_started => |direction| {
            fx.cancelTimer(native_drag_watchdog_key);
            model.throwing = false;
            model.dragging = false;
            model.sample_len = 0;
            if (direction) |state| setThrowState(model, state, fx);
            // Wayland may not deliver the pointer release after the
            // compositor owns the move. This is only a safety net: the
            // native end command still wins when GTK delivers it.
            fx.startTimer(.{
                .key = native_drag_watchdog_key,
                .interval_ms = native_drag_watchdog_ms,
                .mode = .one_shot,
                .on_fire = Effects.timerMsg(.native_drag_watchdog),
            });
        },
        .native_drag_ended => {
            fx.cancelTimer(native_drag_watchdog_key);
            if (fx.moveWindow("main", 0, 0, false)) |read| {
                model.pet_x = read.x;
                model.pet_y = read.y;
                if (bubbleActive(model)) {
                    invalidateBubblePresentation(model, .{ .geometry = true, .urgent = true });
                    syncBubbleWindow(model, fx);
                }
            }
            // Native card panels move the pet directly on AppKit's event
            // stream. Persist the reconciled model position once at release,
            // matching an ordinary pet drag without writing every frame.
            saveSettings(model);
            if (model.state == .@"running-left" or model.state == .@"running-right")
                applyState(model, .waving, 1200, fx);
        },
        .native_drag_watchdog => |timer| {
            if (timer.outcome != .fired) return;
            if (model.state == .@"running-left" or model.state == .@"running-right")
                applyState(model, .waving, 1200, fx);
        },
        .native_bubble_command => |command| {
            const translated: ?Msg = switch (command.action) {
                .toggle => .toggle_bubble_visibility,
                .open, .activate => if (bubbleSlotForVisualIdentity(model, command.identity)) |slot|
                    Msg{ .focus_bubble = slot }
                else
                    null,
                .pin => if (bubbleSlotForVisualIdentity(model, command.identity)) |slot|
                    Msg{ .toggle_bubble_pin = slot }
                else
                    null,
                .subagents => if (bubbleSlotForVisualIdentity(model, command.identity)) |slot|
                    Msg{ .toggle_subagent_details = slot }
                else
                    null,
                .dismiss => if (bubbleSlotForVisualIdentity(model, command.identity)) |slot|
                    Msg{ .dismiss_bubble = slot }
                else
                    null,
                .drag_started => Msg{ .native_drag_started = null },
                .drag_ended => .native_drag_ended,
            };
            if (translated) |action| update(model, action, fx);
        },
        .focus_bubble => |slot| {
            if (slot >= model.bubbles_len) return;
            const bubble = &model.bubbles[slot];
            _ = plat.activateOriginApplication(bubble.origin_app, bubble.ttySlice(), bubble.cwdSlice());
        },
        .toggle_bubble_pin => |slot| {
            if (slot >= model.bubbles_len) return;
            const identity = bubbleIdentityHash(&model.bubbles[slot]) orelse return;
            model.pinned_bubble_identity = if (model.pinned_bubble_identity == identity) 0 else identity;
            applyBubblePresentationOrder(model);
            retargetBubbleGroupSizeSpring(model);
            invalidateBubblePresentation(model, .{ .urgent = true });
            syncBubbleWindow(model, fx);
        },
        .toggle_subagent_details => |slot| {
            if (slot >= model.bubbles_len or model.bubbles[slot].child_messages_len == 0) return;
            const identity = bubbleVisualIdentity(&model.bubbles[slot]);
            model.expanded_subagent_identity = if (model.expanded_subagent_identity == identity) 0 else identity;
            retargetBubbleGroupSizeSpring(model);
            invalidateBubblePresentation(model, .{ .urgent = true });
            syncBubbleWindow(model, fx);
        },
        .toggle_bubble_visibility => {
            if (model.bubbles_len == 0) return;
            const next = nextBubbleDisplayMode(bubbleDisplayMode(model));
            setBubbleDisplayMode(model, next);
            model.bubble_group_manually_closed = next == .hidden;
            model.bubble_expansion_target = if (next == .hidden) 0 else 1;
            model.bubble_fold_phase = switch (next) {
                .all => if (model.bubble_expansion >= 0.999) .unfolded else .materializing,
                .recent => if (model.bubble_expansion >= 0.999) .unfolded else .materializing,
                .hidden => .collapsing,
            };
            retargetBubbleGroupSizeSpring(model);
            invalidateBubblePresentation(model, .{ .urgent = true });
            if (frontBubble(model)) |front|
                loadAgentAvatar(front.agent[0..front.agent_len], model.dark, fx);
            syncBubbleWindow(model, fx);
        },
        .dismiss_bubble => |slot| {
            if (slot >= model.bubbles_len) return;
            const bubble = &model.bubbles[slot];
            // Active work, prompts, and tool execution must remain visible.
            // The control is also hidden for these cards, but keep the model
            // guard so stale UI events cannot suppress a session mid-turn.
            if (!bubbleDismissible(bubble)) return;
            const identity = bubbleIdentityHash(bubble) orelse return;
            if (addDismissedSessionHash(model, identity)) saveDismissedSessions(model);
            const removed = removeBubbleAt(model, slot) orelse return;
            dropMailboxBubble(&removed);
            retargetBubbleGroupSizeSpring(model);
            invalidateBubblePresentation(model, .{ .urgent = true });
            if (frontBubble(model)) |front| {
                loadAgentAvatar(front.agent[0..front.agent_len], model.dark, fx);
                syncBubbleWindow(model, fx);
            } else {
                plat.clearBubbleNativePresentation();
            }
        },
        .noop => {},
        .open_pets_folder => {
            if (env_home) |home| {
                var buf: [512]u8 = undefined;
                const dir = std.fmt.bufPrint(&buf, "{s}/.petdex/pets", .{home}) catch return;
                plat.openExternal(dir);
            }
        },
        .bubble_animation_tick => |timer| {
            if (timer.outcome != .fired or !bubbleActive(model)) return;
            const now = fx.wallMs();
            if (stepBubbleExpansion(model, now)) syncBubbleWindow(model, fx);
        },
        .bubble_presentation_tick => |timer| {
            if (timer.outcome != .fired) return;
            model.bubble_presentation_due_ms = 0;
            // The 100 ms poll only collects feed/input state. This one-shot
            // scheduler owns the bounded layout/native commit after it.
            if (bubbleActive(model) and model.bubble_render_dirty.any())
                syncBubbleWindow(model, fx);
        },
        .frame_clock => |clock| {
            if (clock.input_timestamp_ns != 0)
                model.last_gpu_input_timestamp_ns = clock.input_timestamp_ns;
            if (!model.sheet_loaded) return;
            if (!model.window_fitted) {
                // First-run onboarding: open settings ONCE when no
                // agent carries petdex hooks. Installing one - or just
                // closing the window - both mean never auto-opening
                // again (agents_prompted persists).
                if (!model.agents_prompted) {
                    var any_hooked = false;
                    for (model.agents) |info| {
                        if (info.status == .node or info.status == .current) any_hooked = true;
                    }
                    if (!any_hooked) model.settings_open = true;
                    model.agents_prompted = true;
                    saveSettings(model);
                }
                // The shell window boots at the slider's max extent;
                // fit it to the drawn sprite so the whole window IS the
                // pet — no invisible band above it eating clicks.
                model.window_fitted = fitWindow(model, fx);
                // Restore the persisted position once, right after the
                // first fit: the fit re-anchors bottom_center, so a
                // move applied before it would be anchored away.
                if (model.window_fitted and !model.pos_restored) {
                    model.pos_restored = true;
                    if (initial_pet_x) |x| {
                        if (initial_pet_y) |y| {
                            if (fx.moveWindow("main", 0, 0, false)) |cur| {
                                _ = fx.moveWindow("main", x - cur.x, y - cur.y, false);
                            }
                        }
                    }
                }
            }
            const now = fx.wallMs();
            if (model.throwing) {
                // Momentum rides the frame clock with the real elapsed
                // time: no timer jitter, friction scaled per frame.
                var dt_ms = now - model.last_physics_ms;
                if (dt_ms <= 0) return;
                if (dt_ms > 50) dt_ms = 50;
                model.last_physics_ms = now;
                model.throw_elapsed_ms += @intCast(dt_ms);
                const dt: f64 = @as(f64, @floatFromInt(dt_ms)) / 1000.0;
                const moved = fx.moveWindow("main", model.vx * dt, model.vy * dt, true);
                if (moved) |result| {
                    if (result.hit_x) model.vx = 0;
                    if (result.hit_y) model.vy = 0;
                    model.pet_x = result.x;
                    model.pet_y = result.y;
                }
                // Before the sync, not after: syncBubbleWindow places the
                // window from bubble_flipped, so a flag left over from
                // where the pet WAS puts the window on the wrong side for
                // the whole arc.
                _ = updateBubbleStackInFlight(model, now);
                syncBubbleWindow(model, fx);
                if (model.vx >= physics_min_vel) {
                    setThrowState(model, .@"running-right", fx);
                } else if (model.vx <= -physics_min_vel) {
                    setThrowState(model, .@"running-left", fx);
                }
                const decay = std.math.pow(f64, physics_friction, dt * 1000.0 / @as(f64, physics_tick_ms));
                model.vx *= decay;
                model.vy *= decay;
                const speed = @sqrt(model.vx * model.vx + model.vy * model.vy);
                if (model.throw_elapsed_ms >= physics_max_duration_ms or speed < physics_min_vel) {
                    model.throwing = false;
                    applyState(model, .waving, 1200, fx);
                    // The throw settled: this is where the pet will sit
                    // until the next gesture, so persist it here rather
                    // than on every physics frame.
                    saveSettings(model);
                }
                return;
            }
            const read = fx.moveWindow("main", 0, 0, false) orelse return;
            const pet_moved = @abs(read.x - model.pet_x) > window_position_epsilon or
                @abs(read.y - model.pet_y) > window_position_epsilon;
            model.pet_x = read.x;
            model.pet_y = read.y;
            // Hover and the fan animation ride here, ahead of the drag
            // branch, which returns early: a stack frozen mid-expansion
            // because the pet was being dragged would be a bug nobody
            // could explain from the code.
            //
            // The throw branch above cannot reach this: it returns before
            // the cursor is polled, because it drives its own movement
            // from the velocity rather than from a cursor sample. It runs
            // updateBubbleStackInFlight instead, which does the half that
            // needs no cursor.
            const bubble_changed = updateBubbleStack(model, read.cursor_x, read.cursor_y, now, fx);
            if (pet_moved or bubble_changed) syncBubbleWindow(model, fx);
            if (model.dragging) {
                if (read.primary_down) {
                    // Follow the cursor keeping the grab offset, and
                    // record OUR OWN applied positions: the app drives
                    // the drag, so it has perfect knowledge of the
                    // gesture, no host telemetry involved.
                    const dx = (read.cursor_x - model.grab_dx) - read.x;
                    const dy = (read.cursor_y - model.grab_dy) - read.y;
                    if (dx != 0 or dy != 0) {
                        if (fx.moveWindow("main", dx, dy, false)) |moved| {
                            model.pet_x = moved.x;
                            model.pet_y = moved.y;
                            pushSample(model, moved.x, moved.y, now);
                        }
                    } else {
                        pushSample(model, read.x, read.y, now);
                    }
                    // Mid-drag animation: the pet runs toward where it
                    // is being pulled, from the same 100ms velocity
                    // tail the release uses (per-frame dx flaps).
                    if (releaseVelocity(model)) |vel| {
                        if (vel.x >= physics_min_vel) {
                            setThrowState(model, .@"running-right", fx);
                        } else if (vel.x <= -physics_min_vel) {
                            setThrowState(model, .@"running-left", fx);
                        } else if (@abs(vel.x) < 20 and @abs(vel.y) < 20) {
                            setThrowState(model, .idle, fx);
                        }
                    }
                    // The main window has moved since the frame-clock read
                    // above. Re-anchor the bubble immediately so a drag
                    // across displays does not leave it one frame behind.
                    syncBubbleWindow(model, fx);
                    return;
                }
                // Release: velocity from our own 100ms sample tail,
                // the WebView renderer's computeVelocity semantics.
                model.dragging = false;
                // A tap, not a drag: the window never left the press
                // point and the button came back up quickly. Until now
                // a plain left-click did nothing at all — the pet gets
                // patted and reacts, alternating so it doesn't feel
                // canned (#557's "pet" interaction).
                if (isTap(now - model.press_ms, read.x - model.press_x, read.y - model.press_y)) {
                    model.sample_len = 0;
                    if (frontBubble(model)) |bubble| {
                        const focused = if (env_home) |home| plat.activateHerdrPane(home, bubble.herdrPaneSlice()) else false;
                        if (!focused) _ = plat.activateOriginApplication(bubble.origin_app, bubble.ttySlice(), bubble.cwdSlice());
                    }
                    model.pat_flip = !model.pat_flip;
                    applyState(model, if (model.pat_flip) .jumping else .waving, pat_react_ms, fx);
                    return;
                }
                const velocity = releaseVelocity(model) orelse {
                    model.sample_len = 0;
                    saveSettings(model);
                    return;
                };
                model.sample_len = 0;
                if (@abs(velocity.x) < 1 and @abs(velocity.y) < 1) {
                    // A plain drop (no throw): the pet rests here.
                    saveSettings(model);
                    return;
                }
                model.throwing = true;
                model.vx = velocity.x;
                model.vy = velocity.y;
                model.throw_elapsed_ms = 0;
                model.last_physics_ms = now;
                return;
            }
            const pet_w = frame_w * model.scale;
            const pet_h = frame_h * model.scale;
            const pet_x = if (builtin.target.os.tag == .linux)
                read.x + (@as(f64, win_w) - pet_w) / 2.0
            else
                read.x;
            const pet_y = if (builtin.target.os.tag == .linux)
                read.y + @as(f64, win_h - pet_edge_pad) - pet_h
            else
                read.y;
            const inside = read.cursor_x >= pet_x and read.cursor_x <= pet_x + pet_w and
                read.cursor_y >= pet_y and read.cursor_y <= pet_y + pet_h;
            if (read.primary_down and !model.primary_was_down and inside) {
                model.dragging = true;
                model.grab_dx = read.cursor_x - read.x;
                model.grab_dy = read.cursor_y - read.y;
                model.press_x = read.x;
                model.press_y = read.y;
                model.press_ms = now;
                model.sample_len = 0;
                pushSample(model, read.x, read.y, now);
            }
            model.primary_was_down = read.primary_down;
        },
        .poll_tick => |timer| {
            if (timer.outcome != .fired) return;
            // Re-arm only after collecting this pass.  A one-shot keeps the
            // selected cadence adaptive and, unlike a repeating timer, cannot
            // keep rebuilding the retained canvas while the app is settled.
            defer armPollTimer(model, fx);
            if (plat.pollBubbleNativeControl()) |control| {
                const control_msg: ?Msg = switch (control.action) {
                    .toggle_visibility => .toggle_bubble_visibility,
                    .open => if (bubbleSlotForVisualIdentity(model, control.identity)) |slot| Msg{ .focus_bubble = slot } else null,
                    .pin => if (bubbleSlotForVisualIdentity(model, control.identity)) |slot| Msg{ .toggle_bubble_pin = slot } else null,
                    .subagents => if (bubbleSlotForVisualIdentity(model, control.identity)) |slot| Msg{ .toggle_subagent_details = slot } else null,
                    .dismiss => if (bubbleSlotForVisualIdentity(model, control.identity)) |slot| Msg{ .dismiss_bubble = slot } else null,
                };
                if (control_msg) |action| update(model, action, fx);
            }
            // Card bodies have their own nonactivating native panels. Drain
            // the bounded gesture queue before feed work so clicks open the
            // owning session and drag lifecycle events reconcile promptly.
            var native_card_events: usize = 0;
            while (native_card_events < 32) : (native_card_events += 1) {
                const card_event = plat.pollBubbleNativeCardEvent() orelse break;
                const card_msg: ?Msg = switch (card_event.action) {
                    .activate => if (bubbleSlotForVisualIdentity(model, card_event.identity)) |slot| Msg{ .focus_bubble = slot } else null,
                    .drag_started => Msg{ .native_drag_started = null },
                    .drag_ended => .native_drag_ended,
                };
                if (card_msg) |action| update(model, action, fx);
            }
            // Ahead of the sheet guard on purpose: a machine with no pet
            // installed has no sheet, and that is precisely when a
            // `petdex://<slug>` link has work to do.
            drainPendingInstall(model, fx);
            if (!model.sheet_loaded) return;
            if (model.settings_open and thumbs_built < catalog_mod.catalog_len) buildNextThumb(fx);
            const now = fx.wallMs();
            var bubble_sync_needed = false;
            // The provider-neutral background registry follows Codex and the
            // other local agent stores; the UI tick only drains the mailbox.
            syncStoredSessionTitles(model, now);
            const stale_suppressed = hook_server.mailbox.suppressStaleRunning(now, bubble_stale_running_grace_ms);
            if (stale_suppressed > 0) {
                model.bubble_render_stats.stale_running_suppressions += stale_suppressed;
                invalidateBubblePresentation(model, .{ .content = true });
                bubble_sync_needed = true;
            }
            var drained: [hook_server.max_bubbles]hook_server.Bubble = undefined;
            if (hook_server.mailbox.takeBubbles(&drained)) |raw_count| {
                if (model.settings_open) {
                    for (drained[0..raw_count]) |bubble| {
                        if (std.mem.eql(u8, bubble.agent[0..bubble.agent_len], "dsh")) {
                            if (env_home) |home| model.agents = agent_hooks.scan(boot_allocator, home);
                            break;
                        }
                    }
                }
                bubble_sync_needed = true;
                var urgent = false;
                for (drained[0..raw_count]) |bubble| {
                    if (bubble.status == .needs_input or bubble.status == .failed) urgent = true;
                }
                invalidateBubblePresentation(model, .{ .content = true, .urgent = urgent });
                if (!model.bubbles_enabled or model.focus_mode) {
                    clearBubble(model);
                } else {
                    const visible_count = filterDismissedBubbles(model, &drained, raw_count);
                    // With per-conversation bubbles off, every session
                    // folds into one slot before the model ever sees the
                    // set, so the rest of the pipeline (deadlines, view,
                    // hover) runs the single-bubble path unchanged.
                    const count = if (model.bubbles_per_conversation) blk: {
                        // Mailbox slots retain first-seen session order while
                        // updates happen in place. The renderer treats the
                        // final slot as the front card, so sort by the
                        // monotonic event counter before copying the stack.
                        sortBubblesByCounter(drained[0..visible_count]);
                        break :blk visible_count;
                    } else collapseToNewest(&drained, visible_count);
                    // Deadlines are matched against the outgoing stack,
                    // so the copy has to happen before it is overwritten.
                    const previous = model.bubbles;
                    const previous_deadlines = model.bubble_expires_at_ms;
                    const previous_len = model.bubbles_len;
                    @memcpy(model.bubbles[0..count], drained[0..count]);
                    for (count..hook_server.max_bubbles) |i| model.bubbles[i] = .{};
                    model.bubbles_len = count;
                    if (count == 0) {
                        model.bubble_group_visible = false;
                        model.bubble_show_recent_only = false;
                        model.bubble_group_manually_closed = false;
                        model.bubble_expansion = 0;
                        model.bubble_expansion_target = 0;
                        model.bubble_expansion_velocity = 0;
                        model.bubble_fold_phase = .folded;
                    } else if (previous_len == 0) {
                        // The first tracked session opens the disclosure for
                        // this non-empty group. Later events respect a manual
                        // close and only update its count/tint.
                        model.bubble_group_visible = true;
                        model.bubble_show_recent_only = false;
                        model.bubble_group_manually_closed = false;
                        model.bubble_expansion_target = 1;
                        model.bubble_fold_phase = .materializing;
                        invalidateBubblePresentation(model, .{ .urgent = true });
                    } else {
                        model.bubble_expansion_target = if (model.bubble_group_visible) 1 else 0;
                    }
                    syncBubbleDeadlines(model, previous[0..previous_len], previous_deadlines[0..previous_len], now);
                    applyBubblePresentationOrder(model);
                    retargetBubbleGroupSizeSpring(model);
                    if (frontBubble(model)) |newest| {
                        loadAgentAvatar(newest.agent[0..newest.agent_len], model.dark, fx);
                    }
                    // The stacked cards read their logos out of the
                    // shared strip, which until now only settings ever
                    // loaded. A second conversation must not have to
                    // wait for the settings window to get its avatar.
                    if (model.bubbles_len > 1) loadAgentsAtlas(model.dark, fx);
                }
            }
            if (expireBubbles(model, now)) {
                retargetBubbleGroupSizeSpring(model);
                invalidateBubblePresentation(model, .{ .content = true, .urgent = true });
                bubble_sync_needed = true;
            }
            // The activity window is click-through, so its hover cannot wake
            // the main Metal surface. Poll only the authoritative card
            // geometry at this coarse cadence; once hover changes a dedicated
            // 16 ms one-shot timer carries the short spring to rest.
            if (fx.moveWindow("main", 0, 0, false)) |read| {
                const pet_moved = @abs(read.x - model.pet_x) > window_position_epsilon or
                    @abs(read.y - model.pet_y) > window_position_epsilon;
                model.pet_x = read.x;
                model.pet_y = read.y;
                if (pet_moved) invalidateBubblePresentation(model, .{ .geometry = true });
                bubble_sync_needed = updateBubbleStack(model, read.cursor_x, read.cursor_y, now, fx) or
                    bubble_sync_needed or pet_moved;
            }
            // Keep this 100 ms poll deliberately lightweight: it gathers
            // feed and pointer state, then leaves layout/window/AppKit work
            // to the coalesced one-shot presentation scheduler above.
            if (!bubbleActive(model) and bubble_sync_needed) {
                plat.clearBubbleNativePresentation();
            }
            if (model.waiting_sound and shouldEscalate(model.state, model.waiting_since_ms, model.waiting_escalated, now)) {
                model.waiting_escalated = true;
                playWaitingChime(fx);
            }
            // Daily rotation: fires on the first tick of a new
            // epoch-day (boot included, so an app that slept through
            // midnight — or was closed — still rotates when it next
            // runs). select_pet inside advancePet stamps today and
            // persists, closing the loop.
            if (model.rotate_pets and model.rotation_day != dayFromWallMs(now)) {
                model.rotation_day = dayFromWallMs(now);
                advancePet(model, fx);
            }
            const dwell_over = now - model.shown_at_ms >= model.shown_dwell_ms;
            if (!dwell_over) return;
            if (hook_server.mailbox.pop()) |event| {
                const next_state = std.meta.stringToEnum(State, event.slice()) orelse return;
                if (next_state != model.state or isDurationState(next_state)) {
                    applyState(model, next_state, event.duration_ms, fx);
                } else {
                    model.shown_at_ms = now;
                    model.shown_dwell_ms = dwellFor(next_state, event.duration_ms);
                }
            } else if (isDurationState(model.state)) {
                applyState(model, .idle, 0, fx);
            }
        },
    }
}

pub fn onKey(keyboard: canvas.WidgetKeyboardEvent) ?Msg {
    if (keyboard.modifiers.hasNavigationModifier() or keyboard.modifiers.shift) return null;
    if (std.ascii.eqlIgnoreCase(keyboard.key, "space")) return .cycle_state;
    return null;
}

pub fn onFrame(model: *const Model, frame: native_sdk.platform.GpuFrame) ?Msg {
    if (!model.sheet_loaded) return null;
    const fresh_input = frame.input_timestamp_ns != 0 and
        frame.input_timestamp_ns != model.last_gpu_input_timestamp_ns;
    // Returning null is the SDK's idle law: no message means no rebuild and
    // the retained frame channel starves on its own. Window motion still uses
    // presented-frame pacing, while the first pointer event wakes one frame
    // through its persistent input timestamp.
    if (model.window_fitted and !model.dragging and !model.throwing and !fresh_input)
        return null;
    return .{ .frame_clock = .{ .input_timestamp_ns = frame.input_timestamp_ns } };
}

fn parseNativeBubbleCommand(name: []const u8) ?NativeBubbleCommand {
    const routes = [_]struct { prefix: []const u8, action: NativeBubbleCommandAction }{
        .{ .prefix = "petdex.bubble.control.toggle.", .action = .toggle },
        .{ .prefix = "petdex.bubble.control.open.", .action = .open },
        .{ .prefix = "petdex.bubble.control.pin.", .action = .pin },
        .{ .prefix = "petdex.bubble.control.subagents.", .action = .subagents },
        .{ .prefix = "petdex.bubble.control.dismiss.", .action = .dismiss },
        .{ .prefix = "petdex.bubble.card.activate.", .action = .activate },
        .{ .prefix = "petdex.bubble.card.drag-started.", .action = .drag_started },
        .{ .prefix = "petdex.bubble.card.drag-ended.", .action = .drag_ended },
    };
    for (routes) |route| {
        if (!std.mem.startsWith(u8, name, route.prefix)) continue;
        const identity_text = name[route.prefix.len..];
        if (identity_text.len != 16) return null;
        const identity = std.fmt.parseInt(u64, identity_text, 16) catch return null;
        return .{ .action = route.action, .identity = identity };
    }
    return null;
}

test "Windows native bubble commands preserve the existing action set" {
    const pin = parseNativeBubbleCommand("petdex.bubble.control.pin.fedcba9876543210").?;
    try std.testing.expectEqual(NativeBubbleCommandAction.pin, pin.action);
    try std.testing.expectEqual(@as(u64, 0xfedc_ba98_7654_3210), pin.identity);
    const drag = parseNativeBubbleCommand("petdex.bubble.card.drag-ended.000000000000002a").?;
    try std.testing.expectEqual(NativeBubbleCommandAction.drag_ended, drag.action);
    try std.testing.expectEqual(@as(u64, 42), drag.identity);
    try std.testing.expect(parseNativeBubbleCommand("petdex.bubble.control.stop.000000000000002a") == null);
    try std.testing.expect(parseNativeBubbleCommand("petdex.bubble.control.pin.not-an-identity") == null);
}

pub fn onCommand(name: []const u8) ?Msg {
    if (parseNativeBubbleCommand(name)) |command| return .{ .native_bubble_command = command };
    if (std.mem.eql(u8, name, "petdex.cycle")) return .cycle_state;
    if (std.mem.eql(u8, name, "petdex.settings")) return .open_settings;
    if (std.mem.eql(u8, name, "petdex.close")) return .close_pet;
    if (builtin.target.os.tag == .linux and std.mem.eql(u8, name, "native-sdk.window-drag.begin"))
        return .{ .native_drag_started = null };
    if (builtin.target.os.tag == .linux and std.mem.eql(u8, name, "native-sdk.window-drag.begin-left"))
        return .{ .native_drag_started = .@"running-left" };
    if (builtin.target.os.tag == .linux and std.mem.eql(u8, name, "native-sdk.window-drag.begin-right"))
        return .{ .native_drag_started = .@"running-right" };
    if (builtin.target.os.tag == .linux and std.mem.eql(u8, name, "native-sdk.window-drag.end")) return .native_drag_ended;
    if (std.mem.eql(u8, name, "petdex.quit")) return .quit_app;
    if (std.mem.eql(u8, name, "petdex.focus")) return .toggle_focus_mode;
    if (std.mem.eql(u8, name, "petdex.shuffle")) return .shuffle_pet;
    return null;
}

// ------------------------------------------------------------------- view

pub const AppUi = canvas.Ui(Msg);

const pet_menu = [_]AppUi.ContextMenuItem{
    .{ .label = "Open Settings", .msg = .open_settings },
    .{ .label = "Close Pet", .msg = .close_pet },
};

// The visible card remains intrinsic and grows only with the text it actually
// contains. These values size the surrounding transparent canvas generously
// enough for the configured maximum; one full em per character also covers
// CJK glyphs, unlike the previous 0.62 Latin-average estimate.
const bubble_columns_default: u16 = 40;
pub const bubble_columns_min: u16 = 8;
pub const bubble_columns_max: u16 = 120;
const bubble_answer_lines_default: u8 = 3;
pub const bubble_answer_lines_min: u8 = 1;
pub const bubble_answer_lines_max: u8 = 8;
/// The primary activity band is a compact two-line preview. The persisted
/// preference remains readable for backward compatibility, but cards never
/// let prose displace the title/status/nested hierarchy beyond two lines.
const bubble_message_lines_max: usize = 2;
const bubble_nested_rows_max: usize = 2;
const bubble_agent_icon_width: f32 = 12;
const bubble_content_gap: f32 = 5;
const bubble_card_padding: f32 = 8;
const bubble_card_radius: f32 = 14;
const bubble_head_gap: f32 = 8;
const bubble_line_gap: f32 = 3;
/// Vertical breathing room between stacked conversation cards.
const bubble_stack_gap: f32 = 7;
const bubble_lane_gap: f32 = 10;
const bubble_canvas_margin: f32 = 12;
const bubble_disclosure_size: f32 = 30;
const bubble_disclosure_gap: f32 = 6;
const bubble_control_size: f32 = 28;
const bubble_control_gap: f32 = 4;
const bubble_control_activation_inset: f32 = 6;
/// The visible control remains 30pt while its nonactivating AppKit panel
/// supplies the standard 44pt pointer target.
const bubble_disclosure_activation_inset: f32 = 7;
const bubble_control_fade_lead: f32 = 28;
const bubble_disclosure_morph_segment_ms: i64 = 2200;
const bubble_disclosure_morph_fade_ms: i64 = 240;

/// Hover has to persist this long before the stack fans out, so a
/// cursor crossing the bubble on its way elsewhere does not open it.
const bubble_hover_delay_ms: i64 = 150;
/// A short grace prevents accidental folds while crossing between cards.
const bubble_hover_exit_grace_ms: i64 = 120;
const bubble_completion_settle_ms: i64 = 650;
/// Expansion and hover use critically damped-ish springs on the frame clock,
/// sharing the same bounded integration approach as the throw physics.
const bubble_spring_stiffness: f32 = 230;
const bubble_spring_damping: f32 = 19;
/// Extra headroom required to flip back ABOVE the pet once the stack has
/// flipped below it. Without it a pet parked exactly on the threshold
/// flips every frame.
const bubble_flip_hysteresis: f64 = 40;
/// Minimum screen-space separation between the bubble window and the pet.
/// Keep this outside the window so transparent canvas margins cannot make
/// the visible bubble appear to overlap the sprite on any flip direction.
const bubble_pet_clearance: f64 = 6;

const bubble_lifetime_default_secs: f32 = 0;
const bubble_lifetime_min_secs: f32 = 0;
const bubble_lifetime_max_secs: f32 = 60;

fn clampBubbleLifetime(value: f32) f32 {
    if (!std.math.isFinite(value)) return bubble_lifetime_default_secs;
    return std.math.clamp(@round(value), bubble_lifetime_min_secs, bubble_lifetime_max_secs);
}

fn bubbleDeadlineMs(now_ms: i64, lifetime_secs: f32) i64 {
    const seconds = clampBubbleLifetime(lifetime_secs);
    return if (seconds == 0) -1 else now_ms + @as(i64, @intFromFloat(seconds * 1000));
}

fn bubbleExpiryMs(now_ms: i64, lifetime_secs: f32, busy: bool) i64 {
    return if (busy) -1 else bubbleDeadlineMs(now_ms, lifetime_secs);
}

fn sessionStatusKeepsAlive(status: hook_server.SessionStatus) bool {
    return status == .running or status == .needs_input;
}

fn bubbleKeepsAlive(bubble: *const hook_server.Bubble) bool {
    return bubble.busy or sessionStatusKeepsAlive(bubble.status);
}

fn bubbleLifetimeExpired(deadline_ms: i64, now_ms: i64, state: State) bool {
    return state != .waiting and deadline_ms >= 0 and now_ms >= deadline_ms;
}

fn agentDisplayName(agent: []const u8) []const u8 {
    if (std.ascii.eqlIgnoreCase(agent, "claude-code")) return "Claude";
    if (std.ascii.eqlIgnoreCase(agent, "codex")) return "Codex";
    if (std.ascii.eqlIgnoreCase(agent, "gemini")) return "Gemini";
    if (std.ascii.eqlIgnoreCase(agent, "opencode")) return "OpenCode";
    if (std.ascii.eqlIgnoreCase(agent, "qoder")) return "Qoder";
    if (std.ascii.eqlIgnoreCase(agent, "kimi-code")) return "Kimi";
    if (std.ascii.eqlIgnoreCase(agent, "codebuddy")) return "CodeBuddy";
    if (std.ascii.eqlIgnoreCase(agent, "omp")) return "OMP";
    if (std.ascii.eqlIgnoreCase(agent, "hermes")) return "Hermes";
    return if (agent.len > 0) agent else "Agent";
}

fn agentLineIcon(agent: []const u8) []const u8 {
    if (std.ascii.eqlIgnoreCase(agent, "codex")) return "app:bubble-codex";
    if (std.ascii.eqlIgnoreCase(agent, "hermes")) return "app:bubble-hermes";
    if (std.ascii.eqlIgnoreCase(agent, "claude-code")) return "app:bubble-claude";
    if (std.ascii.eqlIgnoreCase(agent, "gemini")) return "app:bubble-gemini";
    if (std.ascii.eqlIgnoreCase(agent, "opencode")) return "app:bubble-code";
    return "app:bubble-terminal";
}

fn bubbleHostname(bubble: *const hook_server.Bubble) []const u8 {
    if (!bubble.remote) return "local";
    const hostname = bubble.hostnameSlice();
    return if (hostname.len > 0) hostname else "remote";
}

fn bubbleProjectName(bubble: *const hook_server.Bubble) []const u8 {
    const cwd = std.mem.trimEnd(u8, bubble.cwdSlice(), "/\\");
    if (cwd.len == 0) return "";
    const slash = std.mem.lastIndexOfAny(u8, cwd, "/\\") orelse return cwd;
    return if (slash + 1 < cwd.len) cwd[slash + 1 ..] else "";
}

const BubbleContrastPalette = struct {
    title: canvas.Color,
    message: canvas.Color,
    metadata: canvas.Color,
};

/// Canvas text sits above AppKit glass rather than inside its vibrancy tree,
/// so it needs an explicit contrast ladder. These colors pair with the
/// theme-opposite neutral glass tint in `plat.zig` and remain legible when the
/// activity panel recedes behind the focused application.
fn bubbleContrastPalette(model: *const Model) BubbleContrastPalette {
    if (model.high_contrast) return if (model.dark)
        .{
            .title = canvas.Color.rgb8(255, 255, 255),
            .message = canvas.Color.rgb8(245, 246, 249),
            .metadata = canvas.Color.rgb8(222, 225, 232),
        }
    else
        .{
            .title = canvas.Color.rgb8(0, 0, 0),
            .message = canvas.Color.rgb8(20, 22, 28),
            .metadata = canvas.Color.rgb8(48, 52, 62),
        };
    return if (model.dark)
        .{
            .title = canvas.Color.rgb8(250, 250, 252),
            .message = canvas.Color.rgb8(226, 228, 234),
            .metadata = canvas.Color.rgb8(194, 198, 208),
        }
    else
        .{
            .title = canvas.Color.rgb8(10, 11, 14),
            .message = canvas.Color.rgb8(42, 45, 54),
            .metadata = canvas.Color.rgb8(78, 83, 96),
        };
}

fn bubbleMessageColor(model: *const Model) canvas.Color {
    return bubbleContrastPalette(model).message;
}

fn bubbleFallbackSurface(model: *const Model, bubble: *const hook_server.Bubble, hover: f32) canvas.Color {
    const base_alpha: f32 = if (model.dark) 194.0 else 214.0;
    const alpha: u8 = @intFromFloat(@round(@min(@as(f32, 236.0), base_alpha + hover * 18.0)));
    return if (model.dark) switch (bubble.status) {
        .failed => canvas.Color.rgba8(49, 18, 20, alpha),
        .needs_input => canvas.Color.rgba8(49, 34, 15, alpha),
        .running => canvas.Color.rgba8(20, 29, 49, alpha),
        .completed => canvas.Color.rgba8(17, 39, 27, alpha),
        .idle => canvas.Color.rgba8(17, 19, 25, alpha),
    } else switch (bubble.status) {
        .failed => canvas.Color.rgba8(255, 235, 235, alpha),
        .needs_input => canvas.Color.rgba8(255, 244, 223, alpha),
        .running => canvas.Color.rgba8(233, 241, 255, alpha),
        .completed => canvas.Color.rgba8(231, 248, 237, alpha),
        .idle => canvas.Color.rgba8(250, 251, 253, alpha),
    };
}

/// Linux uses the portable panel/icon/button implementation directly. Keep
/// its material deterministic and compositor-friendly instead of asking GTK
/// to emulate the AppKit Liquid Glass treatment. Windows retains the existing
/// portable blur until its layered-window presentation is evaluated separately.
fn bubblePortableBackdropBlur(os: std.Target.Os.Tag) f32 {
    return if (os == .linux) 0 else 14;
}

fn bubblePortableUsesLayoutSpacers(os: std.Target.Os.Tag) bool {
    return os == .linux;
}

const bubble_shimmer_span_max: usize = 24;

/// Build one paragraph's non-overlapping glyph runs. Busy text keeps the
/// dim paragraph foreground, while a broad horizontal sweep of runs references the
/// theme's bright text token and travels left-to-right. Unlike the removed
/// clipped overlay, every byte appears exactly once in the paragraph.
fn bubbleMessageSpans(
    line: []const u8,
    scale: f32,
    model: *const Model,
    busy: bool,
    out: *[bubble_shimmer_span_max]canvas.TextSpan,
) []const canvas.TextSpan {
    if (!busy or model.reduce_motion or line.len == 0) {
        out[0] = .{ .text = line, .scale = scale };
        return out[0..1];
    }

    const display_chars = charCount(line);
    const wanted = @min(display_chars, bubble_shimmer_span_max);
    const chars_per_span = @max(@as(usize, 1), (display_chars + wanted - 1) / wanted);
    var start: usize = 0;
    var count: usize = 0;
    while (start < line.len and count < bubble_shimmer_span_max) : (count += 1) {
        var end = start;
        var chars: usize = 0;
        while (end < line.len and chars < chars_per_span) : (chars += 1) {
            end += 1;
            while (end < line.len and (line[end] & 0xC0) == 0x80) end += 1;
        }
        out[count] = .{ .text = line[start..end], .scale = scale };
        start = end;
    }

    const band = std.math.clamp(model.bubble_shimmer_phase, 0, 1) *
        (@as(f32, @floatFromInt(count)) + 2) - 1;
    // Match the native mask's broader left-to-right light band. The minimum
    // keeps short messages readable while longer lines receive roughly 30%
    // of their width as a soft moving highlight.
    const half_width = @max(0.85, @min(3.5, @as(f32, @floatFromInt(count)) * 0.15));
    for (out[0..count], 0..) |*span, i| {
        const center = @as(f32, @floatFromInt(i)) + 0.5;
        if (@abs(center - band) < half_width) span.color = .text;
    }
    return out[0..count];
}

fn bubbleContentReveal(model: *const Model, slot: usize) f32 {
    if (!bubbleCardPresented(model, slot)) return 0;
    return switch (model.bubble_fold_phase) {
        .folded, .materializing, .collapsing => 0,
        .unfolding => std.math.clamp((bubbleExpansionEased(model) - 0.94) / 0.05, 0, 1),
        .unfolded => 1,
    };
}

/// The AppKit presentation deliberately materializes glass before revealing
/// its text. Linux has no native material hierarchy to coordinate with, so its
/// portable panel content is present as soon as the model says the card is
/// visible. Windows keeps the existing animated presentation until its native
/// host is evaluated independently.
fn bubbleContentRevealForPlatform(model: *const Model, slot: usize, os: std.Target.Os.Tag) f32 {
    if (os == .linux) {
        if (!model.bubble_group_visible or slot >= model.bubbles_len) return 0;
        if (model.bubble_show_recent_only and slot != bubbleMostRecentActiveSlot(model)) return 0;
        return 1;
    }
    return bubbleContentReveal(model, slot);
}

fn bubbleMessageFontSize(model: *const Model) f32 {
    // The preference keeps its durable 8…20 value range, while message
    // typography follows the intentionally non-linear visual range.  The
    // midpoint is the current 50%-larger default; the minimum restores the
    // compact pre-increase bubble people used for dense session stacks.
    const base = bubbleFontSize(model);
    if (base <= bubble_text_default_px) {
        const progress = (base - bubble_text_min_px) /
            (bubble_text_default_px - bubble_text_min_px);
        return 9.5 + progress * (21.75 - 9.5);
    }
    const progress = (base - bubble_text_default_px) /
        (bubble_text_max_px - bubble_text_default_px);
    return 21.75 + progress * (32.25 - 21.75);
}

fn bubbleTitleFontSize(model: *const Model) f32 {
    return bubbleMessageFontSize(model) + 2;
}

fn bubbleMaxCardWidth(model: *const Model) f32 {
    const text_capacity = @as(f32, @floatFromInt(model.bubble_columns)) * bubbleFontSize(model);
    return std.math.clamp(@ceil(text_capacity + 120 + bubble_card_padding * 2), 220, 460);
}

fn bubbleMaxCardHeight(model: *const Model) f32 {
    const rows: f32 = @floatFromInt(bubble_message_lines_max);
    const body_line_height = bubbleMessageFontSize(model) * 1.25;
    const body = rows * body_line_height + @max(0, rows - 1) * bubble_line_gap;
    const nested_line_height = bubbleHeaderTextSize(model) * 1.25;
    const nested = 3 * nested_line_height + 2 * bubble_line_gap;
    return @ceil(bubbleMetadataHeight(model) + bubble_line_gap + bubbleTitleHeight(model) + bubble_line_gap + body + bubble_line_gap + nested + bubble_card_padding * 2);
}

fn bubbleHeaderTextSize(model: *const Model) f32 {
    return bubbleFontSize(model) + 1.5;
}

fn bubbleMetadataHeight(model: *const Model) f32 {
    return @ceil(bubbleHeaderTextSize(model) * 1.25);
}

fn bubbleTitleHeight(model: *const Model) f32 {
    return bubbleTitleFontSize(model) * 1.25;
}

/// The one authoritative layout record for a card. Every band has an explicit
/// top and height, and every geometry consumer starts from `card_width` and
/// `card_height`; this prevents the renderer, companion window, hover region
/// and AppKit material from drifting into four subtly different estimates.
const BubbleLayoutMetrics = struct {
    title_text: []const u8,
    message_lines: [bubble_message_lines_max][]const u8,
    metadata_y: f32,
    metadata_height: f32,
    metadata_left_x: f32,
    metadata_left_width: f32,
    title_y: f32,
    title_height: f32,
    message_y: f32,
    message_line_height: f32,
    message_line_count: usize,
    status_slot_width: f32,
    title_text_width: f32,
    nested_y: f32,
    nested_line_height: f32,
    nested_line_count: usize,
    nested_message_count: usize,
    nested_overflow_count: usize,
    nested_reveal: f32,
    content_width: f32,
    content_height: f32,
    inner_width: f32,
    card_width: f32,
    card_height: f32,
};

const BubbleMetadataLayout = struct {
    left_x: f32 = 0,
    left_width: f32 = 0,
};

/// Metadata is one attributed line: `Agent · Host · Project`. Keeping it in
/// one measured clipping band gives short values the whole available width and
/// avoids AppKit independently truncating a project cell before it needs to.
fn bubbleMetadataLayout(model: *const Model, bubble: *const hook_server.Bubble, inner_width: f32) BubbleMetadataLayout {
    _ = model;
    _ = bubble;
    return .{ .left_width = @max(1, inner_width) };
}

fn bubbleMetadataReveal(model: *const Model, slot: usize) f32 {
    // Metadata is part of the resting card geometry. Hover owns controls only;
    // tying this band to the hover spring made the title/message bands move
    // independently from their presentation frames.
    return if (slot < model.bubbles_len) 1 else 0;
}

fn bubbleNestedRevealAt(model: *const Model, bubble: *const hook_server.Bubble, metadata_reveal: f32) f32 {
    _ = metadata_reveal;
    if (bubble.child_messages_len == 0) return 0;
    if (bubbleSubagentsPinned(model, bubble)) return 1;
    // Nested content remains an explicit disclosure. It must not appear or
    // affect card height merely because the pointer crossed the card.
    return 0;
}

fn bubbleHasStatusBadge(bubble: *const hook_server.Bubble) bool {
    return bubble.status == .completed or bubble.status == .needs_input or bubble.status == .failed;
}

/// Collapse arbitrary feed whitespace without imposing a character budget.
/// Width is a font-metric concern below; clipping here was the source of the
/// premature 40-character wrap visible in the screenshots.
fn normalizeDisplayText(text: []const u8, scratch: []u8) []const u8 {
    if (scratch.len == 0) return "";
    var write: usize = 0;
    var pending_space = false;
    for (text) |byte| {
        if (isDisplayWhitespace(byte)) {
            pending_space = write > 0;
            continue;
        }
        if (pending_space) {
            if (write == scratch.len) break;
            scratch[write] = ' ';
            write += 1;
            pending_space = false;
        }
        if (write == scratch.len) break;
        scratch[write] = byte;
        write += 1;
    }
    // A bounded scratch buffer can end after the first byte of a multi-byte
    // sequence. Back up until the returned slice is valid UTF-8.
    while (write > 0 and !std.unicode.utf8ValidateSlice(scratch[0..write])) write -= 1;
    return scratch[0..write];
}

fn nextUtf8Boundary(text: []const u8, index: usize) usize {
    var next = @min(index + 1, text.len);
    while (next < text.len and (text[next] & 0xC0) == 0x80) next += 1;
    return next;
}

const MeasuredLineBreak = struct {
    line_end: usize,
    consume_end: usize,
};

/// Find the longest UTF-8 prefix that fits, preferring a word boundary. A
/// single over-wide glyph is still consumed so wrapping always makes progress.
fn measuredLineBreak(text: []const u8, width: f32, measure: anytype, font: anytype, size: f32) MeasuredLineBreak {
    var index: usize = 0;
    var hard_end: usize = 0;
    var last_space: ?usize = null;
    while (index < text.len) {
        const next = nextUtf8Boundary(text, index);
        if (canvas.measureTextWidthForFont(measure, font, text[0..next], size) > width) break;
        hard_end = next;
        if (text[index] == ' ') last_space = index;
        index = next;
    }
    if (hard_end == 0 and text.len > 0) hard_end = nextUtf8Boundary(text, 0);
    if (last_space) |space| {
        if (space > 0 and space < hard_end) return .{ .line_end = space, .consume_end = space + 1 };
    }
    return .{ .line_end = hard_end, .consume_end = hard_end };
}

/// Produce the exact two line slices consumed by both measurement and paint.
/// Only the final visible line is ellipsized when prose remains.
fn wrapMeasuredMessage(
    text: []const u8,
    width: f32,
    measure: anytype,
    font: anytype,
    size: f32,
    scratch: *[bubble_message_lines_max][hook_server.bubble_text_capacity]u8,
) [bubble_message_lines_max][]const u8 {
    var lines: [bubble_message_lines_max][]const u8 = @splat("");
    var remaining = std.mem.trim(u8, text, " ");
    for (0..bubble_message_lines_max) |row| {
        if (remaining.len == 0) break;
        if (row + 1 == bubble_message_lines_max) {
            lines[row] = fitTextToWidth(remaining, width, measure, font, size, &scratch[row]);
            break;
        }
        if (canvas.measureTextWidthForFont(measure, font, remaining, size) <= width) {
            lines[row] = remaining;
            break;
        }
        const cut = measuredLineBreak(remaining, width, measure, font, size);
        const line = std.mem.trim(u8, remaining[0..cut.line_end], " ");
        const n = @min(line.len, scratch[row].len);
        @memcpy(scratch[row][0..n], line[0..n]);
        lines[row] = scratch[row][0..n];
        remaining = std.mem.trim(u8, remaining[cut.consume_end..], " ");
    }
    return lines;
}

fn bubbleLayoutHashMix(hash: *u64, value: u64) void {
    hash.* = (hash.* ^ value) *% 1099511628211;
}

fn bubbleLayoutHashBytes(hash: *u64, value: []const u8) void {
    for (value) |byte| bubbleLayoutHashMix(hash, byte);
    bubbleLayoutHashMix(hash, 0xff);
}

fn bubbleLayoutCacheKey(model: *const Model) u64 {
    var hash: u64 = 1469598103934665603;
    const text_size_bits: u32 = @bitCast(model.bubble_text_px);
    bubbleLayoutHashMix(&hash, model.bubbles_len);
    bubbleLayoutHashMix(&hash, text_size_bits);
    bubbleLayoutHashMix(&hash, model.bubble_columns);
    bubbleLayoutHashMix(&hash, model.bubble_answer_lines);
    for (model.bubbles[0..model.bubbles_len]) |*bubble| {
        bubbleLayoutHashMix(&hash, bubbleVisualIdentity(bubble));
        bubbleLayoutHashBytes(&hash, bubble.title[0..bubble.title_len]);
        bubbleLayoutHashBytes(&hash, bubble.text[0..bubble.text_len]);
        bubbleLayoutHashBytes(&hash, bubble.agent[0..bubble.agent_len]);
        bubbleLayoutHashBytes(&hash, bubble.hostnameSlice());
        bubbleLayoutHashBytes(&hash, bubble.cwdSlice());
        bubbleLayoutHashMix(&hash, @intFromEnum(bubble.status));
        for (bubble.child_messages[0..bubble.child_messages_len]) |*child| {
            bubbleLayoutHashBytes(&hash, child.labelSlice());
            bubbleLayoutHashBytes(&hash, child.textSlice());
        }
    }
    return hash;
}

fn ensureBubbleLayoutCache(model: *Model) void {
    const key = bubbleLayoutCacheKey(model);
    if (model.bubble_layout_cache.valid and model.bubble_layout_cache.key == key) return;
    var width: f32 = 220;
    for (0..model.bubbles_len) |slot| width = @max(width, bubbleNaturalCardWidth(model, slot));
    var next: BubbleLayoutCache = .{ .valid = true, .key = key, .common_width = width };
    for (0..model.bubbles_len) |slot| {
        next.cards[slot] = measureBubbleLayout(model, slot, width);
    }
    model.bubble_layout_cache = next;
    model.bubble_render_stats.layout_rebuilds += 1;
}

/// Width is stable for the whole group and reserves the largest real string.
/// Hover actions are overlays, so they deliberately do not consume text width.
fn bubbleNaturalCardWidth(model: *const Model, slot: usize) f32 {
    const bubble = &model.bubbles[slot];
    const tokens = petdexTokens(model);
    const header_size = bubbleHeaderTextSize(model);
    const agent_font = canvas.textSpanFontId(.{ .text = "", .weight = .medium }, tokens.typography);
    const text_font = canvas.textSpanFontId(.{ .text = "" }, tokens.typography);
    const title = normalizeDisplayText(bubble.title[0..bubble.title_len], &bubble_title_scratch[slot]);
    const message = normalizeDisplayText(bubble.text[0..bubble.text_len], &bubble_text_scratch[slot]);

    const agent = agentDisplayName(bubble.agent[0..bubble.agent_len]);
    const host = bubbleHostname(bubble);
    const project = bubbleProjectName(bubble);
    var metadata_width =
        canvas.measureTextWidthForFont(tokens.text_measure, agent_font, agent, header_size) +
        canvas.measureTextWidthForFont(tokens.text_measure, text_font, " · ", header_size) +
        canvas.measureTextWidthForFont(tokens.text_measure, text_font, host, header_size);
    if (project.len > 0) {
        metadata_width += canvas.measureTextWidthForFont(tokens.text_measure, text_font, " · ", header_size) +
            canvas.measureTextWidthForFont(tokens.text_measure, text_font, project, header_size);
    }

    const status_width: f32 = if (bubbleHasStatusBadge(bubble)) 18 + bubble_content_gap else 0;
    var widest = metadata_width;
    if (title.len > 0) widest = @max(widest, canvas.measureTextWidthForFont(tokens.text_measure, text_font, title, bubbleTitleFontSize(model)) + status_width);
    if (message.len > 0) widest = @max(widest, canvas.measureTextWidthForFont(tokens.text_measure, text_font, message, bubbleMessageFontSize(model)));
    for (bubble.child_messages[0..bubble.child_messages_len]) |*child| {
        const child_width = bubble_agent_icon_width + bubble_content_gap +
            canvas.measureTextWidthForFont(tokens.text_measure, text_font, child.labelSlice(), header_size) +
            canvas.measureTextWidthForFont(tokens.text_measure, text_font, " · ", header_size) +
            canvas.measureTextWidthForFont(tokens.text_measure, text_font, child.textSlice(), header_size);
        widest = @max(widest, child_width);
    }
    return std.math.clamp(@ceil(widest + bubble_card_padding * 2), 220, bubbleMaxCardWidth(model));
}

fn bubbleCommonCardWidth(model: *const Model) f32 {
    if (model.bubble_layout_cache.valid) return model.bubble_layout_cache.common_width;
    var width: f32 = 220;
    for (0..model.bubbles_len) |slot| width = @max(width, bubbleNaturalCardWidth(model, slot));
    return width;
}

/// Measure exactly the strings and fixed controls that `bubbleCard` paints.
/// This is intentionally called only while rebuilding `BubbleLayoutCache`.
/// Pointer polls and spring frames consume the retained result below.
fn measureBubbleLayout(model: *const Model, slot: usize, card_width: f32) BubbleMeasuredLayout {
    const bubble = &model.bubbles[slot];
    const tokens = petdexTokens(model);
    const header_size = bubbleHeaderTextSize(model);
    const text_font = canvas.textSpanFontId(.{ .text = "" }, tokens.typography);

    const inner_width = @max(48, card_width - bubble_card_padding * 2);
    const metadata_layout = bubbleMetadataLayout(model, bubble, inner_width);
    const status_slot_width: f32 = if (bubbleHasStatusBadge(bubble)) 18 else 0;
    const title_width = @max(1, inner_width - status_slot_width - if (status_slot_width > 0) bubble_content_gap else 0);
    const title_normalized = normalizeDisplayText(bubble.title[0..bubble.title_len], &bubble_title_scratch[slot]);
    const title = fitTextToWidth(title_normalized, title_width, tokens.text_measure, text_font, bubbleTitleFontSize(model), &bubble_title_fit_scratch[slot]);
    const message_normalized = normalizeDisplayText(bubble.text[0..bubble.text_len], &bubble_text_scratch[slot]);
    const lines = wrapMeasuredMessage(message_normalized, inner_width, tokens.text_measure, text_font, bubbleMessageFontSize(model), &bubble_line_fit_scratch[slot]);

    const has_title_row = title.len > 0 or bubbleHasStatusBadge(bubble);
    var line_count: usize = 0;
    for (lines) |line| if (line.len > 0) {
        line_count += 1;
    };

    const nested_message_count = @min(bubble.child_messages_len, bubble_nested_rows_max);
    const nested_overflow_count = bubble.child_messages_len - nested_message_count;
    const metadata_height = bubbleMetadataHeight(model);
    const title_height = if (has_title_row) bubbleTitleHeight(model) else 0;
    const message_line_height = bubbleMessageFontSize(model) * 1.25;
    const nested_line_height = header_size * 1.25;
    const nested_line_count = nested_message_count + @as(usize, if (nested_overflow_count > 0) 1 else 0);
    return .{
        .valid = true,
        .title_text = title,
        .message_lines = lines,
        .metadata_left_x = metadata_layout.left_x,
        .metadata_left_width = metadata_layout.left_width,
        .metadata_height = metadata_height,
        .title_height = title_height,
        .message_line_height = message_line_height,
        .message_line_count = line_count,
        .status_slot_width = status_slot_width,
        .title_text_width = title_width,
        .nested_line_height = nested_line_height,
        .nested_line_count = nested_line_count,
        .nested_message_count = nested_message_count,
        .nested_overflow_count = nested_overflow_count,
        .inner_width = inner_width,
        .card_width = card_width,
    };
}

/// Compose the small reveal-dependent portion of the layout from text that
/// has already been measured.  This stays allocation-free and has no font
/// engine calls, so it is safe on hover, hit-test and spring paths.
fn bubbleLayoutMetricsFromMeasured(
    model: *const Model,
    bubble: *const hook_server.Bubble,
    measured: *const BubbleMeasuredLayout,
    raw_reveal: f32,
) BubbleLayoutMetrics {
    _ = raw_reveal;
    // The header is always part of an open card. Keeping this fixed makes all
    // primary text bands and intrinsic heights invariant across hover states.
    const metadata_reveal: f32 = 1;
    const nested_reveal = bubbleNestedRevealAt(model, bubble, metadata_reveal);
    const metadata_y = bubble_card_padding;
    const has_body = measured.title_height > 0 or measured.message_line_count > 0;
    const metadata_extent = metadata_reveal * (measured.metadata_height + if (has_body) bubble_line_gap else 0);
    const title_y = metadata_y + metadata_extent;
    const message_y = if (measured.message_line_count == 0)
        title_y + measured.title_height
    else if (measured.title_height > 0)
        title_y + measured.title_height + bubble_line_gap
    else
        title_y;
    const message_height = if (measured.message_line_count == 0)
        0
    else
        measured.message_line_height * @as(f32, @floatFromInt(measured.message_line_count)) +
            bubble_line_gap * @as(f32, @floatFromInt(measured.message_line_count - 1));
    const primary_bottom = if (measured.message_line_count > 0)
        message_y + message_height
    else if (measured.title_height > 0)
        title_y + measured.title_height
    else
        metadata_y + metadata_reveal * measured.metadata_height;
    const nested_height = if (measured.nested_line_count == 0)
        0
    else
        measured.nested_line_height * @as(f32, @floatFromInt(measured.nested_line_count)) +
            bubble_line_gap * @as(f32, @floatFromInt(measured.nested_line_count - 1));
    const nested_y = primary_bottom + if (measured.nested_line_count > 0) bubble_line_gap else 0;
    const content_bottom = primary_bottom + nested_reveal * (if (measured.nested_line_count > 0) bubble_line_gap + nested_height else 0);
    const card_height = @ceil(@max(content_bottom + bubble_card_padding, bubble_card_padding * 2 + 1));
    return .{
        .title_text = measured.title_text,
        .message_lines = measured.message_lines,
        .metadata_y = metadata_y,
        .metadata_height = measured.metadata_height,
        .metadata_left_x = measured.metadata_left_x,
        .metadata_left_width = measured.metadata_left_width,
        .title_y = title_y,
        .title_height = measured.title_height,
        .message_y = message_y,
        .message_line_height = measured.message_line_height,
        .message_line_count = measured.message_line_count,
        .status_slot_width = measured.status_slot_width,
        .title_text_width = measured.title_text_width,
        .nested_y = nested_y,
        .nested_line_height = measured.nested_line_height,
        .nested_line_count = measured.nested_line_count,
        .nested_message_count = measured.nested_message_count,
        .nested_overflow_count = measured.nested_overflow_count,
        .nested_reveal = nested_reveal,
        .content_width = measured.inner_width,
        .content_height = card_height - bubble_card_padding * 2,
        .inner_width = measured.inner_width,
        .card_width = measured.card_width,
        .card_height = card_height,
    };
}

/// The historical reveal argument remains for layout-test callers, but header
/// geometry is now permanent. Cache hits never measure or wrap text.
fn bubbleLayoutMetricsAtMetadataReveal(model: *const Model, slot: usize, raw_reveal: f32) BubbleLayoutMetrics {
    const bubble = &model.bubbles[slot];
    if (model.bubble_layout_cache.valid and
        model.bubble_layout_cache.key == bubbleLayoutCacheKey(model) and
        model.bubble_layout_cache.cards[slot].valid)
    {
        return bubbleLayoutMetricsFromMeasured(model, bubble, &model.bubble_layout_cache.cards[slot], raw_reveal);
    }
    // Pure unit-layout callers can construct a model without priming the
    // cache.  Keep that path correct; production mutations prime it through
    // retarget/snapshot invalidation before pointer polling starts.
    const measured = measureBubbleLayout(model, slot, bubbleCommonCardWidth(model));
    return bubbleLayoutMetricsFromMeasured(model, bubble, &measured, raw_reveal);
}

fn bubbleLayoutMetrics(model: *const Model, slot: usize) BubbleLayoutMetrics {
    return bubbleLayoutMetricsAtMetadataReveal(model, slot, bubbleMetadataReveal(model, slot));
}

/// Every card consumes the shared measured group width. Individual cards
/// remain intrinsic only on the vertical axis.
fn bubbleCardWidth(model: *const Model, slot: usize) f32 {
    return bubbleLayoutMetricsAtMetadataReveal(model, slot, 0).card_width;
}

fn bubbleCardHeight(model: *const Model, slot: usize) f32 {
    return bubbleLayoutMetricsAtMetadataReveal(model, slot, 0).card_height;
}

/// Authoritative width envelope for the group. Heights are intentionally not
/// uniform: every session has an intrinsic keyed spring below.
const BubbleGroupLayoutMetrics = struct {
    common_width: f32,
    compact_height: f32,
    expanded_height: f32,
    presentation_width: f32,
    presentation_height: f32,
    envelope_width: f32,
    envelope_height: f32,
};

fn bubbleGroupRequiredSize(model: *const Model, reveal: f32) struct { width: f32, height: f32 } {
    _ = reveal;
    const width = bubbleCommonCardWidth(model);
    var height: f32 = 1;
    for (0..model.bubbles_len) |slot| {
        height = @max(height, bubbleLayoutMetrics(model, slot).card_height);
    }
    return .{ .width = width, .height = height };
}

fn bubbleCardHeightSpring(model: *const Model, slot: usize) ?*const BubbleCardHeightSpring {
    if (slot >= model.bubbles_len) return null;
    const identity = bubbleVisualIdentity(&model.bubbles[slot]);
    for (&model.bubble_card_height_springs) |*spring| {
        if (spring.initialized and spring.identity == identity) return spring;
    }
    return null;
}

fn bubbleGroupLayoutMetrics(model: *const Model) BubbleGroupLayoutMetrics {
    const compact = bubbleGroupRequiredSize(model, 0);
    const expanded = bubbleGroupRequiredSize(model, 1);
    const spring = &model.bubble_group_size_spring;
    const presentation_width = if (spring.initialized) spring.width else expanded.width;
    const target_width = if (spring.initialized) spring.width_target else expanded.width;
    var presentation_height: f32 = 1;
    var target_height: f32 = 1;
    for (0..model.bubbles_len) |slot| {
        if (bubbleCardHeightSpring(model, slot)) |height_spring| {
            presentation_height = @max(presentation_height, height_spring.height);
            target_height = @max(target_height, height_spring.target);
        } else {
            const natural = bubbleLayoutMetrics(model, slot).card_height;
            presentation_height = @max(presentation_height, natural);
            target_height = @max(target_height, natural);
        }
    }
    return .{
        .common_width = expanded.width,
        .compact_height = compact.height,
        .expanded_height = expanded.height,
        .presentation_width = @max(1, presentation_width),
        .presentation_height = @max(1, presentation_height),
        .envelope_width = @max(presentation_width, target_width),
        .envelope_height = @max(presentation_height, target_height),
    };
}

fn retargetBubbleGroupSizeSpring(model: *Model) void {
    if (model.bubbles_len == 0) {
        model.bubble_group_size_spring = .{};
        model.bubble_card_height_springs = @splat(.{});
        return;
    }
    ensureBubbleLayoutCache(model);
    const expanded = bubbleGroupRequiredSize(model, 1);
    var spring = &model.bubble_group_size_spring;
    if (!spring.initialized) {
        spring.initialized = true;
        spring.width = expanded.width;
    }
    spring.width_target = expanded.width;
    if (model.reduce_motion) {
        spring.width = spring.width_target;
        spring.width_velocity = 0;
    }

    const previous = model.bubble_card_height_springs;
    var next: [hook_server.max_bubbles]BubbleCardHeightSpring = @splat(.{});
    for (0..model.bubbles_len) |slot| {
        const identity = bubbleVisualIdentity(&model.bubbles[slot]);
        // Header geometry is permanent, so hover never retargets this spring.
        // Only content or explicit nested-detail changes can change height.
        const target = bubbleLayoutMetrics(model, slot).card_height;
        for (&previous) |*candidate| {
            if (candidate.initialized and candidate.identity == identity) {
                next[slot] = candidate.*;
                break;
            }
        }
        var card_spring = &next[slot];
        card_spring.identity = identity;
        card_spring.target = target;
        if (!card_spring.initialized) {
            card_spring.initialized = true;
            card_spring.height = target;
        }
        if (model.reduce_motion) {
            card_spring.height = target;
            card_spring.velocity = 0;
        }
    }
    model.bubble_card_height_springs = next;
    invalidateBubblePresentation(model, .{ .geometry = true });
}

fn bubbleAnimatedCardWidth(model: *const Model, slot: usize) f32 {
    _ = slot;
    return bubbleGroupLayoutMetrics(model).presentation_width;
}

fn bubbleAnimatedCardHeight(model: *const Model, slot: usize) f32 {
    if (bubbleCardHeightSpring(model, slot)) |spring| return @max(1, spring.height);
    return bubbleLayoutMetrics(model, slot).card_height;
}

fn bubbleEnvelopeCardWidth(model: *const Model, slot: usize) f32 {
    _ = slot;
    return bubbleGroupLayoutMetrics(model).envelope_width;
}

fn bubbleEnvelopeCardHeight(model: *const Model, slot: usize) f32 {
    if (bubbleCardHeightSpring(model, slot)) |spring| return @max(spring.height, spring.target);
    return bubbleLayoutMetrics(model, slot).card_height;
}

/// The window fits the common group width, or two common-width lanes when
/// vertical screen pressure requires the outward fallback.
fn bubbleStackWidth(model: *const Model) f32 {
    const presented = bubblePresentedCount(model);
    if (presented == 0) return bubble_disclosure_size;
    var widest: f32 = 0;
    for (0..model.bubbles_len) |i| {
        if (!bubbleCardPresented(model, i)) continue;
        widest = @max(widest, bubbleEnvelopeCardWidth(model, i));
    }
    if (model.bubble_secondary_lane and presented > 1) return widest * 2 + bubble_lane_gap;
    return widest;
}

/// Width a card is actually drawn at. A single group spring keeps this
/// identical for every session throughout content and visibility changes.
fn bubbleRenderedCardWidth(model: *const Model, slot: usize) f32 {
    return bubbleAnimatedCardWidth(model, slot);
}

/// Height a card is drawn at.
///
/// Explicit for every card because the panel now shrinks to its actual
/// header/body/progress content instead of inheriting a stack container.
/// In a `.stack` a child with no height of its own inherits the
/// container's (widget_layout.stackChildFrame), and the container
/// reserves the whole expanded fan so cards have room to travel, so a
/// stacked card left at 0 stretches to fan height and draws as a giant
/// rounded rect. Outside a stack there is nothing to inherit from and
/// intrinsic sizing is what the single bubble has always wanted.
fn bubbleRenderedCardHeight(model: *const Model, slot: usize) f32 {
    return bubbleAnimatedCardHeight(model, slot);
}

/// The vertical axis the cards center on, in stack-container local
/// coordinates, for a given expansion.
///
/// NOT the container's center. The window is sized to the widest card
/// the stack could ever show and then clamped on-screen, so near a
/// screen edge the window slides inward. With a narrow front card and a
/// wide hidden peek that left the only VISIBLE card floating far from
/// the pet: the window had moved, and the card sat in its middle.
///
/// The axis therefore tracks the pet, clamped only by what has to fit:
/// collapsed that is the front card (the only one drawn at full alpha),
/// expanded it is the widest card in the fan. Against a screen edge the
/// clamp pushes the fan inward while the stack stays as close to the pet
/// as it can, which is the popover rule: the content shifts, the anchor
/// keeps pointing at its target.
fn bubbleStackAxis(model: *const Model, pet_center_local: f32, expansion: f32) f32 {
    const stack_w = bubbleStackWidth(model);
    // Widest card that must fit at this expansion: the front card alone
    // while collapsed, the whole fan once open.
    if (bubblePresentedCount(model) == 0) return stack_w / 2;
    const front = bubbleEnvelopeCardWidth(model, bubblePresentedFrontSlot(model));
    const needed = front + (stack_w - front) * expansion;
    const half = needed / 2;
    if (stack_w <= needed) return stack_w / 2;
    return std.math.clamp(pet_center_local, half, stack_w - half);
}

/// Linux presents the bubble as a parent-anchored GtkPopover. GTK centers the
/// complete popup on the pet, so the pet's local axis is always the middle of
/// the stack canvas. The global-window path on macOS and Windows still uses
/// the measured/clamped window origin recorded by syncBubbleWindow.
fn bubblePetCenterLocalForPlatform(model: *const Model, os: std.Target.Os.Tag) f32 {
    if (os == .linux) return bubbleStackWidth(model) / 2;
    return model.bubble_pet_center_local;
}

/// Horizontal shift that puts a card on the stack axis.
///
/// `stackChildFrame` places every overlay child at the container's
/// origin with no cross-axis alignment, so cards of different widths
/// would all pin to the left edge and fan out to the right. Centering
/// each one on the shared axis keeps the stack on a single vertical
/// line, anchored near the pet.
fn bubbleCardCenterDx(model: *const Model, slot: usize) f32 {
    const pet_center_local = bubblePetCenterLocalForPlatform(model, builtin.target.os.tag);
    const axis = bubbleStackAxis(model, pet_center_local, bubbleExpansionEased(model));
    const width = bubbleRenderedCardWidth(model, slot);
    if (!model.bubble_secondary_lane or bubblePresentedCount(model) <= 1) return axis - width / 2;
    const group_left = axis - bubbleStackWidth(model) / 2;
    return group_left + @as(f32, @floatFromInt(bubbleCardLane(model, slot))) * (width + bubble_lane_gap);
}

fn bubbleWindowWidth(model: *const Model) f32 {
    const content = if (model.bubbles_len == 0) bubbleMaxCardWidth(model) else bubbleStackWidth(model);
    return content + bubble_canvas_margin * 2;
}

// -------------------------------------------------- collapsed stack math

/// A single bubble is not a stack: no peek, no hover, no animation. The
/// whole stack interaction hangs off this so the speech-bubble path only
/// adds its own pet-anchored tail behavior.
fn bubbleStackable(model: *const Model) bool {
    return bubblePresentedCount(model) > 1;
}

fn bubbleCardLane(model: *const Model, slot: usize) usize {
    if (!model.bubble_secondary_lane or bubblePresentedCount(model) <= 1) return 0;
    // The front/nearest session occupies lane zero; lower-priority sessions
    // alternate outward so both lane heights remain bounded.
    return (model.bubbles_len - 1 - slot) % 2;
}

fn bubbleLaneRenderedHeight(model: *const Model, wanted_lane: usize) f32 {
    var height: f32 = 0;
    var count: usize = 0;
    for (0..model.bubbles_len) |slot| {
        if (!bubbleCardPresented(model, slot)) continue;
        if (bubbleCardLane(model, slot) != wanted_lane) continue;
        height += bubbleRenderedCardHeight(model, slot);
        count += 1;
    }
    if (count > 1) height += bubble_stack_gap * @as(f32, @floatFromInt(count - 1));
    return height;
}

fn easeOutCubic(t: f32) f32 {
    const inv = 1 - std.math.clamp(t, 0, 1);
    return 1 - inv * inv * inv;
}

/// Depth of a card measured from the front. The front card is the most
/// recently updated one, which slice 1 keeps last in `bubbles`, so depth
/// counts backwards from the end.
fn bubbleCardScale(model: *const Model, slot: usize) f32 {
    _ = model;
    _ = slot;
    return 1;
}

/// Opacity for a card at `slot`. The front card is always solid; the
/// ones behind fade with depth until expansion brings them back.
fn bubbleCardAlpha(model: *const Model, slot: usize) f32 {
    if (!bubbleCardPresented(model, slot)) return 0;
    return if (model.bubble_fold_phase == .folded) 0 else 1;
}

/// Vertical placement relative to the disclosure convergence point. Empty
/// glass surfaces begin coincident there, then separate by each preceding
/// card's intrinsic presentation height plus the group gap.
///
/// The sign follows the flip: above the pet the stack grows upward, away
/// from the front card at the bottom; flipped below the pet the front
/// card is on top and the others grow downward.
fn bubbleCardOffset(model: *const Model, slot: usize) f32 {
    if (!bubbleStackable(model)) return 0;
    const expanded = bubbleExpandedCardOffset(model, slot);
    const front_slot = bubblePresentedFrontSlot(model);
    const front_y = if (model.bubble_flipped) 0 else bubbleStackHeightAt(model, 1) - bubbleRenderedCardHeight(model, front_slot);
    return front_y + (expanded - front_y) * bubbleExpansionEased(model);
}

fn bubbleExpandedCardOffset(model: *const Model, slot: usize) f32 {
    var offset: f32 = 0;
    const lane = bubbleCardLane(model, slot);
    if (model.bubble_flipped) {
        var index = model.bubbles_len;
        while (index > slot + 1) {
            index -= 1;
            if (!bubbleCardPresented(model, index)) continue;
            if (bubbleCardLane(model, index) != lane) continue;
            offset += bubbleRenderedCardHeight(model, index) + bubble_stack_gap;
        }
    } else {
        if (model.bubble_secondary_lane) {
            offset = @max(bubbleLaneRenderedHeight(model, 0), bubbleLaneRenderedHeight(model, 1)) -
                bubbleLaneRenderedHeight(model, lane);
        }
        for (0..slot) |index| {
            if (!bubbleCardPresented(model, index)) continue;
            if (bubbleCardLane(model, index) != lane) continue;
            offset += bubbleRenderedCardHeight(model, index) + bubble_stack_gap;
        }
    }
    return offset;
}

/// Height occupied by the intrinsic card lanes at a visibility sample. The
/// window reserves the expanded envelope so resizing never races animation.
fn bubbleStackHeightAt(model: *const Model, expansion: f32) f32 {
    if (bubblePresentedCount(model) == 0) return 0;
    const front = bubbleRenderedCardHeight(model, bubblePresentedFrontSlot(model));
    if (!bubbleStackable(model)) return front;
    var lane_heights: [2]f32 = @splat(0);
    var lane_counts: [2]usize = @splat(0);
    for (0..model.bubbles_len) |slot| {
        if (!bubbleCardPresented(model, slot)) continue;
        const lane = bubbleCardLane(model, slot);
        lane_heights[lane] += bubbleRenderedCardHeight(model, slot);
        lane_counts[lane] += 1;
    }
    var expanded: f32 = 0;
    for (lane_heights, lane_counts) |height, count| {
        if (count == 0) continue;
        expanded = @max(expanded, height + bubble_stack_gap * @as(f32, @floatFromInt(count - 1)));
    }
    return front + (expanded - front) * expansion;
}

fn bubbleEnvelopeStackHeight(model: *const Model) f32 {
    if (model.bubbles_len == 0 or bubblePresentedCount(model) == 0) return 0;
    var lane_heights: [2]f32 = @splat(0);
    var lane_counts: [2]usize = @splat(0);
    for (0..model.bubbles_len) |slot| {
        if (!bubbleCardPresented(model, slot)) continue;
        const lane = bubbleCardLane(model, slot);
        lane_heights[lane] += bubbleEnvelopeCardHeight(model, slot);
        lane_counts[lane] += 1;
    }
    var height: f32 = 0;
    for (lane_heights, lane_counts) |lane_height, count| {
        if (count == 0) continue;
        height = @max(height, lane_height + bubble_stack_gap * @as(f32, @floatFromInt(count - 1)));
    }
    return height;
}

/// At least one maximum-height card is reserved before the first bubble
/// lands so the companion window is never born zero-height. Once content
/// exists, the window follows the cards' intrinsic heights.
///
/// Deliberately the EXPANDED height regardless of the current expansion.
/// Resizing a window every spring frame is the one thing
/// most likely to tear or lag behind the content, so the window is sized
/// once for the tallest state the stack can reach and only the cards
/// inside it animate. Collapsed simply leaves transparent space above
/// the front card, which costs nothing: the window is click-through and
/// fully transparent already.
fn bubbleWindowHeight(model: *const Model) f32 {
    const cards = if (model.bubbles_len == 0)
        bubbleMaxCardHeight(model)
    else
        @max(bubbleStackHeightAt(model, 1), bubbleEnvelopeStackHeight(model));
    return cards + bubble_disclosure_size + bubble_disclosure_gap + bubble_canvas_margin * 2;
}

fn bubbleFontSize(model: *const Model) f32 {
    // Font size is an explicit user preference. The pet scale still controls
    // the bubble geometry, but must not silently override this setting.
    return std.math.clamp(model.bubble_text_px, bubble_text_min_px, bubble_text_max_px);
}

/// Bubble text size bounds shared by all desktop platforms.
pub const bubble_text_min_px: f32 = 8;
pub const bubble_text_max_px: f32 = 20;
/// The visual midpoint. The stored setting remains a linear 8…20 slider;
/// bubble typography resolves its compact/default/maximum anchors around
/// this value without changing existing user preferences.
pub const bubble_text_default_px: f32 = 13;

/// Count display characters (UTF-8 sequences, not bytes).
fn charCount(text: []const u8) usize {
    var n: usize = 0;
    for (text) |b| {
        if ((b & 0xC0) != 0x80) n += 1;
    }
    return n;
}

// One scratch pair PER stacked card: the view's byte slices must
// outlive the frame build, so cards cannot share a buffer the way a
// single bubble could.
var bubble_title_scratch: [hook_server.max_bubbles][1024]u8 = undefined;
var bubble_title_fit_scratch: [hook_server.max_bubbles][1024]u8 = undefined;
var bubble_text_scratch: [hook_server.max_bubbles][hook_server.bubble_text_capacity]u8 = undefined;
var bubble_line_fit_scratch: [hook_server.max_bubbles][bubble_message_lines_max][hook_server.bubble_text_capacity]u8 = undefined;
var bubble_child_scratch: [hook_server.max_bubbles][bubble_nested_rows_max][hook_server.bubble_child_message_capacity + 64]u8 = undefined;
var bubble_child_overflow_scratch: [hook_server.max_bubbles][32]u8 = undefined;
var bubble_disclosure_count_scratch: [4]u8 = undefined;

fn bubbleChildRowText(slot: usize, row: usize, child: *const hook_server.ChildMessage) []const u8 {
    return std.fmt.bufPrint(
        &bubble_child_scratch[slot][row],
        "↳ {s} · {s}",
        .{ child.labelSlice(), child.textSlice() },
    ) catch child.textSlice();
}

fn isDisplayWhitespace(byte: u8) bool {
    return byte == ' ' or byte == '\t' or byte == '\r' or byte == '\n';
}

/// Normalize a feed value to one visual line, then clip to `max_chars` on a
/// safe boundary: never mid UTF-8 sequence, never splitting a JSON escape,
/// preferring the last word boundary within reach, optionally appending an
/// ellipsis into `scratch` (globals: the view's byte slices must outlive the
/// frame build). Explicit newlines cannot escape an authoritative text band.
fn clipDisplay(text: []const u8, max_chars: usize, scratch: []u8, append_ellipsis: bool) []const u8 {
    if (scratch.len == 0) return "";
    var write: usize = 0;
    var pending_space = false;
    var source_clipped = false;
    for (text) |byte| {
        if (isDisplayWhitespace(byte)) {
            pending_space = write > 0;
            continue;
        }
        if (pending_space) {
            if (write == scratch.len) {
                source_clipped = true;
                break;
            }
            scratch[write] = ' ';
            write += 1;
            pending_space = false;
        }
        if (write == scratch.len) {
            source_clipped = true;
            break;
        }
        scratch[write] = byte;
        write += 1;
    }
    const normalized = scratch[0..write];
    if (!source_clipped and charCount(normalized) <= max_chars) return normalized;

    var n: usize = 0;
    var cut: usize = normalized.len;
    for (normalized, 0..) |b, i| {
        if ((b & 0xC0) != 0x80) {
            if (n == max_chars) {
                cut = i;
                break;
            }
            n += 1;
        }
    }
    if (std.mem.lastIndexOfScalar(u8, normalized[0..cut], ' ')) |sp| {
        if (cut - sp <= 10) cut = sp;
    }
    var backslashes: usize = 0;
    while (cut > backslashes and normalized[cut - 1 - backslashes] == '\\') backslashes += 1;
    if (backslashes % 2 == 1) cut -= 1;
    const ell = if (append_ellipsis) "\u{2026}" else "";
    const total = @min(cut, scratch.len - ell.len);
    @memcpy(scratch[total .. total + ell.len], ell);
    return scratch[0 .. total + ell.len];
}

/// Fit a normalized single line against the same font measurement used by the
/// renderer. The output lands on a UTF-8 boundary and reserves the ellipsis,
/// so span paragraphs never get a chance to wrap into another text band.
fn fitTextToWidth(text: []const u8, width: f32, measure: anytype, font: anytype, size: f32, scratch: []u8) []const u8 {
    if (text.len == 0 or scratch.len < 4) return text;
    if (canvas.measureTextWidthForFont(measure, font, text, size) <= width) return text;
    const ellipsis = "\u{2026}";
    const ellipsis_width = canvas.measureTextWidthForFont(measure, font, ellipsis, size);
    const available = @max(0, width - ellipsis_width);
    var cut: usize = 0;
    var last_space: usize = 0;
    var index: usize = 0;
    while (index < text.len) {
        var next = index + 1;
        while (next < text.len and (text[next] & 0xC0) == 0x80) next += 1;
        if (canvas.measureTextWidthForFont(measure, font, text[0..next], size) > available) break;
        cut = next;
        if (text[index] == ' ') last_space = index;
        index = next;
    }
    if (last_space > 0 and cut - last_space <= 12) cut = last_space;
    cut = @min(cut, scratch.len - ellipsis.len);
    @memcpy(scratch[0..cut], text[0..cut]);
    @memcpy(scratch[cut .. cut + ellipsis.len], ellipsis);
    return scratch[0 .. cut + ellipsis.len];
}

/// Split into explicit single-line nodes, so measure equals paint and the
/// configured answer-line count is an actual layout contract.
fn splitLines(text: []const u8, max_chars: usize, max_lines: usize) [bubble_answer_lines_max][]const u8 {
    var lines: [bubble_answer_lines_max][]const u8 = @splat("");
    var remaining = std.mem.trim(u8, text, " ");
    var line_index: usize = 0;
    while (remaining.len > 0 and line_index < @min(max_lines, bubble_answer_lines_max)) : (line_index += 1) {
        if (charCount(remaining) <= max_chars) {
            lines[line_index] = remaining;
            break;
        }
        var chars: usize = 0;
        var hard_cut: usize = remaining.len;
        for (remaining, 0..) |b, i| {
            if ((b & 0xC0) != 0x80) {
                if (chars == max_chars) {
                    hard_cut = i;
                    break;
                }
                chars += 1;
            }
        }
        var cut = hard_cut;
        if (std.mem.lastIndexOfScalar(u8, remaining[0..hard_cut], ' ')) |sp| {
            if (hard_cut - sp <= 14) cut = sp;
        }
        lines[line_index] = std.mem.trim(u8, remaining[0..cut], " ");
        remaining = std.mem.trim(u8, remaining[cut..], " ");
    }
    return lines;
}
fn bubbleActive(model: *const Model) bool {
    return model.bubbles_enabled and !model.focus_mode and model.bubbles_len > 0;
}

fn bubbleDisplayMode(model: *const Model) BubbleDisplayMode {
    if (!model.bubble_group_visible) return .hidden;
    return if (model.bubble_show_recent_only) .recent else .all;
}

fn setBubbleDisplayMode(model: *Model, mode: BubbleDisplayMode) void {
    switch (mode) {
        .all => {
            model.bubble_group_visible = true;
            model.bubble_show_recent_only = false;
        },
        .recent => {
            model.bubble_group_visible = true;
            model.bubble_show_recent_only = true;
        },
        .hidden => {
            model.bubble_group_visible = false;
            // Preserve this bit while the selected card converges into the
            // disclosure. It is cleared when the collapse settles.
        },
    }
}

fn nextBubbleDisplayMode(mode: BubbleDisplayMode) BubbleDisplayMode {
    return switch (mode) {
        .all => .recent,
        .recent => .hidden,
        .hidden => .all,
    };
}

/// Pick the newest conversation that is actually live. Quiet retained cards
/// are eligible only when no running/attention session exists. Pinning still
/// controls ordering in All mode; Recent mode is intentionally activity-led.
fn bubbleMostRecentActiveSlot(model: *const Model) usize {
    std.debug.assert(model.bubbles_len > 0);
    var newest_active: ?usize = null;
    for (model.bubbles[0..model.bubbles_len], 0..) |*bubble, slot| {
        const active = bubble.busy or bubble.status == .running or bubble.status == .needs_input;
        if (!active) continue;
        if (newest_active == null or bubble.counter > model.bubbles[newest_active.?].counter)
            newest_active = slot;
    }
    return newest_active orelse newestOf(model.bubbles[0..model.bubbles_len]);
}

fn bubblePresentedFrontSlot(model: *const Model) usize {
    std.debug.assert(model.bubbles_len > 0);
    if (model.bubble_show_recent_only) return bubbleMostRecentActiveSlot(model);
    return model.bubbles_len - 1;
}

/// Cards are absent in Hidden mode. During the final collapse, the previously
/// selected empty glass remains materialized long enough to merge into the
/// disclosure; its text is already removed by `bubbleContentReveal`.
fn bubbleCardPresented(model: *const Model, slot: usize) bool {
    if (slot >= model.bubbles_len) return false;
    const transitioning_out = !model.bubble_group_visible and model.bubble_fold_phase == .collapsing;
    if (!model.bubble_group_visible and !transitioning_out) return false;
    return !model.bubble_show_recent_only or slot == bubbleMostRecentActiveSlot(model);
}

fn bubblePresentedCount(model: *const Model) usize {
    if (!model.bubble_group_visible and model.bubble_fold_phase != .collapsing) return 0;
    return if (model.bubble_show_recent_only) @min(model.bubbles_len, 1) else model.bubbles_len;
}

/// Hover state for the stack, folded from a cursor sample. The window is
/// click-through and stays that way, so this reads the same global
/// cursor the pet's drag detection polls rather than widget events:
/// expanding is purely visual and must never take input away from
/// whatever is behind the bubble.
///
/// `inside` is tested against the window rect the caller measured, so
/// this function stays pure and testable.
fn updateBubbleHoverIdentity(model: *Model, identity: u64, now_ms: i64) bool {
    _ = now_ms;
    const changed = model.bubble_hovered_identity != identity or model.bubble_hovered != (identity != 0);
    model.bubble_hovered_identity = identity;
    model.bubble_hovered = identity != 0;
    model.bubble_hover_since_ms = -1;
    model.bubble_hover_exit_since_ms = -1;
    // Hover reveals only this card's provenance and action rail. Group
    // visibility is exclusively controlled by the pet-adjacent disclosure.
    model.bubble_expansion_target = if (model.bubble_group_visible) 1 else 0;
    if (changed) retargetBubbleGroupSizeSpring(model);
    return changed;
}

/// Compatibility wrapper retained for pure layout tests. Runtime hover uses a
/// stable session identity so only one card expands its metadata.
fn updateBubbleHover(model: *Model, inside: bool, now_ms: i64) void {
    const identity = if (inside and model.bubbles_len > 0)
        bubbleVisualIdentity(&model.bubbles[model.bubbles_len - 1])
    else
        0;
    _ = updateBubbleHoverIdentity(model, identity, now_ms);
}

/// Linux presents the portable widget tree in a compositor popup rather than
/// an AppKit material hierarchy. Settle its geometry in the model update that
/// created it: this avoids depending on a native-glass materialization loop
/// while preserving the same cards, text, disclosure, and actions.
fn bubbleGeometrySettlesImmediately(os: std.Target.Os.Tag, reduce_motion: bool) bool {
    return reduce_motion or os == .linux;
}

/// Walk `bubble_expansion` toward its target at the animation rate.
/// Returns whether anything moved, so the caller can skip a redundant
/// window sync on the frames where the stack is at rest.
fn stepBubbleExpansionForPlatform(model: *Model, now_ms: i64, os: std.Target.Os.Tag) bool {
    // Bubble updates, settings changes, and native actions retarget their
    // springs at the point where the content changes. Do not remeasure every
    // card from the 10 Hz pointer poll once the presentation is settled.
    // Hover/visibility targets are retargeted when their state changes. The
    // spring then carries the measured height; animation ticks only advance
    // numbers and never invoke text measurement themselves.
    if (model.bubbles_len > 0 and !model.bubble_group_size_spring.initialized) {
        retargetBubbleGroupSizeSpring(model);
    }
    const hover_target: f32 = if (model.bubble_hovered) 1 else 0;
    const moving_before_retarget = @abs(model.bubble_expansion_target - model.bubble_expansion) >= 0.001 or
        @abs(model.bubble_expansion_velocity) >= 0.01 or
        @abs(hover_target - model.bubble_hover_amount) >= 0.001 or
        @abs(model.bubble_hover_velocity) >= 0.01 or
        bubbleGroupSizeSpringMoving(model) or
        anyCompletionSettling(model, now_ms);
    if (!moving_before_retarget) {
        // Keep the next animation's delta local even after a long idle.
        model.bubble_anim_last_ms = now_ms;
        return false;
    }
    const moving = @abs(model.bubble_expansion_target - model.bubble_expansion) >= 0.001 or
        @abs(model.bubble_expansion_velocity) >= 0.01 or
        @abs(hover_target - model.bubble_hover_amount) >= 0.001 or
        @abs(model.bubble_hover_velocity) >= 0.01 or
        bubbleGroupSizeSpringMoving(model);
    // Busy shimmer and attention breathing are native Core Animation on
    // macOS and must not turn a settled card into permanent application-side
    // frame work. Only geometry and the one-shot completion settle belong on
    // this timer.
    if (!moving and !anyCompletionSettling(model, now_ms)) return false;
    var dt_ms: i64 = 0;
    if (bubbleGeometrySettlesImmediately(os, model.reduce_motion)) {
        model.bubble_anim_last_ms = now_ms;
        model.bubble_expansion = model.bubble_expansion_target;
        model.bubble_expansion_velocity = 0;
        model.bubble_hover_amount = hover_target;
        model.bubble_hover_velocity = 0;
        var group_spring = &model.bubble_group_size_spring;
        if (group_spring.initialized) {
            group_spring.width = group_spring.width_target;
            group_spring.width_velocity = 0;
        }
        for (&model.bubble_card_height_springs) |*card_spring| {
            if (!card_spring.initialized) continue;
            card_spring.height = card_spring.target;
            card_spring.velocity = 0;
        }
    } else {
        if (model.bubble_anim_last_ms == 0) model.bubble_anim_last_ms = now_ms;
        dt_ms = now_ms - model.bubble_anim_last_ms;
        model.bubble_anim_last_ms = now_ms;
        // Same guard the throw physics uses: a stall (or a sleeping machine)
        // must not teleport the animation.
        if (dt_ms <= 0) return false;
        if (dt_ms > 50) dt_ms = 50;
        const dt = @as(f32, @floatFromInt(dt_ms)) / 1000;
        springStep(&model.bubble_expansion, &model.bubble_expansion_velocity, model.bubble_expansion_target, dt);
        springStep(&model.bubble_hover_amount, &model.bubble_hover_velocity, hover_target, dt);
        var spring = &model.bubble_group_size_spring;
        if (spring.initialized) {
            springStep(&spring.width, &spring.width_velocity, spring.width_target, dt);
        }
        for (&model.bubble_card_height_springs) |*card_spring| {
            if (!card_spring.initialized) continue;
            springStep(&card_spring.height, &card_spring.velocity, card_spring.target, dt);
        }
    }
    if (model.bubble_expansion_target > 0.5) {
        if (model.bubble_fold_phase == .materializing) model.bubble_fold_phase = .unfolding;
        if (@abs(1 - model.bubble_expansion) < 0.001 and @abs(model.bubble_expansion_velocity) < 0.01)
            model.bubble_fold_phase = .unfolded;
    } else if (@abs(model.bubble_expansion) < 0.001 and @abs(model.bubble_expansion_velocity) < 0.01) {
        model.bubble_fold_phase = .folded;
        if (!model.bubble_group_visible) model.bubble_show_recent_only = false;
        model.bubble_hover_exit_since_ms = -1;
    }
    if (!model.reduce_motion and (anyBusyBubble(model) or anyNeedsInputBubble(model))) {
        model.bubble_shimmer_phase += @as(f32, @floatFromInt(dt_ms)) / 1800;
        if (model.bubble_shimmer_phase >= 1) model.bubble_shimmer_phase -= @floor(model.bubble_shimmer_phase);
    } else {
        model.bubble_shimmer_phase = 0;
    }
    invalidateBubblePresentation(model, .{ .geometry = true });
    return true;
}

fn stepBubbleExpansion(model: *Model, now_ms: i64) bool {
    return stepBubbleExpansionForPlatform(model, now_ms, builtin.target.os.tag);
}

fn springStep(value: *f32, velocity: *f32, target: f32, dt: f32) void {
    const acceleration = (target - value.*) * bubble_spring_stiffness - velocity.* * bubble_spring_damping;
    velocity.* += acceleration * dt;
    value.* += velocity.* * dt;
    if (@abs(target - value.*) < 0.001 and @abs(velocity.*) < 0.01) {
        value.* = target;
        velocity.* = 0;
    }
}

fn anyBusyBubble(model: *const Model) bool {
    for (model.bubbles[0..model.bubbles_len]) |bubble| if (bubble.busy) return true;
    return false;
}

fn anyNeedsInputBubble(model: *const Model) bool {
    for (model.bubbles[0..model.bubbles_len]) |bubble| if (bubble.status == .needs_input) return true;
    return false;
}

fn bubbleGroupSemanticState(model: *const Model) plat.BubbleGlassSemanticState {
    var best: plat.BubbleGlassSemanticState = .idle;
    var best_priority: u8 = 0;
    for (model.bubbles[0..model.bubbles_len]) |bubble| {
        const state: plat.BubbleGlassSemanticState = switch (bubble.status) {
            .idle => .idle,
            .running => .running,
            .needs_input => .needs_input,
            .completed => .completed,
            .failed => .failed,
        };
        const priority: u8 = switch (state) {
            .idle => 0,
            .completed => 1,
            .running => 2,
            .needs_input => 3,
            .failed => 4,
        };
        if (priority > best_priority) {
            best = state;
            best_priority = priority;
        }
    }
    return best;
}

const BubbleDisclosurePresentation = struct {
    show_status_icon: bool = false,
    alpha: f32 = 1,
};

/// Hidden mode alternates its count with the aggregate status. A brief
/// luminance dip at each content swap reads as a native symbol morph while a
/// nonzero floor keeps the small control discoverable and clickable.
fn bubbleDisclosurePresentation(model: *const Model) BubbleDisclosurePresentation {
    if (bubbleDisplayMode(model) != .hidden or model.reduce_motion) return .{};
    const segment = bubble_disclosure_morph_segment_ms;
    const period = segment * 2;
    const clock = @mod(@max(@as(i64, 0), model.bubble_anim_last_ms), period);
    const within = @mod(clock, segment);
    const edge_distance = @min(within, segment - within);
    const fade = std.math.clamp(
        @as(f32, @floatFromInt(edge_distance)) / @as(f32, @floatFromInt(bubble_disclosure_morph_fade_ms)),
        0,
        1,
    );
    return .{
        .show_status_icon = clock >= segment,
        .alpha = 0.38 + fade * 0.62,
    };
}

fn bubbleDisclosureMorphing(model: *const Model) bool {
    return !model.reduce_motion and model.bubbles_len > 0 and bubbleDisplayMode(model) == .hidden;
}

fn completionSettleProgress(model: *const Model, bubble: *const hook_server.Bubble) f32 {
    if (model.reduce_motion or bubble.status != .completed or bubble.completed_at_ms <= 0) return 1;
    const elapsed = @max(0, model.bubble_anim_last_ms - bubble.completed_at_ms);
    const linear = std.math.clamp(
        @as(f32, @floatFromInt(elapsed)) / @as(f32, @floatFromInt(bubble_completion_settle_ms)),
        0,
        1,
    );
    return easeOutCubic(linear);
}

fn anyCompletionSettling(model: *const Model, now_ms: i64) bool {
    if (model.reduce_motion) return false;
    for (model.bubbles[0..model.bubbles_len]) |bubble| {
        if (bubble.status != .completed or bubble.completed_at_ms <= 0) continue;
        const elapsed = now_ms - bubble.completed_at_ms;
        if (elapsed >= 0 and elapsed < bubble_completion_settle_ms) return true;
    }
    return false;
}

fn bubbleGroupSizeSpringMoving(model: *const Model) bool {
    const spring = &model.bubble_group_size_spring;
    if (spring.initialized and (@abs(spring.width_target - spring.width) >= 0.001 or
        @abs(spring.width_velocity) >= 0.01)) return true;
    for (&model.bubble_card_height_springs) |*card_spring| {
        if (!card_spring.initialized) continue;
        if (@abs(card_spring.target - card_spring.height) >= 0.001 or @abs(card_spring.velocity) >= 0.01) return true;
    }
    return false;
}

fn bubblePresentationAnimationPending(model: *const Model, now_ms: i64) bool {
    if (!bubbleActive(model)) return false;
    const hover_target: f32 = if (model.bubble_hovered) 1 else 0;
    return @abs(model.bubble_expansion_target - model.bubble_expansion) >= 0.001 or
        @abs(model.bubble_expansion_velocity) >= 0.01 or
        @abs(hover_target - model.bubble_hover_amount) >= 0.001 or
        @abs(model.bubble_hover_velocity) >= 0.01 or
        bubbleGroupSizeSpringMoving(model) or
        anyCompletionSettling(model, now_ms);
}

/// Eased value the view actually draws with. The model stores linear
/// progress so the interpolation stays reversible mid-flight; the ease
/// is applied once, here, at read time.
fn bubbleExpansionEased(model: *const Model) f32 {
    return easeOutCubic(model.bubble_expansion);
}

/// Grace band around the visible cards, in points. Hitting a rounded
/// corner exactly is not a skill anyone should have to demonstrate.
const bubble_hover_slop: f32 = 4;

/// A rectangle in bubble-window local coordinates.
const BubbleRect = struct { x: f32, y: f32, w: f32, h: f32 };

const BubbleVisualFrame = struct {
    base_x: f32,
    base_y: f32,
    base_w: f32,
    base_h: f32,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    scale: f32,
    scale_x: f32,
    scale_y: f32,
    alpha: f32,
};

/// Final card geometry in stack-local coordinates, after the hover/depth
/// scale. Canvas transforms, hover bounds and the AppKit glass bridge all
/// consume this same record.
fn bubbleVisualFrame(model: *const Model, slot: usize) BubbleVisualFrame {
    const base_w = bubbleRenderedCardWidth(model, slot);
    const base_h = bubbleRenderedCardHeight(model, slot);
    const base_x = bubbleCardCenterDx(model, slot);
    const base_y = bubbleExpandedCardOffset(model, slot);
    const disclosure = bubbleDisclosureFrame(model);
    const origin_y = bubbleStackOriginY(model);
    const closed_x = disclosure.x - bubble_canvas_margin;
    const closed_y = disclosure.y - origin_y;
    const expansion = bubbleExpansionEased(model);
    const w = bubble_disclosure_size + (base_w - bubble_disclosure_size) * expansion;
    const h = bubble_disclosure_size + (base_h - bubble_disclosure_size) * expansion;
    const x = closed_x + (base_x - closed_x) * expansion;
    const y = closed_y + (base_y - closed_y) * expansion;
    const scale_x = w / @max(1, base_w);
    const scale_y = h / @max(1, base_h);
    const scale = @min(scale_x, scale_y);
    return .{
        .base_x = base_x,
        .base_y = base_y,
        .base_w = base_w,
        .base_h = base_h,
        .x = x,
        .y = y,
        .w = w,
        .h = h,
        .scale = scale,
        .scale_x = scale_x,
        .scale_y = scale_y,
        .alpha = bubbleCardAlpha(model, slot),
    };
}

/// Linux renders the activity UI with ordinary Native SDK controls. It does
/// not need the glass-only transition where a card begins as a disclosure-
/// sized material and expands after the native surface is attached. Present
/// the intrinsic portable card immediately while retaining the same expanded
/// stack geometry and authoritative hit-test frames.
fn bubbleVisualFrameForPlatform(model: *const Model, slot: usize, os: std.Target.Os.Tag) BubbleVisualFrame {
    if (os != .linux) return bubbleVisualFrame(model, slot);
    const base_w = bubbleRenderedCardWidth(model, slot);
    const base_h = bubbleRenderedCardHeight(model, slot);
    const base_x = bubbleCardCenterDx(model, slot);
    const base_y = bubbleExpandedCardOffset(model, slot);
    return .{
        .base_x = base_x,
        .base_y = base_y,
        .base_w = base_w,
        .base_h = base_h,
        .x = base_x,
        .y = base_y,
        .w = base_w,
        .h = base_h,
        .scale = 1,
        .scale_x = 1,
        .scale_y = 1,
        .alpha = bubbleContentRevealForPlatform(model, slot, os),
    };
}

/// Top of the stack CONTAINER inside the window, in window-local points.
///
/// `bubbleCardOffset` is relative to that container, not to the window,
/// so anything turning a card offset into window space has to add this
/// first. The two are not the same number, and the gap between them is
/// not decoration.
///
/// `bubbleView` is the authority here. Its root column has no explicit
/// padding node: the two canvas margins are spare window height. Unflipped,
/// `.main = .end` places all of that spare height above the card group.
/// Flipped, `.main = .start` begins with the head gap and upward connector,
/// so the card begins after exactly those two nodes and the spare margins
/// remain below it.
///
/// AppKit glass, GPU content and hit testing all consume this value. Re-adding
/// `tail_h + head_gap` on the unflipped branch shifted only the glass down,
/// which made text appear flush against its top and over-padded below.
fn bubbleStackOriginY(model: *const Model) f32 {
    if (model.bubble_flipped) return bubble_canvas_margin + bubble_disclosure_size + bubble_disclosure_gap;
    // While content shrinks, the window temporarily keeps the larger target /
    // current envelope. The root column is bottom-aligned above the pet, so
    // that spare height sits above the cards; include it here so native glass
    // and hit testing remain locked to the GPU layout during the spring.
    const current = bubbleStackHeightAt(model, 1);
    const reserved = @max(current, bubbleEnvelopeStackHeight(model));
    return bubble_canvas_margin + (reserved - current);
}

/// Stable pet-adjacent disclosure geometry in window coordinates. It is the
/// convergence point for every card glass surface during opening and closing.
fn bubbleDisclosureFrameForPlatform(model: *const Model, os: std.Target.Os.Tag) BubbleRect {
    const window_w = bubbleWindowWidth(model);
    const pet_center_local = bubblePetCenterLocalForPlatform(model, os);
    const pet_x = bubble_canvas_margin + pet_center_local;
    const x = std.math.clamp(pet_x - bubble_disclosure_size / 2, bubble_canvas_margin, window_w - bubble_canvas_margin - bubble_disclosure_size);
    const y = if (model.bubble_flipped)
        bubble_canvas_margin
    else
        bubbleWindowHeight(model) - bubble_canvas_margin - bubble_disclosure_size;
    return .{ .x = x, .y = y, .w = bubble_disclosure_size, .h = bubble_disclosure_size };
}

fn bubbleDisclosureFrame(model: *const Model) BubbleRect {
    return bubbleDisclosureFrameForPlatform(model, builtin.target.os.tag);
}

fn bubblePortableCardUsesWindowDrag(os: std.Target.Os.Tag, presented: bool) bool {
    return os == .linux and presented;
}

/// The union of the cards as they are ACTUALLY DRAWN, in window-local
/// coordinates.
///
/// Derived from the same three functions the renderer transforms each
/// card by — bubbleCardCenterDx for x, bubbleCardOffset for y,
/// bubbleRenderedCardWidth for width — so the hit region cannot drift
/// from the pixels. It used to be re-derived from the window edges and
/// the layout constants, which is how it ended up offset from the cards:
/// a band running up from the window bottom while the cards sit on an
/// axis that tracks the pet and an offset that reserves the whole fan.
/// The visible-but-dead margins around the card were the bug Hunter hit,
/// where only the middle of the card (the text) reliably answered.
fn bubbleCardsRect(model: *const Model) BubbleRect {
    if (bubblePresentedCount(model) == 0) {
        const disclosure = bubbleDisclosureFrame(model);
        return .{
            .x = disclosure.x - bubble_hover_slop,
            .y = disclosure.y - bubble_hover_slop,
            .w = disclosure.w + bubble_hover_slop * 2,
            .h = disclosure.h + bubble_hover_slop * 2,
        };
    }
    // The container is centered horizontally inside the margin, so x
    // only has to clear the margin; y has a flip-dependent band to clear
    // as well (see bubbleStackOriginY).
    const origin_x = bubble_canvas_margin;
    const origin_y = bubbleStackOriginY(model);
    const front = bubblePresentedFrontSlot(model);
    const front_frame = bubbleVisualFrame(model, front);
    var min_x = front_frame.x;
    var max_x = front_frame.x + front_frame.w;
    var min_y = front_frame.y;
    var max_y = front_frame.y + front_frame.h;
    // The peeks behind the front card stick out; they are visible and so
    // they are hoverable.
    if (bubbleStackable(model)) {
        for (0..model.bubbles_len) |slot| {
            if (!bubbleCardPresented(model, slot)) continue;
            const frame = bubbleVisualFrame(model, slot);
            min_x = @min(min_x, frame.x);
            max_x = @max(max_x, frame.x + frame.w);
            min_y = @min(min_y, frame.y);
            max_y = @max(max_y, frame.y + frame.h);
        }
    }
    return .{
        .x = origin_x + min_x - bubble_hover_slop,
        .y = origin_y + min_y - bubble_hover_slop,
        .w = (max_x - min_x) + bubble_hover_slop * 2,
        .h = (max_y - min_y) + bubble_hover_slop * 2,
    };
}

/// Whether a screen-space cursor sample lands on the bubble stack.
///
/// Tested against the CARDS, not the whole window: the window is sized
/// to the expanded height even while collapsed (see bubbleWindowHeight)
/// and to the widest card the stack could ever show, so its rect is
/// mostly transparent space that must not answer to the cursor.
fn bubbleHoverHit(model: *const Model, win_x: f64, win_y: f64, window_h: f64, cursor_x: f64, cursor_y: f64) bool {
    if (!bubbleActive(model)) return false;
    _ = window_h;
    const r = bubbleCardsRect(model);
    const x0 = win_x + @as(f64, @floatCast(r.x));
    const y0 = win_y + @as(f64, @floatCast(r.y));
    return cursor_x >= x0 and cursor_x <= x0 + @as(f64, @floatCast(r.w)) and
        cursor_y >= y0 and cursor_y <= y0 + @as(f64, @floatCast(r.h));
}

fn bubbleHoverIdentityAt(model: *const Model, win_x: f64, win_y: f64, cursor_x: f64, cursor_y: f64) u64 {
    if (!bubbleActive(model) or !model.bubble_group_visible or bubbleContentReveal(model, 0) <= 0.001) return 0;
    const local_x: f32 = @floatCast(cursor_x - win_x);
    const local_y: f32 = @floatCast(cursor_y - win_y);
    if (comptime builtin.target.os.tag == .macos)
        return plat.bubbleNativeCardIdentityAt(local_x, local_y, bubble_hover_slop);

    const origin_y = bubbleStackOriginY(model);
    var remaining = model.bubbles_len;
    while (remaining > 0) {
        remaining -= 1;
        if (!bubbleCardPresented(model, remaining)) continue;
        const frame = bubbleVisualFrame(model, remaining);
        const x = bubble_canvas_margin + frame.x;
        const y = origin_y + frame.y;
        if (local_x >= x - bubble_hover_slop and local_x <= x + frame.w + bubble_hover_slop and
            local_y >= y - bubble_hover_slop and local_y <= y + frame.h + bubble_hover_slop)
            return bubbleVisualIdentity(&model.bubbles[remaining]);
    }
    return 0;
}

/// The part of the stack update that needs no cursor: which side of the
/// pet the stack hangs from, and the walk of the expansion toward its
/// target. Split out because the throw branch owns its own movement and
/// returns before the cursor is ever polled, and a pet in flight still
/// crosses the flip threshold and still has to settle an open fan.
///
/// `hover_target` is what the expansion aims at. In flight it is forced
/// closed: a fan cannot be hovered while the pet is sailing past the
/// cursor, and leaving it open would fly a stale open stack across the
/// screen.
fn updateBubbleStackMotion(model: *Model, hover_target: f32, now_ms: i64) bool {
    // The flip itself is refreshed by syncBubbleWindow, which every path
    // that moves the pet already calls; keeping it there means no caller
    // can place the window from a stale side.
    model.bubble_expansion_target = hover_target;
    return stepBubbleExpansion(model, now_ms);
}

/// Flip and collapse the stack for a pet in flight. The throw drives its
/// own moveWindow and returns before the cursor poll, so without this
/// the flip flag and the expansion both freeze for the whole arc: the
/// stack hangs off the wrong side of a pet that has long since had room
/// above it, and syncBubbleWindow keeps placing the window from that
/// stale flag.
fn updateBubbleStackInFlight(model: *Model, now_ms: i64) bool {
    if (!bubbleActive(model)) return false;
    const hover_changed = model.bubble_hovered or model.bubble_hovered_identity != 0;
    model.bubble_hover_since_ms = -1;
    model.bubble_hover_exit_since_ms = -1;
    model.bubble_hovered = false;
    model.bubble_hovered_identity = 0;
    if (hover_changed) retargetBubbleGroupSizeSpring(model);
    return updateBubbleStackMotion(model, if (model.bubble_group_visible) 1 else 0, now_ms) or hover_changed;
}

/// Fold one frame of hover + animation into the stack state.
fn updateBubbleStack(model: *Model, cursor_x: f64, cursor_y: f64, now_ms: i64, fx: *Effects) bool {
    if (!bubbleActive(model)) {
        const changed = model.bubble_expansion != 0 or model.bubble_expansion_target != 0 or
            model.bubble_hover_amount != 0 or model.bubble_hovered or model.bubble_hovered_identity != 0 or
            model.bubble_fold_phase != .folded;
        model.bubble_hover_since_ms = -1;
        model.bubble_hover_exit_since_ms = -1;
        model.bubble_expansion_target = 0;
        model.bubble_expansion = 0;
        model.bubble_expansion_velocity = 0;
        model.bubble_hover_amount = 0;
        model.bubble_hover_velocity = 0;
        model.bubble_hovered = false;
        model.bubble_hovered_identity = 0;
        model.bubble_fold_phase = .folded;
        if (changed) plat.clearBubbleNativePresentation();
        return changed;
    }

    var hovered_identity: u64 = 0;
    if (fx.moveWindow("bubble", 0, 0, false)) |bub| {
        hovered_identity = if (builtin.target.os.tag == .linux)
            bubbleHoverIdentityAt(model, bub.x, bub.y, bub.x + bub.cursor_x, bub.y + bub.cursor_y)
        else
            bubbleHoverIdentityAt(model, bub.x, bub.y, cursor_x, cursor_y);
    }
    const hover_changed = updateBubbleHoverIdentity(model, hovered_identity, now_ms);
    return updateBubbleStackMotion(model, model.bubble_expansion_target, now_ms) or hover_changed;
}

/// The bubble drawn closest to the pet, i.e. the one the tail points at
/// and the only one the single avatar slot can serve. Null when the
/// stack is empty.
fn newestBubble(model: *const Model) ?*const hook_server.Bubble {
    if (model.bubbles_len == 0) return null;
    return &model.bubbles[newestOf(model.bubbles[0..model.bubbles_len])];
}

fn frontBubble(model: *const Model) ?*const hook_server.Bubble {
    if (model.bubbles_len == 0) return null;
    return &model.bubbles[bubblePresentedFrontSlot(model)];
}

const server_title_sync_interval_ms: i64 = 2000;

fn syncStoredSessionTitles(model: *Model, now_ms: i64) void {
    if (now_ms < model.next_title_sync_ms) return;
    model.next_title_sync_ms = now_ms + server_title_sync_interval_ms;
    const home = env_home orelse return;
    for (model.bubbles[0..model.bubbles_len]) |*bubble| {
        if (bubble.remote or bubble.session_len == 0) continue;
        var title_buf: [256]u8 = undefined;
        const title = hook_runner.storedServerTitle(
            bubble.agent[0..bubble.agent_len],
            home,
            bubble.sessionSlice(),
            &title_buf,
        ) orelse continue;
        _ = hook_server.mailbox.setBubbleTitleIdentity(
            bubble.sessionSlice(),
            title,
            bubble.agent[0..bubble.agent_len],
            bubble.hostnameSlice(),
            false,
            true,
        );
    }
}

fn clearBubble(model: *Model) void {
    model.bubbles = @splat(.{});
    model.bubbles_len = 0;
    model.bubble_expires_at_ms = @splat(-1);
    model.bubble_group_size_spring = .{};
    model.bubble_card_height_springs = @splat(.{});
    model.bubble_window_last_geometry_sync_ms = 0;
    model.bubble_presentation_due_ms = 0;
    model.bubble_render_dirty.clear();
    model.bubble_fold_phase = .folded;
    model.bubble_hover_exit_since_ms = -1;
    model.bubble_group_visible = false;
    model.bubble_show_recent_only = false;
    model.bubble_group_manually_closed = false;
    model.pinned_bubble_identity = 0;
    model.expanded_subagent_identity = 0;
    hook_server.mailbox.clearBubbles();
    plat.clearBubbleNativePresentation();
}

fn removeBubbleAt(model: *Model, slot: usize) ?hook_server.Bubble {
    if (slot >= model.bubbles_len) return null;
    const removed = model.bubbles[slot];
    var i = slot;
    while (i + 1 < model.bubbles_len) : (i += 1) {
        model.bubbles[i] = model.bubbles[i + 1];
        model.bubble_expires_at_ms[i] = model.bubble_expires_at_ms[i + 1];
    }
    model.bubbles_len -= 1;
    model.bubbles[model.bubbles_len] = .{};
    model.bubble_expires_at_ms[model.bubbles_len] = -1;
    const removed_identity = bubbleVisualIdentity(&removed);
    if (model.pinned_bubble_identity == removed_identity) model.pinned_bubble_identity = 0;
    if (model.expanded_subagent_identity == removed_identity) model.expanded_subagent_identity = 0;
    if (model.bubbles_len == 0) {
        model.bubble_group_visible = false;
        model.bubble_show_recent_only = false;
        model.bubble_group_manually_closed = false;
        model.bubble_expansion_target = 0;
        model.bubble_expansion = 0;
        model.bubble_expansion_velocity = 0;
        model.bubble_fold_phase = .folded;
        model.bubble_hover_exit_since_ms = -1;
    }
    return removed;
}

/// Remove dismissed quiet sessions from a complete mailbox snapshot. A busy
/// update is the unambiguous start of new work: it clears the persistent mute
/// before the card reaches presentation ordering, so the revived session
/// appears normally and can become the front card.
fn filterDismissedBubbles(model: *Model, bubbles: *[hook_server.max_bubbles]hook_server.Bubble, count: usize) usize {
    var kept: usize = 0;
    var dismissal_changed = false;
    for (bubbles[0..count]) |bubble| {
        const identity = bubbleIdentityHash(&bubble) orelse {
            bubbles[kept] = bubble;
            kept += 1;
            continue;
        };
        if (dismissedSessionIndex(model, identity) == null) {
            bubbles[kept] = bubble;
            kept += 1;
            continue;
        }
        if (bubble.status == .running or bubble.status == .needs_input) {
            dismissal_changed = removeDismissedSessionHash(model, identity) or dismissal_changed;
            bubbles[kept] = bubble;
            kept += 1;
        } else {
            // The mailbox mirrors every reconnect/title refresh as a complete
            // set. Remove this quiet entry there too so it cannot consume one
            // of the eight live slots while hidden.
            dropMailboxBubble(&bubble);
        }
    }
    for (kept..count) |i| bubbles[i] = .{};
    if (dismissal_changed) saveDismissedSessions(model);
    return kept;
}

const close_pet_window_labels = [_][]const u8{ "bubble", "main" };

fn closePet(model: *Model, fx: *Effects) void {
    clearBubble(model);
    for (close_pet_window_labels) |label| fx.closeWindow(label);
}

/// Index of the most recently updated bubble in `drained`.
///
/// By `counter`, NOT by position: the mailbox keeps its slots in
/// insertion order and a repeat session overwrites its own entry in
/// place (see hook_server.setBubble), so the last slot is the session
/// that FIRST appeared, not the one that spoke last. Only the counter
/// tracks recency.
fn newestOf(bubbles: []const hook_server.Bubble) usize {
    var newest: usize = 0;
    for (bubbles, 0..) |*b, i| {
        if (b.counter > bubbles[newest].counter) newest = i;
    }
    return newest;
}

/// Put bubbles in oldest-to-newest order for the stacked renderer. The
/// mailbox deliberately keeps insertion order so a session update can be
/// applied in place; the view deliberately keeps the newest card in the last
/// slot. Counters are globally monotonic, so this stable insertion sort is
/// deterministic and preserves the original order for equal test fixtures.
fn sortBubblesByCounter(bubbles: []hook_server.Bubble) void {
    if (bubbles.len < 2) return;
    for (1..bubbles.len) |i| {
        const value = bubbles[i];
        var j = i;
        while (j > 0 and bubbles[j - 1].counter > value.counter) : (j -= 1) {
            bubbles[j] = bubbles[j - 1];
        }
        bubbles[j] = value;
    }
}

fn pinnedBubbleIndex(model: *const Model) ?usize {
    if (model.pinned_bubble_identity == 0) return null;
    for (model.bubbles[0..model.bubbles_len], 0..) |*bubble, i| {
        if (bubbleIsPinned(model, bubble)) return i;
    }
    return null;
}

fn presentationFrontIndex(model: *const Model) usize {
    if (pinnedBubbleIndex(model)) |pinned| return pinned;
    var newest_needs_input: ?usize = null;
    var newest_running: ?usize = null;
    for (model.bubbles[0..model.bubbles_len], 0..) |*bubble, i| {
        if (bubble.status == .needs_input) {
            if (newest_needs_input == null or bubble.counter > model.bubbles[newest_needs_input.?].counter) newest_needs_input = i;
            continue;
        }
        if (!bubbleKeepsAlive(bubble)) continue;
        if (newest_running == null or bubble.counter > model.bubbles[newest_running.?].counter) newest_running = i;
    }
    return newest_needs_input orelse newest_running orelse newestOf(model.bubbles[0..model.bubbles_len]);
}

fn applyBubblePresentationOrder(model: *Model) void {
    if (model.bubbles_len <= 1) return;
    const front = presentationFrontIndex(model);
    if (front + 1 == model.bubbles_len) return;
    const bubble = model.bubbles[front];
    const deadline = model.bubble_expires_at_ms[front];
    var i = front;
    while (i + 1 < model.bubbles_len) : (i += 1) {
        model.bubbles[i] = model.bubbles[i + 1];
        model.bubble_expires_at_ms[i] = model.bubble_expires_at_ms[i + 1];
    }
    model.bubbles[model.bubbles_len - 1] = bubble;
    model.bubble_expires_at_ms[model.bubbles_len - 1] = deadline;
}

/// Fold a drained multi-conversation set down to the single newest
/// bubble, which is the classic pre-stack behaviour: one card, newest
/// update wins, with the tail.
///
/// Done here in the CONSUMER rather than in the mailbox on purpose. The
/// protocol does not change: the CLI keeps sending session_id, the
/// server keeps one slot per conversation, and flipping the setting
/// needs no session restart. It only changes how many of those slots
/// reach the model. Turning the setting back on therefore costs nothing
/// but the next event from each live session, which repopulates its own
/// slot.
fn collapseToNewest(drained: []hook_server.Bubble, count: usize) usize {
    if (count <= 1) return count;
    const newest = newestOf(drained[0..count]);
    if (newest != 0) drained[0] = drained[newest];
    for (1..count) |i| drained[i] = .{};
    return 1;
}

/// The same fold applied to a stack that is ALREADY on screen, for the
/// moment the setting is switched off mid-flight.
///
/// Carries the surviving bubble's deadline and manual disclosure state across
/// with it, so changing feed density neither grants a fresh lease nor closes a
/// group the user deliberately left visible.
fn collapseModelToNewest(model: *Model) void {
    if (model.bubbles_len <= 1) return;
    const newest = newestOf(model.bubbles[0..model.bubbles_len]);
    if (newest != 0) {
        model.bubbles[0] = model.bubbles[newest];
        model.bubble_expires_at_ms[0] = model.bubble_expires_at_ms[newest];
    }
    for (1..model.bubbles_len) |i| {
        model.bubbles[i] = .{};
        model.bubble_expires_at_ms[i] = -1;
    }
    model.bubbles_len = 1;
    model.bubble_hover_since_ms = -1;
    model.bubble_hover_exit_since_ms = -1;
    model.bubble_hovered = false;
    model.bubble_hovered_identity = 0;
    model.bubble_expansion_target = if (model.bubble_group_visible) 1 else 0;
    retargetBubbleGroupSizeSpring(model);
}

/// Drop every bubble whose deadline has passed, compacting the stack so
/// the survivors stay dense and ordered. Returns whether anything went,
/// since an emptied stack has to tear its window down.
fn expireBubbles(model: *Model, now_ms: i64) bool {
    var kept: usize = 0;
    var dropped = false;
    for (0..model.bubbles_len) |i| {
        if (bubbleLifetimeExpired(model.bubble_expires_at_ms[i], now_ms, model.state)) {
            // Tell the server too: a slot the app stopped drawing must
            // not keep a session alive against the eviction policy.
            const expired_identity = bubbleVisualIdentity(&model.bubbles[i]);
            dropMailboxBubble(&model.bubbles[i]);
            if (model.pinned_bubble_identity == expired_identity) model.pinned_bubble_identity = 0;
            if (model.expanded_subagent_identity == expired_identity) model.expanded_subagent_identity = 0;
            dropped = true;
            continue;
        }
        model.bubbles[kept] = model.bubbles[i];
        model.bubble_expires_at_ms[kept] = model.bubble_expires_at_ms[i];
        kept += 1;
    }
    for (kept..model.bubbles_len) |i| {
        model.bubbles[i] = .{};
        model.bubble_expires_at_ms[i] = -1;
    }
    model.bubbles_len = kept;
    if (kept == 0) {
        model.bubble_group_visible = false;
        model.bubble_show_recent_only = false;
        model.bubble_group_manually_closed = false;
        model.bubble_expansion = 0;
        model.bubble_expansion_target = 0;
        model.bubble_expansion_velocity = 0;
        model.bubble_fold_phase = .folded;
    }
    return dropped;
}

/// Re-key the deadlines onto a freshly drained stack. The mailbox owns
/// membership and order, so a bubble that was already on screen keeps
/// the deadline it had (re-stamping it on every unrelated update would
/// make a quiet session immortal), and only new or changed entries get
/// a fresh one.
fn syncBubbleDeadlines(model: *Model, previous: []const hook_server.Bubble, previous_deadlines: []const i64, now_ms: i64) void {
    for (0..model.bubbles_len) |i| {
        const fresh = bubbleExpiryMs(now_ms, model.bubble_lifetime_secs, bubbleKeepsAlive(&model.bubbles[i]));
        model.bubble_expires_at_ms[i] = fresh;
        for (previous, previous_deadlines) |old, deadline| {
            if (bubbleVisualIdentity(&old) != bubbleVisualIdentity(&model.bubbles[i])) continue;
            if (old.counter == model.bubbles[i].counter) model.bubble_expires_at_ms[i] = deadline;
            break;
        }
    }
    for (model.bubbles_len..hook_server.max_bubbles) |i| model.bubble_expires_at_ms[i] = -1;
}

/// The window tracks exactly what is drawn: the sprite, plus a band
/// above it while a bubble is showing (kept at least bubble-wide so
/// the text can wrap like the old 190px-capped tooltip).
fn fitWindow(model: *const Model, fx: *Effects) bool {
    // The Linux Wayland pet keeps its fixed max-size startup canvas.
    // Win/mac retain the upstream sprite-sized main window.
    if (builtin.target.os.tag == .linux) return true;
    return fx.resizeWindow("main", frame_w * model.scale, frame_h * model.scale, .bottom_center);
}

/// Track the bubble window's last known size so a settings change that
/// grows the card can grow the window with it. The window is created
/// once at its then-current size; without this it keeps that size
/// forever and a larger card renders off its right edge while the tail
/// points at nothing.
var bubble_window_w: f32 = 0;
var bubble_window_h: f32 = 0;
const window_position_epsilon: f64 = 0.5;

const BubbleMovePlan = struct {
    dx: f64,
    dy: f64,
};

/// Calculate a global-coordinate move without applying a display clamp.
/// The caller applies the destination display's visible-frame constraint
/// only after this move has crossed any monitor boundary.
fn bubbleMovePlan(cur_x: f64, cur_y: f64, want_x: f64, want_y: f64) ?BubbleMovePlan {
    const dx = want_x - cur_x;
    const dy = want_y - cur_y;
    if (@abs(dx) <= window_position_epsilon and @abs(dy) <= window_position_epsilon) return null;
    return .{ .dx = dx, .dy = dy };
}

/// Return a correction from the host's reported clamped origin to the
/// origin that a readback says is actually on screen. Older Native SDK
/// hosts reported a zero-delta clamp result without applying the origin;
/// the second, unbounded leg below keeps this app correct with either host.
fn bubbleClampCorrection(actual_x: f64, actual_y: f64, settled_x: f64, settled_y: f64) ?BubbleMovePlan {
    return bubbleMovePlan(actual_x, actual_y, settled_x, settled_y);
}

fn bubbleCurrentWindowHeight(model: *const Model) f32 {
    if (!model.bubble_render_dirty.any() and bubble_window_h > 0) return bubble_window_h;
    return bubbleWindowHeight(model);
}

fn updateBubbleScreenPlacement(model: *Model) void {
    const pet_w = frame_w * model.scale;
    const pet_h = frame_h * model.scale;
    const pet_center_x = model.pet_x + pet_w / 2;
    const pet_center_y = model.pet_y + pet_h / 2;
    const screen = plat.visibleScreenFrameAt(pet_center_x, pet_center_y) orelse {
        model.bubble_secondary_lane = false;
        model.bubble_flipped = bubbleShouldFlip(model, model.pet_y, @floatCast(bubbleCurrentWindowHeight(model)));
        return;
    };

    // Measure the preferred single column first. A second outward lane halves
    // vertical pressure only when neither side can contain that column.
    const was_secondary = model.bubble_secondary_lane;
    model.bubble_secondary_lane = false;
    const single_height: f64 = @floatCast(bubbleCurrentWindowHeight(model));
    const above = @max(0, model.pet_y - screen.y);
    const below = @max(0, screen.y + screen.height - (model.pet_y + pet_h));
    const required = single_height + bubble_pet_clearance;
    const keep_secondary = was_secondary and @max(above, below) < required + bubble_flip_hysteresis;
    if (!keep_secondary and above >= required) {
        model.bubble_flipped = false;
        return;
    }
    if (!keep_secondary and below >= required) {
        model.bubble_flipped = true;
        return;
    }
    model.bubble_secondary_lane = bubblePresentedCount(model) > 1;
    model.bubble_flipped = below > above;
}

fn bubbleWantX(model: *const Model, bubble_w: f32) f64 {
    return model.pet_x + @as(f64, @floatCast(frame_w * model.scale - bubble_w)) / 2.0;
}

/// Keep the bubble window glued above the pet and sized to its content:
/// read both origins and close the gap. Self-correcting, so drags,
/// throws, scale changes, and text-size changes all need no
/// special-casing.
fn syncBubbleWindow(model: *Model, fx: *Effects) void {
    // Linux uses a parent-local compositor popup. Its descriptor drives
    // size and anchoring, so application-side global moves are both
    // unnecessary and invalid on Wayland.
    if (!bubbleActive(model)) return;
    const now_ms = fx.wallMs();
    if (builtin.target.os.tag == .linux) {
        syncBubbleGlass(model, fx, bubbleWindowHeight(model), now_ms);
        return;
    }
    // Pet physics may run at display rate, but companion-window placement is
    // intentionally capped at 30 Hz. Retain the dirty geometry so the
    // one-shot scheduler catches the newest position rather than performing
    // an AppKit transaction for every pet frame.
    if (model.bubble_window_last_geometry_sync_ms > 0 and
        now_ms - model.bubble_window_last_geometry_sync_ms < bubble_geometry_commit_interval_ms)
    {
        invalidateBubblePresentation(model, .{ .geometry = true });
        return;
    }
    model.bubble_window_last_geometry_sync_ms = now_ms;
    // The flip is decided HERE, in the function that consumes it, rather
    // than by each caller beforehand. bubbleWantY below reads the flag,
    // so a caller that moved the pet and forgot to refresh it first would
    // place the window on the side the pet used to be on. That is exactly
    // what the throw branch did: it drives its own moveWindow and returns
    // before the cursor poll, so it never reached the frame clock's
    // update and flew the whole arc with a stale flag.
    const prior_flipped = model.bubble_flipped;
    const prior_secondary_lane = model.bubble_secondary_lane;
    updateBubbleScreenPlacement(model);
    if (prior_flipped != model.bubble_flipped or prior_secondary_lane != model.bubble_secondary_lane)
        invalidateBubblePresentation(model, .{ .geometry = true });
    // A stationary card group does not need to remeasure text merely because
    // the pet/window polling path ran. The retained window size is already
    // authoritative until content or a spring invalidates geometry.
    const measure_window = model.bubble_render_dirty.any() or bubble_window_w <= 0 or bubble_window_h <= 0;
    const bubble_w = if (measure_window) bubbleWindowWidth(model) else bubble_window_w;
    const bubble_h = if (measure_window) bubbleWindowHeight(model) else bubble_window_h;
    // Resize before moving: the move centers on the new width, so doing
    // it the other way round centers on the old one and leaves the
    // bubble offset by half the delta.
    if (@abs(bubble_w - bubble_window_w) > 0.5 or @abs(bubble_h - bubble_window_h) > 0.5) {
        _ = fx.resizeWindow("bubble", bubble_w, bubble_h, .top_left);
        bubble_window_w = bubble_w;
        bubble_window_h = bubble_h;
        model.bubble_window_presentation_generation +%= 1;
        invalidateBubblePresentation(model, .{ .geometry = true });
    }
    const cur = fx.moveWindow("bubble", 0, 0, false) orelse return;
    const want_x = bubbleWantX(model, bubble_w);
    const want_y = bubbleWantY(model, bubble_h);
    if (bubbleMovePlan(cur.x, cur.y, want_x, want_y)) |plan| {
        // `true` constrains against the display that currently owns the
        // window. It cannot be used for the first leg of a cross-display
        // move: the bubble would remain trapped on the old display.
        _ = fx.moveWindow("bubble", plan.dx, plan.dy, false) orelse return;
        model.bubble_window_presentation_generation +%= 1;
        invalidateBubblePresentation(model, .{ .geometry = true });
        // The global move has reached the target display. A zero-distance
        // constrained move now lets that display apply its visible-frame
        // correction, including negative coordinates and taskbar insets.
        const settled = fx.moveWindow("bubble", 0, 0, true) orelse return;
        // The pre-fix macOS host returned the clamped origin here but did
        // not call setFrameOrigin when dx/dy were zero. Read the actual
        // origin back and reconcile that legacy behavior explicitly; this
        // also makes the app robust while an SDK fix is rolling out.
        const actual = fx.moveWindow("bubble", 0, 0, false) orelse return;
        if (bubbleClampCorrection(actual.x, actual.y, settled.x, settled.y)) |correction| {
            const corrected = fx.moveWindow("bubble", correction.dx, correction.dy, false) orelse return;
            if (recordPetCenterLocal(model, corrected.x))
                invalidateBubblePresentation(model, .{ .geometry = true });
        } else {
            if (recordPetCenterLocal(model, actual.x))
                invalidateBubblePresentation(model, .{ .geometry = true });
        }
        syncBubbleGlass(model, fx, bubble_h, now_ms);
        return;
    }
    if (recordPetCenterLocal(model, cur.x))
        invalidateBubblePresentation(model, .{ .geometry = true });
    syncBubbleGlass(model, fx, bubble_h, now_ms);
}

fn applyBubbleNativeControlSemantics(control: *plat.BubbleNativeControl) void {
    switch (control.action) {
        .toggle_visibility => {
            control.accessibility_label.set("Show or hide agent sessions");
            control.accessibility_value.set(switch (control.disclosure_mode) {
                .all => "All sessions shown",
                .recent => "Recent sessions shown",
                .hidden => "Sessions hidden",
            });
            control.accessibility_role = .toggle_button;
            control.toggled = control.selected;
        },
        .open => control.accessibility_label.set("Open agent session"),
        .pin => {
            control.accessibility_label.set(if (control.selected) "Unpin agent session" else "Pin agent session");
            control.accessibility_value.set(if (control.selected) "Pinned" else "Not pinned");
            control.accessibility_role = .toggle_button;
            control.toggled = control.selected;
        },
        .subagents => {
            control.accessibility_label.set(if (control.selected) "Collapse subagent messages" else "Expand subagent messages");
            control.accessibility_value.set(if (control.selected) "Expanded" else "Collapsed");
            control.accessibility_role = .toggle_button;
            control.toggled = control.selected;
        },
        .dismiss => control.accessibility_label.set("Dismiss agent session"),
    }
}

fn appendBubbleNativeControl(out: *[plat.max_bubble_native_controls]plat.BubbleNativeControl, count: *usize, source: plat.BubbleNativeControl) void {
    if (count.* >= out.len) return;
    var control = source;
    applyBubbleNativeControlSemantics(&control);
    out[count.*] = control;
    count.* += 1;
}

const bubble_disclosure_identity: u64 = 0xf4d6_9bc2_35a8_710e;

fn bubbleCanActivateOrigin(bubble: *const hook_server.Bubble) bool {
    return plat.canActivateOrigin(bubble.origin_app, bubble.ttySlice(), bubble.cwdSlice());
}

fn bubbleCardActionCount(bubble: *const hook_server.Bubble) usize {
    var count: usize = 0;
    if (bubbleCanActivateOrigin(bubble)) count += 1;
    if (bubble.session_len > 0) count += 1;
    if (bubble.child_messages_len > 0) count += 1;
    if (bubbleDismissible(bubble)) count += 1;
    return count;
}

fn bubbleCardActionRailWidth(bubble: *const hook_server.Bubble) f32 {
    const count = bubbleCardActionCount(bubble);
    if (count == 0) return 0;
    return bubble_control_size * @as(f32, @floatFromInt(count)) +
        bubble_control_gap * @as(f32, @floatFromInt(count - 1));
}

fn bubbleCardActionRailFrame(model: *const Model, slot: usize) ?BubbleRect {
    if (slot >= model.bubbles_len or !bubbleCardPresented(model, slot)) return null;
    const rail_width = bubbleCardActionRailWidth(&model.bubbles[slot]);
    if (rail_width <= 0) return null;
    const frame = bubbleVisualFrame(model, slot);
    return .{
        .x = bubble_canvas_margin + frame.x + frame.w - bubble_card_padding - rail_width,
        .y = bubbleStackOriginY(model) + frame.y + @max(bubble_card_padding, (frame.h - bubble_control_size) / 2),
        .w = rail_width,
        .h = bubble_control_size,
    };
}

fn bubbleNativeControlsWithPolicy(model: *const Model, out: *[plat.max_bubble_native_controls]plat.BubbleNativeControl, include_unhovered: bool) usize {
    // Constructing the presentation model is portable and is covered on every
    // host. Only submitting it to AppKit is macOS-specific (syncBubbleGlass).
    if (model.bubbles_len == 0) return 0;
    var count: usize = 0;
    const disclosure = bubbleDisclosureFrame(model);
    const mode = bubbleDisplayMode(model);
    const disclosure_presentation = bubbleDisclosurePresentation(model);
    const group_status = bubbleGroupSemanticState(model);
    appendBubbleNativeControl(out, &count, .{
        .identity = bubble_disclosure_identity,
        .action = .toggle_visibility,
        .x = disclosure.x,
        .y = disclosure.y,
        .w = disclosure.w,
        .h = disclosure.h,
        .selected = mode != .hidden,
        .badge_count = if (mode == .hidden and !disclosure_presentation.show_status_icon)
            @intCast(model.bubbles_len)
        else
            0,
        .presentation_alpha = disclosure_presentation.alpha,
        .activation_inset = bubble_disclosure_activation_inset,
        .points_up = model.bubble_flipped,
        .disclosure_mode = switch (mode) {
            .all => .all,
            .recent => .recent,
            .hidden => .hidden,
        },
        .semantic_state = group_status,
        .show_status_icon = disclosure_presentation.show_status_icon,
    });

    for (0..model.bubbles_len) |slot| {
        if (!bubbleCardPresented(model, slot)) continue;
        const content_reveal = bubbleContentReveal(model, slot);
        if (content_reveal <= 0.5) continue;
        const bubble = &model.bubbles[slot];
        const identity = bubbleVisualIdentity(bubble);
        const hovered = identity == model.bubble_hovered_identity and model.bubble_hover_amount > 0.15;
        if (!include_unhovered and !hovered) continue;
        var actions: [4]plat.BubbleNativeControlAction = undefined;
        var action_count: usize = 0;
        if (bubbleCanActivateOrigin(bubble)) {
            actions[action_count] = .open;
            action_count += 1;
        }
        if (bubble.session_len > 0) {
            actions[action_count] = .pin;
            action_count += 1;
        }
        if (bubble.child_messages_len > 0) {
            actions[action_count] = .subagents;
            action_count += 1;
        }
        if (bubbleDismissible(bubble)) {
            actions[action_count] = .dismiss;
            action_count += 1;
        }
        if (action_count == 0) continue;
        const rail = bubbleCardActionRailFrame(model, slot) orelse continue;
        var action_x = rail.x;
        const action_y = rail.y;
        for (actions[0..action_count]) |action| {
            appendBubbleNativeControl(out, &count, .{
                .identity = identity,
                .action = action,
                .x = action_x,
                .y = action_y,
                .w = bubble_control_size,
                .h = bubble_control_size,
                .selected = switch (action) {
                    .pin => bubbleIsPinned(model, bubble),
                    .subagents => bubbleSubagentsPinned(model, bubble),
                    else => false,
                },
                // Linux retains these action nodes even before pointer hover so
                // GTK keyboard traversal and assistive technology can discover
                // every available command. The portable canvas remains the
                // visual/pointer authority until hover reveals the rail.
                .presentation_alpha = if (hovered) std.math.clamp(model.bubble_hover_amount, 0, 1) else 0,
                .activation_inset = bubble_control_activation_inset,
                .overlay = true,
            });
            action_x += bubble_control_size + bubble_control_gap;
        }
    }
    return count;
}

fn bubbleNativeControls(model: *const Model, out: *[plat.max_bubble_native_controls]plat.BubbleNativeControl) usize {
    return bubbleNativeControlsWithPolicy(model, out, false);
}

fn bubbleNativeSemanticState(bubble: *const hook_server.Bubble) plat.BubbleGlassSemanticState {
    return switch (bubble.status) {
        .idle => .idle,
        .running => .running,
        .needs_input => .needs_input,
        .completed => .completed,
        .failed => .failed,
    };
}

fn scaleBubbleNativeFrame(frame: plat.BubbleNativeFrame, scale_x: f32, scale_y: f32) plat.BubbleNativeFrame {
    return .{
        .x = frame.x * scale_x,
        .y = frame.y * scale_y,
        .w = frame.w * scale_x,
        .h = frame.h * scale_y,
    };
}

fn syncBubbleGlass(model: *Model, fx: *Effects, window_height: f32, now_ms: i64) void {
    if ((builtin.target.os.tag != .macos and builtin.target.os.tag != .windows and builtin.target.os.tag != .linux) or model.bubbles_len == 0) return;
    if (!bubblePresentationMayCommit(model, now_ms)) return;
    const dirty = model.bubble_render_dirty;
    ensureBubbleLayoutCache(model);
    model.bubble_render_stats.snapshot_builds += 1;
    var presentation: plat.BubbleNativePresentation = .{};
    presentation.window_height = window_height;
    presentation.placement_generation = model.bubble_window_presentation_generation;
    const origin_y = bubbleStackOriginY(model);
    for (0..model.bubbles_len) |slot| {
        if (slot >= presentation.cards.len) break;
        const bubble = &model.bubbles[slot];
        const metrics = bubbleLayoutMetrics(model, slot);
        const frame = bubbleVisualFrame(model, slot);
        const glass = plat.BubbleGlassRect{
            .identity = bubbleVisualIdentity(bubble),
            .x = bubble_canvas_margin + frame.x,
            .y = origin_y + frame.y,
            .w = frame.w,
            .h = frame.h,
            .alpha = frame.alpha,
            .corner_radius = bubble_card_radius * frame.scale,
            .role = .card,
            .dark_appearance = model.dark,
            .high_contrast = model.high_contrast,
            .semantic_state = bubbleNativeSemanticState(bubble),
            .interaction_state = if (bubbleIsPinned(model, bubble))
                .selected
            else if (bubbleVisualIdentity(bubble) == model.bubble_hovered_identity)
                .hovered
            else
                .idle,
            .materialization = if (!bubbleCardPresented(model, slot))
                .hidden
            else switch (model.bubble_fold_phase) {
                .folded => .hidden,
                .materializing => .materializing,
                .unfolding, .unfolded => .visible,
                .collapsing => .collapsing,
            },
        };
        var native: plat.BubbleNativeCardSnapshot = .{
            .glass = glass,
            .content_alpha = bubbleContentReveal(model, slot) * frame.alpha,
            // Header labels live in the resting card geometry; folding still
            // hides the entire native content through `content_alpha`.
            .metadata_alpha = 1,
            .nested_alpha = metrics.nested_reveal,
            .metadata_font_size = bubbleHeaderTextSize(model) * frame.scale,
            .title_font_size = bubbleTitleFontSize(model) * frame.scale,
            .message_font_size = bubbleMessageFontSize(model) * frame.scale,
            .nested_font_size = bubbleHeaderTextSize(model) * frame.scale,
            .busy = bubble.busy,
            .reduce_motion = model.reduce_motion,
            .shimmer_phase = model.bubble_shimmer_phase,
        };
        native.agent.set(agentDisplayName(bubble.agent[0..bubble.agent_len]));
        native.hostname.set(bubbleHostname(bubble));
        native.project.set(bubbleProjectName(bubble));
        native.title.set(metrics.title_text);
        var accessibility_label_buf: [plat.bubble_native_accessibility_text_capacity]u8 = undefined;
        const accessibility_label = std.fmt.bufPrint(&accessibility_label_buf, "Agent session: {s}", .{metrics.title_text}) catch "Agent session";
        native.accessibility_label.set(accessibility_label);
        native.accessibility_value.set(switch (bubble.status) {
            .idle => "Idle",
            .running => "Running",
            .needs_input => "Needs input",
            .completed => "Completed",
            .failed => "Failed",
        });
        native.action_available = bubbleCanActivateOrigin(bubble);
        for (metrics.message_lines, 0..) |line, row| {
            if (line.len == 0) continue;
            native.message_lines[row].set(line);
            native.message_line_count += 1;
        }

        const scale_x = frame.w / @max(1, frame.base_w);
        const scale_y = frame.h / @max(1, frame.base_h);
        const base_inner_width = @max(1, frame.base_w - bubble_card_padding * 2);
        const metadata_y = metrics.metadata_y;
        const metadata_height = metrics.metadata_height;
        native.metadata_frame = scaleBubbleNativeFrame(.{
            .x = bubble_card_padding,
            .y = metadata_y,
            .w = base_inner_width,
            .h = metadata_height,
        }, scale_x, scale_y);

        native.metadata_left_frame = scaleBubbleNativeFrame(.{
            .x = bubble_card_padding + metrics.metadata_left_x,
            .y = metadata_y,
            .w = metrics.metadata_left_width,
            .h = metadata_height,
        }, scale_x, scale_y);

        const status_gap: f32 = if (metrics.status_slot_width > 0) bubble_content_gap else 0;
        native.title_frame = scaleBubbleNativeFrame(.{
            .x = bubble_card_padding,
            .y = metrics.title_y,
            .w = @max(1, base_inner_width - metrics.status_slot_width - status_gap),
            .h = metrics.title_height,
        }, scale_x, scale_y);
        if (metrics.status_slot_width > 0) {
            native.status_frame = scaleBubbleNativeFrame(.{
                .x = frame.base_w - bubble_card_padding - 15,
                .y = metrics.title_y + @max(0, (metrics.title_height - 15) / 2),
                .w = 15,
                .h = 15,
            }, scale_x, scale_y);
        }
        for (0..plat.bubble_native_message_lines) |row| {
            if (row >= native.message_line_count) break;
            native.message_frames[row] = scaleBubbleNativeFrame(.{
                .x = bubble_card_padding,
                .y = metrics.message_y + @as(f32, @floatFromInt(row)) * (metrics.message_line_height + bubble_line_gap),
                .w = base_inner_width,
                .h = metrics.message_line_height,
            }, scale_x, scale_y);
        }

        if (metrics.nested_message_count > 0) {
            const nested_start = bubble.child_messages_len - metrics.nested_message_count;
            for (0..metrics.nested_message_count) |row| {
                native.nested_lines[row].set(bubbleChildRowText(slot, row, &bubble.child_messages[nested_start + row]));
                native.nested_frames[row] = scaleBubbleNativeFrame(.{
                    .x = bubble_card_padding,
                    .y = metrics.nested_y + @as(f32, @floatFromInt(row)) * (metrics.nested_line_height + bubble_line_gap),
                    .w = base_inner_width,
                    .h = metrics.nested_line_height,
                }, scale_x, scale_y);
                native.nested_line_count += 1;
            }
        }
        if (metrics.nested_overflow_count > 0 and native.nested_line_count < native.nested_lines.len) {
            const row: usize = native.nested_line_count;
            const overflow = std.fmt.bufPrint(&bubble_child_overflow_scratch[slot], "+{d} more", .{metrics.nested_overflow_count}) catch "+more";
            native.nested_lines[row].set(overflow);
            native.nested_frames[row] = scaleBubbleNativeFrame(.{
                .x = bubble_card_padding + bubble_agent_icon_width + bubble_content_gap,
                .y = metrics.nested_y + @as(f32, @floatFromInt(row)) * (metrics.nested_line_height + bubble_line_gap),
                .w = @max(1, base_inner_width - bubble_agent_icon_width - bubble_content_gap),
                .h = metrics.nested_line_height,
            }, scale_x, scale_y);
            native.nested_line_count += 1;
        }

        if (bubbleCardActionRailFrame(model, slot)) |rail| {
            const local_rail_x = rail.x - glass.x;
            const fade_x = @max(bubble_card_padding * scale_x, local_rail_x - bubble_control_fade_lead);
            native.action_fade_start = fade_x;
            // The foreground feather belongs only to the card whose own
            // action rail is visible. A different card being hovered must
            // not fade every card in the group.
            if (bubbleVisualIdentity(bubble) == model.bubble_hovered_identity and model.bubble_hover_amount > 0.15)
                native.action_fade_alpha = std.math.clamp(model.bubble_hover_amount, 0, 1) * native.content_alpha;
        }
        presentation.cards[presentation.card_count] = native;
        presentation.card_count += 1;
    }
    const disclosure = bubbleDisclosureFrame(model);
    const group_status = bubbleGroupSemanticState(model);
    const disclosure_glass = plat.BubbleGlassRect{
        .identity = bubble_disclosure_identity,
        .x = disclosure.x,
        .y = disclosure.y,
        .w = disclosure.w,
        .h = disclosure.h,
        .corner_radius = bubble_disclosure_size / 2,
        .semantic_state = group_status,
        .interaction_state = .idle,
        .materialization = .visible,
        .role = .disclosure,
        .dark_appearance = model.dark,
        .high_contrast = model.high_contrast,
    };
    const disclosure_presentation = bubbleDisclosurePresentation(model);
    presentation.disclosure = .{
        .glass = disclosure_glass,
        .visible = true,
        .mode = switch (bubbleDisplayMode(model)) {
            .all => .all,
            .recent => .recent,
            .hidden => .hidden,
        },
        .semantic_state = group_status,
        .session_count = @intCast(model.bubbles_len),
        .show_status_icon = disclosure_presentation.show_status_icon,
        .presentation_alpha = disclosure_presentation.alpha,
        .toggled = bubbleDisplayMode(model) != .hidden,
    };
    presentation.disclosure.accessibility_label.set("Show or hide agent sessions");
    presentation.disclosure.accessibility_value.set(switch (bubbleDisplayMode(model)) {
        .all => "All sessions shown",
        .recent => "Recent sessions shown",
        .hidden => "Sessions hidden",
    });
    var controls: [plat.max_bubble_native_controls]plat.BubbleNativeControl = @splat(.{});
    const control_count = bubbleNativeControlsWithPolicy(model, &controls, builtin.target.os.tag == .linux);
    @memcpy(presentation.controls[0..control_count], controls[0..control_count]);
    presentation.control_count = control_count;
    if (builtin.target.os.tag == .windows or builtin.target.os.tag == .linux) {
        if (plat.bubbleNativePresentationJsonAlloc(boot_allocator, &presentation)) |payload| {
            defer boot_allocator.free(payload);
            if (!fx.emitWindowEvent("bubble", plat.bubble_native_payload_event, payload)) return;
        } else return;
    } else {
        plat.setBubbleNativePresentation(&presentation);
    }
    model.bubble_render_stats.native_submissions += 1;
    if (dirty.geometry or dirty.urgent) model.bubble_render_last_geometry_ms = now_ms;
    if (dirty.content or dirty.appearance) model.bubble_render_last_content_ms = now_ms;
    model.bubble_render_dirty.clear();
}

/// Project the pet's center into the stack container's coordinates.
///
/// `window_x` is where the window ACTUALLY landed, which after an edge
/// clamp is not where it was asked to go. Deriving the axis from the
/// real origin is the whole point: it is the difference between the two
/// that used to leave a narrow card stranded in the middle of a window
/// that had slid away from the pet.
fn recordPetCenterLocal(model: *Model, window_x: f64) bool {
    const pet_center = model.pet_x + (frame_w * model.scale) / 2.0;
    // The container sits inside the canvas margin, so strip it to land
    // in the same space bubbleCardCenterDx works in.
    const next: f32 = @floatCast(pet_center - window_x - bubble_canvas_margin);
    if (@abs(next - model.bubble_pet_center_local) <= 0.25) return false;
    model.bubble_pet_center_local = next;
    return true;
}

/// Where the top of the bubble window wants to sit for the current flip.
/// The clearance is applied to the window edge, not the card's internal
/// margin, so both the speech tail and stacked cards stay outside the pet.
fn bubbleWantY(model: *const Model, bubble_h: f32) f64 {
    if (model.bubble_flipped) return model.pet_y + frame_h * model.scale + bubble_pet_clearance;
    return model.pet_y - bubble_h - bubble_pet_clearance;
}

/// Decide whether the stack hangs below the pet instead of above it.
///
/// The window is always sized to its EXPANDED height, so that is the
/// space the decision has to clear: flipping only once the collapsed
/// stack overflows would send the fan off-screen the moment someone
/// hovers it.
///
/// Hysteresis keeps a pet parked near the threshold from flapping every
/// frame: it takes the full height plus the clearance to flip down, but
/// that threshold plus a margin to come back up.
fn bubbleShouldFlip(model: *const Model, space_above: f64, needed: f64) bool {
    const required = needed + bubble_pet_clearance;
    if (model.bubble_flipped) return space_above < required + bubble_flip_hysteresis;
    return space_above < required;
}

/// What the pet window shows before there is a pet to draw.
///
/// This used to be a bare panel: a grey rectangle with no text and no
/// action, which reads as a broken app rather than an empty one. The two
/// ways to get here need different answers, and the code already knew
/// the difference — it just said so in a debug print nobody sees.
///
/// Nothing installed is the first-run case, and it gets a button. The
/// download rides the same queue a `petdex://` link uses instead of
/// bundling a sheet into every binary: boba is ~2MB against a 4.5MB
/// executable, which is a permanent 43% for a state that ends the moment
/// someone picks a pet.
///
/// Pets installed but none decoded is the other case, and on Linux it is
/// the common one: gdk-pixbuf needs a loader plugin per format and
/// Ubuntu ships none for webp, so every pet fails while sitting right
/// there on disk. Offering that user a download sends them in exactly
/// the wrong direction.
fn emptyStateView(ui: *AppUi, model: *const Model) AppUi.Node {
    const has_pets = catalog_mod.catalog_len > 0;
    // The pet window is 192pt wide, so these have to fit a narrow column
    // rather than a sentence's worth of room: the first attempt read
    // "Pets found, none could be drawn. Linux needs webp-pixbuf-loader."
    // and rendered as an ellipsis. Newlines rather than one long line,
    // since the label truncates instead of wrapping.
    const body = if (!has_pets)
        "No pet yet"
    else if (builtin.os.tag == .linux)
        "Pets found,\nnone could\nbe drawn.\n\nLinux needs\nwebp-pixbuf-\nloader."
    else
        "Pets found,\nnone could\nbe drawn.\n\nThe sheet may\nbe corrupt.";

    // style_tokens rather than a literal colour: the muted token already
    // tracks the theme, which is the same reason the settings rows use it.
    const label = ui.text(.{
        .size = .sm,
        .text_alignment = .center,
        .style_tokens = .{ .foreground = .text_muted },
    }, body);

    var children: [3]AppUi.Node = undefined;
    var count: usize = 0;
    children[count] = label;
    count += 1;
    if (!has_pets) {
        children[count] = ui.button(.{
            .size = .sm,
            .variant = .primary,
            .on_press = Msg.install_first_pet,
        }, if (model.install.busy()) "Downloading..." else "Get a pet");
        count += 1;
    }
    if (model.install.error_len > 0) {
        // Same literal the settings banner uses: the token set has no
        // error colour, so matching it keeps the two error surfaces
        // reading as one thing.
        var err = ui.text(.{ .size = .sm, .text_alignment = .center }, model.install.errorSlice());
        err.widget.style.foreground = canvas.Color.rgb8(250, 105, 94);
        children[count] = err;
        count += 1;
    }

    return ui.panel(.{
        .width = frame_w,
        .height = frame_h,
        .padding = 16,
        .semantics = .{ .label = "No pet installed" },
    }, .{ui.column(.{ .grow = 1, .main = .center, .cross = .center, .gap = 10 }, children[0..count])});
}

pub fn rootView(ui: *AppUi, model: *const Model) AppUi.Node {
    if (!model.sheet_loaded) return emptyStateView(ui, model);
    const w = frame_w * model.scale;
    const h = frame_h * model.scale;
    var node = ui.image(.{
        .width = w,
        .height = h,
        .image = @intCast(model.frame_index + 1),
        .semantics = .{ .label = "Petdex pet" },
    });
    node.widget.image_fit = .stretch;
    node.widget.image_sampling = .nearest;
    // Linux hands primary presses to the compositor through GTK/GDK;
    // secondary presses still follow the canvas context-menu route.
    if (builtin.target.os.tag == .linux) {
        // Bind the menu to the sprite itself, not only its layout parent.
        // The deepest context-menu node on the right-click hit route wins.
        node.context_menu = &pet_menu;
        return ui.column(.{ .grow = 1, .main = .end, .cross = .center, .window_drag = true, .context_menu = &pet_menu }, .{
            node,
            ui.el(.stack, .{ .width = 1, .height = pet_edge_pad }, .{}),
        });
    }
    // Win/mac keep the app-owned drag path and canvas context menu. Unlike the
    // Win32 modal move loop, this keeps frame callbacks running so the
    // companion bubble can be repositioned in the same frame as the pet.
    return ui.column(.{ .grow = 1, .main = .end, .cross = .center, .on_press = .noop, .context_menu = &pet_menu }, .{node});
}

// ----------------------------------------------------------- bubble

/// One conversation's card. `slot` indexes the per-card clip scratch and
/// decides whether this is the newest bubble, which is the only one the
/// single avatar registry slot can speak for.
fn bubbleCard(ui: *AppUi, model: *const Model, slot: usize) AppUi.Node {
    const bubble = &model.bubbles[slot];
    const metrics = bubbleLayoutMetrics(model, slot);
    const card_width = bubbleRenderedCardWidth(model, slot);
    if (builtin.target.os.tag == .macos) {
        // AppKit renders the entire macOS foreground inside the owning
        // NSGlassEffectView.contentView. Keep only an empty authoritative
        // geometry node in Metal so there is exactly one native text node per
        // line and inactive glass/text appearance cannot diverge.
        var placeholder = ui.el(.stack, .{
            .width = card_width,
            .height = bubbleRenderedCardHeight(model, slot),
            .semantics = .{ .label = "Agent session" },
        }, .{});
        placeholder.widget.style.background = canvas.Color.rgba8(0, 0, 0, 0);
        placeholder.widget.style.border = canvas.Color.rgba8(0, 0, 0, 0);
        placeholder.widget.style.stroke_width = 0;
        placeholder.widget.backdrop_blur = 0;
        const native_visual = bubbleVisualFrame(model, slot);
        placeholder.widget.transform = canvas.Affine.translate(native_visual.x, native_visual.y)
            .multiply(canvas.Affine.scale(native_visual.scale_x, native_visual.scale_y));
        placeholder.widget.opacity = native_visual.alpha;
        return placeholder;
    }
    const inner_w = @max(48, card_width - bubble_card_padding * 2);
    const message_size = bubbleMessageFontSize(model);
    const message_scale = message_size / bubbleFontSize(model);
    const title_available_width = metrics.title_text_width;
    const title_clipped = metrics.title_text;
    const text_lines = metrics.message_lines;

    const palette = bubbleContrastPalette(model);
    const title_fg = palette.title;
    const muted_fg = palette.metadata;
    const text_fg = palette.message;
    const hover = if (bubbleVisualIdentity(bubble) == model.bubble_hovered_identity)
        std.math.clamp(model.bubble_hover_amount, 0, 1.2)
    else
        0;
    const content_reveal = bubbleContentRevealForPlatform(model, slot, builtin.target.os.tag);

    // Provenance is a permanent, single measured metadata line. Agent and
    // project use the stronger label color while hostname stays secondary.
    // One clipping parent owns the complete sequence, preventing an isolated
    // project cell from truncating while there is still room on the card.
    const metadata_scale = bubbleHeaderTextSize(model) / bubbleFontSize(model);
    const agent_name = agentDisplayName(bubble.agent[0..bubble.agent_len]);
    const host_text = bubbleHostname(bubble);
    const project = bubbleProjectName(bubble);
    var header_nodes: [2]AppUi.Node = undefined;
    var header_count: usize = 0;
    var left_metadata_spans: [5]canvas.TextSpan = .{
        .{ .text = agent_name, .weight = .medium, .color = .text, .scale = metadata_scale },
        .{ .text = " · ", .color = .text_muted, .scale = metadata_scale },
        .{ .text = host_text, .color = .text_muted, .scale = metadata_scale },
        .{ .text = if (project.len > 0) " · " else "", .color = .text_muted, .scale = metadata_scale },
        .{ .text = project, .color = .text, .scale = metadata_scale },
    };
    var left_metadata = ui.paragraph(.{
        .size = .heading,
        .width = metrics.metadata_left_width,
        .height = metrics.metadata_height,
        .wrap = false,
        .overflow = .ellipsis,
    }, &left_metadata_spans);
    left_metadata.widget.style.foreground = muted_fg;
    var left_metadata_clip = ui.el(.stack, .{
        .width = metrics.metadata_left_width,
        .height = metrics.metadata_height,
    }, .{left_metadata});
    left_metadata_clip.widget.layout.clip_content = true;
    left_metadata_clip.widget.transform = canvas.Affine.translate(metrics.metadata_left_x, 0);
    header_nodes[header_count] = left_metadata_clip;
    header_count += 1;

    var rows: [bubble_answer_lines_max]AppUi.Node = undefined;
    var row_count: usize = 0;
    for (text_lines) |line| {
        if (line.len == 0) continue;
        var shimmer_spans: [bubble_shimmer_span_max]canvas.TextSpan = undefined;
        const spans = bubbleMessageSpans(line, message_scale, model, bubble.busy, &shimmer_spans);
        var line_node = ui.paragraph(.{
            .size = .heading,
            // Lines are already split and capped above. Give the paragraph
            // the complete content band: constraining it to the measured
            // glyph width let the SDK re-wrap the final word onto a clipped
            // second baseline, which looked like overlapping duplicate text.
            .width = inner_w,
            .height = metrics.message_line_height,
            .wrap = false,
            .overflow = .ellipsis,
        }, spans);
        line_node.widget.style.foreground = text_fg;
        // A text node cannot clip its own drawing in Native SDK. Put every
        // shimmer paragraph behind a dedicated clipping parent instead.
        var line_clip = ui.el(.stack, .{
            .width = inner_w,
            .height = metrics.message_line_height,
        }, .{line_node});
        line_clip.widget.layout.clip_content = true;
        rows[row_count] = line_clip;
        row_count += 1;
    }

    var nested_nodes: [bubble_nested_rows_max + 1]AppUi.Node = undefined;
    var nested_count: usize = 0;
    if (metrics.nested_message_count > 0) {
        const nested_start = bubble.child_messages_len - metrics.nested_message_count;
        for (0..metrics.nested_message_count) |row| {
            const child = &bubble.child_messages[nested_start + row];
            var branch_icon = ui.appIcon(.{
                .width = bubble_agent_icon_width,
                .height = bubble_agent_icon_width,
                .semantics = .{ .label = "Subagent message" },
            }, "app:bubble-branch");
            branch_icon.widget.style.foreground = muted_fg;
            var child_text = ui.paragraph(.{
                .size = .heading,
                .width = @max(1, inner_w - bubble_agent_icon_width - bubble_content_gap),
                .height = metrics.nested_line_height,
                .wrap = false,
                .overflow = .ellipsis,
            }, &.{
                .{ .text = child.labelSlice(), .weight = .medium, .scale = metadata_scale },
                .{ .text = " · ", .scale = metadata_scale },
                .{ .text = child.textSlice(), .scale = metadata_scale },
            });
            child_text.widget.style.foreground = muted_fg;
            var nested_row = ui.row(.{
                .width = inner_w,
                .height = metrics.nested_line_height,
                .gap = bubble_content_gap,
                .cross = .center,
            }, .{ branch_icon, child_text });
            nested_row.widget.layout.clip_content = true;
            nested_nodes[nested_count] = nested_row;
            nested_count += 1;
        }
    }
    if (metrics.nested_overflow_count > 0) {
        const overflow = std.fmt.bufPrint(
            &bubble_child_overflow_scratch[slot],
            "+{d} more",
            .{metrics.nested_overflow_count},
        ) catch "+more";
        var overflow_text = ui.paragraph(.{
            .size = .heading,
            .width = @max(1, inner_w - bubble_agent_icon_width - bubble_content_gap),
            .height = metrics.nested_line_height,
            .wrap = false,
            .overflow = .ellipsis,
        }, &.{.{ .text = overflow, .scale = metadata_scale }});
        overflow_text.widget.style.foreground = muted_fg;
        var overflow_row = ui.row(.{
            .width = inner_w,
            .height = metrics.nested_line_height,
            .gap = bubble_content_gap,
            .cross = .center,
        }, .{
            ui.el(.stack, .{ .width = bubble_agent_icon_width, .height = 1 }, .{}),
            overflow_text,
        });
        overflow_row.widget.layout.clip_content = true;
        nested_nodes[nested_count] = overflow_row;
        nested_count += 1;
    }

    // Folding removes nonfront content from the presentation before glass
    // surfaces converge. Unfolding attaches it only after spatial separation.
    var bands: [4]AppUi.Node = undefined;
    var band_count: usize = 0;
    var header = ui.el(.stack, .{
        .width = inner_w,
        .height = metrics.metadata_height,
    }, @as([]const AppUi.Node, header_nodes[0..header_count]));
    header.widget.layout.clip_content = true;
    header.widget.opacity = 1;
    header.widget.transform = canvas.Affine.translate(0, metrics.metadata_y - bubble_card_padding);
    if (content_reveal > 0.001) {
        header.widget.transform = canvas.Affine.translate(0, metrics.metadata_y - bubble_card_padding);
        bands[band_count] = header;
        band_count += 1;
    }
    if (content_reveal > 0.001 and (title_clipped.len > 0 or bubbleHasStatusBadge(bubble))) {
        var title = ui.text(.{
            .size = .display,
            .width = title_available_width,
            .height = metrics.title_height,
            .wrap = false,
            .overflow = .ellipsis,
        }, title_clipped);
        title.widget.style.foreground = title_fg;
        title.widget.layout.clip_content = true;

        var status_slot: AppUi.Node = undefined;
        const status_icon: ?[]const u8 = switch (bubble.status) {
            .completed => "app:bubble-completed",
            .needs_input => "app:bubble-needs-input",
            .failed => "app:bubble-dismiss",
            .idle, .running => null,
        };
        if (status_icon) |icon_name| {
            const status_label: []const u8 = switch (bubble.status) {
                .completed => "Session completed",
                .needs_input => "Session needs your input",
                .failed => "Session failed",
                .idle, .running => "Session status",
            };
            var icon = ui.appIcon(.{
                .width = 15,
                .height = 15,
                .semantics = .{ .label = status_label },
            }, icon_name);
            icon.widget.style.foreground = switch (bubble.status) {
                .completed => canvas.Color.rgb8(52, 199, 89),
                .needs_input => canvas.Color.rgb8(255, 159, 10),
                .failed => canvas.Color.rgb8(255, 69, 58),
                .idle, .running => muted_fg,
            };
            if (bubble.status == .needs_input and !model.reduce_motion) {
                const triangle = 1 - @abs(model.bubble_shimmer_phase * 2 - 1);
                icon.widget.opacity = 0.72 + triangle * 0.24;
            } else if (bubble.status == .completed) {
                // One understated arrival rather than a looping success
                // animation; afterward the native green glass cue is static.
                icon.widget.opacity = 0.68 + completionSettleProgress(model, bubble) * 0.32;
            }
            const icon_slot = ui.el(.stack, .{
                .width = 18,
                .height = metrics.title_height,
                .main = .center,
                .cross = .center,
            }, .{icon});
            status_slot = icon_slot;
        } else {
            status_slot = ui.el(.stack, .{ .width = metrics.status_slot_width, .height = metrics.title_height }, .{});
        }
        var title_row = ui.row(.{
            .width = inner_w,
            .height = metrics.title_height,
            .gap = if (metrics.status_slot_width > 0) bubble_content_gap else 0,
            .cross = .center,
        }, .{ title, status_slot });
        title_row.widget.layout.clip_content = true;
        title_row.widget.transform = canvas.Affine.translate(0, metrics.title_y - bubble_card_padding);
        bands[band_count] = title_row;
        band_count += 1;
    }
    if (content_reveal > 0.001 and row_count > 0) {
        const message_height = metrics.message_line_height * @as(f32, @floatFromInt(row_count)) +
            bubble_line_gap * @as(f32, @floatFromInt(row_count - 1));
        var messages = ui.column(.{ .width = inner_w, .height = message_height, .gap = bubble_line_gap, .cross = .start }, @as([]const AppUi.Node, rows[0..row_count]));
        messages.widget.layout.clip_content = true;
        messages.widget.transform = canvas.Affine.translate(0, metrics.message_y - bubble_card_padding);
        bands[band_count] = messages;
        band_count += 1;
    }
    if (content_reveal > 0.001 and nested_count > 0) {
        var nested = ui.column(.{
            .width = inner_w,
            .height = metrics.nested_line_height * @as(f32, @floatFromInt(nested_count)) +
                bubble_line_gap * @as(f32, @floatFromInt(nested_count - 1)),
            .gap = bubble_line_gap,
            .cross = .start,
        }, @as([]const AppUi.Node, nested_nodes[0..nested_count]));
        nested.widget.layout.clip_content = true;
        nested.widget.transform = canvas.Affine.translate(0, metrics.nested_y - bubble_card_padding);
        nested.widget.opacity = metrics.nested_reveal;
        bands[band_count] = nested;
        band_count += 1;
    }
    var flow = ui.el(.stack, .{
        .width = inner_w,
        .height = @max(0, bubbleRenderedCardHeight(model, slot) - bubble_card_padding * 2),
    }, @as([]const AppUi.Node, bands[0..band_count]));
    flow.widget.layout.clip_content = true;
    flow.widget.opacity = content_reveal;

    var card_layers: [2]AppUi.Node = undefined;
    var card_layer_count: usize = 0;
    card_layers[card_layer_count] = flow;
    card_layer_count += 1;
    if (builtin.target.os.tag != .macos and hover > 0.15 and content_reveal > 0.5) {
        var action_nodes: [4]AppUi.Node = undefined;
        var action_count: usize = 0;
        if (bubbleCanActivateOrigin(bubble)) {
            action_nodes[action_count] = ui.el(.icon_button, .{
                .width = bubble_control_size,
                .height = bubble_control_size,
                .size = .sm,
                .variant = .ghost,
                .icon = "app:bubble-chat",
                .on_press = .{ .focus_bubble = @intCast(slot) },
                .semantics = .{ .label = "Open agent session" },
            }, .{});
            action_count += 1;
        }
        if (bubble.session_len > 0) {
            const pinned = bubbleIsPinned(model, bubble);
            var pin = ui.el(.icon_button, .{
                .width = bubble_control_size,
                .height = bubble_control_size,
                .size = .sm,
                .variant = .ghost,
                .icon = "app:bubble-pin",
                .on_press = .{ .toggle_bubble_pin = @intCast(slot) },
                .semantics = .{ .label = if (pinned) "Unpin session" else "Pin session to front" },
            }, .{});
            pin.widget.style.foreground = if (pinned) title_fg else muted_fg;
            action_nodes[action_count] = pin;
            action_count += 1;
        }
        if (bubble.child_messages_len > 0) {
            const expanded = bubbleSubagentsPinned(model, bubble);
            var branch = ui.el(.icon_button, .{
                .width = bubble_control_size,
                .height = bubble_control_size,
                .size = .sm,
                .variant = .ghost,
                .icon = "app:bubble-branch",
                .on_press = .{ .toggle_subagent_details = @intCast(slot) },
                .semantics = .{ .label = if (expanded) "Collapse subagent messages" else "Expand subagent messages" },
            }, .{});
            branch.widget.style.foreground = if (expanded) title_fg else muted_fg;
            action_nodes[action_count] = branch;
            action_count += 1;
        }
        if (bubbleDismissible(bubble)) {
            action_nodes[action_count] = ui.el(.icon_button, .{
                .width = bubble_control_size,
                .height = bubble_control_size,
                .size = .sm,
                .variant = .ghost,
                .icon = "app:bubble-dismiss",
                .on_press = .{ .dismiss_bubble = @intCast(slot) },
                .semantics = .{ .label = "Dismiss ended session" },
            }, .{});
            action_count += 1;
        }
        if (action_count > 0) {
            const rail_width = bubble_control_size * @as(f32, @floatFromInt(action_count)) +
                bubble_control_gap * @as(f32, @floatFromInt(action_count - 1));
            var rail = ui.row(.{
                .width = rail_width,
                .height = bubble_control_size,
                .gap = bubble_control_gap,
                .cross = .center,
            }, action_nodes[0..action_count]);
            rail.widget.opacity = std.math.clamp(hover, 0, 1);
            rail.widget.backdrop_blur = 0;
            rail.widget.style.radius = 0;
            rail.widget.style.background = canvas.Color.rgba8(0, 0, 0, 0);
            rail.widget.style.border = canvas.Color.rgba8(0, 0, 0, 0);
            rail.widget.style.stroke_width = 0;
            rail.widget.transform = canvas.Affine.translate(
                inner_w - rail_width,
                @max(0, (bubbleRenderedCardHeight(model, slot) - bubble_card_padding * 2 - bubble_control_size) / 2),
            );
            card_layers[card_layer_count] = rail;
            card_layer_count += 1;
        }
    }
    var card = ui.el(.panel, .{
        .padding = bubble_card_padding,
        .width = card_width,
        .height = bubbleRenderedCardHeight(model, slot),
        .semantics = .{ .label = "Agent session" },
    }, card_layers[0..card_layer_count]);
    // On Linux the bubble is a parent-local compositor popup. Its card body
    // therefore moves the owning pet window through the SDK's window-drag
    // channel; nested icon buttons remain press exclusions automatically.
    // A hidden/recently filtered card must not leave an invisible native drag
    // rectangle over the sibling disclosure control after the popup shrinks.
    const card_presented = bubbleCardPresented(model, slot);
    card.widget.window_drag = bubblePortableCardUsesWindowDrag(
        builtin.target.os.tag,
        card_presented,
    );
    // Filtering to Recent/Hidden must remove the card from the portable
    // accessibility tree as well as the compositor input region. Retaining
    // an invisible `Agent session` node let AT and automation target content
    // outside the shrunken popup after the disclosure hid it.
    card.widget.semantics.hidden = !card_presented;
    card.widget.style.radius = bubble_card_radius;
    card.widget.layout.clip_content = true;
    if (builtin.target.os.tag == .macos) {
        // AppKit owns the material and edge treatment. Painting another blur
        // and translucent fill here muddies the system refraction and doubles
        // the work during every spring frame.
        card.widget.backdrop_blur = 0;
        card.widget.style.background = canvas.Color.rgba8(0, 0, 0, 0);
        card.widget.style.border = canvas.Color.rgba8(0, 0, 0, 0);
        card.widget.style.stroke_width = 0;
    } else if (model.dark) {
        card.widget.backdrop_blur = bubblePortableBackdropBlur(builtin.target.os.tag);
        card.widget.style.background = bubbleFallbackSurface(model, bubble, hover);
        card.widget.style.border = canvas.Color.rgba8(255, 255, 255, @intFromFloat(34 + hover * 30));
        card.widget.style.stroke_width = 1;
    } else {
        card.widget.backdrop_blur = bubblePortableBackdropBlur(builtin.target.os.tag);
        card.widget.style.background = bubbleFallbackSurface(model, bubble, hover);
        card.widget.style.border = canvas.Color.rgba8(70, 78, 100, @intFromFloat(44 + hover * 26));
        card.widget.style.stroke_width = 1;
    }

    // Depth: shift up, shrink, and fade with distance from the front,
    // plus the horizontal shift that centers this card in the stack.
    //
    // Affine.scale is canvas-origin anchored (it is applied raw, see
    // widget_tree.widgetTransform), so scaling alone would also drag the
    // card toward the canvas corner. Translating the card's center to
    // the origin, scaling, and translating back keeps it centered, and
    // the offsets compose on top of that.
    const visual = bubbleVisualFrameForPlatform(model, slot, builtin.target.os.tag);
    card.widget.transform = canvas.Affine.translate(visual.x, visual.y)
        .multiply(canvas.Affine.scale(visual.scale_x, visual.scale_y));
    card.widget.opacity = visual.alpha;
    return card;
}

/// Cards and their pet-adjacent disclosure share one absolute geometry.
/// The stack node is only a presentation canvas: each intrinsic card frame
/// is supplied by `bubbleVisualFrame`, and closing converges every empty
/// glass surface into the circular disclosure without a speech-tail layer.
fn bubbleView(ui: *AppUi, model: *const Model) AppUi.Node {
    if (builtin.target.os.tag == .macos or builtin.target.os.tag == .windows) {
        // AppKit/Win32 own every visible card, label, status glyph and control
        // on their native presentation paths. The secondary GPU surface is
        // only the transparent window
        // host; rebuilding per-card placeholder geometry here made unrelated
        // pet sprite and poll messages remeasure all bubble text.
        return ui.el(.stack, .{
            .width = @max(@as(f32, 1), bubble_window_w),
            .height = @max(@as(f32, 1), bubble_window_h),
        }, .{});
    }
    var root_layers: [2]AppUi.Node = undefined;
    var root_count: usize = 0;
    var overlay: [hook_server.max_bubbles]AppUi.Node = undefined;
    for (0..model.bubbles_len) |slot| overlay[slot] = bubbleCard(ui, model, slot);
    const group = ui.el(.stack, .{
        .width = bubbleStackWidth(model),
        .height = bubbleEnvelopeStackHeight(model),
    }, overlay[0..model.bubbles_len]);
    if (bubblePortableUsesLayoutSpacers(builtin.target.os.tag)) {
        // Keep the Linux portable CPU canvas on ordinary layout coordinates.
        // GTK's software presenter correctly renders each card's own transform,
        // but a translated parent stack containing those transformed cards can
        // collapse to a fully transparent display-list span. Spacers express
        // the same authoritative origin without a nested transform or glass.
        const group_left = ui.el(.stack, .{ .width = bubble_canvas_margin, .height = 1 }, .{});
        const group_top = ui.el(.stack, .{ .width = 1, .height = bubbleStackOriginY(model) }, .{});
        const group_row = ui.row(.{
            .width = bubbleWindowWidth(model),
            .height = bubbleEnvelopeStackHeight(model),
            .cross = .start,
        }, .{ group_left, group });
        root_layers[root_count] = ui.column(.{
            .width = bubbleWindowWidth(model),
            .height = bubbleWindowHeight(model),
            .cross = .start,
        }, .{ group_top, group_row });
    } else {
        // Preserve the existing AppKit/Win32 transform path byte-for-byte on
        // platforms that did not exhibit the GTK software-presenter defect.
        var positioned_group = group;
        positioned_group.widget.transform = canvas.Affine.translate(bubble_canvas_margin, bubbleStackOriginY(model));
        root_layers[root_count] = positioned_group;
    }
    root_count += 1;

    // macOS supplies the visible disclosure through NSButton so it inherits
    // native glass lighting, tooltips and accessibility. Other platforms use
    // the same authoritative frame with the thin built-in Lucide chevron.
    if (builtin.target.os.tag != .macos) {
        const disclosure = bubbleDisclosureFrame(model);
        const mode = bubbleDisplayMode(model);
        const disclosure_presentation = bubbleDisclosurePresentation(model);
        var control = switch (mode) {
            .all => ui.el(.icon_button, .{
                .width = disclosure.w,
                .height = disclosure.h,
                .size = .sm,
                .variant = .ghost,
                .icon = "app:bubble-layers",
                .on_press = .toggle_bubble_visibility,
                .semantics = .{ .label = "Show most recent active session only" },
            }, .{}),
            .recent => ui.el(.icon_button, .{
                .width = disclosure.w,
                .height = disclosure.h,
                .size = .sm,
                .variant = .ghost,
                .icon = "app:bubble-recent",
                .on_press = .toggle_bubble_visibility,
                .semantics = .{ .label = "Hide session cards" },
            }, .{}),
            .hidden => blk: {
                if (disclosure_presentation.show_status_icon) {
                    const status_icon: []const u8 = switch (bubbleGroupSemanticState(model)) {
                        .failed => "app:bubble-dismiss",
                        .needs_input => "app:bubble-needs-input",
                        .running => "app:bubble-terminal",
                        .completed => "app:bubble-completed",
                        .idle => "app:bubble-chat",
                    };
                    break :blk ui.el(.icon_button, .{
                        .width = disclosure.w,
                        .height = disclosure.h,
                        .size = .sm,
                        .variant = .ghost,
                        .icon = status_icon,
                        .on_press = .toggle_bubble_visibility,
                        .semantics = .{ .label = "Show all active sessions" },
                    }, .{});
                }
                const count_text = std.fmt.bufPrint(&bubble_disclosure_count_scratch, "{d}", .{model.bubbles_len}) catch "";
                break :blk ui.button(.{
                    .width = disclosure.w,
                    .height = disclosure.h,
                    .size = .sm,
                    .variant = .ghost,
                    .on_press = .toggle_bubble_visibility,
                    .semantics = .{ .label = "Show all active sessions" },
                }, count_text);
            },
        };
        control.widget.style.radius = bubble_disclosure_size / 2;
        control.widget.backdrop_blur = bubblePortableBackdropBlur(builtin.target.os.tag);
        control.widget.opacity = disclosure_presentation.alpha;
        control.widget.style.foreground = bubbleContrastPalette(model).title;
        control.widget.style.background = switch (bubbleGroupSemanticState(model)) {
            .failed => canvas.Color.rgba8(255, 69, 58, 64),
            .needs_input => canvas.Color.rgba8(255, 159, 10, 64),
            .running => canvas.Color.rgba8(75, 132, 255, 56),
            .completed => canvas.Color.rgba8(52, 199, 89, 52),
            .idle => if (model.dark) canvas.Color.rgba8(0, 0, 0, 96) else canvas.Color.rgba8(0, 0, 0, 44),
        };
        if (bubblePortableUsesLayoutSpacers(builtin.target.os.tag)) {
            // Native SDK automation and AT bounds are derived from layout
            // frames. A transform-only disclosure painted in the right place
            // but still advertised (and synthesized clicks) at (0,0), where
            // it overlapped the card. Express the popup-local offset as
            // ordinary layout on Linux, matching the card stack above.
            const disclosure_left = ui.el(.stack, .{
                .width = disclosure.x,
                .height = 1,
            }, .{});
            const disclosure_top = ui.el(.stack, .{
                .width = 1,
                .height = disclosure.y,
            }, .{});
            const disclosure_row = ui.row(.{
                .width = bubbleWindowWidth(model),
                .height = disclosure.h,
                .cross = .start,
            }, .{ disclosure_left, control });
            root_layers[root_count] = ui.column(.{
                .width = bubbleWindowWidth(model),
                .height = bubbleWindowHeight(model),
                .cross = .start,
            }, .{ disclosure_top, disclosure_row });
        } else {
            control.widget.transform = canvas.Affine.translate(disclosure.x, disclosure.y);
            root_layers[root_count] = control;
        }
        root_count += 1;
    }

    return ui.el(.stack, .{
        .width = bubbleWindowWidth(model),
        .height = bubbleWindowHeight(model),
    }, root_layers[0..root_count]);
}

// --------------------------------------------------------- settings window

const settings_window_label = "settings";
const settings_canvas_label = "settings-canvas";

fn petdexWindows(model: *const Model, scratch: *PetdexApp.WindowsScratch) []const PetdexApp.WindowDescriptor {
    var count: usize = 0;
    if (bubbleActive(model)) {
        // syncBubbleWindow updates these presentation dimensions before the
        // model-declared window is rebuilt. Reusing them on native hosts avoids a
        // complete measured-text layout on every unrelated Msg (including
        // each pet animation frame).
        const bubble_w = if ((builtin.target.os.tag == .macos or builtin.target.os.tag == .windows) and bubble_window_w > 0)
            bubble_window_w
        else
            bubbleWindowWidth(model);
        const bubble_h = if ((builtin.target.os.tag == .macos or builtin.target.os.tag == .windows) and bubble_window_h > 0)
            bubble_window_h
        else
            bubbleWindowHeight(model);
        if (comptime builtin.target.os.tag == .linux) {
            const pet_h = frame_h * model.scale;
            scratch.windows[count] = .{
                .label = "bubble",
                .canvas_label = "bubble-canvas",
                .title = "Petdex Activity",
                .width = bubble_w,
                .height = bubble_h,
                .x = win_w / 2,
                .y = win_h - pet_edge_pad - pet_h,
                .resizable = false,
                .titlebar = .chromeless,
                .floating = true,
                .transparent = true,
                .click_through = true,
                .popup_parent = "main",
                .content_generation = model.bubble_view_generation,
            };
        } else {
            scratch.windows[count] = .{
                .label = "bubble",
                .canvas_label = "bubble-canvas",
                .title = "Petdex Activity",
                .width = bubble_w,
                .height = bubble_h,
                .x = @floatCast(bubbleWantX(model, bubble_w)),
                // Same flip the frame clock maintains, so the window is born
                // on the correct side rather than spawning over the pet and
                // jumping on the next sync.
                .y = @floatCast(bubbleWantY(model, bubble_h)),
                .resizable = false,
                .titlebar = .chromeless,
                .floating = true,
                .fullscreen_overlay = true,
                .transparent = true,
                .click_through = true,
            };
        }
        count += 1;
    }
    if (model.settings_open) {
        scratch.windows[count] = .{
            .label = settings_window_label,
            .canvas_label = settings_canvas_label,
            .title = "Petdex Settings",
            .width = 420,
            .height = 680,
            .resizable = false,
            .on_close = .settings_closed,
        };
        count += 1;
    }
    writeBubblePerfStats(model);
    return scratch.windows[0..count];
}

fn petdexWindowView(ui: *PetdexApp.Ui, model: *const Model, window_label: []const u8) PetdexApp.Ui.Node {
    if (std.mem.eql(u8, window_label, "bubble")) return bubbleView(ui, model);
    std.debug.assert(std.mem.eql(u8, window_label, settings_window_label));
    return settings_view.settingsView(ui, model, .{
        .ready = agents_icons_ready,
        .image = agent_icon_atlas_id,
        .rect = &agentIconRect,
    }, .{
        .image = thumb_atlas_id,
        .ready = &thumbs_ready,
        .cell_w = @floatFromInt(thumb_w),
        .cell_h = @floatFromInt(thumb_h),
    });
}

/// Keep the stable hook entry pointing at the running binary so agent hooks
/// survive app updates: the hooks reference it, the app rewrites it every
/// boot. Both platforms use regular launcher files. A Unix symlink let a
/// remote executable installer follow the entry and overwrite the app binary;
/// replacing a regular launcher is atomic and cannot mutate its target.
fn refreshHookEntry(argv0: []const u8) void {
    _ = argv0;
    const home = env_home orelse return;
    var self_buf: [1024]u8 = undefined;
    const rp = plat.executablePath(&self_buf) orelse return;
    var dir_buf: [512]u8 = undefined;
    const bin = std.fmt.bufPrint(&dir_buf, "{s}/.petdex/bin", .{home}) catch return;
    plat.makeDir(bin);
    var link_buf: [512]u8 = undefined;
    const link = std.fmt.bufPrint(&link_buf, "{s}/.petdex/bin/petdex-hook", .{home}) catch return;
    if (builtin.os.tag == .windows) {
        var launcher_path_buf: [512]u8 = undefined;
        const launcher_path = std.fmt.bufPrint(&launcher_path_buf, "{s}.cmd", .{link}) catch return;
        var launcher_buf: [1536]u8 = undefined;
        const launcher = plat.windowsHookLauncher(&launcher_buf, rp) orelse return;
        _ = plat.writeFile(launcher_path, launcher);
        // Remove a stale link/file from pre-launcher builds. The .cmd entry is
        // the only path used by new configurations.
        plat.deleteFile(link);
    } else {
        var launcher_buf: [1536]u8 = undefined;
        const launcher = plat.unixHookLauncher(&launcher_buf, rp) orelse return;
        // writeFileMode intentionally follows user-managed symlinks, so remove
        // a legacy hook link first. The replacement is a private executable
        // regular file and subsequent writes replace only that file.
        plat.deleteFile(link);
        _ = plat.writeFileMode(link, launcher, 0o700);
    }
}

// -------------------------------------------------------------------- app

/// Menu-bar extra: Petdex's persistent handle. With the Dock icon
/// hidden the app has no menu bar of its own, so this is the only
/// always-reachable way to Settings and Quit; it is installed
/// unconditionally so the hide-Dock toggle can never strand the user.
/// Model-derived (the `status_item_fn` shape) so Focus Mode can show
/// its state in the label; the static options keep icon and tooltip.
fn petdexStatusItem(model: *const Model, scratch: *PetdexApp.StatusItemScratch) PetdexApp.StatusItemState {
    scratch.items[0] = .{ .id = 1, .label = "Open Settings", .command = "petdex.settings" };
    scratch.items[1] = .{
        .id = 2,
        .label = if (model.focus_mode) "Focus Mode: On" else "Focus Mode: Off",
        .command = "petdex.focus",
    };
    scratch.items[2] = .{ .id = 3, .label = "Shuffle Pet", .command = "petdex.shuffle" };
    scratch.items[3] = .{ .id = 4, .separator = true };
    scratch.items[4] = .{ .id = 5, .label = "Quit Petdex", .command = "petdex.quit" };
    return .{ .items = scratch.items[0..5] };
}

/// The menu-bar button icon: the brand mark's silhouette with the face
/// punched out (the host loads it as a template image, so only alpha
/// survives). The platform gets a PATH, not bytes, and a relative path
/// dies the moment Finder launches the bundle with cwd=/ — so the
/// embedded PNG is materialized into the runtime dir at boot and the
/// tray points at that absolute path. Missing HOME or a failed write
/// degrade to the host's title fallback ("P"), never a broken item.
const tray_icon_png = if (builtin.target.os.tag == .linux)
    @embedFile("assets/tray-icon-color.png")
else
    @embedFile("assets/tray-icon.png");
var tray_icon_path_buf: [512]u8 = undefined;
var tray_icon_path: []const u8 = "";

fn materializeTrayIcon() void {
    const home = env_home orelse return;
    var dir_buf: [512]u8 = undefined;
    const dir = std.fmt.bufPrint(&dir_buf, "{s}/.petdex/runtime", .{home}) catch return;
    plat.makeDir(dir);
    const path = std.fmt.bufPrint(&tray_icon_path_buf, "{s}/.petdex/runtime/tray-icon.png", .{home}) catch return;
    if (plat.writeFile(path, tray_icon_png)) tray_icon_path = path;
}

const app_menus = [_]native_sdk.platform.Menu{.{
    .title = "Pet",
    .items = &.{
        .{ .label = "Settings...", .command = "petdex.settings", .key = ",", .modifiers = .{ .primary = true } },
        .{ .separator = true },
        .{ .label = "Close Pet", .command = "petdex.close", .key = "w", .modifiers = .{ .primary = true } },
    },
}};

const PetdexApp = native_sdk.UiApp(Model, Msg);

pub fn main(init: std.process.Init) !void {
    // Windows has no HOME. Everything the app keeps per-user hangs off
    // this one lookup (the pet catalog, ~/.petdex/runtime, the settings
    // file), so reading only HOME made a Windows build behave like a
    // machine with nothing installed even with pets sitting in
    // %USERPROFILE%\.petdex\pets. HOME still wins where it exists, so a
    // POSIX user pointing it elsewhere keeps that.
    env_home = init.environ_map.get("HOME") orelse init.environ_map.get("USERPROFILE");
    env_perf_stats_path = init.environ_map.get("PETDEX_PERF_STATS_PATH");
    // Claude Code honors CLAUDE_CONFIG_DIR for fully isolated installs;
    // wiring hooks into ~/.claude for those users writes a settings.json
    // their Claude Code never reads, and detection shows them as
    // disconnected after a successful connect (#601).
    agent_hooks.env_claude_config_dir = init.environ_map.get("CLAUDE_CONFIG_DIR");
    // Kimi Code relocates its whole config with KIMI_CODE_HOME, so the
    // same blind spot #601 described applies: hooks written to the
    // default dir would land somewhere it never reads.
    agent_hooks.env_kimi_code_home = init.environ_map.get("KIMI_CODE_HOME");
    agent_hooks.env_pi_coding_agent_dir = init.environ_map.get("PI_CODING_AGENT_DIR");
    // Qoder's two builds each resolve their root through two variables, and the
    // prefix differs per build (QODER_* vs QODERCN_*). Unlike every other
    // touchpoint for these agents, nothing here is compiler-enforced: omit a
    // line and the app still builds, the tests still pass (they set the globals
    // directly), and the only symptom is hooks written to a root that install
    // never reads.
    agent_hooks.env_qoder_config_dir = init.environ_map.get("QODER_CONFIG_DIR");
    agent_hooks.env_qoder_cn_config_dir = init.environ_map.get("QODERCN_CONFIG_DIR");
    agent_hooks.env_qoder_cli_home = init.environ_map.get("QODER_CLI_HOME");
    agent_hooks.env_qoder_cn_cli_home = init.environ_map.get("QODERCN_CLI_HOME");
    agent_hooks.env_hermes_home = init.environ_map.get("HERMES_HOME");
    dsh_integration.env_dsh_home = init.environ_map.get("DSH_HOME");
    session_reconcile.env_claude_config_dir = init.environ_map.get("CLAUDE_CONFIG_DIR");
    session_reconcile.env_kimi_code_home = init.environ_map.get("KIMI_CODE_HOME");
    session_reconcile.env_kimi_share_dir = init.environ_map.get("KIMI_SHARE_DIR");
    session_reconcile.env_pi_coding_agent_dir = init.environ_map.get("PI_CODING_AGENT_DIR");
    session_reconcile.env_xdg_data_home = init.environ_map.get("XDG_DATA_HOME");
    session_reconcile.env_qoder_config_dir = init.environ_map.get("QODER_CONFIG_DIR");
    session_reconcile.env_qoder_cn_config_dir = init.environ_map.get("QODERCN_CONFIG_DIR");
    session_reconcile.env_qoder_cli_home = init.environ_map.get("QODER_CLI_HOME");
    session_reconcile.env_qoder_cn_cli_home = init.environ_map.get("QODERCN_CLI_HOME");
    session_reconcile.env_hermes_home = init.environ_map.get("HERMES_HOME");
    // Hook hot path: `<binary> bubble <phase> [agent]` runs the
    // in-binary runner and exits before any UI machinery spins up.
    // initAllocator, not init: on Windows the command line arrives as
    // one UTF-16 string that has to be split and transcoded, so the
    // iterator needs an allocator there. It is a no-op elsewhere.
    var args_it = std.process.Args.Iterator.initAllocator(init.minimal.args, boot_allocator) catch return;
    defer args_it.deinit();
    const argv0: ?[]const u8 = args_it.next();
    if (args_it.next()) |cmd| {
        if (std.mem.eql(u8, cmd, "bubble")) {
            const phase = args_it.next() orelse return;
            const agent: ?[]const u8 = args_it.next();
            const origin_app = plat.OriginApplication.fromTermProgram(init.environ_map.get("TERM_PROGRAM"));
            hook_runner.run(phase, agent, origin_app, init.environ_map.get("PWD"), init.environ_map.get("HERDR_PANE_ID"), env_home orelse return);
            return;
        }
    }
    canvas.icons.registerAppIcons(&app_icons);
    if (argv0) |a0| refreshHookEntry(a0);
    materializeTrayIcon();
    env_wanted_pet = init.environ_map.get("PETDEX_PET");
    boot_io = init.io;
    resolveInitialPet(init.io, boot_allocator, init.environ_map) catch |err| {
        std.debug.print("petdex: no pet found ({s}); install one with `petdex install <pet>`\n", .{@errorName(err)});
    };
    var custom_font_bytes: ?[]u8 = null;
    defer if (custom_font_bytes) |bytes| boot_allocator.free(bytes);
    var font_registrations: [1]PetdexApp.FontRegistration = undefined;
    var app_fonts: []const PetdexApp.FontRegistration = &.{};
    if (initial_font_path_len > 0) {
        const path = initial_font_path[0..initial_font_path_len];
        if (plat.readFileAlloc(boot_allocator, path, max_custom_font_bytes)) |bytes| {
            if (canvas.font_ttf.parseFailureReason(bytes) == null) {
                custom_font_bytes = bytes;
                custom_font_active = true;
                font_registrations[0] = .{
                    .id = custom_font_id,
                    .name = path,
                    .ttf = bytes,
                };
                app_fonts = font_registrations[0..];
            } else {
                boot_allocator.free(bytes);
                initial_font_load_failed = true;
            }
        } else {
            initial_font_load_failed = true;
        }
    }
    const app_state = try PetdexApp.create(std.heap.page_allocator, .{
        .name = "petdex-desktop-native",
        .scene = shell_scene,
        .canvas_label = canvas_label,
        .update_fx = update,
        .init_fx = boot,
        .view = rootView,
        .on_key = onKey,
        .on_command = onCommand,
        .status_item = .{
            .icon_path = tray_icon_path,
            .tooltip = "Petdex",
        },
        .status_item_fn = petdexStatusItem,
        .on_frame = if (builtin.target.os.tag == .linux) null else onFrame,
        .on_urls_opened = onUrlsOpened,
        .windows_fn = petdexWindows,
        .window_view = petdexWindowView,
        .tokens_fn = petdexTokens,
        .fonts = app_fonts,
        .on_appearance = onAppearance,
    });
    defer if (env_home) |home| remote_writeback.cleanupStagingRoot(home);
    defer remote_runtime.deinitWritebacks();
    // Effect workers can still own stdin slices from the writeback arenas.
    // Tear the app down (and join those workers) before reclaiming the arenas.
    defer app_state.destroy();
    app_state.model = .{};
    perf_stats_last = .{};
    perf_stats_last_generation = 0;
    perf_stats_written = false;
    writeBubblePerfStats(&app_state.model);
    defer writeBubblePerfStats(&app_state.model);

    try runner.runWithOptions(app_state.app(), .{
        .app_name = "petdex-desktop-native",
        .window_title = "Petdex",
        .bundle_id = "dev.petdex.desktop-native",
        .icon_path = "assets/icon.png",
        .default_frame = geometry.RectF.init(0, 0, win_w, win_h),
        .restore_state = false,
        .js_window_api = false,
        // GTK and Win32 both present application menus inside the client
        // area. On the chromeless transparent pet that looks like a titlebar,
        // steals vertical space, and leaves a dirty bottom strip. Linux and
        // Windows expose these commands through the pet's context menu.
        .menus = if (builtin.target.os.tag == .macos) &app_menus else &.{},
        .security = .{
            .permissions = &app_permissions,
            .navigation = .{ .allowed_origins = &.{ "zero://inline", "zero://app" } },
        },
    }, init);
}

test "every agent gets its own cell in the icon strip" {
    // One slot holds them all, so a wrong offset silently draws the
    // neighbouring agent's logo rather than failing to register.
    for (0..agent_art.len) |i| {
        const rect = agentIconRect(i);
        try std.testing.expectEqual(@as(f32, @floatFromInt(i * agent_icon_px)), rect.x);
        try std.testing.expectEqual(@as(f32, 0), rect.y);
        try std.testing.expectEqual(@as(f32, agent_icon_px), rect.width);
        try std.testing.expectEqual(@as(f32, agent_icon_px), rect.height);
    }
    // Cells abut with no overlap: agent N ends exactly where N+1 begins.
    if (agent_art.len >= 2) {
        const first = agentIconRect(0);
        const second = agentIconRect(1);
        try std.testing.expectEqual(first.x + first.width, second.x);
    }
    // The packed strip stays inside the SDK's per-image bounds, which is
    // the ceiling this atlas exists to avoid running into again.
    const atlas_w = agent_art.len * agent_icon_px;
    try std.testing.expect(atlas_w * agent_icon_px * 4 <= 1024 * 1024);
    try std.testing.expect(atlas_w <= 512 * 512);
}

test "transparent surfaces clear independently from settings" {
    // The pet and bubble windows contain transparent atlas padding. Their
    // GPU surface must preserve that alpha instead of painting a rectangle.
    try std.testing.expectEqualStrings("premultiplied", @tagName(shell_views[0].gpu_alpha_mode.?));
    try std.testing.expect(shell_windows[0].transparent);

    // The settings window paints an opaque page background of its own on
    // AppKit and Win32. Linux presents every surface through one
    // alpha-zero GTK clear, so there the settings background is
    // transparent too and the pet-vs-settings split does not apply.
    const settings_alpha: f32 = if (builtin.target.os.tag == .linux) 0 else 1;

    var model: Model = .{};
    const pet_background = petdexTokens(&model).colors.background;
    const settings_background = settingsBackground(&model);
    try std.testing.expectEqual(@as(f32, 0), pet_background.a);
    try std.testing.expectEqual(settings_alpha, settings_background.a);

    model.dark = false;
    try std.testing.expectEqual(@as(f32, 0), petdexTokens(&model).colors.background.a);
    try std.testing.expectEqual(settings_alpha, settingsBackground(&model).a);
}

test "one image slot covers every agent" {
    // agent_art is what loadAgentsAtlas walks, so a new AgentKind without
    // artwork would pack short and leave the last agent blank.
    try std.testing.expectEqual(agent_hooks.agent_count + 2, agent_art.len);
}

test "DSH bubbles keep the companion window click through" {
    var model: Model = .{};
    model.bubbles_len = 1;
    model.bubbles[0].origin_app = .default_browser;
    var scratch: PetdexApp.WindowsScratch = .{};
    const windows = petdexWindows(&model, &scratch);
    try std.testing.expect(windows.len > 0);
    try std.testing.expect(windows[0].click_through);
}

test "Herdr agent aliases resolve to their Petdex artwork" {
    try std.testing.expectEqual(agent_hooks.AgentKind.claude_code, agentKindForName("claude").?);
    try std.testing.expectEqual(agent_hooks.AgentKind.opencode, agentKindForName("open-code").?);
    try std.testing.expectEqual(agent_hooks.AgentKind.qoder, agentKindForName("qodercli").?);
    try std.testing.expectEqual(agent_hooks.AgentKind.kimi_code, agentKindForName("kimi").?);
    try std.testing.expectEqual(herdr_icon_index, agentIconIndex("herdr"));
}

test "Hermes uses its dedicated agent art" {
    const hermes_art = agent_art[@intFromEnum(agent_hooks.AgentKind.hermes)];
    const fallback_art = agent_art[agent_fallback_index];
    try std.testing.expectEqualSlices(u8, @embedFile("assets/agents/hermes.png"), hermes_art.light);
    try std.testing.expect(!std.mem.eql(u8, fallback_art.light, hermes_art.light));
}

test "activating index 0 works before any sheet is loaded" {
    // Two bugs met here on a first run. `active_pet` starts at 0 and the
    // first downloaded pet lands at index 0, so an `index == active_pet`
    // early return skipped the activation the empty state exists to
    // perform, and `sheet_loaded` never flipped because select_pet
    // assumed a sheet was already up. Both failed silently: the pet
    // downloaded to disk and the window kept drawing the empty state.
    const fresh: Model = .{};
    try std.testing.expectEqual(@as(u32, 0), fresh.active_pet);
    try std.testing.expect(!fresh.sheet_loaded);
    // The guard has to consider both, not just the index.
    const would_skip_before = 0 == fresh.active_pet;
    const would_skip_now = 0 == fresh.active_pet and fresh.sheet_loaded;
    try std.testing.expect(would_skip_before);
    try std.testing.expect(!would_skip_now);
}

test "empty-state copy fits the pet window" {
    // The label truncates rather than wrapping, and the window is 192pt,
    // so a sentence renders as an ellipsis (which is how the first
    // attempt shipped). Every line has to stand alone.
    const longest = "Pets found,\nnone could\nbe drawn.\n\nLinux needs\nwebp-pixbuf-\nloader.";
    var it = std.mem.splitScalar(u8, longest, '\n');
    while (it.next()) |line| {
        try std.testing.expect(line.len <= 14);
    }
}

test "update checks stay daily across a long-lived process" {
    try std.testing.expectEqual(@as(u64, update_boot_delay_ms), updateCheckDelay(0, 1000));
    try std.testing.expectEqual(@as(u64, update_boot_delay_ms), updateCheckDelay(2000, 1000));
    try std.testing.expectEqual(@as(u64, 23 * 60 * 60 * 1000), updateCheckDelay(1000, 1000 + 60 * 60 * 1000));
    try std.testing.expectEqual(@as(u64, update_boot_delay_ms), updateCheckDelay(1000, 1000 + update_background_interval_ms));
}

test "cached update versions restore the correct phase" {
    var model: Model = .{};
    updateCachePhase(&model);
    try std.testing.expectEqual(updates.Phase.idle, model.update_phase);
    @memcpy(model.latest_version[0.."0.9.0".len], "0.9.0");
    model.latest_version_len = "0.9.0".len;
    updateCachePhase(&model);
    try std.testing.expectEqual(updates.Phase.available, model.update_phase);
    @memcpy(model.latest_version[0.."0.8.0".len], "0.8.0");
    model.latest_version_len = "0.8.0".len;
    updateCachePhase(&model);
    try std.testing.expectEqual(updates.Phase.current, model.update_phase);
}

test "bubble text default is its own value, not the range floor" {
    // #625 widened the range down to 8 while the default still read
    // `min`, so every install shrank and the slider sat hard left. The
    // default must survive the next range change too.
    try std.testing.expectEqual(@as(f32, 13), bubble_text_default_px);
    try std.testing.expect(bubble_text_default_px > bubble_text_min_px);
    try std.testing.expect(bubble_text_default_px < bubble_text_max_px);
    // A fresh model renders at the default, and the slider reflects it
    // somewhere in the middle rather than at either end.
    const fresh: Model = .{};
    try std.testing.expectEqual(bubble_text_default_px, fresh.bubble_text_px);
    const fraction = (fresh.bubble_text_px - bubble_text_min_px) / (bubble_text_max_px - bubble_text_min_px);
    try std.testing.expect(fraction > 0.2 and fraction < 0.8);
}

test "waiting escalation pings once, only while still waiting" {
    // Not yet due.
    try std.testing.expect(!shouldEscalate(.waiting, 0, false, waiting_escalation_ms - 1));
    // Due, not yet fired.
    try std.testing.expect(shouldEscalate(.waiting, 0, false, waiting_escalation_ms));
    // Already fired: never again this spell.
    try std.testing.expect(!shouldEscalate(.waiting, 0, true, waiting_escalation_ms * 2));
    // The user answered; the spell is over.
    try std.testing.expect(!shouldEscalate(.idle, 0, false, waiting_escalation_ms));
}

test "waiting chime fires only on the transition into waiting" {
    try std.testing.expect(shouldChime(.running, .waiting));
    try std.testing.expect(shouldChime(.idle, .waiting));
    // Re-posted waiting while the prompt is still up: stay quiet.
    try std.testing.expect(!shouldChime(.waiting, .waiting));
    // Leaving waiting never chimes.
    try std.testing.expect(!shouldChime(.waiting, .idle));
    try std.testing.expect(!shouldChime(.running, .idle));
}

test {
    // `zig build test` only collects tests from the root module FILE,
    // and imports are analyzed lazily — so without these references
    // every test in the imported files (18 today, across agent_hooks,
    // hook_runner and installer) compiled green and never ran. This
    // block is the standard aggregator: referencing the imports forces
    // their semantic analysis, which is what registers their tests.
    _ = agent_hooks;
    _ = hook_runner;
    _ = hook_server;
    _ = session_reconcile;
    _ = installer;
    _ = plat;
    _ = remote_agents;
    _ = remote_runtime;
    _ = remote_ssh;
    _ = remote_writeback;
    _ = settings_view;
}

test "bubble geometry follows columns lines and font size" {
    var model: Model = .{};
    try std.testing.expectEqual(bubble_columns_default, model.bubble_columns);
    try std.testing.expectEqual(bubble_answer_lines_default, model.bubble_answer_lines);
    const default_width = bubbleMaxCardWidth(&model);
    const default_height = bubbleWindowHeight(&model);
    model.bubble_columns = 10;
    try std.testing.expect(bubbleMaxCardWidth(&model) < default_width);
    model.bubble_columns = 60;
    try std.testing.expect(bubbleMaxCardWidth(&model) <= 460);
    model.bubble_answer_lines = 4;
    // The redesigned session card has a strict two-line message contract;
    // legacy settings above two may remain on disk but cannot grow the UI.
    try std.testing.expectEqual(default_height, bubbleWindowHeight(&model));
    model.bubble_text_px = bubble_text_max_px;
    try std.testing.expectEqual(@as(f32, 460), bubbleMaxCardWidth(&model));
    try std.testing.expect(bubbleWindowHeight(&model) > default_height);
}

test "custom font path round-trips through settings JSON escaping" {
    const path = "C:\\Users\\名字\\Font \"Regular\".ttf";
    var escaped_buf: [256]u8 = undefined;
    const escaped = jsonEscapeString(path, &escaped_buf).?;
    try std.testing.expectEqualStrings("C:\\\\Users\\\\名字\\\\Font \\\"Regular\\\".ttf", escaped);
    var decoded_buf: [256]u8 = undefined;
    try std.testing.expectEqualStrings(path, jsonUnescapeString(escaped, &decoded_buf).?);
}

test "tap detection separates pats from drags" {
    // Clean click: quick, still.
    try std.testing.expect(isTap(120, 0, 0));
    // Device-pixel jitter under a fast grab still counts.
    try std.testing.expect(isTap(300, 2, -2));
    // Held too long: a grab, not a pat.
    try std.testing.expect(!isTap(tap_max_ms + 1, 0, 0));
    // Moved: a drag, not a pat.
    try std.testing.expect(!isTap(120, tap_slop_px, 0));
    try std.testing.expect(!isTap(120, 0, -tap_slop_px));
}

test "epoch-day flips exactly at UTC midnight" {
    try std.testing.expectEqual(@as(u32, 0), dayFromWallMs(0));
    try std.testing.expectEqual(@as(u32, 0), dayFromWallMs(std.time.ms_per_day - 1));
    try std.testing.expectEqual(@as(u32, 1), dayFromWallMs(std.time.ms_per_day));
    // A real date (2026-07-29T12:00Z), so a unit slip cannot pass.
    try std.testing.expectEqual(@as(u32, 20663), dayFromWallMs(1785326400000));
}

test "bubble lifetime validates and produces a deadline" {
    try std.testing.expectEqual(@as(f32, 0), clampBubbleLifetime(std.math.nan(f32)));
    try std.testing.expectEqual(@as(f32, 0), clampBubbleLifetime(0));
    try std.testing.expectEqual(@as(f32, 60), clampBubbleLifetime(90));
    try std.testing.expectEqual(@as(f32, 6), clampBubbleLifetime(5.6));
    try std.testing.expectEqual(@as(i64, -1), bubbleDeadlineMs(2000, 0));
    try std.testing.expectEqual(@as(i64, 7000), bubbleDeadlineMs(2000, 5));
    try std.testing.expectEqual(@as(i64, -1), bubbleExpiryMs(2000, 0, false));
    try std.testing.expectEqual(@as(i64, -1), bubbleExpiryMs(2000, 5, true));
    try std.testing.expectEqual(@as(i64, 7000), bubbleExpiryMs(2000, 5, false));
    try std.testing.expect(!bubbleLifetimeExpired(7000, 8000, .waiting));
    try std.testing.expect(bubbleLifetimeExpired(7000, 8000, .idle));
}

/// Seed the model's stack directly, the shape the poll tick would leave.
fn testPushBubble(model: *Model, session: []const u8, text: []const u8, busy: bool, deadline: i64) void {
    const i = model.bubbles_len;
    var b: hook_server.Bubble = .{
        .busy = busy,
        .status = if (busy) .running else .idle,
        .counter = @intCast(i + 1),
    };
    @memcpy(b.session[0..session.len], session);
    b.session_len = session.len;
    @memcpy(b.text[0..text.len], text);
    b.text_len = text.len;
    model.bubbles[i] = b;
    model.bubble_expires_at_ms[i] = deadline;
    model.bubbles_len = i + 1;
    model.bubble_group_visible = true;
    model.bubble_expansion = 1;
    model.bubble_expansion_target = 1;
    model.bubble_fold_phase = .unfolded;
    retargetBubbleGroupSizeSpring(model);
}

fn testSetBubbleMetadata(
    bubble: *hook_server.Bubble,
    agent: []const u8,
    hostname: []const u8,
    cwd: []const u8,
    remote: bool,
) void {
    std.debug.assert(agent.len <= bubble.agent.len);
    std.debug.assert(hostname.len <= bubble.hostname.len);
    std.debug.assert(cwd.len <= bubble.source_cwd.len);
    @memcpy(bubble.agent[0..agent.len], agent);
    bubble.agent_len = agent.len;
    @memcpy(bubble.hostname[0..hostname.len], hostname);
    bubble.hostname_len = hostname.len;
    @memcpy(bubble.source_cwd[0..cwd.len], cwd);
    bubble.source_cwd_len = cwd.len;
    bubble.remote = remote;
}

fn testPushChildMessage(bubble: *hook_server.Bubble, label: []const u8, text: []const u8) void {
    const i = bubble.child_messages_len;
    var child = &bubble.child_messages[i];
    @memcpy(child.label[0..label.len], label);
    child.label_len = label.len;
    @memcpy(child.text[0..text.len], text);
    child.text_len = text.len;
    child.counter = @intCast(i + 1);
    bubble.child_messages_len = i + 1;
}

test "bubbles per conversation defaults on, and only an explicit false opts out" {
    // The rollout rule: the stack ships enabled, so a settings file
    // written before this key existed has to roll FORWARD into it. Only
    // a user who deliberately turned it off gets the classic bubble.
    try std.testing.expect((Model{}).bubbles_per_conversation);

    const missing = "{\"active_pet\":\"boba\",\"scale\":0.70,\"bubbles\":true}";
    const explicit_false = "{\"active_pet\":\"boba\",\"bubbles\":true,\"bubbles_per_conversation\":false}";
    const explicit_true = "{\"active_pet\":\"boba\",\"bubbles\":true,\"bubbles_per_conversation\":true}";

    // This is the exact predicate settingsLoad runs, kept in one place
    // so the test cannot drift into asserting a different rule.
    const optedOut = struct {
        fn f(json: []const u8) bool {
            return std.mem.indexOf(u8, json, "\"bubbles_per_conversation\":false") != null;
        }
    }.f;
    try std.testing.expect(!optedOut(missing));
    try std.testing.expect(optedOut(explicit_false));
    try std.testing.expect(!optedOut(explicit_true));

    // The two keys share a prefix, so the older `bubbles` probe must not
    // read the new key's value as its own. A settings file with the
    // stack turned off and messages left on would otherwise hide every
    // bubble, which is a far worse failure than the one being fixed.
    const bubblesOff = struct {
        fn f(json: []const u8) bool {
            return std.mem.indexOf(u8, json, "\"bubbles\":false") != null;
        }
    }.f;
    try std.testing.expect(!bubblesOff(explicit_false));
    try std.testing.expect(bubblesOff("{\"bubbles\":false,\"bubbles_per_conversation\":false}"));
}

test "with per-conversation bubbles off, two sessions collapse to the newest one" {
    // The classic behaviour, reproduced at the consumer: the protocol is
    // untouched (the CLI still sends session_id and the mailbox still
    // keeps a slot each), only the number of slots that reach the model
    // changes.
    var drained: [hook_server.max_bubbles]hook_server.Bubble = undefined;
    for (&drained) |*b| b.* = .{};

    // Two conversations, and the SECOND session to arrive spoke first:
    // the mailbox keeps insertion order, so recency lives in `counter`
    // and the newest is not the last slot. A fold that took
    // `drained[count - 1]` would pick the wrong card here.
    drained[0] = .{ .counter = 9 };
    @memcpy(drained[0].text[0.."newest".len], "newest");
    drained[0].text_len = "newest".len;
    drained[1] = .{ .counter = 4 };
    @memcpy(drained[1].text[0.."older".len], "older");
    drained[1].text_len = "older".len;

    const count = collapseToNewest(&drained, 2);
    try std.testing.expectEqual(@as(usize, 1), count);
    try std.testing.expectEqualStrings("newest", drained[0].text[0..drained[0].text_len]);
    // The vacated slot is cleared, not left holding a stale copy that a
    // later drain of a bigger set could resurrect.
    try std.testing.expectEqual(@as(usize, 0), drained[1].text_len);

    // One card means the single-bubble path: no stack, so a tail and no
    // hover fan, which is what "classic" means on screen.
    var model: Model = .{};
    model.bubbles_per_conversation = false;
    testPushBubble(&model, "alpha", "newest", false, -1);
    try std.testing.expect(!bubbleStackable(&model));

    // And with the setting ON the same two slots survive as a stack.
    var stacked: Model = .{};
    testPushBubble(&stacked, "alpha", "older", false, -1);
    testPushBubble(&stacked, "beta", "newest", false, -1);
    try std.testing.expectEqual(@as(usize, 2), stacked.bubbles_len);
    try std.testing.expect(bubbleStackable(&stacked));
    // A single bubble is already collapsed and must pass through
    // unchanged rather than being rewritten.
    var lone: [hook_server.max_bubbles]hook_server.Bubble = undefined;
    for (&lone) |*b| b.* = .{};
    lone[0] = .{ .counter = 3 };
    try std.testing.expectEqual(@as(usize, 1), collapseToNewest(&lone, 1));
    try std.testing.expectEqual(@as(u64, 3), lone[0].counter);
}

test "switching per-conversation bubbles off collapses the stack already on screen" {
    // Requirement 4: flipping the toggle with a fan open must not leave
    // the stack sitting there until some agent happens to speak.
    var model: Model = .{};
    testPushBubble(&model, "alpha", "older", false, 5_000);
    testPushBubble(&model, "beta", "newest", false, 9_000);
    // Pretend the fan was open and mid-hover when the switch was flipped.
    model.bubble_expansion = 1;
    model.bubble_fold_phase = .unfolded;
    model.bubble_expansion_target = 1;
    model.bubble_hover_since_ms = 1234;

    collapseModelToNewest(&model);

    try std.testing.expectEqual(@as(usize, 1), model.bubbles_len);
    try std.testing.expectEqualStrings("newest", model.bubbles[0].text[0..model.bubbles[0].text_len]);
    // The survivor keeps ITS deadline: being the last one standing is
    // not a reason to get a fresh lease.
    try std.testing.expectEqual(@as(i64, 9_000), model.bubble_expires_at_ms[0]);
    try std.testing.expectEqual(@as(i64, -1), model.bubble_expires_at_ms[1]);
    try std.testing.expectEqual(@as(usize, 0), model.bubbles[1].text_len);
    // Disclosure state is independent of conversation-density mode.
    try std.testing.expectEqual(@as(f32, 1), model.bubble_expansion);
    try std.testing.expectEqual(@as(f32, 1), model.bubble_expansion_target);
    try std.testing.expectEqual(@as(i64, -1), model.bubble_hover_since_ms);
    // Which is exactly the single-bubble render path: tail, no stack.
    try std.testing.expect(!bubbleStackable(&model));

    // Idempotent: flipping the switch twice, or collapsing an already
    // single bubble, must not clear the last card off the screen.
    collapseModelToNewest(&model);
    try std.testing.expectEqual(@as(usize, 1), model.bubbles_len);
    try std.testing.expectEqualStrings("newest", model.bubbles[0].text[0..model.bubbles[0].text_len]);
}

test "a card hugs its content instead of always taking the column budget" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "hi", false, -1);
    const short = bubbleCardWidth(&model, 0);
    try std.testing.expect(short < bubbleMaxCardWidth(&model));

    // Longer content widens the card, and the column budget is still the
    // ceiling: text past it wraps rather than growing the card forever.
    var long: Model = .{};
    testPushBubble(&long, "beta", "a much longer line of bubble text", false, -1);
    try std.testing.expect(bubbleCardWidth(&long, 0) > short);

    // The column budget stays a ceiling no card can cross. It is not an
    // equality: the budget reserves one em per character and real text
    // paints narrower, so even a full card measures under it.
    var overflow: Model = .{};
    testPushBubble(&overflow, "gamma", "x" ** 199, false, -1);
    try std.testing.expect(bubbleCardWidth(&overflow, 0) <= bubbleMaxCardWidth(&overflow));
    try std.testing.expect(bubbleCardWidth(&overflow, 0) > bubbleCardWidth(&long, 0));
}

test "bubble provenance shortens local host and extracts workspace" {
    var local: hook_server.Bubble = .{};
    const local_host = "Shakibs-MacBook-Pro.local";
    @memcpy(local.hostname[0..local_host.len], local_host);
    local.hostname_len = local_host.len;
    const local_cwd = "/Users/shakib/Dev/petdex/";
    @memcpy(local.source_cwd[0..local_cwd.len], local_cwd);
    local.source_cwd_len = local_cwd.len;
    try std.testing.expectEqualStrings("local", bubbleHostname(&local));
    try std.testing.expectEqualStrings("petdex", bubbleProjectName(&local));

    var remote = local;
    remote.remote = true;
    const remote_host = "inframework";
    @memcpy(remote.hostname[0..remote_host.len], remote_host);
    remote.hostname_len = remote_host.len;
    try std.testing.expectEqualStrings("inframework", bubbleHostname(&remote));
}

test "dismissed session identity separates agent and remote host" {
    var local: hook_server.Bubble = .{};
    const session = "shared-session";
    @memcpy(local.session[0..session.len], session);
    local.session_len = session.len;
    @memcpy(local.agent[0.."codex".len], "codex");
    local.agent_len = "codex".len;

    var remote = local;
    remote.remote = true;
    @memcpy(remote.hostname[0.."rogue".len], "rogue");
    remote.hostname_len = "rogue".len;
    try std.testing.expect(bubbleIdentityHash(&local).? != bubbleIdentityHash(&remote).?);

    var other_host = remote;
    @memset(&other_host.hostname, 0);
    @memcpy(other_host.hostname[0.."inframework".len], "inframework");
    other_host.hostname_len = "inframework".len;
    try std.testing.expect(bubbleIdentityHash(&remote).? != bubbleIdentityHash(&other_host).?);

    var hermes = local;
    @memset(&hermes.agent, 0);
    @memcpy(hermes.agent[0.."hermes".len], "hermes");
    hermes.agent_len = "hermes".len;
    try std.testing.expect(bubbleIdentityHash(&local).? != bubbleIdentityHash(&hermes).?);
}

test "dismissed sessions persist as a bounded deduplicated hash list" {
    var model: Model = .{};
    try std.testing.expect(addDismissedSessionHash(&model, 10));
    try std.testing.expect(!addDismissedSessionHash(&model, 10));
    for (11..44) |identity| _ = addDismissedSessionHash(&model, @intCast(identity));
    try std.testing.expectEqual(@as(usize, max_dismissed_sessions), model.dismissed_sessions_len);
    try std.testing.expect(dismissedSessionIndex(&model, 10) == null);
    try std.testing.expect(dismissedSessionIndex(&model, 43) != null);

    var encoded: [max_dismissed_sessions * 17]u8 = undefined;
    const data = encodeDismissedSessions(&model, &encoded).?;
    var decoded: Model = .{};
    decodeDismissedSessions(&decoded, data);
    try std.testing.expectEqual(model.dismissed_sessions_len, decoded.dismissed_sessions_len);
    try std.testing.expectEqualSlices(u64, model.dismissed_session_hashes[0..model.dismissed_sessions_len], decoded.dismissed_session_hashes[0..decoded.dismissed_sessions_len]);
}

test "quiet dismissed updates stay hidden and new busy work revives them" {
    hook_server.mailbox.clearBubbles();
    defer hook_server.mailbox.clearBubbles();
    var model: Model = .{};
    var quiet: [hook_server.max_bubbles]hook_server.Bubble = @splat(.{});
    testPushBubble(&model, "alpha", "finished", false, -1);
    quiet[0] = model.bubbles[0];
    const identity = bubbleIdentityHash(&quiet[0]).?;
    try std.testing.expect(addDismissedSessionHash(&model, identity));

    try std.testing.expectEqual(@as(usize, 0), filterDismissedBubbles(&model, &quiet, 1));
    try std.testing.expect(dismissedSessionIndex(&model, identity) != null);

    var busy: [hook_server.max_bubbles]hook_server.Bubble = @splat(.{});
    busy[0] = model.bubbles[0];
    busy[0].busy = true;
    busy[0].status = .running;
    try std.testing.expectEqual(@as(usize, 1), filterDismissedBubbles(&model, &busy, 1));
    try std.testing.expect(dismissedSessionIndex(&model, identity) == null);
    try std.testing.expectEqualStrings("alpha", busy[0].sessionSlice());
}

test "only quiet keyed sessions expose dismissal" {
    var quiet: hook_server.Bubble = .{};
    @memcpy(quiet.session[0.."alpha".len], "alpha");
    quiet.session_len = "alpha".len;
    try std.testing.expect(bubbleDismissible(&quiet));
    quiet.busy = true;
    quiet.status = .running;
    try std.testing.expect(!bubbleDismissible(&quiet));
    quiet.busy = false;
    quiet.status = .needs_input;
    try std.testing.expect(!bubbleDismissible(&quiet));
    quiet.status = .completed;
    quiet.session_len = 0;
    try std.testing.expect(!bubbleDismissible(&quiet));
}

test "bubble layout bands clamp the primary message to two lines" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "one two three four five six seven eight nine ten eleven twelve", true, -1);
    model.bubble_columns = 14;
    const title = "A deliberately long session title";
    @memcpy(model.bubbles[0].title[0..title.len], title);
    model.bubbles[0].title_len = title.len;
    const agent = "codex";
    @memcpy(model.bubbles[0].agent[0..agent.len], agent);
    model.bubbles[0].agent_len = agent.len;

    const rest = bubbleLayoutMetricsAtMetadataReveal(&model, 0, 0);
    const metrics = bubbleLayoutMetricsAtMetadataReveal(&model, 0, 1);
    try std.testing.expectEqual(bubble_message_lines_max, metrics.message_line_count);
    try std.testing.expect(metrics.metadata_y + metrics.metadata_height <= metrics.title_y);
    try std.testing.expect(metrics.title_y + metrics.title_height <= metrics.message_y);
    const line_gaps = bubble_line_gap * @as(f32, @floatFromInt(metrics.message_line_count - 1));
    const message_bottom = metrics.message_y + metrics.message_line_height * @as(f32, @floatFromInt(metrics.message_line_count)) + line_gaps;
    try std.testing.expect(message_bottom <= metrics.card_height - bubble_card_padding + 0.01);
    try std.testing.expectEqual(metrics.card_width - bubble_card_padding * 2, metrics.inner_width);
    try std.testing.expectEqual(metrics.title_y, rest.title_y);
    try std.testing.expectEqual(metrics.message_y, rest.message_y);
    try std.testing.expectEqual(metrics.card_height, rest.card_height);
    try std.testing.expectEqual(metrics.card_width, rest.card_width);
}

test "bubble title is one measured text leaf and cannot enter the message band" {
    var model: Model = .{};
    model.bubble_columns = 24;
    testPushBubble(&model, "alpha", "Called skill_view", true, -1);
    const raw_title = "Resume timed-out delegated\ndevelopment with a much longer suffix";
    @memcpy(model.bubbles[0].title[0..raw_title.len], raw_title);
    model.bubbles[0].title_len = raw_title.len;

    const metrics = bubbleLayoutMetricsAtMetadataReveal(&model, 0, 0);
    const expected = metrics.title_text;
    try std.testing.expect(std.mem.indexOfScalar(u8, expected, '\n') == null);
    try std.testing.expect(std.mem.endsWith(u8, expected, "\u{2026}"));

    var native_title: plat.BubbleNativeText = .{};
    native_title.set(expected);
    try std.testing.expectEqualStrings(expected, native_title.slice());
    const source = @embedFile("main.zig");
    const card_start = std.mem.indexOf(u8, source, "fn bubbleCard(").?;
    const native_return = std.mem.indexOf(u8, source[card_start..], "return placeholder;").?;
    const first_gpu_text = std.mem.indexOf(u8, source[card_start..], "var title = ui.text").?;
    try std.testing.expect(native_return < first_gpu_text);
    try std.testing.expectEqual(bubbleTitleFontSize(&model), petdexTokens(&model).typography.display_size);

    try std.testing.expect(metrics.title_y + metrics.title_height <= metrics.message_y);
    const tokens = petdexTokens(&model);
    const font = canvas.textSpanFontId(.{ .text = "" }, tokens.typography);
    try std.testing.expect(canvas.measureTextWidthForFont(tokens.text_measure, font, expected, bubbleTitleFontSize(&model)) <= metrics.title_text_width + 0.01);
}

test "nested subagent rows stay inside their parent card without intersecting primary bands" {
    var model: Model = .{};
    testPushBubble(&model, "parent", "Primary assistant response spans two compact lines for context", false, -1);
    model.bubble_columns = 18;
    const title = "Canonical parent conversation";
    @memcpy(model.bubbles[0].title[0..title.len], title);
    model.bubbles[0].title_len = title.len;
    testPushChildMessage(&model.bubbles[0], "Research", "Found the authoritative server record");
    testPushChildMessage(&model.bubbles[0], "Tests", "Verified the remote rollout parser");
    testPushChildMessage(&model.bubbles[0], "Review", "No standalone child bubble is needed");
    testPushChildMessage(&model.bubbles[0], "Docs", "Summarized the final behavior");

    const collapsed = bubbleLayoutMetricsAtMetadataReveal(&model, 0, 0);
    const hovered = bubbleLayoutMetricsAtMetadataReveal(&model, 0, 1);
    try std.testing.expectEqual(@as(usize, 2), hovered.nested_message_count);
    try std.testing.expectEqual(@as(usize, 2), hovered.nested_overflow_count);
    try std.testing.expectEqual(@as(usize, 3), hovered.nested_line_count);
    try std.testing.expectEqual(@as(f32, 0), collapsed.nested_reveal);
    try std.testing.expectEqual(@as(f32, 0), hovered.nested_reveal);
    try std.testing.expectEqual(collapsed.card_height, hovered.card_height);

    model.expanded_subagent_identity = bubbleVisualIdentity(&model.bubbles[0]);
    const expanded = bubbleLayoutMetricsAtMetadataReveal(&model, 0, 0);
    try std.testing.expectEqual(@as(f32, 1), expanded.nested_reveal);
    try std.testing.expect(expanded.card_height > collapsed.card_height);

    const primary_gaps = bubble_line_gap * @as(f32, @floatFromInt(expanded.message_line_count - 1));
    const primary_bottom = expanded.message_y + expanded.message_line_height * @as(f32, @floatFromInt(expanded.message_line_count)) + primary_gaps;
    try std.testing.expect(primary_bottom <= expanded.nested_y);
    const nested_gaps = bubble_line_gap * @as(f32, @floatFromInt(expanded.nested_line_count - 1));
    const nested_bottom = expanded.nested_y + expanded.nested_line_height * @as(f32, @floatFromInt(expanded.nested_line_count)) + nested_gaps;
    try std.testing.expect(nested_bottom <= expanded.card_height - bubble_card_padding + 0.01);
    try std.testing.expect(expanded.title_text_width + expanded.status_slot_width +
        (if (expanded.status_slot_width > 0) bubble_content_gap else 0) <= expanded.inner_width + 0.01);

    const pinned_at_rest = bubbleLayoutMetricsAtMetadataReveal(&model, 0, 1);
    try std.testing.expectEqual(@as(f32, 1), pinned_at_rest.nested_reveal);
    try std.testing.expectEqual(expanded.card_height, pinned_at_rest.card_height);
}

test "completion and input states keep a title-row status slot without a title" {
    var model: Model = .{};
    testPushBubble(&model, "question", "Choose a deployment target", false, -1);
    model.bubbles[0].status = .needs_input;
    const needs_input = bubbleLayoutMetricsAtMetadataReveal(&model, 0, 0);
    try std.testing.expect(needs_input.title_height > 0);
    try std.testing.expect(needs_input.status_slot_width > 0);
    try std.testing.expect(needs_input.title_y + needs_input.title_height <= needs_input.message_y);

    model.bubbles[0].status = .completed;
    const completed = bubbleLayoutMetricsAtMetadataReveal(&model, 0, 0);
    try std.testing.expectEqual(needs_input.title_height, completed.title_height);
}

test "completion cue settles once and Reduce Motion snaps it static" {
    var model: Model = .{ .bubble_anim_last_ms = 10_000 };
    testPushBubble(&model, "done", "Finished", false, -1);
    model.bubbles[0].status = .completed;
    model.bubbles[0].completed_at_ms = 10_000;
    try std.testing.expectEqual(@as(f32, 0), completionSettleProgress(&model, &model.bubbles[0]));
    try std.testing.expect(anyCompletionSettling(&model, 10_200));
    model.bubble_anim_last_ms = 10_000 + bubble_completion_settle_ms;
    try std.testing.expectEqual(@as(f32, 1), completionSettleProgress(&model, &model.bubbles[0]));
    try std.testing.expect(!anyCompletionSettling(&model, model.bubble_anim_last_ms));
    model.reduce_motion = true;
    model.bubble_anim_last_ms = 10_000;
    try std.testing.expectEqual(@as(f32, 1), completionSettleProgress(&model, &model.bubbles[0]));
}

test "group height stays stable while hover reveals only controls" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "Current activity", false, -1);
    @memcpy(model.bubbles[0].agent[0.."codex".len], "codex");
    model.bubbles[0].agent_len = "codex".len;
    retargetBubbleGroupSizeSpring(&model);
    const rest = bubbleLayoutMetricsAtMetadataReveal(&model, 0, 0);
    const hovered = bubbleLayoutMetricsAtMetadataReveal(&model, 0, 1);

    try std.testing.expectEqual(rest.card_width, bubbleAnimatedCardWidth(&model, 0));
    try std.testing.expectEqual(rest.card_height, bubbleAnimatedCardHeight(&model, 0));
    try std.testing.expectEqual(rest.metadata_y, hovered.metadata_y);
    try std.testing.expectEqual(rest.title_y, hovered.title_y);
    try std.testing.expectEqual(rest.message_y, hovered.message_y);
    try std.testing.expectEqual(rest.card_height, hovered.card_height);
    model.bubble_hovered = true;
    model.bubble_hovered_identity = bubbleVisualIdentity(&model.bubbles[0]);
    model.bubble_hover_amount = 1;
    model.reduce_motion = true;
    retargetBubbleGroupSizeSpring(&model);
    try std.testing.expectEqual(rest.card_height, bubbleAnimatedCardHeight(&model, 0));

    // AppKit's interactive Liquid Glass owns hover scale/bounce. The canvas
    // frame changes only for stack depth, so it cannot double the response.
    const visual = bubbleVisualFrame(&model, 0);
    try std.testing.expectEqual(@as(f32, 1), visual.scale);
}

test "message foreground is dimmer than title and brighter than provenance" {
    const dark: Model = .{ .dark = true };
    const dark_palette = bubbleContrastPalette(&dark);
    try std.testing.expectEqual(dark_palette.message, bubbleMessageColor(&dark));
    try std.testing.expect(dark_palette.message.r < dark_palette.title.r);
    try std.testing.expect(dark_palette.message.r > dark_palette.metadata.r);

    const light: Model = .{ .dark = false };
    const light_palette = bubbleContrastPalette(&light);
    try std.testing.expectEqual(light_palette.message, bubbleMessageColor(&light));
    try std.testing.expect(light_palette.message.r > light_palette.title.r);
    try std.testing.expect(light_palette.message.r < light_palette.metadata.r);

    const high_dark = bubbleContrastPalette(&Model{ .dark = true, .high_contrast = true });
    const high_light = bubbleContrastPalette(&Model{ .dark = false, .high_contrast = true });
    try std.testing.expect(high_dark.title.r > dark_palette.title.r);
    try std.testing.expect(high_light.title.r < light_palette.title.r);
}

test "busy message shimmer travels through one copy of the text" {
    const model: Model = .{ .dark = true, .bubble_shimmer_phase = 0.25 };
    var storage: [bubble_shimmer_span_max]canvas.TextSpan = undefined;
    const spans = bubbleMessageSpans("shimmering text", 1, &model, true, &storage);
    try std.testing.expect(spans.len > 1);
    var bytes: usize = 0;
    var bright: usize = 0;
    for (spans) |span| {
        bytes += span.text.len;
        if (span.color == .text) bright += 1;
    }
    try std.testing.expectEqual("shimmering text".len, bytes);
    try std.testing.expect(bright > 0);

    var settled_storage: [bubble_shimmer_span_max]canvas.TextSpan = undefined;
    const settled = bubbleMessageSpans("shimmering text", 1, &model, false, &settled_storage);
    try std.testing.expectEqual(@as(usize, 1), settled.len);
    try std.testing.expect(settled[0].color == null);

    const src = @embedFile("main.zig");
    const start = std.mem.indexOf(u8, src, "for (text_lines) |line|").?;
    const end = std.mem.indexOf(u8, src[start..], "var nested_nodes").?;
    const loop = src[start..][0..end];
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, loop, "ui.paragraph"));
    try std.testing.expect(std.mem.indexOf(u8, loop, ".width = inner_w") != null);
    try std.testing.expect(std.mem.indexOf(u8, loop, "beam_x") == null);
    try std.testing.expect(std.mem.indexOf(u8, loop, "var bright") == null);
}

test "bubble typography maps compact, default, and maximum preference anchors" {
    var model: Model = .{};
    model.bubble_text_px = bubble_text_min_px;
    try std.testing.expectApproxEqAbs(@as(f32, 9.5), bubbleMessageFontSize(&model), 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 9.5), bubbleHeaderTextSize(&model), 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 11.5), bubbleTitleFontSize(&model), 0.001);

    model.bubble_text_px = bubble_text_default_px;
    try std.testing.expectApproxEqAbs(@as(f32, 21.75), bubbleMessageFontSize(&model), 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 14.5), bubbleHeaderTextSize(&model), 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 23.75), bubbleTitleFontSize(&model), 0.001);

    model.bubble_text_px = bubble_text_max_px;
    try std.testing.expectApproxEqAbs(@as(f32, 32.25), bubbleMessageFontSize(&model), 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 21.5), bubbleHeaderTextSize(&model), 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 34.25), bubbleTitleFontSize(&model), 0.001);

    var previous: f32 = 0;
    for (8..21) |size| {
        model.bubble_text_px = @floatFromInt(size);
        const resolved = bubbleMessageFontSize(&model);
        try std.testing.expect(resolved >= previous);
        previous = resolved;
    }

    testPushBubble(&model, "compact", "Compact text remains inside its measured card bands", false, -1);
    model.bubble_text_px = bubble_text_min_px;
    const metrics = bubbleLayoutMetricsAtMetadataReveal(&model, 0, 1);
    try std.testing.expect(metrics.metadata_y + metrics.metadata_height <= metrics.title_y);
    try std.testing.expect(metrics.title_y + metrics.title_height <= metrics.message_y);
    try std.testing.expect(metrics.message_y + metrics.message_line_height * @as(f32, @floatFromInt(metrics.message_line_count)) <= metrics.card_height - bubble_card_padding + 0.01);
}

test "metadata line uses available width before ellipsizing" {
    var model: Model = .{};
    testPushBubble(&model, "metadata", "A canonical assistant response deliberately keeps this card wide enough to verify that short metadata stays whole before any tail ellipsis is considered.", false, -1);
    testSetBubbleMetadata(&model.bubbles[0], "codex", "", "", false);
    const local_metrics = bubbleLayoutMetricsAtMetadataReveal(&model, 0, 1);
    const local_layout = bubbleMetadataLayout(&model, &model.bubbles[0], local_metrics.inner_width);
    try std.testing.expectEqual(local_metrics.inner_width, local_layout.left_width);
    try std.testing.expect(local_metrics.metadata_left_x + local_metrics.metadata_left_width <= local_metrics.inner_width + 0.01);

    testSetBubbleMetadata(&model.bubbles[0], "Codex", "inframework", "/Users/shakib/Dev/petdex", true);
    const remote_metrics = bubbleLayoutMetricsAtMetadataReveal(&model, 0, 1);
    const remote_layout = bubbleMetadataLayout(&model, &model.bubbles[0], remote_metrics.inner_width);
    try std.testing.expectEqual(remote_metrics.inner_width, remote_layout.left_width);
    try std.testing.expectEqual(remote_metrics.inner_width, remote_metrics.metadata_left_width);

    const tokens = petdexTokens(&model);
    const regular = canvas.textSpanFontId(.{ .text = "" }, tokens.typography);
    const agent_font = canvas.textSpanFontId(.{ .text = "", .weight = .medium }, tokens.typography);
    const header_size = bubbleHeaderTextSize(&model);
    const natural_metadata = @ceil(
        canvas.measureTextWidthForFont(tokens.text_measure, agent_font, "Codex", header_size) +
            canvas.measureTextWidthForFont(tokens.text_measure, regular, " · ", header_size) +
            canvas.measureTextWidthForFont(tokens.text_measure, regular, "inframework", header_size) +
            canvas.measureTextWidthForFont(tokens.text_measure, regular, " · petdex", header_size) + 1,
    );
    try std.testing.expect(remote_layout.left_width >= natural_metadata);

    testSetBubbleMetadata(&model.bubbles[0], "Codex", "long-host-name-for-東京", "/workspace/long-project-name-for-项目", true);
    const constrained = bubbleMetadataLayout(&model, &model.bubbles[0], 160);
    try std.testing.expectEqual(@as(f32, 160), constrained.left_width);

    const src = @embedFile("main.zig");
    const card_start = std.mem.indexOf(u8, src, "fn bubbleCard(").?;
    const card_end = std.mem.indexOf(u8, src[card_start..], "var flow =").?;
    const header = src[card_start..][0..card_end];
    try std.testing.expect(std.mem.indexOf(u8, header, "left_metadata_spans") != null);
    try std.testing.expect(std.mem.indexOf(u8, header, ".{ .text = project, .color = .text") != null);
    try std.testing.expect(std.mem.indexOf(u8, header, "right_metadata_spans") == null);
    try std.testing.expect(std.mem.indexOf(u8, header, "var header = ui.el(.stack") != null);
    try std.testing.expect(std.mem.indexOf(u8, @embedFile("plat.zig"), "metadata_left_frame") != null);
    try std.testing.expect(std.mem.indexOf(u8, @embedFile("plat.zig"), "nativeMetadataAttributedString(snapshot)") != null);
    try std.testing.expect(std.mem.indexOf(u8, @embedFile("plat.zig"), "snapshot.project), snapshot.metadata_font_size, 0, \"labelColor\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, @embedFile("plat.zig"), "applyMetadataParagraphStyle") != null);
    try std.testing.expect(std.mem.indexOf(u8, @embedFile("plat.zig"), "NSParagraphStyle") != null);
}

test "one group size spring follows the largest session across reordering" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "short", false, -1);
    testPushBubble(&model, "beta", "also short", false, -1);
    retargetBubbleGroupSizeSpring(&model);
    const old_width = model.bubble_group_size_spring.width;

    const old_alpha = model.bubbles[0];
    model.bubbles[0] = model.bubbles[1];
    model.bubbles[1] = old_alpha;
    const longer = "a much longer updated response that expands the card smoothly";
    @memcpy(model.bubbles[1].text[0..longer.len], longer);
    model.bubbles[1].text_len = longer.len;
    retargetBubbleGroupSizeSpring(&model);

    const spring = &model.bubble_group_size_spring;
    try std.testing.expectEqual(old_width, spring.width);
    try std.testing.expect(spring.width_target > spring.width);
    try std.testing.expectEqual(spring.width_target, bubbleEnvelopeCardWidth(&model, 1));

    model.bubble_anim_last_ms = 1_000;
    _ = stepBubbleExpansionForPlatform(&model, 1_016, .macos);
    try std.testing.expect(model.bubble_group_size_spring.width > old_width);
    try std.testing.expect(model.bubble_group_size_spring.width < spring.width_target);
}

test "every animation sample keeps widths uniform and intrinsic heights nonoverlapping" {
    var model: Model = .{};
    testPushBubble(&model, "one", "short", false, -1);
    testPushBubble(&model, "two", "a substantially longer response that needs more room", true, -1);
    testPushBubble(&model, "three", "medium activity", false, -1);
    testPushChildMessage(&model.bubbles[1], "Child", "A meaningful nested response");
    model.expanded_subagent_identity = bubbleVisualIdentity(&model.bubbles[1]);
    retargetBubbleGroupSizeSpring(&model);
    model.bubble_hovered = true;
    model.bubble_expansion_target = 1;
    model.bubble_fold_phase = .unfolding;
    model.bubble_anim_last_ms = 1_000;
    for (0..24) |sample| {
        _ = stepBubbleExpansionForPlatform(&model, 1_016 + @as(i64, @intCast(sample * 16)), .macos);
        const width = bubbleRenderedCardWidth(&model, 0);
        for (1..model.bubbles_len) |slot| {
            try std.testing.expectEqual(width, bubbleRenderedCardWidth(&model, slot));
            const previous = bubbleVisualFrame(&model, slot - 1);
            const current = bubbleVisualFrame(&model, slot);
            if (bubbleContentReveal(&model, slot) > 0)
                try std.testing.expect(previous.y + previous.h <= current.y + 0.01);
        }
    }
}

test "secondary outward lane keeps intrinsic cards separated and reduces vertical pressure" {
    var model: Model = .{};
    testPushBubble(&model, "one", "short", false, -1);
    testPushBubble(&model, "two", "a longer response that wraps onto the second measured line", false, -1);
    testPushBubble(&model, "three", "medium activity", false, -1);
    testPushBubble(&model, "four", "another long assistant response that exercises intrinsic sizing", false, -1);
    model.bubble_group_visible = true;
    model.bubble_expansion = 1;
    model.bubble_fold_phase = .unfolded;
    retargetBubbleGroupSizeSpring(&model);

    const single_lane_height = bubbleStackHeightAt(&model, 1);
    model.bubble_secondary_lane = true;
    const two_lane_height = bubbleStackHeightAt(&model, 1);
    try std.testing.expect(two_lane_height < single_lane_height);
    try std.testing.expectEqual(@as(usize, 0), bubbleCardLane(&model, model.bubbles_len - 1));

    const common_width = bubbleRenderedCardWidth(&model, 0);
    for (1..model.bubbles_len) |slot| {
        try std.testing.expectEqual(common_width, bubbleRenderedCardWidth(&model, slot));
    }
    const lane_zero = bubbleVisualFrame(&model, model.bubbles_len - 1);
    const lane_one = bubbleVisualFrame(&model, model.bubbles_len - 2);
    try std.testing.expect(lane_zero.x + lane_zero.w + bubble_lane_gap <= lane_one.x + 0.01 or
        lane_one.x + lane_one.w + bubble_lane_gap <= lane_zero.x + 0.01);

    for (0..2) |lane| {
        var previous_bottom: ?f32 = null;
        for (0..model.bubbles_len) |slot| {
            if (bubbleCardLane(&model, slot) != lane) continue;
            const frame = bubbleVisualFrame(&model, slot);
            if (previous_bottom) |bottom| try std.testing.expect(bottom + bubble_stack_gap <= frame.y + 0.01);
            previous_bottom = frame.y + frame.h;
        }
    }
}

test "native disclosure and hovered action rail expose only authoritative controls" {
    var model: Model = .{};
    testPushBubble(&model, "codex-session", "Finished the implementation", false, -1);
    var bubble = &model.bubbles[0];
    bubble.origin_app = .codex;
    bubble.status = .completed;
    bubble.busy = false;
    testPushChildMessage(bubble, "Research", "Confirmed the platform behavior");
    model.bubble_group_visible = true;
    model.bubble_expansion = 1;
    model.bubble_fold_phase = .unfolded;
    model.bubble_hovered_identity = bubbleVisualIdentity(bubble);
    model.bubble_hover_amount = 1;
    retargetBubbleGroupSizeSpring(&model);

    var controls: [plat.max_bubble_native_controls]plat.BubbleNativeControl = @splat(.{});
    const count = bubbleNativeControls(&model, &controls);
    const open_available = bubbleCanActivateOrigin(bubble);
    try std.testing.expectEqual(@as(usize, if (open_available) 5 else 4), count);
    try std.testing.expectEqual(plat.BubbleNativeControlAction.toggle_visibility, controls[0].action);
    try std.testing.expect(controls[0].selected);
    try std.testing.expectEqual(@as(u8, 0), controls[0].badge_count);
    try std.testing.expectEqual(plat.BubbleDisclosureMode.all, controls[0].disclosure_mode);
    try std.testing.expectEqualStrings("Show or hide agent sessions", controls[0].accessibility_label.slice());
    try std.testing.expectEqualStrings("All sessions shown", controls[0].accessibility_value.slice());
    try std.testing.expect(controls[0].toggled);
    try std.testing.expectEqual(bubble_disclosure_activation_inset, controls[0].activation_inset);
    const first_card_action: usize = if (open_available) 1 else 0;
    if (open_available) try std.testing.expectEqual(plat.BubbleNativeControlAction.open, controls[1].action);
    try std.testing.expectEqual(plat.BubbleNativeControlAction.pin, controls[first_card_action + 1].action);
    try std.testing.expectEqualStrings("Pin agent session", controls[first_card_action + 1].accessibility_label.slice());
    try std.testing.expectEqual(plat.BubbleNativeControlAction.subagents, controls[first_card_action + 2].action);
    try std.testing.expectEqual(plat.BubbleNativeControlAction.dismiss, controls[first_card_action + 3].action);
    const rail = bubbleCardActionRailFrame(&model, 0).?;
    try std.testing.expectEqual(rail.x, controls[1].x);
    try std.testing.expectEqual(rail.y, controls[1].y);
    for (controls[1..count]) |control| {
        try std.testing.expect(control.overlay);
        try std.testing.expectEqual(bubble_control_activation_inset, control.activation_inset);
        try std.testing.expectEqual(@as(f32, 40), control.w + control.activation_inset * 2);
        try std.testing.expectEqual(@as(f32, 40), control.h + control.activation_inset * 2);
    }

    model.bubble_group_visible = false;
    model.bubble_fold_phase = .folded;
    model.bubble_hovered_identity = 0;
    model.bubble_hover_amount = 0;
    const closed_count = bubbleNativeControls(&model, &controls);
    try std.testing.expectEqual(@as(usize, 1), closed_count);
    try std.testing.expect(!controls[0].selected);
    try std.testing.expectEqual(@as(u8, 1), controls[0].badge_count);
    try std.testing.expectEqual(plat.BubbleDisclosureMode.hidden, controls[0].disclosure_mode);
    try std.testing.expectEqualStrings("Sessions hidden", controls[0].accessibility_value.slice());
    try std.testing.expect(!controls[0].toggled);
}

test "portable disclosure uses registered app icons for each visible mode" {
    var has_layers = false;
    var has_recent = false;
    for (app_icons) |entry| {
        if (std.mem.eql(u8, entry.name, "bubble-layers")) has_layers = true;
        if (std.mem.eql(u8, entry.name, "bubble-recent")) has_recent = true;
    }
    try std.testing.expect(has_layers);
    try std.testing.expect(has_recent);
}

test "portable bubble controls are constructed independently of native glass submission" {
    var model: Model = .{};
    testPushBubble(&model, "portable-session", "Portable bubble controls", false, -1);

    var controls: [plat.max_bubble_native_controls]plat.BubbleNativeControl = @splat(.{});
    const count = bubbleNativeControls(&model, &controls);
    try std.testing.expect(count > 0);
    try std.testing.expectEqual(plat.BubbleNativeControlAction.toggle_visibility, controls[0].action);
}

test "Linux native accessibility controls retain unhovered actions without painting them" {
    var model: Model = .{};
    testPushBubble(&model, "linux-keyboard-session", "Keyboard reachable", false, -1);
    model.bubble_group_visible = true;
    model.bubble_expansion = 1;
    model.bubble_fold_phase = .unfolded;
    model.bubble_hovered_identity = 0;
    model.bubble_hover_amount = 0;
    retargetBubbleGroupSizeSpring(&model);

    var visual: [plat.max_bubble_native_controls]plat.BubbleNativeControl = @splat(.{});
    var accessible: [plat.max_bubble_native_controls]plat.BubbleNativeControl = @splat(.{});
    const visual_count = bubbleNativeControls(&model, &visual);
    const accessible_count = bubbleNativeControlsWithPolicy(&model, &accessible, true);
    try std.testing.expectEqual(@as(usize, 1), visual_count);
    try std.testing.expect(accessible_count > visual_count);
    for (accessible[1..accessible_count]) |control| {
        try std.testing.expect(control.enabled);
        try std.testing.expectEqual(@as(f32, 0), control.presentation_alpha);
        try std.testing.expect(control.accessibility_label.slice().len > 0);
    }
}

test "Linux portable bubble panels do not request a glass blur" {
    try std.testing.expectEqual(@as(f32, 0), bubblePortableBackdropBlur(.linux));
    try std.testing.expectEqual(@as(f32, 14), bubblePortableBackdropBlur(.windows));
    try std.testing.expectEqual(@as(f32, 14), bubblePortableBackdropBlur(.macos));
    try std.testing.expect(bubblePortableUsesLayoutSpacers(.linux));
    try std.testing.expect(!bubblePortableUsesLayoutSpacers(.windows));
    try std.testing.expect(!bubblePortableUsesLayoutSpacers(.macos));
}

test "Linux portable bubble geometry settles without native glass materialization" {
    try std.testing.expect(bubbleGeometrySettlesImmediately(.linux, false));
    try std.testing.expect(!bubbleGeometrySettlesImmediately(.windows, false));
    try std.testing.expect(!bubbleGeometrySettlesImmediately(.macos, false));
    try std.testing.expect(bubbleGeometrySettlesImmediately(.windows, true));
}

test "Linux portable cards bypass the native glass materialization phase" {
    var model: Model = .{};
    testPushBubble(&model, "portable-session", "Portable bubble content", true, -1);
    model.bubble_expansion = 0;
    model.bubble_expansion_target = 1;
    model.bubble_fold_phase = .materializing;

    const linux_frame = bubbleVisualFrameForPlatform(&model, 0, .linux);
    try std.testing.expectEqual(linux_frame.base_w, linux_frame.w);
    try std.testing.expectEqual(linux_frame.base_h, linux_frame.h);
    try std.testing.expectEqual(@as(f32, 1), linux_frame.alpha);
    try std.testing.expectEqual(@as(f32, 1), bubbleContentRevealForPlatform(&model, 0, .linux));

    const animated_frame = bubbleVisualFrameForPlatform(&model, 0, .windows);
    try std.testing.expectEqual(bubble_disclosure_size, animated_frame.w);
    try std.testing.expectEqual(bubble_disclosure_size, animated_frame.h);
    try std.testing.expectEqual(@as(f32, 0), bubbleContentRevealForPlatform(&model, 0, .windows));

    model.bubble_group_visible = false;
    model.bubble_fold_phase = .collapsing;
    try std.testing.expectEqual(@as(f32, 0), bubbleContentRevealForPlatform(&model, 0, .linux));
    try std.testing.expectEqual(@as(f32, 0), bubbleVisualFrameForPlatform(&model, 0, .linux).alpha);
}

test "disclosure cycles all recent hidden and back to all" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "First session", false, -1);
    testPushBubble(&model, "beta", "Second session", true, -1);
    try std.testing.expectEqual(BubbleDisplayMode.all, bubbleDisplayMode(&model));

    var next = nextBubbleDisplayMode(bubbleDisplayMode(&model));
    try std.testing.expectEqual(BubbleDisplayMode.recent, next);
    setBubbleDisplayMode(&model, next);
    try std.testing.expect(model.bubble_group_visible);
    try std.testing.expect(model.bubble_show_recent_only);

    next = nextBubbleDisplayMode(bubbleDisplayMode(&model));
    try std.testing.expectEqual(BubbleDisplayMode.hidden, next);
    setBubbleDisplayMode(&model, next);
    try std.testing.expect(!model.bubble_group_visible);

    next = nextBubbleDisplayMode(bubbleDisplayMode(&model));
    try std.testing.expectEqual(BubbleDisplayMode.all, next);
    setBubbleDisplayMode(&model, next);
    try std.testing.expect(model.bubble_group_visible);
    try std.testing.expect(!model.bubble_show_recent_only);
}

test "recent mode follows the newest active conversation through every geometry consumer" {
    var model: Model = .{};
    testPushBubble(&model, "older-attention", "Waiting for a choice", false, -1);
    testPushBubble(&model, "newer-running", "Implementing", true, -1);
    testPushBubble(&model, "newest-quiet", "Done", false, -1);
    model.bubbles[0].status = .needs_input;
    model.bubbles[0].counter = 8;
    model.bubbles[1].status = .running;
    model.bubbles[1].counter = 12;
    model.bubbles[2].status = .completed;
    model.bubbles[2].counter = 20;
    model.bubble_show_recent_only = true;
    model.bubble_fold_phase = .unfolded;
    model.bubble_expansion = 1;

    try std.testing.expectEqual(@as(usize, 1), bubbleMostRecentActiveSlot(&model));
    try std.testing.expectEqualStrings("newer-running", frontBubble(&model).?.sessionSlice());
    try std.testing.expectEqual(@as(usize, 1), bubblePresentedCount(&model));
    try std.testing.expectEqual(@as(f32, 0), bubbleCardAlpha(&model, 0));
    try std.testing.expectEqual(@as(f32, 1), bubbleCardAlpha(&model, 1));
    try std.testing.expectEqual(@as(f32, 0), bubbleCardAlpha(&model, 2));
    try std.testing.expect(!bubbleStackable(&model));
    try std.testing.expectEqual(bubbleRenderedCardHeight(&model, 1), bubbleStackHeightAt(&model, 1));

    // A later event moves the single presentation without needing a manual
    // reorder or reopening the group.
    model.bubbles[0].counter = 24;
    try std.testing.expectEqual(@as(usize, 0), bubbleMostRecentActiveSlot(&model));
    try std.testing.expectEqualStrings("older-attention", frontBubble(&model).?.sessionSlice());
    try std.testing.expectEqual(@as(f32, 1), bubbleCardAlpha(&model, 0));
    try std.testing.expectEqual(@as(f32, 0), bubbleCardAlpha(&model, 1));
}

test "hidden disclosure morphs count and status without shrinking its hit target" {
    var model: Model = .{ .dark = true };
    testPushBubble(&model, "question", "Choose a target", false, -1);
    model.bubbles[0].status = .needs_input;
    model.bubble_group_visible = false;
    model.bubble_show_recent_only = false;
    model.bubble_fold_phase = .folded;
    model.bubble_anim_last_ms = 1_000;

    var controls: [plat.max_bubble_native_controls]plat.BubbleNativeControl = @splat(.{});
    var count = bubbleNativeControls(&model, &controls);
    try std.testing.expectEqual(@as(usize, 1), count);
    try std.testing.expectEqual(@as(u8, 1), controls[0].badge_count);
    try std.testing.expect(!controls[0].show_status_icon);
    try std.testing.expectEqual(plat.BubbleGlassSemanticState.needs_input, controls[0].semantic_state);
    try std.testing.expectEqual(bubble_disclosure_activation_inset, controls[0].activation_inset);

    model.bubble_anim_last_ms = bubble_disclosure_morph_segment_ms + 1_000;
    count = bubbleNativeControls(&model, &controls);
    try std.testing.expectEqual(@as(usize, 1), count);
    try std.testing.expectEqual(@as(u8, 0), controls[0].badge_count);
    try std.testing.expect(controls[0].show_status_icon);

    try std.testing.expectEqual(@as(f32, 44), controls[0].w + controls[0].activation_inset * 2);
    try std.testing.expectEqual(@as(f32, 44), controls[0].h + controls[0].activation_inset * 2);

    model.reduce_motion = true;
    count = bubbleNativeControls(&model, &controls);
    try std.testing.expectEqual(@as(u8, 1), controls[0].badge_count);
    try std.testing.expect(!controls[0].show_status_icon);
    try std.testing.expectEqual(@as(f32, 1), controls[0].presentation_alpha);
}

test "fold transitions detach nonfront content before glass convergence" {
    var model: Model = .{};
    testPushBubble(&model, "older", "Older response", false, -1);
    testPushBubble(&model, "front", "Front response", true, -1);
    model.bubble_expansion = 0.7;
    model.bubble_fold_phase = .collapsing;
    try std.testing.expectEqual(@as(f32, 0), bubbleContentReveal(&model, 0));
    try std.testing.expectEqual(@as(f32, 0), bubbleContentReveal(&model, 1));
    model.bubble_fold_phase = .materializing;
    try std.testing.expectEqual(@as(f32, 0), bubbleContentReveal(&model, 0));
    model.bubble_fold_phase = .unfolded;
    try std.testing.expectEqual(@as(f32, 1), bubbleContentReveal(&model, 0));
}

test "measured ellipsis keeps shimmer text within its clipping band" {
    const model: Model = .{};
    const tokens = petdexTokens(&model);
    const font = canvas.textSpanFontId(.{ .text = "" }, tokens.typography);
    var scratch: [256]u8 = undefined;
    const fitted = fitTextToWidth("Remote résumé 東京 with a long activity summary", 92, tokens.text_measure, font, bubbleMessageFontSize(&model), &scratch);
    try std.testing.expect(std.unicode.utf8ValidateSlice(fitted));
    try std.testing.expect(canvas.measureTextWidthForFont(tokens.text_measure, font, fitted, bubbleMessageFontSize(&model)) <= 92.01);
}

test "closed disclosure hides every conversation text band" {
    var model: Model = .{};
    testPushBubble(&model, "older", "Older content must not overlap", false, -1);
    testPushBubble(&model, "front", "Front content remains readable", false, -1);
    model.bubble_expansion = 0;
    model.bubble_fold_phase = .folded;
    try std.testing.expectEqual(@as(f32, 0), bubbleContentReveal(&model, 0));
    try std.testing.expectEqual(@as(f32, 0), bubbleContentReveal(&model, 1));

    model.bubble_expansion = 1;
    model.bubble_fold_phase = .unfolded;
    try std.testing.expectApproxEqAbs(@as(f32, 1), bubbleContentReveal(&model, 0), 0.0001);
    try std.testing.expectEqual(@as(f32, 1), bubbleContentReveal(&model, 1));
}

test "session message stays clamped when legacy preference requests eight lines" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen", true, -1);
    model.bubble_columns = 12;
    model.bubble_answer_lines = 2;
    const two_line_height = bubbleCardHeight(&model, 0);
    model.bubble_answer_lines = 8;
    try std.testing.expectEqual(two_line_height, bubbleCardHeight(&model, 0));

    try std.testing.expectEqual(bubble_message_lines_max, bubbleLayoutMetrics(&model, 0).message_line_count);
}

test "measured wrapping consumes the full inner width without a 40 character cut" {
    var model: Model = .{};
    const text = "Both production builds now pass the native ReleaseFast artifact and the remote smoke verification while preserving every authoritative assistant detail from the canonical feed";
    testPushBubble(&model, "alpha", text, false, -1);
    const metrics = bubbleLayoutMetrics(&model, 0);
    const tokens = petdexTokens(&model);
    const font = canvas.textSpanFontId(.{ .text = "" }, tokens.typography);
    try std.testing.expectEqual(bubble_message_lines_max, metrics.message_line_count);
    // The measured line may be shorter than the old 40-character heuristic
    // now that message typography is larger; it must still use most of the
    // available width rather than wrapping at an arbitrary character count.
    try std.testing.expect(charCount(metrics.message_lines[0]) > 20);
    try std.testing.expect(canvas.measureTextWidthForFont(tokens.text_measure, font, metrics.message_lines[0], bubbleMessageFontSize(&model)) > metrics.inner_width * 0.65);
    for (metrics.message_lines) |line| {
        if (line.len == 0) continue;
        try std.testing.expect(std.unicode.utf8ValidateSlice(line));
        try std.testing.expect(canvas.measureTextWidthForFont(tokens.text_measure, font, line, bubbleMessageFontSize(&model)) <= metrics.inner_width + 0.01);
    }
    try std.testing.expect(std.mem.endsWith(u8, metrics.message_lines[1], "\u{2026}"));
}

test "the window takes the widest card in the stack" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "hi", false, -1);
    const solo = bubbleWindowWidth(&model);
    testPushBubble(&model, "beta", "a much longer line of bubble text", false, -1);
    const widest = bubbleCardWidth(&model, 1);
    try std.testing.expect(bubbleWindowWidth(&model) > solo);
    try std.testing.expectEqual(widest + bubble_canvas_margin * 2, bubbleWindowWidth(&model));
    // Every presentation card consumes the common measured width.
    try std.testing.expectEqual(widest, bubbleCardWidth(&model, 0));
    try std.testing.expectEqual(bubbleRenderedCardWidth(&model, 0), bubbleRenderedCardWidth(&model, 1));
}

test "one bubble still uses the manual disclosure and hover never toggles it" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "solo", true, -1);
    try std.testing.expect(!bubbleStackable(&model));
    try std.testing.expectEqual(@as(f32, 1), bubbleCardScale(&model, 0));
    try std.testing.expectEqual(@as(f32, 1), bubbleCardAlpha(&model, 0));
    try std.testing.expect(model.bubble_group_visible);
    updateBubbleHover(&model, true, 10_000);
    try std.testing.expectEqual(@as(f32, 1), model.bubble_expansion_target);
    try std.testing.expectEqual(@as(i64, -1), model.bubble_hover_since_ms);
}

test "closed group hides all cards at the disclosure frame" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "older", false, -1);
    testPushBubble(&model, "beta", "newer", true, -1);
    try std.testing.expect(bubbleStackable(&model));
    model.bubble_group_visible = false;
    model.bubble_expansion = 0;
    model.bubble_fold_phase = .folded;
    const disclosure = bubbleDisclosureFrame(&model);
    for (0..model.bubbles_len) |slot| {
        try std.testing.expectEqual(@as(f32, 0), bubbleCardAlpha(&model, slot));
        const frame = bubbleVisualFrame(&model, slot);
        try std.testing.expectApproxEqAbs(disclosure.x, bubble_canvas_margin + frame.x, 0.01);
        try std.testing.expectApproxEqAbs(disclosure.y, bubbleStackOriginY(&model) + frame.y, 0.01);
    }
}

test "expanded restores the slice 1 column" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "older", false, -1);
    testPushBubble(&model, "beta", "newer", true, -1);
    model.bubble_expansion = 1;
    model.bubble_fold_phase = .unfolded;

    // Fully expanded every card is full size and solid again, spaced a
    // whole card plus the stack gap apart: exactly the slice 1 layout.
    for (0..model.bubbles_len) |i| {
        try std.testing.expectEqual(@as(f32, 1), bubbleCardScale(&model, i));
        try std.testing.expectEqual(@as(f32, 1), bubbleCardAlpha(&model, i));
    }
    try std.testing.expectEqual(bubbleStackHeightAt(&model, 1) - bubbleCardHeight(&model, 1), bubbleCardOffset(&model, 1));
    try std.testing.expectEqual(bubbleCardHeight(&model, 0) + bubble_stack_gap, bubbleCardOffset(&model, 1) - bubbleCardOffset(&model, 0));
}

test "hover reveals one card but never changes manual group visibility" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "older", false, -1);
    testPushBubble(&model, "beta", "newer", true, -1);

    model.bubble_group_visible = false;
    model.bubble_expansion_target = 0;
    updateBubbleHover(&model, true, 1_000);
    try std.testing.expectEqual(@as(f32, 0), model.bubble_expansion_target);
    try std.testing.expect(model.bubble_hovered_identity != 0);
    updateBubbleHover(&model, false, 2_000);
    try std.testing.expectEqual(@as(f32, 0), model.bubble_expansion_target);
    try std.testing.expectEqual(@as(u64, 0), model.bubble_hovered_identity);
}

test "expansion walks to its target and settles" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "older", false, -1);
    testPushBubble(&model, "beta", "newer", true, -1);
    model.bubble_expansion = 0;
    model.bubble_expansion_target = 1;
    model.bubble_fold_phase = .materializing;
    model.bubble_anim_last_ms = 1_000;

    // One frame moves partway, never straight to the end.
    try std.testing.expect(stepBubbleExpansionForPlatform(&model, 1_016, .macos));
    try std.testing.expect(model.bubble_expansion > 0);
    try std.testing.expect(model.bubble_expansion < 1);

    // Enough frames and it lands exactly on the target, then reports no
    // further movement so the caller can stop syncing the window.
    var t: i64 = 1_016;
    while (t < 2_500) : (t += 16) {
        _ = stepBubbleExpansionForPlatform(&model, t, .macos);
    }
    try std.testing.expectEqual(@as(f32, 1), model.bubble_expansion);
    model.bubbles[1].busy = false;
    model.reduce_motion = true;
    _ = stepBubbleExpansionForPlatform(&model, t + 1, .macos);
    model.reduce_motion = false;
    try std.testing.expect(!stepBubbleExpansionForPlatform(&model, t + 16, .macos));

    // A long stall (sleeping machine) is clamped, not teleported.
    model.bubble_expansion_target = 0;
    model.bubble_anim_last_ms = t;
    _ = stepBubbleExpansionForPlatform(&model, t + 10_000, .macos);
    try std.testing.expect(model.bubble_expansion > 0);
}

test "idle GPU frame channel stops even while a session is busy" {
    var model: Model = .{
        .sheet_loaded = true,
        .window_fitted = true,
    };
    testPushBubble(&model, "codex", "working", true, -1);

    try std.testing.expect(onFrame(&model, .{}) == null);

    const input_timestamp: u64 = 42_000_000;
    const input_msg = onFrame(&model, .{ .input_timestamp_ns = input_timestamp }) orelse
        return error.TestExpectedEqual;
    switch (input_msg) {
        .frame_clock => |clock| try std.testing.expectEqual(input_timestamp, clock.input_timestamp_ns),
        else => return error.TestExpectedEqual,
    }

    model.last_gpu_input_timestamp_ns = input_timestamp;
    try std.testing.expect(onFrame(&model, .{ .input_timestamp_ns = input_timestamp }) == null);
    model.dragging = true;
    try std.testing.expect(onFrame(&model, .{ .input_timestamp_ns = input_timestamp }) != null);
}

test "settled busy cards do not rearm geometry animation" {
    var model: Model = .{};
    testPushBubble(&model, "codex", "working", true, -1);
    model.bubble_group_visible = true;
    model.bubble_expansion = 1;
    model.bubble_expansion_target = 1;
    model.bubble_fold_phase = .unfolded;
    retargetBubbleGroupSizeSpring(&model);
    for (&model.bubble_card_height_springs) |*spring| {
        if (!spring.initialized) continue;
        spring.height = spring.target;
        spring.velocity = 0;
    }
    model.bubble_group_size_spring.width = model.bubble_group_size_spring.width_target;
    model.bubble_group_size_spring.width_velocity = 0;
    model.bubble_anim_last_ms = 1_000;

    try std.testing.expect(!stepBubbleExpansion(&model, 1_016));
    try std.testing.expect(!bubblePresentationAnimationPending(&model, 1_016));
}

test "hover hit tests the drawn cards, not the tall transparent window" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "older", false, -1);
    testPushBubble(&model, "beta", "newer", true, -1);

    const win_x: f64 = 100;
    const win_y: f64 = 200;
    const win_height: f64 = @floatCast(bubbleWindowHeight(&model));
    const visible = bubbleCardsRect(&model);
    const inside_x = win_x + visible.x + visible.w / 2;
    const inside_y = win_y + visible.y + visible.h / 2;

    try std.testing.expect(bubbleHoverHit(&model, win_x, win_y, win_height, inside_x, inside_y));
    // The window reserves the expanded height even while collapsed, so
    // the top of the window is empty air. That must NOT count as hover
    // or the stack would open from far above the visible cards.
    try std.testing.expect(!bubbleHoverHit(&model, win_x, win_y, win_height, win_x + 20, win_y + 2));
    // Outside horizontally.
    try std.testing.expect(!bubbleHoverHit(&model, win_x, win_y, win_height, win_x - 5, inside_y));
    // Below the cards entirely (down by the pet).
    try std.testing.expect(!bubbleHoverHit(&model, win_x, win_y, win_height, inside_x, win_y + win_height + 30));

    // Expanded, the live band reaches much higher up the window.
    model.bubble_expansion = 1;
    const high = win_y + @as(f64, @floatCast(bubbleStackOriginY(&model) + bubbleCardOffset(&model, 0) + bubbleCardHeight(&model, 0) / 2));
    try std.testing.expect(bubbleHoverHit(&model, win_x, win_y, win_height, win_x + 20, high));
}

test "uniform group uses one common measured width in every phase" {
    var model: Model = .{};
    // A wide card behind a narrow front one: the case that looked wrong
    // on screen, with the peek jutting out past the front card's edge
    // and its text still legible.
    testPushBubble(&model, "alpha", "a much longer line of bubble text", false, -1);
    testPushBubble(&model, "beta", "eve", true, -1);

    const front = bubbleCardWidth(&model, 1);
    try std.testing.expectEqual(bubbleCardWidth(&model, 0), front);
    const common = bubbleCardWidth(&model, 0);
    try std.testing.expectEqual(common, bubbleRenderedCardWidth(&model, 0));
    try std.testing.expectEqual(common, bubbleRenderedCardWidth(&model, 1));

    // Every card centers on the SAME axis: stackChildFrame pins overlay
    // children to the container's left edge, so without this the narrow
    // card sat left and the wide ones fanned right. The axis itself
    // tracks the pet rather than the container center, so this compares
    // the cards against each other, not against a fixed midpoint.
    const axis = bubbleCardCenterDx(&model, 0) + bubbleRenderedCardWidth(&model, 0) / 2;
    for (0..model.bubbles_len) |i| {
        const dx = bubbleCardCenterDx(&model, i);
        const w = bubbleRenderedCardWidth(&model, i);
        try std.testing.expect(@abs((dx + w / 2) - axis) < 0.01);
    }

    // Expanded presentation stays uniform too.
    model.bubble_expansion = 1;
    model.bubble_fold_phase = .unfolded;
    try std.testing.expectEqual(common, bubbleRenderedCardWidth(&model, 0));
    var short: Model = .{};
    testPushBubble(&short, "alpha", "hi", false, -1);
    testPushBubble(&short, "beta", "a much longer line of bubble text", true, -1);
    try std.testing.expectEqual(bubbleRenderedCardWidth(&short, 0), bubbleRenderedCardWidth(&short, 1));
}

test "flipping sends the stack below the pet, clear of the sprite" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "older", false, -1);
    testPushBubble(&model, "beta", "newer", true, -1);
    const bubble_h = bubbleWindowHeight(&model);

    // Pet pinned to the very top of the screen: there is no room above,
    // so the window must hang below it and never overlap the sprite.
    model.pet_y = 0;
    model.bubble_flipped = bubbleShouldFlip(&model, model.pet_y, @floatCast(bubble_h));
    try std.testing.expect(model.bubble_flipped);

    const pet_h: f64 = @floatCast(frame_h * model.scale);
    const win_y = bubbleWantY(&model, bubble_h);
    try std.testing.expect(win_y >= model.pet_y + pet_h + bubble_pet_clearance - 0.01);

    // Plenty of room above: the stack sits over the pet as usual, and
    // the window ends above the pet with the same positive clearance.
    var high: Model = .{};
    testPushBubble(&high, "alpha", "older", false, -1);
    testPushBubble(&high, "beta", "newer", true, -1);
    high.pet_y = 2000;
    high.bubble_flipped = bubbleShouldFlip(&high, high.pet_y, @floatCast(bubble_h));
    try std.testing.expect(!high.bubble_flipped);
    try std.testing.expect(bubbleWantY(&high, bubble_h) + @as(f64, @floatCast(bubble_h)) <= high.pet_y - bubble_pet_clearance + 0.01);
}

test "the flip has hysteresis so a pet on the threshold does not flap" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "older", false, -1);
    testPushBubble(&model, "beta", "newer", true, -1);
    const needed: f64 = 200;

    // Coming from unflipped it takes the full height plus the clearance to
    // flip down.
    model.bubble_flipped = false;
    try std.testing.expect(!bubbleShouldFlip(&model, needed + bubble_pet_clearance + 1, needed));
    try std.testing.expect(bubbleShouldFlip(&model, needed + bubble_pet_clearance - 1, needed));

    // Once flipped, the same space is NOT enough to come back: it takes
    // the clearance and hysteresis too, so the band between the two is
    // stable either way.
    model.bubble_flipped = true;
    try std.testing.expect(bubbleShouldFlip(&model, needed + bubble_pet_clearance + bubble_flip_hysteresis - 1, needed));
    try std.testing.expect(!bubbleShouldFlip(&model, needed + bubble_pet_clearance + bubble_flip_hysteresis + 1, needed));
}

test "a flipped stack grows downward and is hit tested from the top" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "older", false, -1);
    testPushBubble(&model, "beta", "newer", true, -1);

    model.bubble_expansion = 1;
    model.bubble_fold_phase = .unfolded;
    // Unflipped the cards behind sit ABOVE the front one.
    try std.testing.expect(bubbleCardOffset(&model, 0) < bubbleCardOffset(&model, 1));
    model.bubble_flipped = true;
    // Flipped they hang BELOW it, and the front card leads at the top.
    try std.testing.expect(bubbleCardOffset(&model, 0) > bubbleCardOffset(&model, 1));
    try std.testing.expectEqual(@as(f32, 0), bubbleCardOffset(&model, 1));

    const win_x: f64 = 100;
    const win_y: f64 = 200;
    const win_height: f64 = @floatCast(bubbleWindowHeight(&model));
    const top = win_y + @as(f64, @floatCast(bubbleStackOriginY(&model)));

    // Just below the top edge is on the cards now.
    try std.testing.expect(bubbleHoverHit(&model, win_x, win_y, win_height, win_x + 20, top + 4));
    // The empty band is at the BOTTOM of a flipped window, and must not
    // count as hover.
    try std.testing.expect(!bubbleHoverHit(&model, win_x, win_y, win_height, win_x + 20, win_y + win_height - 2));
}

test "uniform cards keep one stable stack axis at screen edges" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "a much longer line of bubble text", false, -1);
    testPushBubble(&model, "beta", "eve", true, -1);

    const stack_w = bubbleStackWidth(&model);
    const front = bubbleRenderedCardWidth(&model, 1);
    try std.testing.expectEqual(front, stack_w);

    const axis_right = bubbleStackAxis(&model, stack_w, 0);
    try std.testing.expectEqual(stack_w / 2, axis_right);

    // Same on the other side.
    const axis_left = bubbleStackAxis(&model, 0, 0);
    try std.testing.expectEqual(stack_w / 2, axis_left);

    // A pet comfortably inside gets its exact center, no clamp.
    try std.testing.expectEqual(stack_w / 2, bubbleStackAxis(&model, stack_w / 2, 0));

    // Expanded the clamp has to fit the WIDEST card, so a pet at the
    // edge pushes the fan inward: the axis lands at the container
    // center because the widest card fills it.
    try std.testing.expectEqual(stack_w / 2, bubbleStackAxis(&model, stack_w, 1));

    const mid = bubbleStackAxis(&model, stack_w, 0.5);
    try std.testing.expectEqual(stack_w / 2, mid);
}

test "the disclosure follows the pet and stays inside the window margins" {
    var model: Model = .{};
    testPushBubble(&model, "codex", "running tests", true, -1);
    model.bubble_pet_center_local = 0;
    try std.testing.expectEqual(bubble_canvas_margin, bubbleDisclosureFrameForPlatform(&model, .macos).x);
    model.bubble_pet_center_local = bubbleStackWidth(&model);
    const right = bubbleDisclosureFrameForPlatform(&model, .windows);
    try std.testing.expectEqual(bubbleWindowWidth(&model) - bubble_canvas_margin - bubble_disclosure_size, right.x);
}

test "linux centers the disclosure and bubble drag on the pet anchored popover" {
    var model: Model = .{};
    testPushBubble(&model, "codex", "running tests", true, -1);
    // This field is intentionally wrong: Linux must ignore stale global-window
    // bookkeeping because GtkPopover supplies the authoritative local origin.
    model.bubble_pet_center_local = 0;
    const disclosure = bubbleDisclosureFrameForPlatform(&model, .linux);
    try std.testing.expectApproxEqAbs(bubbleWindowWidth(&model) / 2, disclosure.x + disclosure.w / 2, 0.01);
    try std.testing.expect(bubblePortableCardUsesWindowDrag(.linux, true));
    try std.testing.expect(!bubblePortableCardUsesWindowDrag(.linux, false));
    try std.testing.expect(!bubblePortableCardUsesWindowDrag(.macos, true));
    try std.testing.expect(!bubblePortableCardUsesWindowDrag(.windows, true));
}

test "closed cards converge into the disclosure and open to intrinsic frames" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "a much wider card behind the front one with enough prose to wrap", false, -1);
    testPushBubble(&model, "codex", "working", true, -1);
    model.bubble_pet_center_local = bubbleStackWidth(&model) / 2;
    model.bubble_expansion = 0;
    const disclosure = bubbleDisclosureFrame(&model);
    for (0..model.bubbles_len) |slot| {
        const closed = bubbleVisualFrame(&model, slot);
        try std.testing.expectApproxEqAbs(disclosure.x, bubble_canvas_margin + closed.x, 0.01);
        try std.testing.expectApproxEqAbs(disclosure.y, bubbleStackOriginY(&model) + closed.y, 0.01);
        try std.testing.expectEqual(bubble_disclosure_size, closed.w);
        try std.testing.expectEqual(bubble_disclosure_size, closed.h);
    }
    model.bubble_expansion = 1;
    const first = bubbleVisualFrame(&model, 0);
    const second = bubbleVisualFrame(&model, 1);
    try std.testing.expect(first.y + first.h + bubble_stack_gap <= second.y + 0.01);
    try std.testing.expect(first.h != second.h);
}

test "disclosure and native card geometry share window coordinates on both placements" {
    for ([_]bool{ false, true }) |flipped| {
        var model: Model = .{};
        testPushBubble(&model, "codex", "checking balanced padding", true, -1);
        model.bubble_pet_center_local = bubbleStackWidth(&model) / 2;
        model.bubble_flipped = flipped;
        model.bubble_group_visible = true;
        model.bubble_expansion = 1;
        model.bubble_fold_phase = .unfolded;
        const frame = bubbleVisualFrame(&model, 0);
        const card_y = bubbleStackOriginY(&model) + frame.y;
        const disclosure = bubbleDisclosureFrame(&model);
        if (flipped) {
            try std.testing.expect(disclosure.y < card_y);
        } else {
            try std.testing.expect(card_y + frame.h < disclosure.y);
        }
    }
}

test "bubble movement crosses displays before applying target bounds" {
    // A constrained relative move is bounded by the display that owns the
    // bubble before the move. It cannot cross a monitor boundary from that
    // display, so the implementation must first use global coordinates and
    // only then ask the destination display to apply its visible-frame clamp.
    const src = @embedFile("main.zig");
    const sync_start = std.mem.indexOf(u8, src, "fn syncBubbleWindow").?;
    const sync = src[sync_start..];
    const unbounded = std.mem.indexOf(u8, sync, "fx.moveWindow(\"bubble\", plan.dx, plan.dy, false)");
    const bounded = std.mem.indexOf(u8, sync, "fx.moveWindow(\"bubble\", 0, 0, true)");
    const readback = std.mem.indexOf(u8, sync, "const actual = fx.moveWindow(\"bubble\", 0, 0, false)");
    const correction = std.mem.indexOf(u8, sync, "fx.moveWindow(\"bubble\", correction.dx, correction.dy, false)");
    try std.testing.expect(unbounded != null);
    try std.testing.expect(bounded != null);
    try std.testing.expect(readback != null);
    try std.testing.expect(correction != null);
    try std.testing.expect(unbounded.? < bounded.?);
    try std.testing.expect(bounded.? < readback.?);
    try std.testing.expect(readback.? < correction.?);
}

test "bubble move plan preserves signed screen coordinates" {
    const MoveCase = struct {
        cur_x: f64,
        cur_y: f64,
        want_x: f64,
        want_y: f64,
        dx: f64,
        dy: f64,
    };
    const cases = [_]MoveCase{
        .{ .cur_x = 1280, .cur_y = 120, .want_x = -640, .want_y = 120, .dx = -1920, .dy = 0 },
        .{ .cur_x = -1440, .cur_y = -300, .want_x = 1920, .want_y = 600, .dx = 3360, .dy = 900 },
        .{ .cur_x = 300, .cur_y = -900, .want_x = 300, .want_y = 200, .dx = 0, .dy = 1100 },
        .{ .cur_x = 300, .cur_y = 900, .want_x = 300, .want_y = -800, .dx = 0, .dy = -1700 },
    };
    for (cases) |case| {
        const plan = bubbleMovePlan(case.cur_x, case.cur_y, case.want_x, case.want_y) orelse {
            return error.MissingMovePlan;
        };
        try std.testing.expectApproxEqAbs(case.dx, plan.dx, 0.001);
        try std.testing.expectApproxEqAbs(case.dy, plan.dy, 0.001);
    }
    try std.testing.expect(bubbleMovePlan(10, 20, 10.4, 20.4) == null);
}

test "bubble keeps one pet-relative offset through drag release and throw positions" {
    var model: Model = .{};
    testPushBubble(&model, "codex", "running tests", true, -1);
    model.scale = 1.25;
    const bubble_w = bubbleWindowWidth(&model);
    const bubble_h = bubbleWindowHeight(&model);
    const pet_w: f64 = @floatCast(frame_w * model.scale);
    const expected_center_dx = pet_w / 2.0 - @as(f64, @floatCast(bubble_w)) / 2.0;

    // Drag start, an in-flight drag sample, button release, then two throw
    // frames. The placement helpers consume only the latest pet origin, so
    // every phase must produce exactly the same pet-relative attachment.
    const positions = [_][2]f64{
        .{ -900, 900 },
        .{ -420, 760 },
        .{ 100, 710 },
        .{ 510, 680 },
        .{ 890, 640 },
    };
    for (positions) |position| {
        model.pet_x = position[0];
        model.pet_y = position[1];
        model.bubble_flipped = bubbleShouldFlip(&model, model.pet_y, @floatCast(bubble_h));
        try std.testing.expect(!model.bubble_flipped);
        const bubble_x = bubbleWantX(&model, bubble_w);
        const bubble_y = bubbleWantY(&model, bubble_h);
        try std.testing.expectApproxEqAbs(expected_center_dx, bubble_x - model.pet_x, 0.001);
        try std.testing.expectApproxEqAbs(
            model.pet_y - bubble_pet_clearance,
            bubble_y + bubble_h,
            0.001,
        );
    }
}

test "drag and throw branches resync the bubble after each pet move" {
    const src = @embedFile("main.zig");
    const throw_branch = std.mem.indexOf(u8, src, "if (model.throwing) {").?;
    const frame_read = std.mem.indexOf(u8, src[throw_branch..], "const read = fx.moveWindow(\"main\", 0, 0, false)").? + throw_branch;
    const throw_move = std.mem.indexOf(u8, src[throw_branch..frame_read], "fx.moveWindow(\"main\", model.vx * dt, model.vy * dt, true)").? + throw_branch;
    const throw_sync = std.mem.indexOf(u8, src[throw_move..frame_read], "syncBubbleWindow(model, fx);");
    try std.testing.expect(throw_sync != null);

    const drag_branch = std.mem.indexOf(u8, src[frame_read..], "if (model.dragging) {").? + frame_read;
    const drag_move = std.mem.indexOf(u8, src[drag_branch..], "fx.moveWindow(\"main\", dx, dy, false)").? + drag_branch;
    const release = std.mem.indexOf(u8, src[drag_branch..], "model.dragging = false;").? + drag_branch;
    const drag_sync = std.mem.indexOf(u8, src[drag_move..release], "syncBubbleWindow(model, fx);");
    try std.testing.expect(drag_sync != null);

    // The common frame sync happens before the drag branch. It covers the
    // press transition and release frame; the second sync above covers the
    // window move performed while the button remains down.
    const common_sync = std.mem.lastIndexOf(u8, src[frame_read..drag_branch], "syncBubbleWindow(model, fx);");
    try std.testing.expect(common_sync != null);
}

test "bubble clamp correction reconciles a reported-only host clamp" {
    // A legacy host may report the target display's clamped origin while
    // leaving the window at the requested off-screen origin. The correction
    // must move from the read-back origin to the reported settled origin.
    const correction = bubbleClampCorrection(1920, 110, 1680, 96) orelse {
        return error.MissingClampCorrection;
    };
    try std.testing.expectApproxEqAbs(-240, correction.dx, 0.001);
    try std.testing.expectApproxEqAbs(-14, correction.dy, 0.001);

    // A fixed host has already applied the clamp, so the extra leg is a
    // no-op and must not perturb the window a second time.
    try std.testing.expect(bubbleClampCorrection(1680, 96, 1680, 96) == null);
}

test "the hover rect covers the whole visible card, not just its text" {
    // Hunter hit this live: the fan only opened over the TEXT. The hit
    // region was re-derived from the window edges and layout constants
    // while the cards are placed by bubbleCardCenterDx/bubbleCardOffset,
    // so the two drifted: a band running up from the window bottom, and
    // cards sitting on an axis that tracks the pet. The overlap was the
    // middle of the card, which is where the text is.
    var model: Model = .{};
    testPushBubble(&model, "alpha", "older", false, -1);
    testPushBubble(&model, "beta", "newer", true, -1);
    testPushBubble(&model, "eve", "ok, shipped", false, -1);
    model.bubble_expansion = 1;
    model.bubble_expansion_target = 1;
    model.bubble_fold_phase = .unfolded;
    model.bubble_pet_center_local = 120;

    for ([_]bool{ false, true }) |flipped| {
        model.bubble_flipped = flipped;
        const r = bubbleCardsRect(&model);

        // Every card that is drawn must sit inside the hit rect: this is
        // the property that was violated, and it is checked against the
        // SAME functions the renderer transforms by.
        for (0..model.bubbles_len) |slot| {
            const frame = bubbleVisualFrame(&model, slot);
            const cx = bubble_canvas_margin + frame.x;
            const cy = bubbleStackOriginY(&model) + frame.y;
            const cw = frame.w;
            const chh = frame.h;
            try std.testing.expect(r.x <= cx);
            try std.testing.expect(r.y <= cy);
            try std.testing.expect(r.x + r.w >= cx + cw);
            try std.testing.expect(r.y + r.h >= cy + chh);
        }

        // And it must not balloon to the whole window: a rect that always
        // said yes would pass the loop above while making the collapsed
        // stack expand from anywhere in the transparent canvas. Collapsed,
        // the widest thing drawn is the front card, so the rect is that
        // plus slop — NOT the full stack width, which is reserved for the
        // widest hidden card and is mostly transparent while collapsed.
        try std.testing.expectApproxEqAbs(
            bubbleRenderedCardWidth(&model, model.bubbles_len - 1) + bubble_hover_slop * 2,
            r.w,
            0.01,
        );
        try std.testing.expect(r.w < bubbleWindowWidth(&model));
        try std.testing.expect(r.h < bubbleWindowHeight(&model));

        // The corners of the front card answer, which is the actual
        // complaint: not just the text in the middle.
        const front_frame = bubbleVisualFrame(&model, model.bubbles_len - 1);
        const fx0 = bubble_canvas_margin + front_frame.x;
        const fy0 = bubbleStackOriginY(&model) + front_frame.y;
        const fw = front_frame.w;
        const fh = front_frame.h;
        const wh: f64 = @floatCast(bubbleWindowHeight(&model));
        for ([_][2]f32{
            .{ fx0 + 1, fy0 + 1 },
            .{ fx0 + fw - 1, fy0 + 1 },
            .{ fx0 + 1, fy0 + fh - 1 },
            .{ fx0 + fw - 1, fy0 + fh - 1 },
        }) |pt| {
            try std.testing.expect(bubbleHoverHit(&model, 0, 0, wh, pt[0], pt[1]));
        }

        // Well outside the cards still says no.
        try std.testing.expect(!bubbleHoverHit(&model, 0, 0, wh, fx0 - 40, fy0 + fh / 2));
        try std.testing.expect(!bubbleHoverHit(&model, 0, 0, wh, fx0 + fw + 40, fy0 + fh / 2));
    }
}

test "glass and hit testing use the root column's actual card origin" {
    // `bubbleView` contains no explicit outer-margin nodes. The window's two
    // canvas margins become spare height which `.main` places at the opposite
    // end from the pet. Write the layout equations independently here so the
    // AppKit glass cannot drift away from GPU content again.
    var model: Model = .{};
    testPushBubble(&model, "alpha", "older", false, -1);
    testPushBubble(&model, "beta", "newer", true, -1);
    testPushBubble(&model, "eve", "ok, shipped", false, -1);
    model.bubble_expansion = 1;
    model.bubble_expansion_target = 1;
    model.bubble_fold_phase = .unfolded;
    model.bubble_pet_center_local = 120;

    // The reserve the window carries beyond the cards themselves.
    const reserve = bubble_disclosure_size + bubble_disclosure_gap;
    const content_h = bubbleWindowHeight(&model) - bubble_canvas_margin * 2;
    try std.testing.expectApproxEqAbs(
        bubbleStackHeightAt(&model, 1) + reserve,
        content_h,
        0.01,
    );

    const current = bubbleStackHeightAt(&model, 1);
    const reserved = @max(current, bubbleEnvelopeStackHeight(&model));
    const unflipped_origin = bubble_canvas_margin + (reserved - current);
    const flipped_origin = bubble_canvas_margin + reserve;

    model.bubble_flipped = false;
    try std.testing.expectApproxEqAbs(unflipped_origin, bubbleStackOriginY(&model), 0.01);
    model.bubble_flipped = true;
    try std.testing.expectApproxEqAbs(flipped_origin, bubbleStackOriginY(&model), 0.01);

    // Both branches sit strictly below a bare margin, so returning a generic
    // canvas inset instead of the root-column placement fails both.
    try std.testing.expect(unflipped_origin >= bubble_canvas_margin);
    try std.testing.expect(flipped_origin > bubble_canvas_margin);
    // And they differ from each other, so a helper that dropped the flip
    // and returned one constant for both fails too.
    try std.testing.expect(unflipped_origin != flipped_origin);

    // The consequence Hunter felt: the BOTTOM edge of the front card is
    // inside the rect on both flips. This is what failed on screen.
    for ([_]bool{ false, true }) |flipped| {
        model.bubble_flipped = flipped;
        const origin_y = if (flipped) flipped_origin else unflipped_origin;
        const front = model.bubbles_len - 1;
        const front_frame = bubbleVisualFrame(&model, front);
        const fy0 = origin_y + front_frame.y;
        const fx = bubble_canvas_margin + front_frame.x + 4;
        const bottom = fy0 + front_frame.h;
        const wh: f64 = @floatCast(bubbleWindowHeight(&model));
        // One point inside the bottom edge: live.
        try std.testing.expect(bubbleHoverHit(&model, 0, 0, wh, fx, bottom - 1));
        // The bottom edge itself, within the grace band: still live.
        try std.testing.expect(bubbleHoverHit(&model, 0, 0, wh, fx, bottom + bubble_hover_slop - 1));
        // The live band ends at the LOWEST drawn edge, which is the front
        // card unflipped and the deepest peek once flipped: the peeks are
        // drawn, so they are hoverable, and the rect is their union.
        const first_frame = bubbleVisualFrame(&model, 0);
        var drawn_top = origin_y + first_frame.y;
        var drawn_bottom = drawn_top + first_frame.h;
        for (0..model.bubbles_len) |slot| {
            const frame = bubbleVisualFrame(&model, slot);
            const top = origin_y + frame.y;
            drawn_top = @min(drawn_top, top);
            drawn_bottom = @max(drawn_bottom, top + frame.h);
        }
        // Well past the slop below everything drawn: dead, so the fix
        // widened the rect onto the cards rather than onto the window.
        try std.testing.expect(!bubbleHoverHit(&model, 0, 0, wh, fx, drawn_bottom + bubble_hover_slop + 8));
        // Symmetrically, the air above the topmost card stays dead. This
        // is the half the old rect got wrong in the other direction: it
        // answered live in a band above the stack.
        try std.testing.expect(!bubbleHoverHit(&model, 0, 0, wh, fx, drawn_top - bubble_hover_slop - 8));
    }
}

test "closed hover rect follows the disclosure at screen edges" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "a much wider card than the front one", false, -1);
    testPushBubble(&model, "eve", "ok", false, -1);
    model.bubble_expansion = 0;
    model.bubble_expansion_target = 0;
    model.bubble_group_visible = false;
    model.bubble_fold_phase = .folded;

    // Pet hard against the left edge, then hard against the right. The
    // expected x is computed HERE from the clamp rule rather than by
    // calling the same helper the implementation uses, so a rect that
    // ignored the axis and centered on the window would not be able to
    // agree with it.
    const stack_w = bubbleStackWidth(&model);
    for ([_]f32{ 0, stack_w }) |center| {
        model.bubble_pet_center_local = center;
        const r = bubbleCardsRect(&model);
        const disclosure = bubbleDisclosureFrame(&model);
        const want_x = disclosure.x - bubble_hover_slop;
        try std.testing.expectApproxEqAbs(want_x, r.x, 0.01);
        try std.testing.expectApproxEqAbs(bubble_disclosure_size + bubble_hover_slop * 2, r.w, 0.01);
    }
}

test "a thrown pet keeps its flip and manual disclosure state current through the flight" {
    // The throw branch drives its own moveWindow from the velocity and
    // returns before the cursor is polled, so it never reaches
    // updateBubbleStack. Without its own update the flip flag and the
    // expansion both freeze for the whole arc: the stack hangs off the
    // wrong side of a pet that already has room above it, and
    // syncBubbleWindow keeps placing the window from that stale flag.
    var model: Model = .{};
    testPushBubble(&model, "alpha", "older", false, -1);
    testPushBubble(&model, "beta", "newer", true, -1);

    // Start pinned to the top with the stack flipped below, and a fan
    // left open by a hover just before the throw.
    model.pet_y = 0;
    model.bubble_flipped = true;
    model.bubble_expansion = 1;
    model.bubble_expansion_target = 1;
    model.bubble_anim_last_ms = 0;

    const needed: f64 = @floatCast(bubbleWindowHeight(&model));
    var now: i64 = 0;
    // A real flick: 900 px/s only carries the pet ~115px before friction
    // drops it under physics_min_vel, short of the threshold, so the test
    // would never cross anything. This is a hard throw.
    var vy: f64 = 3000;
    var crossed_back = false;
    var frames: usize = 0;

    // Physics loop, same shape as the throw branch: 16ms frames, the
    // window integrates velocity, friction decays it.
    while (frames < 60) : (frames += 1) {
        now += 16;
        model.pet_y += vy * 0.016;
        vy *= physics_friction;
        if (@abs(vy) < physics_min_vel) vy = 0;
        _ = updateBubbleStackInFlight(&model, now);
        // Stand in for syncBubbleWindow, which owns the flip refresh and
        // is what the throw branch calls every frame. Asserting against
        // bubbleWantY rather than the flag alone ties this to the value
        // the window is actually placed from.
        const want = bubbleShouldFlip(&model, model.pet_y, needed);
        model.bubble_flipped = want;

        // The invariant: every single frame of the flight, the window
        // wants to sit on the side the pet's position calls for.
        const want_y = bubbleWantY(&model, @floatCast(needed));
        if (want) {
            // Flipped: window hangs below the sprite.
            try std.testing.expect(want_y >= model.pet_y + bubble_pet_clearance);
        } else {
            // Upright: window ends above the pet with the same clearance.
            try std.testing.expect(want_y + needed <= model.pet_y - bubble_pet_clearance + 0.01);
            crossed_back = true;
        }
    }

    // The pet really did travel far enough to stop needing the flip,
    // otherwise the assertion above proves nothing.
    try std.testing.expect(crossed_back);
    try std.testing.expect(model.pet_y > needed);
    // Manual visibility is not changed by pet motion.
    try std.testing.expectEqual(@as(f32, 1), model.bubble_expansion);
    try std.testing.expectEqual(@as(i64, -1), model.bubble_hover_since_ms);

    // Guard the wiring, not just the helper: the throw branch has to run
    // the in-flight update itself, because it returns before the frame
    // clock's cursor poll. Deleting that call is the regression this
    // whole test exists for, and a helper tested in isolation cannot see
    // it, so pin the source instead.
    const src = @embedFile("main.zig");
    const throw_branch = std.mem.indexOf(u8, src, "if (model.throwing) {").?;
    const branch_end = std.mem.indexOf(u8, src[throw_branch..], "const read = fx.moveWindow").?;
    const in_flight = std.mem.indexOf(u8, src[throw_branch..][0..branch_end], "updateBubbleStackInFlight(model, now);");
    try std.testing.expect(in_flight != null);
    // And it must come BEFORE the sync, or the window is placed from the
    // side the pet was on a frame ago.
    const sync = std.mem.indexOf(u8, src[throw_branch..][0..branch_end], "syncBubbleWindow(model, fx);").?;
    try std.testing.expect(in_flight.? < sync);
}

test "a stacked card keeps its own height, never the container's" {
    // The regression this pins, and the one the containment test below
    // could NOT see: cards are placed by transform inside a container
    // that reserves the whole expanded fan, and in a `.stack` a child
    // with height 0 inherits the container's height
    // (widget_layout.stackChildFrame). Every card stretched to fan
    // height and drew as one giant rounded rect with its content pinned
    // to an edge, while every offset assertion stayed green because the
    // POSITIONS were all still right.
    var model: Model = .{};
    testPushBubble(&model, "alpha", "older", false, -1);
    testPushBubble(&model, "beta", "newer", true, -1);

    const container = bubbleStackHeightAt(&model, 1);
    for (0..model.bubbles_len) |i| {
        const card_h = bubbleCardHeight(&model, i);
        try std.testing.expectEqual(card_h, bubbleRenderedCardHeight(&model, i));
        try std.testing.expect(card_h < bubbleMaxCardHeight(&model));
        try std.testing.expect(bubbleRenderedCardHeight(&model, i) < container);
    }

    // A single bubble uses that same compact intrinsic measurement.
    var solo: Model = .{};
    testPushBubble(&solo, "alpha", "solo", false, -1);
    try std.testing.expectEqual(bubbleCardHeight(&solo, 0), bubbleRenderedCardHeight(&solo, 0));
}

test "a flipped stack stays inside its container at both ends" {
    // The second screenshot: flipped, mid-hover, the wide card cut off
    // against the bottom. The container reserves one card height while
    // the fan needs the full expanded extent, so cards placed by
    // transform ran past its bounds and the window edge clipped them.
    var model: Model = .{};
    testPushBubble(&model, "alpha", "a much longer line of bubble text", false, -1);
    testPushBubble(&model, "beta", "another wide line of bubble text", false, -1);
    testPushBubble(&model, "gamma", "eve", true, -1);
    model.bubble_flipped = true;

    const container = bubbleStackHeightAt(&model, 1);
    // Every card, at every point of the animation, must sit fully
    // inside the container: top edge at or below 0, bottom edge at or
    // above the container height.
    for ([_]f32{ 0, 0.25, 0.5, 0.75, 1 }) |expansion| {
        model.bubble_expansion = expansion;
        for (0..model.bubbles_len) |i| {
            const top = bubbleCardOffset(&model, i);
            const card_h = bubbleCardHeight(&model, i);
            try std.testing.expect(top >= -0.01);
            try std.testing.expect(top + card_h <= container + 0.01);
        }
        // Flipped, the FRONT card leads at the top, hard against the
        // head gap, and the rest hang below it.
        try std.testing.expectEqual(@as(f32, 0), bubbleCardOffset(&model, model.bubbles_len - 1));
    }

    // Unflipped the same containment holds, with the front card last.
    model.bubble_flipped = false;
    for ([_]f32{ 0, 0.5, 1 }) |expansion| {
        model.bubble_expansion = expansion;
        for (0..model.bubbles_len) |i| {
            const top = bubbleCardOffset(&model, i);
            const card_h = bubbleCardHeight(&model, i);
            try std.testing.expect(top >= -0.01);
            try std.testing.expect(top + card_h <= container + 0.01);
        }
        try std.testing.expectEqual(container - bubbleCardHeight(&model, model.bubbles_len - 1), bubbleCardOffset(&model, model.bubbles_len - 1));
    }
}

test "an agent with no dedicated art uses the fallback tile" {
    try std.testing.expectEqual(@as(usize, @intFromEnum(agent_hooks.AgentKind.claude_code)), agentIconIndex("claude-code"));
    try std.testing.expectEqual(@as(usize, @intFromEnum(agent_hooks.AgentKind.codex)), agentIconIndex("codex"));
    try std.testing.expectEqual(agent_fallback_index, agentIconIndex("some-unknown-agent"));
    try std.testing.expectEqual(agent_fallback_index, agentIconIndex(""));
}

test "clearing a bubble also cancels its lifetime" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "x", true, 1234);
    clearBubble(&model);
    try std.testing.expectEqual(@as(usize, 0), model.bubbles_len);
    try std.testing.expect(!bubbleActive(&model));
    try std.testing.expectEqual(@as(i64, -1), model.bubble_expires_at_ms[0]);
}

test "closing the pet clears its bubble and closes both windows" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "x", true, 1234);
    var fx = Effects.init(std.testing.allocator);
    defer fx.deinit();

    closePet(&model, &fx);

    try std.testing.expectEqual(@as(usize, 0), model.bubbles_len);
    try std.testing.expectEqual(@as(u32, close_pet_window_labels.len), fx.windowActionState().close_count);
    try std.testing.expectEqualStrings("bubble", close_pet_window_labels[0]);
    try std.testing.expectEqualStrings("main", close_pet_window_labels[1]);
    try std.testing.expectEqualStrings("main", fx.windowActionState().lastLabel());
}

test "two conversations stack and grow the window vertically" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "reading", true, -1);
    const one_high = bubbleWindowHeight(&model);
    const one_wide = bubbleWindowWidth(&model);
    testPushBubble(&model, "beta", "testing", true, -1);
    try std.testing.expect(bubbleWindowHeight(&model) > one_high);
    // Cards remain in one column; the front card may become slightly wider
    // to reserve its stack-lock control.
    try std.testing.expect(bubbleWindowWidth(&model) >= one_wide);
    try std.testing.expectEqualStrings("beta", newestBubble(&model).?.sessionSlice());
}

test "newest bubble follows its update counter instead of its slot" {
    var model: Model = .{};
    testPushBubble(&model, "codex-session", "current codex update", true, -1);
    testPushBubble(&model, "claude-session", "older claude update", false, -1);

    // The Claude conversation was opened later, but Codex received the
    // latest event. Mailbox slots stay in insertion order, so the last slot
    // is not necessarily the newest bubble.
    model.bubbles[0].counter = 9;
    model.bubbles[1].counter = 4;
    @memcpy(model.bubbles[0].agent[0.."codex".len], "codex");
    model.bubbles[0].agent_len = "codex".len;
    @memcpy(model.bubbles[1].agent[0.."claude-code".len], "claude-code");
    model.bubbles[1].agent_len = "claude-code".len;

    const newest = newestBubble(&model).?;
    try std.testing.expectEqualStrings("codex", newest.agent[0..newest.agent_len]);

    sortBubblesByCounter(model.bubbles[0..model.bubbles_len]);
    try std.testing.expectEqualStrings("claude-session", model.bubbles[0].sessionSlice());
    try std.testing.expectEqualStrings("codex-session", model.bubbles[1].sessionSlice());
}

test "pinned front remains authoritative while other work updates" {
    var model: Model = .{};
    testPushBubble(&model, "pinned", "Pinned answer", false, -1);
    testPushBubble(&model, "active", "Active work", true, -1);
    model.pinned_bubble_identity = bubbleVisualIdentity(&model.bubbles[0]);

    applyBubblePresentationOrder(&model);
    try std.testing.expectEqualStrings("pinned", frontBubble(&model).?.sessionSlice());

    for (model.bubbles[0..model.bubbles_len]) |*bubble| {
        bubble.busy = false;
        bubble.status = .completed;
    }
    applyBubblePresentationOrder(&model);
    try std.testing.expectEqualStrings("pinned", frontBubble(&model).?.sessionSlice());
}

test "attention tint remains group-wide while pin controls the nearest card" {
    var model: Model = .{};
    testPushBubble(&model, "pinned", "Pinned answer", false, -1);
    testPushBubble(&model, "question", "Which database should I use?", false, -1);
    testPushBubble(&model, "running", "Implementing the migration", true, -1);
    model.pinned_bubble_identity = bubbleVisualIdentity(&model.bubbles[0]);
    model.bubbles[1].status = .needs_input;
    model.bubbles[1].counter = 2;
    model.bubbles[2].counter = 9;

    applyBubblePresentationOrder(&model);
    try std.testing.expectEqualStrings("pinned", frontBubble(&model).?.sessionSlice());
    try std.testing.expectEqual(plat.BubbleGlassSemanticState.needs_input, bubbleGroupSemanticState(&model));
    var found_question = false;
    for (model.bubbles[0..model.bubbles_len]) |*bubble| {
        if (bubble.status != .needs_input) continue;
        found_question = true;
        try std.testing.expectEqual(@as(i64, -1), bubbleExpiryMs(10_000, 5, bubbleKeepsAlive(bubble)));
    }
    try std.testing.expect(found_question);
}

test "visible group survives pointer exit and settled work until user closes it" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "Older", false, -1);
    testPushBubble(&model, "beta", "Working", true, -1);
    model.bubble_group_visible = true;
    updateBubbleHover(&model, false, 1_000);
    try std.testing.expect(model.bubble_group_visible);
    try std.testing.expectEqual(@as(f32, 1), model.bubble_expansion_target);

    model.bubbles[1].busy = false;
    model.bubbles[1].status = .completed;
    updateBubbleHover(&model, false, 1_100);
    try std.testing.expect(model.bubble_group_visible);
    try std.testing.expectEqual(@as(f32, 1), model.bubble_expansion_target);
}

test "an empty stack still reserves one card of window height" {
    var model: Model = .{};
    const empty = bubbleWindowHeight(&model);
    testPushBubble(&model, "alpha", "reading", true, -1);
    try std.testing.expect(empty >= bubbleWindowHeight(&model));
}

test "expiry drops only the bubbles past their deadline" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "settled", false, 5000);
    testPushBubble(&model, "beta", "busy", true, -1);
    testPushBubble(&model, "gamma", "settled later", false, 9000);

    try std.testing.expect(expireBubbles(&model, 6000));
    try std.testing.expectEqual(@as(usize, 2), model.bubbles_len);
    // The survivors stay dense and keep their own deadlines: a compaction
    // that shifted bubbles without their deadline would expire the wrong
    // conversation on the next tick.
    try std.testing.expectEqualStrings("beta", model.bubbles[0].sessionSlice());
    try std.testing.expectEqual(@as(i64, -1), model.bubble_expires_at_ms[0]);
    try std.testing.expectEqualStrings("gamma", model.bubbles[1].sessionSlice());
    try std.testing.expectEqual(@as(i64, 9000), model.bubble_expires_at_ms[1]);
    try std.testing.expect(!expireBubbles(&model, 6000));
}

test "an unchanged bubble keeps its deadline when another one updates" {
    var model: Model = .{};
    model.bubble_lifetime_secs = 5;
    testPushBubble(&model, "alpha", "settled", false, 4000);
    testPushBubble(&model, "beta", "settled too", false, 4000);
    const previous = model.bubbles;
    const previous_deadlines = model.bubble_expires_at_ms;

    // beta gets a new payload (higher counter), alpha is untouched.
    model.bubbles[1].counter = 99;
    syncBubbleDeadlines(&model, previous[0..2], previous_deadlines[0..2], 10_000);
    try std.testing.expectEqual(@as(i64, 4000), model.bubble_expires_at_ms[0]);
    try std.testing.expectEqual(@as(i64, 15_000), model.bubble_expires_at_ms[1]);
}

test "deadlines follow composite conversation identity and never expire pending input" {
    var model: Model = .{};
    model.bubble_lifetime_secs = 5;
    testPushBubble(&model, "shared", "Codex", false, 4_000);
    testPushBubble(&model, "shared", "Hermes", false, 6_000);
    @memcpy(model.bubbles[0].agent[0.."codex".len], "codex");
    model.bubbles[0].agent_len = "codex".len;
    @memcpy(model.bubbles[1].agent[0.."hermes".len], "hermes");
    model.bubbles[1].agent_len = "hermes".len;

    var previous = model.bubbles;
    var previous_deadlines = model.bubble_expires_at_ms;
    // Put the same raw session id in the opposite identity order. Session-id
    // matching alone would transfer Hermes's deadline to Codex here.
    const swap = previous[0];
    previous[0] = previous[1];
    previous[1] = swap;
    const deadline_swap = previous_deadlines[0];
    previous_deadlines[0] = previous_deadlines[1];
    previous_deadlines[1] = deadline_swap;
    model.bubbles[1].counter = 99;
    model.bubbles[1].status = .needs_input;

    syncBubbleDeadlines(&model, previous[0..2], previous_deadlines[0..2], 10_000);
    try std.testing.expectEqual(@as(i64, 4_000), model.bubble_expires_at_ms[0]);
    try std.testing.expectEqual(@as(i64, -1), model.bubble_expires_at_ms[1]);
}

test "steady sprite pacing preserves gesture and reaction cadence" {
    var model: Model = .{};
    model.state = .idle;
    try std.testing.expectEqual(@as(u32, 350), steadySpriteFrameDuration(&model, 120));

    model.state = .running;
    try std.testing.expectEqual(@as(u32, 250), steadySpriteFrameDuration(&model, 120));

    model.state = .waving;
    try std.testing.expectEqual(@as(u32, 120), steadySpriteFrameDuration(&model, 120));

    model.throwing = true;
    model.state = .running;
    try std.testing.expectEqual(@as(u32, 120), steadySpriteFrameDuration(&model, 120));
}

test "poll cadence backs off only after sessions and interactions settle" {
    var model: Model = .{};
    try std.testing.expectEqual(poll_settled_interval_ms, pollInterval(&model));

    testPushBubble(&model, "active", "Working", true, -1);
    try std.testing.expectEqual(poll_agent_interval_ms, pollInterval(&model));

    model.bubbles[0].busy = false;
    model.bubbles[0].status = .idle;
    try std.testing.expectEqual(poll_settled_interval_ms, pollInterval(&model));

    model.bubble_hovered = true;
    try std.testing.expectEqual(poll_interaction_interval_ms, pollInterval(&model));
}

test "bubble presentation scheduler caps content and geometry commits" {
    var model: Model = .{};
    invalidateBubblePresentation(&model, .{ .content = true });
    try std.testing.expect(bubblePresentationMayCommit(&model, 1_000));
    model.bubble_render_last_content_ms = 1_000;
    try std.testing.expect(!bubblePresentationMayCommit(&model, 1_066));
    try std.testing.expect(bubblePresentationMayCommit(&model, 1_067));

    model.bubble_render_dirty.clear();
    invalidateBubblePresentation(&model, .{ .geometry = true });
    model.bubble_render_last_geometry_ms = 2_000;
    try std.testing.expect(!bubblePresentationMayCommit(&model, 2_032));
    try std.testing.expect(bubblePresentationMayCommit(&model, 2_033));
    try std.testing.expect(model.bubble_render_stats.deferred_submissions >= 2);
}

test "Linux portable presentation consumes dirty snapshots without a timer loop" {
    var model: Model = .{};
    const initial_generation = model.bubble_view_generation;
    invalidateBubblePresentation(&model, .{ .content = true, .urgent = true });
    try std.testing.expect(model.bubble_view_generation != initial_generation);
    try std.testing.expect(commitPortableBubblePresentationForPlatform(&model, 4_200, .linux));
    try std.testing.expect(!model.bubble_render_dirty.any());
    try std.testing.expectEqual(@as(i64, 4_200), model.bubble_render_last_content_ms);
    try std.testing.expectEqual(@as(i64, 4_200), model.bubble_render_last_geometry_ms);
    try std.testing.expectEqual(@as(u64, 1), model.bubble_render_stats.portable_commits);
    try std.testing.expect(!commitPortableBubblePresentationForPlatform(&model, 4_201, .linux));
}

test "native presentation platforms retain dirty snapshots for their commit path" {
    var model: Model = .{};
    invalidateBubblePresentation(&model, .{ .geometry = true });
    try std.testing.expect(!commitPortableBubblePresentationForPlatform(&model, 5_000, .macos));
    try std.testing.expect(!commitPortableBubblePresentationForPlatform(&model, 5_000, .windows));
    try std.testing.expect(model.bubble_render_dirty.geometry);
    try std.testing.expectEqual(@as(u64, 0), model.bubble_render_stats.portable_commits);
}

test "pet animation frames do not invalidate the Linux bubble window" {
    var model: Model = .{ .sheet_loaded = true };
    testPushBubble(&model, "settled", "Static portable bubble", false, -1);
    model.bubble_render_dirty.clear();
    const generation = model.bubble_view_generation;
    var fx = Effects.init(std.testing.allocator);
    defer fx.deinit();

    update(&model, .{ .frame_tick = .{ .key = frame_timer_key } }, &fx);

    try std.testing.expectEqual(generation, model.bubble_view_generation);
    try std.testing.expect(!model.bubble_render_dirty.any());
}

test "performance counter seam emits bounded valid JSON" {
    var model: Model = .{};
    model.bubble_render_stats.layout_rebuilds = 3;
    model.bubble_render_stats.portable_commits = 2;
    model.bubble_view_generation = 9;
    var json_buf: [512]u8 = undefined;
    const json = bubblePerfStatsJson(&model, &json_buf) orelse return error.TestUnexpectedResult;
    const Snapshot = struct {
        layoutRebuilds: u64,
        snapshotBuilds: u64,
        nativeSubmissions: u64,
        portableCommits: u64,
        deferredSubmissions: u64,
        staleRunningSuppressions: u64,
        viewGeneration: u64,
    };
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const snapshot = try std.json.parseFromSliceLeaky(Snapshot, arena.allocator(), json, .{});
    try std.testing.expectEqual(@as(u64, 3), snapshot.layoutRebuilds);
    try std.testing.expectEqual(@as(u64, 2), snapshot.portableCommits);
    try std.testing.expectEqual(@as(u64, 0), snapshot.nativeSubmissions);
    try std.testing.expectEqual(@as(u64, 9), snapshot.viewGeneration);
}

test "bubble width cache survives hover and rebuilds for content" {
    var model: Model = .{};
    testPushBubble(&model, "alpha", "Short activity", true, -1);
    ensureBubbleLayoutCache(&model);
    const first_width = model.bubble_layout_cache.common_width;
    try std.testing.expect(model.bubble_layout_cache.valid);
    try std.testing.expectEqual(@as(u64, 1), model.bubble_render_stats.layout_rebuilds);

    model.bubble_hovered_identity = bubbleVisualIdentity(&model.bubbles[0]);
    model.bubble_hovered = true;
    ensureBubbleLayoutCache(&model);
    try std.testing.expectEqual(@as(u64, 1), model.bubble_render_stats.layout_rebuilds);
    try std.testing.expectEqual(first_width, model.bubble_layout_cache.common_width);
    _ = bubbleLayoutMetricsAtMetadataReveal(&model, 0, 0);
    _ = bubbleLayoutMetricsAtMetadataReveal(&model, 0, 0.5);
    _ = bubbleLayoutMetricsAtMetadataReveal(&model, 0, 1);
    // Hover and spring sampling reuse the retained measured text instead of
    // reinvoking the font engine.
    try std.testing.expectEqual(@as(u64, 1), model.bubble_render_stats.layout_rebuilds);

    const replacement = "A much longer activity that needs a wider measured card";
    @memcpy(model.bubbles[0].text[0..replacement.len], replacement);
    model.bubbles[0].text_len = replacement.len;
    ensureBubbleLayoutCache(&model);
    try std.testing.expectEqual(@as(u64, 2), model.bubble_render_stats.layout_rebuilds);
    try std.testing.expect(model.bubble_layout_cache.common_width >= first_width);
}
