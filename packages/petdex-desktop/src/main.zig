const std = @import("std");

extern fn getpid() c_int;
const runner = @import("runner");
const zero_native = @import("zero-native");

pub const panic = std.debug.FullPanic(zero_native.debug.capturePanic);

const WINDOW_W: f32 = 140;
// 180px tall: pet at top:34 + 78px sprite = 112; +16 bottom margin
// after gravity-throw recovery. The bubble sits in the 30px strip
// above the pet via getBoundingClientRect anchoring.
const WINDOW_H: f32 = 180;
const MENU_W: u32 = 480;
const MENU_H: u32 = 420;
const MAX_PET_BYTES: usize = 16 * 1024 * 1024;
const MAX_ACTIVE_BYTES: usize = 4 * 1024;
const MAX_SLUG_LEN: usize = 64;
// Matches web `MAX_SLUGS_IN_COMMAND` — caps deeplink and bridge batch installs.
const MAX_INSTALL_SLUGS: usize = 24;
// Room for `slugs=a,b,c` query values (24 slugs × ~65 chars, matches web cap).
const MAX_SLUGS_QUERY_BYTES: usize = MAX_INSTALL_SLUGS * (MAX_SLUG_LEN + 1);

const DeepLink = union(enum) {
    none,
    activate: []const u8,
    install: std.ArrayList([]const u8),
};

const AgentAsset = struct {
    name: []const u8,
    bytes: []const u8,
};

const agent_assets = [_]AgentAsset{
    .{ .name = "claude-code.svg", .bytes = @embedFile("assets/agents/claude-code.svg") },
    .{ .name = "codex.svg", .bytes = @embedFile("assets/agents/codex.svg") },
    .{ .name = "gemini.svg", .bytes = @embedFile("assets/agents/gemini.svg") },
    .{ .name = "opencode.svg", .bytes = @embedFile("assets/agents/opencode.svg") },
    .{ .name = "antigravity.svg", .bytes = @embedFile("assets/agents/antigravity.svg") },
    .{ .name = "fallback.svg", .bytes = @embedFile("assets/agents/fallback.svg") },
};

const html_head =
    \\<!doctype html>
    \\<html>
    \\<head>
    \\<meta charset="utf-8">
    \\<meta http-equiv="cache-control" content="no-cache, no-store, must-revalidate">
    \\<meta http-equiv="pragma" content="no-cache">
    \\<meta http-equiv="expires" content="0">
    \\<style>
    \\  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; width: 100%; height: 100%; font-family: -apple-system, system-ui, sans-serif; }
    \\  body { -webkit-user-select: none; user-select: none; pointer-events: none; }
    \\  // Pet positioned 60px from the top to leave room for a
    \\  // bubble tooltip + visual gap above. Forced via inline JS
    \\  // below since something in WebKit kept caching/overriding
    \\  // the rule when we used .stage{top:Xpx}.
    \\  .stage { position: fixed; left: 8px; pointer-events: none; }
    \\  .pet {
    \\    aspect-ratio: 192 / 208;
    \\    width: 4.5rem;
    \\    image-rendering: pixelated;
    \\    background-image: url('spritesheet.webp');
    \\    background-repeat: no-repeat;
    \\    background-size: 800% 900%;
    \\    background-position: 0% 0%;
    \\    pointer-events: auto;
    \\    cursor: grab;
    \\  }
    \\  .pet.dragging { cursor: grabbing; }
    \\  .menu { pointer-events: auto; }
    \\  .menu {
    \\    position: fixed;
    \\    background: rgba(20, 20, 22, 0.96);
    \\    color: #f0f0f0;
    \\    border: 1px solid rgba(255, 255, 255, 0.08);
    \\    border-radius: 8px;
    \\    padding: 6px;
    \\    font-size: 10px;
    \\    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    \\    width: 168px;
    \\    z-index: 999;
    \\    backdrop-filter: blur(16px);
    \\    pointer-events: auto;
    \\    display: flex;
    \\    flex-direction: column;
    \\    gap: 6px;
    \\  }
    \\  .menu input {
    \\    background: rgba(255, 255, 255, 0.05);
    \\    border: 1px solid rgba(255, 255, 255, 0.08);
    \\    color: #f0f0f0;
    \\    border-radius: 5px;
    \\    padding: 4px 8px;
    \\    font-size: 10px;
    \\    outline: none;
    \\    font-family: inherit;
    \\  }
    \\  .menu input:focus { border-color: rgba(255, 255, 255, 0.2); }
    \\  .menu .scroller {
    \\    position: relative;
    \\    height: 240px;
    \\    overflow-y: auto;
    \\    overflow-x: hidden;
    \\  }
    \\  .menu .scroller::-webkit-scrollbar { width: 6px; }
    \\  .menu .scroller::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
    \\  .menu .spacer { width: 100%; pointer-events: none; }
    \\  .menu .viewport {
    \\    position: absolute;
    \\    top: 0;
    \\    left: 0;
    \\    right: 0;
    \\    display: grid;
    \\    grid-template-columns: repeat(3, 1fr);
    \\    gap: 4px;
    \\    will-change: transform;
    \\  }
    \\  .menu .cell {
    \\    display: flex;
    \\    flex-direction: column;
    \\    align-items: center;
    \\    padding: 4px 2px;
    \\    border-radius: 5px;
    \\    cursor: pointer;
    \\    gap: 2px;
    \\    min-width: 0;
    \\    height: 60px;
    \\    box-sizing: border-box;
    \\  }
    \\  .menu .cell:hover { background: rgba(255, 255, 255, 0.08); }
    \\  .menu .cell.active { background: rgba(0, 122, 255, 0.18); outline: 1px solid rgba(0, 122, 255, 0.4); }
    \\  .menu .thumb {
    \\    width: 40px;
    \\    height: 40px;
    \\    image-rendering: pixelated;
    \\    background-repeat: no-repeat;
    \\    background-size: 800% 900%;
    \\    background-position: 0% 0%;
    \\    background-color: rgba(255,255,255,0.04);
    \\    border-radius: 4px;
    \\  }
    \\  .menu .label {
    \\    font-size: 8px;
    \\    color: rgba(255,255,255,0.7);
    \\    width: 100%;
    \\    text-align: center;
    \\    overflow: hidden;
    \\    text-overflow: ellipsis;
    \\    white-space: nowrap;
    \\  }
    \\  .menu .empty {
    \\    color: rgba(255,255,255,0.3);
    \\    text-align: center;
    \\    padding: 12px 0;
    \\    font-size: 9px;
    \\  }
    \\  .menu .count {
    \\    font-size: 8px;
    \\    color: rgba(255,255,255,0.4);
    \\    text-align: right;
    \\    padding: 0 2px;
    \\  }
    \\  .menu .footer {
    \\    border-top: 1px solid rgba(255, 255, 255, 0.08);
    \\    padding-top: 6px;
    \\    display: flex;
    \\    justify-content: flex-end;
    \\  }
    \\  .menu .quit {
    \\    color: rgba(255, 136, 136, 0.85);
    \\    cursor: pointer;
    \\    padding: 2px 6px;
    \\    border-radius: 3px;
    \\    font-size: 9px;
    \\    transition: background 120ms ease;
    \\  }
    \\  .menu .quit:hover { background: rgba(255, 100, 100, 0.12); }
    \\  .menu .quit-confirm {
    \\    display: flex;
    \\    gap: 4px;
    \\    align-items: center;
    \\    font-size: 9px;
    \\  }
    \\  .menu .quit-confirm span { color: rgba(255,255,255,0.5); }
    \\  .menu .quit-confirm button {
    \\    background: transparent;
    \\    border: 1px solid rgba(255, 100, 100, 0.4);
    \\    color: #f88;
    \\    border-radius: 3px;
    \\    padding: 1px 6px;
    \\    font-size: 9px;
    \\    cursor: pointer;
    \\    font-family: inherit;
    \\  }
    \\  .menu .quit-confirm button:hover { background: rgba(255, 100, 100, 0.12); }
    \\  .menu .quit-confirm button.cancel {
    \\    border-color: rgba(255, 255, 255, 0.15);
    \\    color: rgba(255,255,255,0.6);
    \\  }
    \\  .menu .quit-confirm button.cancel:hover { background: rgba(255, 255, 255, 0.06); }
    \\</style>
    \\</head>
    \\<body>
    \\<div class="stage"><div class="pet" id="pet" data-state="idle"></div></div>
    \\<script type="application/json" id="petdex-data">
;

const html_tail =
    \\</script>
    \\<script>
    \\window.__PETDEX__ = JSON.parse(document.getElementById("petdex-data").textContent);
    \\(() => {
    \\  const COLS = 8, ROWS = 9;
    \\  const STATES = {
    \\    idle:           { row: 0, frames: [{c:0,d:280},{c:1,d:110},{c:2,d:110},{c:3,d:140},{c:4,d:140},{c:5,d:320}], slow: 6 },
    \\    "running-right":{ row: 1, count: 8, dur: 120, last: 220 },
    \\    "running-left": { row: 2, count: 8, dur: 120, last: 220 },
    \\    waving:         { row: 3, count: 4, dur: 140, last: 280 },
    \\    jumping:        { row: 4, count: 5, dur: 140, last: 280 },
    \\    failed:         { row: 5, count: 8, dur: 140, last: 240 },
    \\    waiting:        { row: 6, count: 6, dur: 150, last: 260 },
    \\    running:        { row: 7, count: 6, dur: 120, last: 220 },
    \\    review:         { row: 8, count: 6, dur: 150, last: 280 },
    \\  };
    \\  function buildFrames(s) {
    \\    if (s.frames) { const slow = s.slow || 1; return s.frames.map(f => ({ c: f.c, r: s.row, d: f.d * slow })); }
    \\    return Array.from({length: s.count}, (_,i) => ({ c: i, r: s.row, d: i === s.count - 1 ? s.last : s.dur }));
    \\  }
    \\  function pos(c, r) { return `${c/(COLS-1)*100}% ${r/(ROWS-1)*100}%`; }
    \\  const pet = document.getElementById('pet');
    \\  // Force the pet's container down via inline JS to leave room
    \\  // for the bubble tooltip above. CSS .stage{top:Xpx} kept
    \\  // appearing not to apply during testing — inline style on the
    \\  // element wins over any cached/conflicting rule.
    \\  const stageEl = pet.parentElement;
    \\  if (stageEl) {
    \\    stageEl.style.top = '34px';
    \\    stageEl.style.left = '8px';
    \\    stageEl.style.position = 'fixed';
    \\  }
    \\  let currentState = 'idle';
    \\  let stateTimer = null;
    \\  function play(state) {
    \\    if (state === currentState) return;
    \\    currentState = state;
    \\    pet.dataset.state = state;
    \\    if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
    \\    const def = STATES[state] || STATES.idle;
    \\    const frames = buildFrames(def);
    \\    let i = 0;
    \\    pet.style.backgroundPosition = pos(frames[0].c, frames[0].r);
    \\    if (frames.length === 1) return;
    \\    const tick = () => {
    \\      stateTimer = setTimeout(() => {
    \\        i = (i + 1) % frames.length;
    \\        pet.style.backgroundPosition = pos(frames[i].c, frames[i].r);
    \\        tick();
    \\      }, frames[i].d);
    \\    };
    \\    tick();
    \\  }
    \\  play('idle');
    \\  // Sidecar HTTP state polling: external CLIs (Claude Code, Codex CLI, Gemini CLI,
    \\  // OpenCode, shell scripts) POST to localhost:7777/state, the sidecar writes a
    \\  // JSON file, and the WebView polls that file via the bridge. Drag/throw states
    \\  // take precedence so user input always feels responsive.
    \\  let lastSidecarCounter = 0;
    \\  let sidecarRevertTimer = null;
    \\  async function pollSidecarState() {
    \\    if (!(window.zero && window.zero.invoke)) return;
    \\    if (dragging || momentumTimer != null) return;
    \\    try {
    \\      const r = await window.zero.invoke('petdex.read_runtime_state', {});
    \\      if (!r || typeof r.counter !== 'number') return;
    \\      if (r.counter === lastSidecarCounter) return;
    \\      lastSidecarCounter = r.counter;
    \\      const desired = typeof r.state === 'string' ? r.state : 'idle';
    \\      if (sidecarRevertTimer) { clearTimeout(sidecarRevertTimer); sidecarRevertTimer = null; }
    \\      play(desired);
    \\    } catch (e) {}
    \\  }
    \\  setInterval(pollSidecarState, 200);
    \\
    \\  // Bubble: tooltip-style text shown above the sprite while a tool
    \\  // is running. Persistent semantics — the text stays until a new
    \\  // bubble lands, just like Codex desktop does it. We poll the
    \\  // bubble.json file via the bridge and update the DOM only when
    \\  // the counter changes. The element is created lazily on first
    \\  // bubble so installs without the runner persisted (no bubbles
    \\  // ever) keep the DOM clean.
    \\  let lastBubbleCounter = 0;
    \\  let bubbleEl = null;
    \\  let bubbleAvatarEl = null;
    \\  let bubbleTextEl = null;
    \\  let bubbleWithMenu = false;
    \\  let stickyLocalBubble = false;
    \\  const AGENT_AVATARS = {
    \\    'claude-code': 'agents/claude-code.svg',
    \\    'codex': 'agents/codex.svg',
    \\    'gemini': 'agents/gemini.svg',
    \\    'opencode': 'agents/opencode.svg',
    \\    'antigravity': 'agents/antigravity.svg',
    \\  };
    \\  function agentAvatarSrc(source) {
    \\    return AGENT_AVATARS[source] || 'agents/fallback.svg';
    \\  }
    \\  function ensureBubble() {
    \\    if (bubbleEl) return bubbleEl;
    \\    bubbleEl = document.createElement('div');
    \\    bubbleEl.id = 'pet-bubble';
    \\    // Speech bubble anchored to the pet's bounding rect so it
    \\    // tracks the pet wherever it lives in the WebView (compact
    \\    // mode, picker-expanded mode, after a drag/throw, etc.).
    \\    // We position it absolutely with top/left computed from
    \\    // the pet's getBoundingClientRect() each time we render.
    \\    // z-index 5: below the picker menu (which uses 999) so the
    \\    // user's pet-browsing flow takes precedence — the bubble
    \\    // is ambient feedback, the picker is an active modal.
    \\    // White-space: normal (wrap) instead of nowrap so longer
    \\    // tool names ("mcp__custom__do_thing", "AskUserQuestion")
    \\    // don't get clipped with an ellipsis. We cap at max-width
    \\    // so it wraps to a 2-3 line tooltip rather than expanding
    \\    // sideways forever and overlapping the picker menu.
    \\    // overflow-wrap:break-word breaks long unbreakable runs only when
    \\    // they would overflow — gentler than `anywhere`, which breaks
    \\    // mid-word for any line that happens to be longer than the box,
    \\    // producing orphan single-letter lines like "AskUserQuestio\n n"
    \\    // (Hunter screenshot 2026-05-11). break-word + word-break:keep-all
    \\    // leaves CamelCase and snake_case alone when they fit, breaks them
    \\    // at character boundaries only when they don't.
    \\    // No width:max-content — that lets the bubble grow past
    \\    // max-width because max-content is the intrinsic width of
    \\    // an unwrapped text run, which beats max-width. Default
    \\    // (auto width) plus inline-block lets the bubble shrink
    \\    // to short text yet still respect max-width on long ones.
    \\    bubbleEl.style.cssText = 'position:fixed;padding:4px 8px;border-radius:10px;background:#ffffff;color:#111;font:600 11px system-ui,-apple-system,sans-serif;line-height:1.2;box-shadow:0 2px 6px rgba(0,0,0,0.30);text-align:left;white-space:normal;max-width:190px;display:flex;align-items:center;gap:6px;opacity:0;transition:opacity 180ms ease;pointer-events:none;z-index:5;';
    \\    bubbleAvatarEl = document.createElement('img');
    \\    bubbleAvatarEl.alt = 'Agent avatar';
    \\    bubbleAvatarEl.decoding = 'async';
    \\    bubbleAvatarEl.style.cssText = 'width:20px;height:20px;flex:0 0 auto;object-fit:cover;display:block;';
    \\    bubbleTextEl = document.createElement('span');
    \\    bubbleTextEl.style.cssText = 'display:block;min-width:0;word-break:keep-all;overflow-wrap:break-word;';
    \\    bubbleEl.appendChild(bubbleAvatarEl);
    \\    bubbleEl.appendChild(bubbleTextEl);
    \\    document.body.appendChild(bubbleEl);
    \\    return bubbleEl;
    \\  }
    \\  function setBubbleContent(text, agentSource) {
    \\    ensureBubble();
    \\    const source = typeof agentSource === 'string' ? agentSource : '';
    \\    bubbleAvatarEl.src = agentAvatarSrc(source);
    \\    bubbleAvatarEl.alt = source ? source + ' avatar' : 'Agent avatar';
    \\    bubbleTextEl.textContent = text;
    \\  }
    \\  function positionBubbleNearPet(el) {
    \\    // Anchor the bubble ABOVE the pet. The picker menu opens to
    \\    // the right of the pet, so right-side placement collides;
    \\    // top placement is the only spot that's stable across the
    \\    // pet's compact + picker-expanded modes.
    \\    // We measure the bubble AFTER setting its text (caller
    \\    // ensures that order), so el.offsetWidth is the real width.
    \\    const rect = pet.getBoundingClientRect();
    \\    const bw = el.offsetWidth || 100;
    \\    const bh = el.offsetHeight || 22;
    \\    const ww = window.innerWidth;
    \\    const gap = 14;
    \\    // Center horizontally on the pet's center, clamp inside
    \\    // viewport. We re-read offsetWidth after the textContent
    \\    // change so the wrap is fully resolved before we compute
    \\    // the center.
    \\    const petCenterX = rect.left + rect.width / 2;
    \\    const realBw = el.offsetWidth;
    \\    const desiredLeft = petCenterX - realBw / 2;
    \\    const left = Math.max(4, Math.min(ww - realBw - 4, desiredLeft));
    \\    // Pet slide-down policy: when the bubble is too tall to
    \\    // fit above the default pet position (top:34), shove the
    \\    // pet down ONCE for this bubble. Subsequent re-positions
    \\    // (resize, picker close) keep the pet wherever it landed
    \\    // until a NEW bubble arrives — that prevents the flicker
    \\    // where the pet bobs back up when a modal closes.
    \\    const stageEl = pet.parentElement;
    \\    const currentPetTop = stageEl
    \\      ? parseInt(stageEl.style.top || '34', 10)
    \\      : 34;
    \\    let top = rect.top - bh - gap;
    \\    if (top < 2) {
    \\      // Need more room. Bump pet down once, but only if the new
    \\      // position is BELOW where it currently sits — never push
    \\      // the pet upward as a side effect of a re-render.
    \\      const newPetTop = bh + gap + 4;
    \\      if (stageEl && newPetTop > currentPetTop) {
    \\        stageEl.style.top = newPetTop + 'px';
    \\        const rect2 = pet.getBoundingClientRect();
    \\        top = Math.max(2, rect2.top - bh - gap);
    \\      } else {
    \\        // Pet is already low enough — just clamp the bubble.
    \\        top = Math.max(2, top);
    \\      }
    \\    }
    \\    // Note: we don't snap the pet back to 34 on short bubbles
    \\    // here — that's done in pollBubble when a bubble counter
    \\    // change with shorter content lands.
    \\    el.style.left = left + 'px';
    \\    el.style.top = top + 'px';
    \\  }
    \\  async function pollBubble() {
    \\    if (!(window.zero && window.zero.invoke)) return;
    \\    if (stickyLocalBubble) return;
    \\    // While the picker menu is open, hide the bubble. The
    \\    // picker is a modal flow (user is browsing pets); the
    \\    // bubble is ambient feedback that should defer. Without
    \\    // this, the bubble either overlaps the pet ugly or shoves
    \\    // it sideways into the menu — both feel wrong. We bring
    \\    // the bubble back when the picker closes.
    \\    if (menuEl) {
    \\      if (bubbleWithMenu && bubbleEl && bubbleTextEl && bubbleTextEl.textContent) {
    \\        positionBubbleNearPet(bubbleEl);
    \\        bubbleEl.style.opacity = '1';
    \\        return;
    \\      }
    \\      if (bubbleEl) bubbleEl.style.opacity = '0';
    \\      return;
    \\    }
    \\    try {
    \\      const r = await window.zero.invoke('petdex.read_runtime_bubble', {});
    \\      if (!r || typeof r.counter !== 'number') return;
    \\      if (r.counter === lastBubbleCounter) {
    \\        // Same bubble — but it may have been hidden while the
    \\        // picker was open. Re-show it now that we're back to
    \\        // the compact single-pet view.
    \\        if (bubbleEl && bubbleEl.style.opacity === '0' && bubbleTextEl && bubbleTextEl.textContent) {
    \\          positionBubbleNearPet(bubbleEl);
    \\          bubbleEl.style.opacity = '1';
    \\        }
    \\        return;
    \\      }
    \\      lastBubbleCounter = r.counter;
    \\      const text = typeof r.text === 'string' ? r.text : '';
    \\      const el = ensureBubble();
    \\      if (text) {
    \\        // Reset pet to its default top:34 BEFORE measuring the
    \\        // new bubble. positionBubbleNearPet will only push down
    \\        // if the new content actually needs more room. This
    \\        // is what makes the pet snap back to default when a
    \\        // short bubble follows a long one.
    \\        const stageEl = pet.parentElement;
    \\        if (stageEl && stageEl.style.top !== '34px') {
    \\          stageEl.style.top = '34px';
    \\        }
    \\        setBubbleContent(text, r.agent_source);
    \\        positionBubbleNearPet(el);
    \\        el.style.opacity = '1';
    \\      } else {
    \\        el.style.opacity = '0';
    \\        // Empty text means "no current bubble" — restore pet.
    \\        const stageEl = pet.parentElement;
    \\        if (stageEl && stageEl.style.top !== '34px') {
    \\          stageEl.style.top = '34px';
    \\        }
    \\      }
    \\    } catch (e) {}
    \\  }
    \\  setInterval(pollBubble, 200);
    \\  pollBubble();
    \\
    \\  // Custom URL scheme handling: macOS routes `petdex://<slug>`
    \\  // launches via AppleEvent, which the native side persists to
    \\  // ~/.petdex-desktop/runtime/incoming-url.txt. We poll for it
    \\  // here, parse + validate the slug, and call set_active to swap
    \\  // pets without restarting the app. The native side deletes the
    \\  // file after handing it to us via the bridge.
    \\  //
    \\  // If the slug isn't installed locally, we narrate progress
    \\  // through the bubble system ("Installing aurora..."), shell
    \\  // out to `petdex install <slug>` via the bridge, and retry
    \\  // set_active when it finishes. The current pet stays visible
    \\  // throughout so there's no empty-stage flash.
    \\  let incomingUrlPolling = false;
    \\  const MIN_INSTALL_BUBBLE_MS = 1200;
    \\  const SUCCESS_BUBBLE_BEFORE_RELOAD_MS = 900;
    \\  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    \\  async function showLocalBubbleFor(ms, text) {
    \\    showLocalBubble(text);
    \\    await sleep(ms);
    \\  }
    \\  function installReportNote(rep) {
    \\    if (!rep || typeof rep !== 'object') return '';
    \\    const parts = [];
    \\    if (Array.isArray(rep.missing) && rep.missing.length)
    \\      parts.push(rep.missing.length + ' skipped (not found)');
    \\    if (Array.isArray(rep.failed) && rep.failed.length)
    \\      parts.push(rep.failed.length + ' failed to download');
    \\    if (!parts.length) return '';
    \\    return parts.join('; ') + '. ';
    \\  }
    \\  function showLocalBubble(text) {
    \\    const el = ensureBubble();
    \\    setBubbleContent(text, null);
    \\    positionBubbleNearPet(el);
    \\    el.style.opacity = '1';
    \\  }
    \\  async function holdLocalBubble(ms, text) {
    \\    showLocalBubble(text);
    \\    stickyLocalBubble = true;
    \\    await sleep(ms);
    \\    stickyLocalBubble = false;
    \\  }
    \\  async function showInstallPetError(r, installHint) {
    \\    const err = (r && r.error) || 'unknown';
    \\    let rep = r && r.install_report;
    \\    if (typeof rep === 'string') {
    \\      try { rep = JSON.parse(rep); } catch (_) { rep = null; }
    \\    }
    \\    const note = (r && r.issue_note) || installReportNote(rep);
    \\    const cmd = 'npx petdex@latest install ' + installHint;
    \\    try { window.zero.invoke('petdex.set_mascot_state', { state: 'failed' }); } catch (_) {}
    \\    let text;
    \\    if (err === 'cli_not_persisted') text = 'Run: npx petdex@latest init';
    \\    else if (err === 'no_home') text = 'No HOME env. Run: ' + cmd;
    \\    else if (err === 'node_not_found') text = 'Node.js not found. Install from nodejs.org or via brew install node.';
    \\    else if (err === 'abnormal_exit') text = note + 'petdex install crashed. Try terminal: ' + cmd;
    \\    else if (err.indexOf('exit_') === 0) text = note ? note + 'Try: ' + cmd : 'Install failed (' + err + '). Try: ' + cmd;
    \\    else if (err.indexOf('spawn_') === 0) text = 'Install spawn failed (' + err + '). Try: ' + cmd;
    \\    else text = 'Install failed: ' + err;
    \\    await holdLocalBubble(1000, text);
    \\  }
    \\  async function showInstallCrashed() {
    \\    try { window.zero.invoke('petdex.set_mascot_state', { state: 'failed' }); } catch (_) {}
    \\    await holdLocalBubble(1000, 'Install crashed');
    \\  }
    \\  async function activateOrInstall(slug) {
    \\    if (!(window.zero && window.zero.invoke)) return;
    \\    try { closeMenu(); } catch (_) {}
    \\    try {
    \\      await window.zero.invoke('petdex.set_active', { slug });
    \\      try { await window.zero.invoke('petdex.refresh_pets', {}); } catch (_) {}
    \\      location.reload();
    \\      return;
    \\    } catch (_) {}
    \\    // First attempt failed (most likely "slug not installed").
    \\    // Narrate + shell out to `petdex install <slug>`.
    \\    const installStarted = Date.now();
    \\    showLocalBubble('Installing ' + slug + '…');
    \\    try {
    \\      const r = await window.zero.invoke('petdex.install_pet', { slug });
    \\      const installElapsed = Date.now() - installStarted;
    \\      if (installElapsed < MIN_INSTALL_BUBBLE_MS) {
    \\        await sleep(MIN_INSTALL_BUBBLE_MS - installElapsed);
    \\      }
    \\      if (r && r.ok) {
    \\        // Install succeeded. Try activate; one retry after 500ms
    \\        // covers the race where set_active runs before the freshly
    \\        // written sprite has hit the disk's directory entry — the
    \\        // CLI returns after fs.write() resolves, but the sidecar's
    \\        // pets-root scan can still miss it for a few hundred ms on
    \\        // some filesystems (APFS volumes under heavy IO).
    \\        for (let attempt = 0; attempt < 2; attempt++) {
    \\          try {
    \\            await window.zero.invoke('petdex.set_active', { slug });
    \\            try { await window.zero.invoke('petdex.refresh_pets', {}); } catch (_) {}
    \\            await showLocalBubbleFor(SUCCESS_BUBBLE_BEFORE_RELOAD_MS, installReportNote(r.install_report) + 'Showing ' + slug + '.');
    \\            location.reload();
    \\            return;
    \\          } catch (e) {
    \\            if (attempt === 0) {
    \\              await sleep(500);
    \\              continue;
    \\            }
    \\            try { await window.zero.invoke('petdex.refresh_pets', {}); } catch (_) {}
    \\            showLocalBubble(installReportNote(r.install_report) + 'Installed. Right-click to switch to ' + slug);
    \\            return;
    \\          }
    \\        }
    \\        return;
    \\      }
    \\      await showInstallPetError(r, slug);
    \\    } catch (e) {
    \\      await showInstallCrashed();
    \\    }
    \\  }
    \\  async function installBatch(slugs) {
    \\    if (!(window.zero && window.zero.invoke) || !slugs || slugs.length === 0) return;
    \\    try { closeMenu(); } catch (_) {}
    \\    const label = slugs.length === 1 ? slugs[0] : slugs.length + ' pets';
    \\    const installStarted = Date.now();
    \\    showLocalBubble('Installing ' + label + '…');
    \\    try {
    \\      const r = await window.zero.invoke('petdex.install_pet', { slugs: slugs.join(',') });
    \\      const installElapsed = Date.now() - installStarted;
    \\      if (installElapsed < MIN_INSTALL_BUBBLE_MS) {
    \\        await sleep(MIN_INSTALL_BUBBLE_MS - installElapsed);
    \\      }
    \\      if (r && r.ok) {
    \\        let rep = r.install_report;
    \\        if (typeof rep === 'string') {
    \\          try { rep = JSON.parse(rep); } catch (_) { rep = null; }
    \\        }
    \\        const issues = (r.issue_note || installReportNote(rep) || '');
    \\        const n = typeof r.installed_count === 'number' ? r.installed_count : slugs.length;
    \\        if (n === 0) {
    \\          await holdLocalBubble(1000, issues + 'No pets installed.');
    \\          return;
    \\        }
    \\        try { await window.zero.invoke('petdex.refresh_pets', {}); } catch (_) {}
    \\        const summary = n === 1 ? 'Installed 1 pet' : 'Installed ' + n + ' pets';
    \\        if (issues) await holdLocalBubble(1000, issues + summary);
    \\        else showLocalBubble(summary);
    \\        await sleep(1000);
    \\        try { sessionStorage.setItem('petdex-post-install', '1'); } catch (_) {}
    \\        location.reload();
    \\        return;
    \\      }
    \\      await showInstallPetError(r, slugs.join(' '));
    \\    } catch (e) {
    \\      await showInstallCrashed();
    \\    }
    \\  }
    \\  async function handleDeepLink(r) {
    \\    if (!r) return;
    \\    if (r.kind === 'install' && Array.isArray(r.slugs) && r.slugs.length > 0) {
    \\      await installBatch(r.slugs);
    \\      return;
    \\    }
    \\    const slug = (r.kind === 'activate' && r.slug) ? r.slug : (typeof r.slug === 'string' ? r.slug : '');
    \\    if (slug) await activateOrInstall(slug);
    \\  }
    \\  async function pollIncomingUrl() {
    \\    if (incomingUrlPolling) return;
    \\    if (!(window.zero && window.zero.invoke)) return;
    \\    incomingUrlPolling = true;
    \\    try {
    \\      const r = await window.zero.invoke('petdex.read_incoming_url', {});
    \\      await handleDeepLink(r);
    \\    } catch (e) {} finally {
    \\      incomingUrlPolling = false;
    \\    }
    \\  }
    \\  setInterval(pollIncomingUrl, 1000);
    \\  pollIncomingUrl();
    \\  // Reposition the bubble whenever the pet might have moved —
    \\  // window resize, drag, throw. Cheap (one rect read + two
    \\  // style writes); the polling interval already handles
    \\  // most updates, this just keeps it glued during interaction.
    \\  window.addEventListener('resize', () => {
    \\    // Skip when the picker is open — the picker's resize is
    \\    // what's firing this event, and we don't want to chase it
    \\    // (would shove the pet around mid-modal). pollBubble is
    \\    // also paused while menuEl exists.
    \\    if (menuEl && !bubbleWithMenu) return;
    \\    if (bubbleEl && bubbleEl.style.opacity === '1') positionBubbleNearPet(bubbleEl);
    \\  });
    \\
    \\  // Layer 1 autoupdate: read update.json (written by the sidecar's
    \\  // periodic GH releases poll) and render a notification card. A
    \\  // single click POSTs to the sidecar's /update endpoint, which
    \\  // spawns `npx petdex update --silent`. We keep this DOM lightweight
    \\  // — a fixed-position card, no animations.
    \\  let lastUpdateStatus = '';
    \\  let updateCard = null;
    \\  let needsInitFlag = false;
    \\  function ensureUpdateCard() {
    \\    if (updateCard) return updateCard;
    \\    updateCard = document.createElement('div');
    \\    updateCard.id = 'update-card';
    \\    // Match the bubble's white-card style for visual consistency.
    \\    // The update card was originally dark; once the bubble shipped
    \\    // with white-on-black, the dark update card felt out of place
    \\    // sitting underneath the same pet.
    \\    // pointer-events: auto is REQUIRED — body sets it to none
    \\    // for the whole document so the pet click-through works
    \\    // outside the sprite. Without auto here, click handler never
    \\    // fires and the user clicks "Update available" but nothing
    \\    // happens. (Hunter hit this 2026-05-10.)
    \\    updateCard.style.cssText = 'position:fixed;left:6px;right:6px;bottom:6px;padding:6px 9px;border-radius:9px;background:#ffffff;color:#111;font:600 11px system-ui,-apple-system,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,0.30);display:none;cursor:pointer;pointer-events:auto;line-height:1.25;text-align:center;';
    \\    updateCard.addEventListener('click', async () => {
    \\      if (!(window.zero && window.zero.invoke)) return;
    \\      try {
    \\        const r = await window.zero.invoke('petdex.trigger_update', {});
    \\        // r is JSON-encoded: ok:true means curl POST returned 2xx.
    \\        // ok:false carries an `error` field — most commonly
    \\        // curl_exit_7 (sidecar dead). The previous handler swallowed
    \\        // every failure and rendered "Updating..." while nothing
    \\        // was happening, leaving the user wondering why their pet
    \\        // never restarted. Now we surface the situation with an
    \\        // actionable terminal command.
    \\        if (r && r.ok === false) {
    \\          const code = (r.error || '');
    \\          if (code.indexOf('curl_exit_') === 0 || code === 'no_token' || code === 'token_read' || code === 'empty_token') {
    \\            renderUpdate({ status: 'error', message: 'Sidecar offline. Run: npx petdex@latest update' });
    \\            return;
    \\          }
    \\          renderUpdate({ status: 'error', message: 'Update failed (' + code + '). Run: npx petdex@latest update' });
    \\          return;
    \\        }
    \\        renderUpdate({ status: 'running', message: 'Updating...' });
    \\      } catch (e) {
    \\        // Bridge crash. The invoke layer itself blew up — fall back
    \\        // to terminal instructions rather than a silent dead button.
    \\        renderUpdate({ status: 'error', message: 'Update failed. Run: npx petdex@latest update' });
    \\      }
    \\    });
    \\    document.body.appendChild(updateCard);
    \\    return updateCard;
    \\  }
    \\  function renderUpdate(info) {
    \\    const card = ensureUpdateCard();
    \\    if (needsInitFlag) { card.style.display = 'none'; return; }
    \\    if (info.status === 'idle' || (!info.available && info.status !== 'error' && info.status !== 'done')) {
    \\      card.style.display = 'none';
    \\      return;
    \\    }
    \\    let text = '';
    \\    if (info.status === 'available') {
    \\      text = 'Update ' + (info.latest || 'available') + ' - click to install';
    \\    } else if (info.status === 'running') {
    \\      text = info.message || 'Updating...';
    \\    } else if (info.status === 'done') {
    \\      text = info.message || 'Update installed. Restart Petdex.';
    \\    } else if (info.status === 'error') {
    \\      text = info.message || 'Update failed.';
    \\    }
    \\    card.textContent = text;
    \\    card.style.display = 'block';
    \\  }
    \\  async function pollUpdate() {
    \\    if (!(window.zero && window.zero.invoke)) return;
    \\    try {
    \\      const info = await window.zero.invoke('petdex.read_update_info', {});
    \\      if (!info || typeof info !== 'object') return;
    \\      const sig = info.status + ':' + (info.latest || '') + ':' + (info.message || '');
    \\      if (sig === lastUpdateStatus) return;
    \\      lastUpdateStatus = sig;
    \\      renderUpdate(info);
    \\    } catch (e) {}
    \\  }
    \\  setInterval(pollUpdate, 5000);
    \\  pollUpdate();
    \\  // Init banner. Shown when ~/.petdex/bin/petdex.js does not exist,
    \\  // meaning the user launched the .app without running `petdex init`.
    \\  // Takes priority over the update banner (new users need init first).
    \\  let initCard = null;
    \\  let initToastTimer = null;
    \\  function ensureInitCard() {
    \\    if (initCard) return initCard;
    \\    initCard = document.createElement('div');
    \\    initCard.id = 'init-card';
    \\    initCard.style.cssText = 'position:fixed;left:6px;right:6px;bottom:6px;padding:6px 9px;border-radius:9px;background:#ffffff;color:#111;font:600 11px system-ui,-apple-system,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,0.30);display:none;cursor:pointer;pointer-events:auto;line-height:1.25;text-align:center;';
    \\    initCard.addEventListener('click', async () => {
    \\      try {
    \\        await navigator.clipboard.writeText('npx petdex init');
    \\      } catch (e) {}
    \\      showInitToast('Comando copiado. Pegalo en tu terminal.');
    \\    });
    \\    document.body.appendChild(initCard);
    \\    return initCard;
    \\  }
    \\  function showInitToast(msg) {
    \\    if (initToastTimer) { clearTimeout(initToastTimer); initToastTimer = null; }
    \\    const card = ensureInitCard();
    \\    const prev = card.textContent;
    \\    card.textContent = msg;
    \\    initToastTimer = setTimeout(() => {
    \\      card.textContent = prev;
    \\      initToastTimer = null;
    \\    }, 3000);
    \\  }
    \\  function renderInitBanner(needsInit) {
    \\    needsInitFlag = needsInit;
    \\    const card = ensureInitCard();
    \\    if (needsInit) {
    \\      card.textContent = 'Run `petdex init` to wire your agents';
    \\      card.style.display = 'block';
    \\      const uc = document.getElementById('update-card');
    \\      if (uc) uc.style.display = 'none';
    \\    } else {
    \\      card.style.display = 'none';
    \\    }
    \\  }
    \\  async function pollInitStatus() {
    \\    if (!(window.zero && window.zero.invoke)) return;
    \\    try {
    \\      const info = await window.zero.invoke('petdex.read_init_status', {});
    \\      if (!info || typeof info !== 'object') return;
    \\      renderInitBanner(info.needsInit === true);
    \\    } catch (e) {}
    \\  }
    \\  setInterval(pollInitStatus, 5000);
    \\  pollInitStatus();
    \\  // Sidecar watchdog. The sidecar dies via parent watchdog when
    \\  // we exit, but it can also crash mid-flight (Node OOM, an
    \\  // unhandled error in the HTTP handler) leaving us alive with
    \\  // no listener on :7777 — at which point hooks fail until the
    \\  // user restarts. Probe /health every 5s; after 3 consecutive
    \\  // failures, ask the bridge to respawn it. Backs off on
    \\  // repeated respawns so a sidecar that won't start doesn't
    \\  // burn CPU.
    \\  let sidecarFails = 0;
    \\  let lastRespawnAt = 0;
    \\  async function probeSidecar() {
    \\    try {
    \\      const r = await fetch('http://127.0.0.1:7777/health', {
    \\        signal: AbortSignal.timeout(500),
    \\      });
    \\      if (r.ok) {
    \\        sidecarFails = 0;
    \\        return;
    \\      }
    \\    } catch (e) {}
    \\    sidecarFails += 1;
    \\    if (sidecarFails < 3) return;
    \\    // Backoff: wait at least 4s between respawn attempts.
    \\    const now = Date.now();
    \\    if (now - lastRespawnAt < 4000) return;
    \\    lastRespawnAt = now;
    \\    try {
    \\      await window.zero.invoke('petdex.respawn_sidecar', {});
    \\      sidecarFails = 0;
    \\    } catch (e) {}
    \\  }
    \\  setInterval(probeSidecar, 5000);
    \\  // Drag + momentum (Codex parity).
    \\  const TICK_MS = 16, FRICTION = 0.88, MIN_VEL = 65, MAX_DURATION = 900;
    \\  const SAMPLE_WINDOW_MS = 100, THRESHOLD = 4;
    \\  let dragging = false;
    \\  let lastX = 0, lastY = 0;
    \\  let samples = [];
    \\  let resetTimer = null;
    \\  let momentumTimer = null;
    \\  async function moveWindowClamped(dx, dy) {
    \\    if (!(window.zero && window.zero.invoke)) return { hitX: false, hitY: false };
    \\    try {
    \\      const r = await window.zero.invoke('zero-native.window.move', { dx, dy, clampToVisibleFrame: true });
    \\      return { hitX: !!(r && r.hitX), hitY: !!(r && r.hitY) };
    \\    } catch (e) { return { hitX: false, hitY: false }; }
    \\  }
    \\  function pushSample(e) {
    \\    const t = performance.now();
    \\    samples.push({ x: e.screenX, y: e.screenY, t });
    \\    samples = samples.filter(s => t - s.t <= SAMPLE_WINDOW_MS);
    \\  }
    \\  function computeVelocity() {
    \\    if (samples.length < 2) return null;
    \\    const last = samples[samples.length - 1];
    \\    const first = samples.find(s => last.t - s.t > 16);
    \\    if (first == null) return null;
    \\    const dtSec = (last.t - first.t) / 1000;
    \\    if (dtSec <= 0) return null;
    \\    return { x: (last.x - first.x) / dtSec, y: (last.y - first.y) / dtSec };
    \\  }
    \\  function cancelMomentum() { if (momentumTimer != null) { clearTimeout(momentumTimer); momentumTimer = null; } }
    \\  function throwWithVelocity(vx, vy) {
    \\    if (!Number.isFinite(vx) || !Number.isFinite(vy) || (vx === 0 && vy === 0)) return;
    \\    cancelMomentum();
    \\    let elapsed = 0;
    \\    const tick = async () => {
    \\      momentumTimer = null;
    \\      elapsed += TICK_MS;
    \\      const r = await moveWindowClamped(vx * TICK_MS / 1000, vy * TICK_MS / 1000);
    \\      if (r.hitX) vx = 0;
    \\      if (r.hitY) vy = 0;
    \\      if (vx >= MIN_VEL) play('running-right'); else if (vx <= -MIN_VEL) play('running-left');
    \\      vx *= FRICTION; vy *= FRICTION;
    \\      if (elapsed >= MAX_DURATION || Math.hypot(vx, vy) < MIN_VEL) {
    \\        play('waving');
    \\        if (resetTimer) clearTimeout(resetTimer);
    \\        resetTimer = setTimeout(() => play('idle'), 1200);
    \\        return;
    \\      }
    \\      momentumTimer = setTimeout(tick, TICK_MS);
    \\    };
    \\    momentumTimer = setTimeout(tick, TICK_MS);
    \\  }
    \\  pet.addEventListener('pointerdown', (e) => {
    \\    if (e.button !== 0) return; // ignore right/middle clicks entirely
    \\    closeMenu();
    \\    dragging = true;
    \\    lastX = e.screenX; lastY = e.screenY;
    \\    samples = [];
    \\    pushSample(e);
    \\    pet.classList.add('dragging');
    \\    pet.setPointerCapture(e.pointerId);
    \\    play('jumping');
    \\    if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
    \\    cancelMomentum();
    \\    e.preventDefault();
    \\  });
    \\  // Suppress any default behavior from non-left buttons so the pet doesn't react.
    \\  pet.addEventListener('mousedown', (e) => { if (e.button !== 0) e.preventDefault(); });
    \\  pet.addEventListener('auxclick', (e) => e.preventDefault());
    \\  pet.addEventListener('pointermove', (e) => {
    \\    if (!dragging) return;
    \\    const dx = e.screenX - lastX, dy = e.screenY - lastY;
    \\    lastX = e.screenX; lastY = e.screenY;
    \\    pushSample(e);
    \\    moveWindowClamped(dx, dy);
    \\    if (dx >= THRESHOLD) play('running-right'); else if (dx <= -THRESHOLD) play('running-left');
    \\  });
    \\  function endDrag(e) {
    \\    if (!dragging) return;
    \\    dragging = false;
    \\    pet.classList.remove('dragging');
    \\    try { pet.releasePointerCapture(e.pointerId); } catch (_) {}
    \\    const v = computeVelocity();
    \\    if (v != null && Math.hypot(v.x, v.y) >= MIN_VEL) throwWithVelocity(v.x, v.y);
    \\    else { play('waving'); resetTimer = setTimeout(() => play('idle'), 1200); }
    \\  }
    \\  pet.addEventListener('pointerup', endDrag);
    \\  pet.addEventListener('pointercancel', endDrag);
    \\  // Pet picker — grid of mini-sprites with search, positioned next to mascot.
    \\  let menuEl = null;
    \\  async function resizeWindowTo(w, h) {
    \\    if (!(window.zero && window.zero.invoke)) return;
    \\    try { await window.zero.invoke('zero-native.window.resize', { width: w, height: h, anchor: 'top-left' }); } catch (e) {}
    \\  }
    \\  // openMenu positions against menuWidth/Height, but WebKit still clips to the
    \\  // *current* window until the native resize lands. Wait for innerWidth to catch up
    \\  // so post-install "Switch active pet?" does not flash a menu sliced at 140px.
    \\  function waitForWindowSize(w, h, timeoutMs) {
    \\    const deadline = Date.now() + (timeoutMs || 500);
    \\    return new Promise((resolve) => {
    \\      const tick = () => {
    \\        if (window.innerWidth >= w - 2 && window.innerHeight >= h - 2) {
    \\          resolve();
    \\          return;
    \\        }
    \\        if (Date.now() >= deadline) {
    \\          resolve();
    \\          return;
    \\        }
    \\        requestAnimationFrame(tick);
    \\      };
    \\      tick();
    \\    });
    \\  }
    \\  function closeMenu() {
    \\    const dismissPrompt = bubbleWithMenu;
    \\    bubbleWithMenu = false;
    \\    if (menuEl) { menuEl.remove(); menuEl = null; }
    \\    if (dismissPrompt && bubbleEl) {
    \\      bubbleEl.style.opacity = '0';
    \\      if (bubbleTextEl) bubbleTextEl.textContent = '';
    \\    }
    \\    const data = window.__PETDEX__ || {};
    \\    if (data.compactWidth && data.compactHeight) resizeWindowTo(data.compactWidth, data.compactHeight);
    \\  }
    \\  async function selectPet(slug) {
    \\    const data = window.__PETDEX__ || {};
    \\    if (slug === data.active) { closeMenu(); return; }
    \\    closeMenu();
    \\    try {
    \\      await window.zero.invoke('petdex.set_active', { slug });
    \\      try { await window.zero.invoke('petdex.refresh_pets', {}); } catch (_) {}
    \\      location.reload();
    \\    } catch (e) {}
    \\  }
    \\  // Virtual scroll: only render rows that are within the scroller viewport (+ buffer).
    \\  // Scales to thousands of pets without DOM bloat. Thumbnails load lazily via
    \\  // IntersectionObserver — when a cell scrolls in, set its background-image; when
    \\  // it scrolls out, drop it so WebKit can release the decoded image.
    \\  const COLUMNS = 3;
    \\  const ROW_HEIGHT = 64; // 60 cell + 4 gap
    \\  const ROW_BUFFER = 2;
    \\  function makeVirtualGrid(scroller, spacer, viewport, getItems, active, onSelect) {
    \\    let observer = null;
    \\    let cellCache = new Map();
    \\    function loadThumb(cell) {
    \\      const slug = cell.dataset.slug;
    \\      if (!slug) return;
    \\      const thumb = cell.firstChild;
    \\      if (thumb && !thumb.style.backgroundImage) {
    \\        thumb.style.backgroundImage = `url('${slug}/spritesheet.webp')`;
    \\      }
    \\    }
    \\    function unloadThumb(cell) {
    \\      const thumb = cell.firstChild;
    \\      if (thumb) thumb.style.backgroundImage = '';
    \\    }
    \\    if ('IntersectionObserver' in window) {
    \\      observer = new IntersectionObserver((entries) => {
    \\        for (const entry of entries) {
    \\          if (entry.isIntersecting) loadThumb(entry.target);
    \\          else unloadThumb(entry.target);
    \\        }
    \\      }, { root: scroller, rootMargin: '50px 0px' });
    \\    }
    \\    function buildCell(p) {
    \\      const cell = document.createElement('div');
    \\      cell.className = 'cell' + (p.slug === active() ? ' active' : '');
    \\      cell.dataset.slug = p.slug;
    \\      cell.title = p.displayName || p.slug;
    \\      const thumb = document.createElement('div');
    \\      thumb.className = 'thumb';
    \\      const label = document.createElement('div');
    \\      label.className = 'label';
    \\      label.textContent = p.displayName || p.slug;
    \\      cell.appendChild(thumb);
    \\      cell.appendChild(label);
    \\      cell.addEventListener('click', (ev) => { ev.stopPropagation(); onSelect(p.slug); });
    \\      if (observer) observer.observe(cell);
    \\      else loadThumb(cell);
    \\      return cell;
    \\    }
    \\    function render() {
    \\      const items = getItems();
    \\      if (items.length === 0) {
    \\        spacer.style.height = '0px';
    \\        viewport.innerHTML = '';
    \\        viewport.style.transform = 'translateY(0px)';
    \\        const empty = document.createElement('div');
    \\        empty.className = 'empty';
    \\        empty.textContent = 'no pets';
    \\        empty.style.gridColumn = '1 / -1';
    \\        viewport.appendChild(empty);
    \\        return;
    \\      }
    \\      const totalRows = Math.ceil(items.length / COLUMNS);
    \\      spacer.style.height = (totalRows * ROW_HEIGHT) + 'px';
    \\      const scrollTop = scroller.scrollTop;
    \\      const viewportHeight = scroller.clientHeight;
    \\      const firstVisibleRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - ROW_BUFFER);
    \\      const lastVisibleRow = Math.min(totalRows - 1, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + ROW_BUFFER);
    \\      const startIdx = firstVisibleRow * COLUMNS;
    \\      const endIdx = Math.min(items.length, (lastVisibleRow + 1) * COLUMNS);
    \\      // Recycle DOM cells: clear viewport, append slice. Cheap because endIdx-startIdx is small.
    \\      if (observer) for (const c of viewport.children) observer.unobserve(c);
    \\      viewport.innerHTML = '';
    \\      viewport.style.transform = `translateY(${firstVisibleRow * ROW_HEIGHT}px)`;
    \\      for (let i = startIdx; i < endIdx; i++) {
    \\        viewport.appendChild(buildCell(items[i]));
    \\      }
    \\    }
    \\    scroller.addEventListener('scroll', () => requestAnimationFrame(render), { passive: true });
    \\    return { render, dispose: () => { if (observer) observer.disconnect(); } };
    \\  }
    \\  // Pre-compute position based on data dimensions (not measured DOM rect) so the
    \\  // menu has a stable position even before resize completes.
    \\  function positionMenuFromData(petRect) {
    \\    const data = window.__PETDEX__ || {};
    \\    const menuW = 180; // matches .menu width + padding
    \\    const menuH = 320; // approx total height of menu
    \\    const gap = 8;
    \\    const winW = data.menuWidth || window.innerWidth;
    \\    const winH = data.menuHeight || window.innerHeight;
    \\    let left = petRect.right + gap;
    \\    let top = petRect.top;
    \\    if (left + menuW > winW - 4) left = petRect.left - menuW - gap;
    \\    if (left < 4) left = 4;
    \\    if (top + menuH > winH - 4) top = winH - menuH - 4;
    \\    if (top < 4) top = 4;
    \\    menuEl.style.left = left + 'px';
    \\    menuEl.style.top = top + 'px';
    \\  }
    \\  let virtualGrid = null;
    \\  async function openMenu() {
    \\    if (menuEl) closeMenu();
    \\    if (virtualGrid) { virtualGrid.dispose(); virtualGrid = null; }
    \\    const data = window.__PETDEX__ || { pets: [], active: null };
    \\    if (data.menuWidth && data.menuHeight) {
    \\      await resizeWindowTo(data.menuWidth, data.menuHeight);
    \\      await waitForWindowSize(data.menuWidth, data.menuHeight);
    \\    }
    \\    // Snapshot pet position after the picker window has expanded.
    \\    const petRect = pet.getBoundingClientRect();
    \\    menuEl = document.createElement('div');
    \\    menuEl.className = 'menu';
    \\    const input = document.createElement('input');
    \\    input.type = 'text';
    \\    input.placeholder = `search ${data.pets.length} pets`;
    \\    const count = document.createElement('div');
    \\    count.className = 'count';
    \\    const scroller = document.createElement('div');
    \\    scroller.className = 'scroller';
    \\    const spacer = document.createElement('div');
    \\    spacer.className = 'spacer';
    \\    const viewport = document.createElement('div');
    \\    viewport.className = 'viewport';
    \\    scroller.appendChild(spacer);
    \\    scroller.appendChild(viewport);
    \\    let currentItems = data.pets;
    \\    function applyFilter(query) {
    \\      const filter = query.trim().toLowerCase();
    \\      currentItems = filter ? data.pets.filter(p =>
    \\        p.slug.toLowerCase().includes(filter) ||
    \\        (p.displayName || '').toLowerCase().includes(filter)
    \\      ) : data.pets;
    \\      count.textContent = currentItems.length === data.pets.length
    \\        ? `${data.pets.length} pets`
    \\        : `${currentItems.length} of ${data.pets.length}`;
    \\      scroller.scrollTop = 0;
    \\      if (virtualGrid) virtualGrid.render();
    \\    }
    \\    const footer = document.createElement('div');
    \\    footer.className = 'footer';
    \\    const quit = document.createElement('div');
    \\    quit.className = 'quit';
    \\    quit.textContent = 'quit';
    \\    quit.addEventListener('click', (ev) => {
    \\      ev.stopPropagation();
    \\      const confirmRow = document.createElement('div');
    \\      confirmRow.className = 'quit-confirm';
    \\      const label = document.createElement('span');
    \\      label.textContent = 'sure?';
    \\      const yes = document.createElement('button');
    \\      yes.textContent = 'quit';
    \\      yes.addEventListener('click', (e) => {
    \\        e.stopPropagation();
    \\        try { window.zero.invoke('petdex.quit', {}); } catch (err) {}
    \\      });
    \\      const no = document.createElement('button');
    \\      no.className = 'cancel';
    \\      no.textContent = 'no';
    \\      no.addEventListener('click', (e) => {
    \\        e.stopPropagation();
    \\        confirmRow.replaceWith(quit);
    \\      });
    \\      confirmRow.appendChild(label);
    \\      confirmRow.appendChild(no);
    \\      confirmRow.appendChild(yes);
    \\      quit.replaceWith(confirmRow);
    \\    });
    \\    footer.appendChild(quit);
    \\    menuEl.appendChild(input);
    \\    menuEl.appendChild(count);
    \\    menuEl.appendChild(scroller);
    \\    menuEl.appendChild(footer);
    \\    document.body.appendChild(menuEl);
    \\    virtualGrid = makeVirtualGrid(scroller, spacer, viewport, () => currentItems, () => data.active, selectPet);
    \\    applyFilter('');
    \\    positionMenuFromData(petRect);
    \\    input.addEventListener('input', () => applyFilter(input.value));
    \\    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
    \\    setTimeout(() => input.focus(), 0);
    \\  }
    \\  pet.addEventListener('click', (e) => {
    \\    if (menuEl && bubbleWithMenu) {
    \\      e.stopPropagation();
    \\      closeMenu();
    \\    }
    \\  });
    \\  pet.addEventListener('contextmenu', (e) => {
    \\    e.preventDefault();
    \\    e.stopImmediatePropagation();
    \\    void openMenu();
    \\  });
    \\  // Prevent the system's default contextmenu anywhere (selection helpers, etc.)
    \\  document.addEventListener('contextmenu', (e) => e.preventDefault());
    \\  window.addEventListener('blur', closeMenu);
    \\  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
    \\  document.addEventListener('click', (e) => {
    \\    if (menuEl && !menuEl.contains(e.target) && e.target !== pet) closeMenu();
    \\  }, true);
    \\  (async () => {
    \\    try {
    \\      if (!sessionStorage.getItem('petdex-post-install')) return;
    \\      sessionStorage.removeItem('petdex-post-install');
    \\      bubbleWithMenu = true;
    \\      await openMenu();
    \\      showLocalBubble('Switch active pet?');
    \\      if (menuEl) positionMenuFromData(pet.getBoundingClientRect());
    \\    } catch (_) {}
    \\  })();
    \\})();
    \\</script>
    \\</body>
    \\</html>
;

const Pet = struct {
    slug: []u8,
    display_name: []u8,
    // Absolute path of the pets root that contains this slug. We
    // store it per-pet because we now read from BOTH ~/.petdex/pets
    // AND ~/.codex/pets — picking just the first existing root
    // (the old behavior) made an empty ~/.petdex/pets dir mask a
    // populated ~/.codex/pets, and the binary would exit with "No
    // pets in ...".
    root: []u8,
};

fn spawnSidecar(allocator: std.mem.Allocator, io: std.Io, sidecar_dir: []const u8, env_map: *std.process.Environ.Map) !void {
    // The HTTP sidecar runs on Node (≥ 18). We assume Node is available
    // because devs of coding agents almost universally have it installed —
    // a much safer assumption than requiring Bun. The pre-built
    // `sidecar/server.js` ships next to the binary so we don't need any
    // bundler at runtime either.
    const node_path = findExecutableOnPath(allocator, io, env_map, "node") catch {
        std.debug.print("petdex: `node` not found on PATH; HTTP sidecar disabled. Hooks won't reach the mascot. Install Node.js (>= 18) and relaunch.\n", .{});
        return;
    };
    defer allocator.free(node_path);

    const server_path = try std.fs.path.join(allocator, &.{ sidecar_dir, "server.js" });
    defer allocator.free(server_path);

    // server.js is installed to ~/.petdex/sidecar/server.js by `petdex
    // install desktop`. If it's missing, the binary was launched without
    // the CLI's install step (or the user wiped ~/.petdex/sidecar). Bail
    // gracefully so hooks fail loudly instead of POSTing to a dead port.
    var probe = std.Io.Dir.openFileAbsolute(io, server_path, .{}) catch {
        std.debug.print("petdex: sidecar not found at {s}. Run `petdex install desktop` (or `petdex update`) to fetch it. Hooks won't reach the mascot.\n", .{server_path});
        return;
    };
    probe.close(io);

    // Pass our PID to the sidecar so it can self-terminate if we die. The
    // sidecar polls process.kill(parent, 0) every 2s and exits on ESRCH.
    // This prevents zombie node processes hogging port 7777 after a
    // `petdex desktop stop` or a crash.
    var pid_buf: [32]u8 = undefined;
    const pid_str = try std.fmt.bufPrint(&pid_buf, "{d}", .{getpid()});
    try env_map.put("PETDEX_PARENT_PID", pid_str);

    const argv = &[_][]const u8{ node_path, server_path };
    _ = std.process.spawn(io, .{
        .argv = argv,
        .environ_map = env_map,
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
    }) catch |err| {
        std.debug.print("petdex: failed to spawn sidecar: {s}\n", .{@errorName(err)});
        return;
    };
    // Detach: we never wait on the child explicitly. The sidecar's parent
    // watchdog handles cleanup when we exit; in-band it listens for SIGTERM.
    std.debug.print("petdex: sidecar spawned (node {s})\n", .{server_path});
}

fn findExecutableOnPath(allocator: std.mem.Allocator, io: std.Io, env_map: *std.process.Environ.Map, name: []const u8) ![]u8 {
    // Pass 1: $PATH as inherited from the parent. Works when the binary
    // is launched from a shell (Ghostty, Terminal). Also works when a
    // shell login session set launchctl PATH at login (rare on stock
    // macOS).
    if (env_map.get("PATH")) |path| {
        var iter = std.mem.splitScalar(u8, path, ':');
        while (iter.next()) |dir| {
            if (dir.len == 0) continue;
            const candidate = try std.fs.path.join(allocator, &.{ dir, name });
            var file = std.Io.Dir.openFileAbsolute(io, candidate, .{}) catch {
                allocator.free(candidate);
                continue;
            };
            file.close(io);
            return candidate;
        }
    }

    // Pass 2: Finder/launchctl launches inherit a minimal PATH
    // (/usr/bin:/bin:/usr/sbin:/sbin) that almost never includes
    // homebrew or version managers. Hunter hit this 2026-05-11: the
    // .app launched from /Applications/ via Finder couldn't find his
    // nvm-installed node, the sidecar never started, and the WebView
    // sat there silently with no hooks reaching it. Fall back to the
    // common install locations explicitly. Order matters: most-likely-
    // current-default first.
    const home = env_map.get("HOME") orelse "";
    var explicit_buf: [16][]const u8 = undefined;
    var explicit_len: usize = 0;
    const candidates = [_][]const u8{
        "/opt/homebrew/bin",   // Apple Silicon homebrew (default since 2020)
        "/usr/local/bin",      // Intel homebrew, official Node installer
        "/usr/bin",            // system, unlikely to have node but cheap to check
    };
    for (candidates) |dir| {
        explicit_buf[explicit_len] = dir;
        explicit_len += 1;
    }
    for (explicit_buf[0..explicit_len]) |dir| {
        const candidate = try std.fs.path.join(allocator, &.{ dir, name });
        var file = std.Io.Dir.openFileAbsolute(io, candidate, .{}) catch {
            allocator.free(candidate);
            continue;
        };
        file.close(io);
        return candidate;
    }

    // Pass 3: Node version managers stash node under per-version dirs
    // that don't sit on PATH unless the user shimmed them. Probe the
    // popular ones. We can't enumerate nvm versions cheaply from zig
    // (would need a glob), so we check the "default alias" symlinks
    // each manager exposes.
    if (home.len > 0 and std.mem.eql(u8, name, "node")) {
        const manager_paths = [_][]const u8{
            ".volta/bin/node",                // volta
            ".fnm/aliases/default/bin/node",  // fnm with default alias
            ".asdf/shims/node",               // asdf
            ".n/bin/node",                    // tj/n
            ".local/bin/node",                // user-local install
        };
        for (manager_paths) |rel| {
            const candidate = try std.fs.path.join(allocator, &.{ home, rel });
            var file = std.Io.Dir.openFileAbsolute(io, candidate, .{}) catch {
                allocator.free(candidate);
                continue;
            };
            file.close(io);
            return candidate;
        }
        // nvm: walk ~/.nvm/versions/node/* and pick the highest one.
        // Cheaper than parsing the alias file and tolerates a missing
        // 'default' alias. We pick lexicographically last, which works
        // for sane v20+ semver dirs (v20.10.0 < v22.14.0).
        const nvm_root = try std.fs.path.join(allocator, &.{ home, ".nvm", "versions", "node" });
        defer allocator.free(nvm_root);
        if (std.Io.Dir.openDirAbsolute(io, nvm_root, .{ .iterate = true })) |dir_h| {
            var dir_handle = dir_h;
            defer dir_handle.close(io);
            var best: ?[]u8 = null;
            errdefer if (best) |b| allocator.free(b);
            var it = dir_handle.iterate();
            while (try it.next(io)) |entry| {
                if (entry.kind != .directory) continue;
                if (best) |b| {
                    if (std.mem.lessThan(u8, b, entry.name)) {
                        allocator.free(b);
                        best = try allocator.dupe(u8, entry.name);
                    }
                } else {
                    best = try allocator.dupe(u8, entry.name);
                }
            }
            if (best) |b| {
                defer allocator.free(b);
                const candidate = try std.fs.path.join(allocator, &.{ nvm_root, b, "bin", "node" });
                var file = std.Io.Dir.openFileAbsolute(io, candidate, .{}) catch {
                    allocator.free(candidate);
                    return error.ExecutableNotFound;
                };
                file.close(io);
                return candidate;
            }
        } else |_| {}
    }

    return error.ExecutableNotFound;
}

const PetdexState = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    config_dir: []u8,
    // Every existing pets root in priority order (.petdex first,
    // .codex second). Stored as a list rather than a single dir so
    // setActiveCmd can resolve the correct root when the user
    // installed a pet into ~/.codex/pets but NOT ~/.petdex/pets —
    // the previous "first root wins" logic made an empty .petdex
    // dir mask a populated .codex dir at startup.
    pets_roots: [][]u8,
    asset_root: []u8,
    // Held so respawn_sidecar can re-issue spawnSidecar without
    // having to re-resolve sidecar_dir or rebuild the env map.
    sidecar_dir: []u8,
    env_map: *std.process.Environ.Map,
    bridge_handlers: [12]zero_native.BridgeHandler = undefined,

    fn deinit(self: *PetdexState) void {
        self.allocator.free(self.config_dir);
        for (self.pets_roots) |r| self.allocator.free(r);
        self.allocator.free(self.pets_roots);
        self.allocator.free(self.asset_root);
        self.allocator.free(self.sidecar_dir);
    }

    fn bridge(self: *PetdexState) zero_native.BridgeDispatcher {
        self.bridge_handlers = .{
            .{ .name = "petdex.set_active", .context = self, .invoke_fn = setActiveCmd },
            .{ .name = "petdex.quit", .context = self, .invoke_fn = quitCmd },
            .{ .name = "petdex.read_runtime_state", .context = self, .invoke_fn = readRuntimeStateCmd },
            .{ .name = "petdex.read_runtime_bubble", .context = self, .invoke_fn = readRuntimeBubbleCmd },
            .{ .name = "petdex.read_incoming_url", .context = self, .invoke_fn = readIncomingUrlCmd },
            .{ .name = "petdex.install_pet", .context = self, .invoke_fn = installPetCmd },
            .{ .name = "petdex.refresh_pets", .context = self, .invoke_fn = refreshPetsCmd },
            .{ .name = "petdex.read_update_info", .context = self, .invoke_fn = readUpdateInfoCmd },
            .{ .name = "petdex.read_init_status", .context = self, .invoke_fn = readInitStatusCmd },
            .{ .name = "petdex.trigger_update", .context = self, .invoke_fn = triggerUpdateCmd },
            .{ .name = "petdex.respawn_sidecar", .context = self, .invoke_fn = respawnSidecarCmd },
            .{ .name = "petdex.set_mascot_state", .context = self, .invoke_fn = setMascotStateCmd },
        };
        return .{
            .policy = .{ .enabled = true, .commands = &petdex_command_policies },
            .registry = .{ .handlers = &self.bridge_handlers },
        };
    }

    // Called by the WebView JS when /health fails repeatedly. The
    // old sidecar's parent watchdog handles cleanup if it's alive,
    // so this is fire-and-forget. We don't track the new pid; the
    // next health probe is the success/failure signal.
    fn respawnSidecarCmd(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation;
        const self: *PetdexState = @ptrCast(@alignCast(context));
        spawnSidecar(self.allocator, self.io, self.sidecar_dir, self.env_map) catch |err| {
            return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"{s}\"}}", .{@errorName(err)});
        };
        return std.fmt.bufPrint(output, "{{\"ok\":true}}", .{});
    }

    fn readRuntimeStateCmd(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation;
        const self: *PetdexState = @ptrCast(@alignCast(context));
        const path = try std.fs.path.join(self.allocator, &.{ self.config_dir, "runtime", "state.json" });
        defer self.allocator.free(path);
        var file = std.Io.Dir.openFileAbsolute(self.io, path, .{}) catch {
            return std.fmt.bufPrint(output, "{{\"state\":\"idle\",\"counter\":0}}", .{});
        };
        defer file.close(self.io);
        const stat = try file.stat(self.io);
        const size: usize = @intCast(stat.size);
        if (size == 0 or size > output.len) {
            return std.fmt.bufPrint(output, "{{\"state\":\"idle\",\"counter\":0}}", .{});
        }
        const read = try file.readPositionalAll(self.io, output[0..size], 0);
        return output[0..read];
    }

    // Read + consume the incoming-url.txt the AppleEvent handler writes.
    // Returns {kind, slug, slugs?} for the WebView. Always deletes the file
    // after read so re-polling doesn't see stale URLs.
    fn readIncomingUrlCmd(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation;
        const self: *PetdexState = @ptrCast(@alignCast(context));
        const home = self.env_map.get("HOME") orelse {
            return std.fmt.bufPrint(output, "{{\"kind\":\"none\",\"slug\":\"\"}}", .{});
        };
        const runtime_dir = try std.fs.path.join(self.allocator, &.{ home, ".petdex-desktop", "runtime" });
        defer self.allocator.free(runtime_dir);

        const incoming_path = try std.fs.path.join(self.allocator, &.{ runtime_dir, "incoming-url.txt" });
        defer self.allocator.free(incoming_path);
        var deeplink = readDeepLinkFromPath(self.allocator, self.io, incoming_path) catch DeepLink{ .none = {} };
        std.Io.Dir.deleteFileAbsolute(self.io, incoming_path) catch {};

        const pending_path = try std.fs.path.join(self.allocator, &.{ runtime_dir, "pending-deeplink.txt" });
        defer self.allocator.free(pending_path);
        if (deeplink == .none) {
            deeplink = readDeepLinkFromPath(self.allocator, self.io, pending_path) catch DeepLink{ .none = {} };
        }
        // Drop any leftover pending link so a fresh incoming URL cannot leave
        // a stale install/activate queued for the next poll.
        std.Io.Dir.deleteFileAbsolute(self.io, pending_path) catch {};

        defer freeDeepLink(self.allocator, deeplink);
        return try formatDeepLinkJson(self.allocator, deeplink, output);
    }

    // Mirror of readRuntimeStateCmd, but reads ~/.petdex/runtime/bubble.json
    // (written by the sidecar's POST /bubble handler). The WebView polls
    // this every 200ms via the bridge, alongside the state poll. A
    // missing file is normal on first launch — we return an empty
    // payload so the JS side just shows nothing.
    fn readRuntimeBubbleCmd(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation;
        const self: *PetdexState = @ptrCast(@alignCast(context));
        const path = try std.fs.path.join(self.allocator, &.{ self.config_dir, "runtime", "bubble.json" });
        defer self.allocator.free(path);
        var file = std.Io.Dir.openFileAbsolute(self.io, path, .{}) catch {
            return std.fmt.bufPrint(output, "{{\"text\":\"\",\"counter\":0}}", .{});
        };
        defer file.close(self.io);
        const stat = try file.stat(self.io);
        const size: usize = @intCast(stat.size);
        if (size == 0 or size > output.len) {
            return std.fmt.bufPrint(output, "{{\"text\":\"\",\"counter\":0}}", .{});
        }
        const read = try file.readPositionalAll(self.io, output[0..size], 0);
        return output[0..read];
    }

    // Spawn `node ~/.petdex/bin/petdex.js install <slug>` and wait for
    // it to finish. Used by the URL-scheme deep-link path: when the
    // user opens petdex://<slug> for a pet they don't have installed,
    // we shell out to the CLI which downloads the sprite + petJson
    // from petdex.crafter.run, validates the host allowlist, and
    // writes them under ~/.petdex/pets/<slug>. The CLI is the
    // single source of truth for install logic — replicating it in
    // zig would mean two places to keep in sync.
    fn installPetCmd(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        const self: *PetdexState = @ptrCast(@alignCast(context));
        var slugs = try parseInstallSlugsFromPayload(self.allocator, invocation.request.payload);
        defer {
            for (slugs.items) |s| self.allocator.free(s);
            slugs.deinit(self.allocator);
        }
        if (slugs.items.len == 0) return error.MissingSlug;

        const home = self.env_map.get("HOME") orelse {
            return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"no_home\"}}", .{});
        };
        const cli_path = try std.fs.path.join(self.allocator, &.{ home, ".petdex", "bin", "petdex.js" });
        defer self.allocator.free(cli_path);

        // Verify the CLI snapshot exists. If `petdex hooks install`
        // was never run, this file is absent and we can't auto-install.
        std.Io.Dir.accessAbsolute(self.io, cli_path, .{}) catch {
            return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"cli_not_persisted\"}}", .{});
        };

        // Resolve node via the same PATH-aware lookup the sidecar uses.
        // launchctl PATH on Finder-launched .apps is /usr/bin:/bin:/usr/sbin:/sbin
        // — no nvm, no homebrew, no node. Plain `node` in argv would
        // resolve to FileNotFound and the user would see "Install failed:
        // FileNotFound" (Hunter 2026-05-11) with no idea what to do.
        const node_path = findExecutableOnPath(self.allocator, self.io, self.env_map, "node") catch {
            return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"node_not_found\"}}", .{});
        };
        defer self.allocator.free(node_path);

        var argv: std.ArrayList([]const u8) = .empty;
        defer argv.deinit(self.allocator);
        try argv.appendSlice(self.allocator, &.{ node_path, cli_path, "install" });
        try argv.appendSlice(self.allocator, slugs.items);

        const runtime_dir = try std.fs.path.join(self.allocator, &.{ home, ".petdex-desktop", "runtime" });
        defer self.allocator.free(runtime_dir);
        try ensurePrivateDir(self.allocator, self.io, runtime_dir);
        const summary_path = try std.fs.path.join(self.allocator, &.{ runtime_dir, "install-machine-summary.json" });
        defer self.allocator.free(summary_path);
        std.Io.Dir.deleteFileAbsolute(self.io, summary_path) catch {};

        var child_env = std.process.Environ.Map.init(self.allocator);
        defer child_env.deinit();
        {
            const keys = self.env_map.keys();
            const vals = self.env_map.values();
            for (keys, vals) |k, v| {
                try child_env.put(k, v);
            }
        }
        try child_env.put("PETDEX_INSTALL_MACHINE_SUMMARY_PATH", summary_path);

        var child = std.process.spawn(self.io, .{
            .argv = argv.items,
            .stdin = .ignore,
            .stdout = .ignore,
            .stderr = .ignore,
            .environ_map = &child_env,
        }) catch |err| {
            return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"spawn_{s}\"}}", .{@errorName(err)});
        };
        const term = child.wait(self.io) catch |err| {
            return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"{s}\"}}", .{@errorName(err)});
        };

        const report_opt = readOptionalInstallMachineReport(self.allocator, self.io, summary_path);
        defer if (report_opt) |rp| self.allocator.free(rp);
        std.Io.Dir.deleteFileAbsolute(self.io, summary_path) catch {};

        const disk_installed = countRequestedSlugsOnDisk(self.io, self.pets_roots, slugs.items);

        switch (term) {
            .exited => |code| {
                if (code == 0) {
                    return try formatInstallPetBridgeJson(self.allocator, output, true, null, report_opt, slugs.items.len, disk_installed);
                }
                var err_buf: [48]u8 = undefined;
                const err_tag = std.fmt.bufPrint(&err_buf, "exit_{d}", .{code}) catch "exit_unknown";
                return try formatInstallPetBridgeJson(self.allocator, output, false, err_tag, report_opt, slugs.items.len, disk_installed);
            },
            else => {
                return try formatInstallPetBridgeJson(self.allocator, output, false, "abnormal_exit", report_opt, slugs.items.len, disk_installed);
            },
        }
    }

    fn refreshPetsCmd(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation;
        const self: *PetdexState = @ptrCast(@alignCast(context));

        var pets = try listPetsAcrossRoots(self.allocator, self.io, self.pets_roots);
        errdefer {
            for (pets.items) |p| {
                self.allocator.free(p.slug);
                self.allocator.free(p.display_name);
                self.allocator.free(p.root);
            }
            pets.deinit(self.allocator);
        }
        if (pets.items.len == 0) {
            return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"no_pets\"}}", .{});
        }

        const stored_active = try readActiveSlug(self.allocator, self.io, self.config_dir);
        defer if (stored_active) |s| self.allocator.free(s);

        const active_slug = blk: {
            if (stored_active) |s| {
                for (pets.items) |p| {
                    if (std.mem.eql(u8, p.slug, s)) break :blk s;
                }
            }
            break :blk pets.items[0].slug;
        };

        const sprite = try loadSpritesheetAcrossRoots(self.allocator, self.io, self.pets_roots, active_slug);
        defer self.allocator.free(sprite.bytes);

        var root_dir = try std.Io.Dir.openDirAbsolute(self.io, self.asset_root, .{});
        defer root_dir.close(self.io);
        try writeFileAll(self.io, root_dir, "spritesheet.webp", sprite.bytes);
        if (!std.mem.eql(u8, sprite.ext, "webp")) {
            const sprite_name = if (std.mem.eql(u8, sprite.ext, "png")) "spritesheet.png" else "spritesheet.webp";
            try writeFileAll(self.io, root_dir, sprite_name, sprite.bytes);
        }

        const petdex_json = try buildPetdexJson(self.allocator, pets.items, active_slug);
        defer self.allocator.free(petdex_json);
        const html_doc = try buildHtml(self.allocator, petdex_json);
        defer self.allocator.free(html_doc);
        try writeFileAll(self.io, root_dir, "index.html", html_doc);
        try copyAllSpritesheets(self.allocator, self.io, self.asset_root, pets.items);

        const response = try std.fmt.bufPrint(output, "{{\"ok\":true,\"active\":\"{s}\"}}", .{active_slug});

        for (pets.items) |p| {
            self.allocator.free(p.slug);
            self.allocator.free(p.display_name);
            self.allocator.free(p.root);
        }
        pets.deinit(self.allocator);

        return response;
    }

    fn setActiveCmd(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        const self: *PetdexState = @ptrCast(@alignCast(context));
        const slug = jsonStringField(invocation.request.payload, "slug") orelse return error.MissingSlug;

        // Load BEFORE persisting active.json. Reversed order would
        // poison the stored slug if the sprite is unreadable: the
        // file would point at a broken pet, and every subsequent
        // launch would crash in main()'s loadSpritesheet call until
        // the user manually edited active.json. Validating first
        // means a failed selection leaves the previous active intact.
        //
        // We try each pets root in priority order (.petdex first,
        // .codex second) and use the first one that has the slug.
        // The picker would have shown the slug from whichever root
        // it actually came from — we just need to find it again.
        const sprite = try loadSpritesheetAcrossRoots(self.allocator, self.io, self.pets_roots, slug);
        defer self.allocator.free(sprite.bytes);

        var root_dir = try std.Io.Dir.openDirAbsolute(self.io, self.asset_root, .{});
        defer root_dir.close(self.io);
        try writeFileAll(self.io, root_dir, "spritesheet.webp", sprite.bytes);
        if (!std.mem.eql(u8, sprite.ext, "webp")) {
            const sprite_name = if (std.mem.eql(u8, sprite.ext, "png")) "spritesheet.png" else "spritesheet.webp";
            try writeFileAll(self.io, root_dir, sprite_name, sprite.bytes);
        }

        // Persist last — by here we've proven the pet is loadable
        // AND we've successfully written the sprite into asset_root.
        try writeActiveSlug(self.io, self.config_dir, slug);

        return std.fmt.bufPrint(output, "{{\"ok\":true}}", .{});
    }

    fn quitCmd(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = context;
        _ = invocation;
        std.process.exit(0);
        return std.fmt.bufPrint(output, "{{\"ok\":true}}", .{});
    }

    fn readUpdateInfoCmd(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation;
        const self: *PetdexState = @ptrCast(@alignCast(context));
        const path = try std.fs.path.join(self.allocator, &.{ self.config_dir, "runtime", "update.json" });
        defer self.allocator.free(path);
        var file = std.Io.Dir.openFileAbsolute(self.io, path, .{}) catch {
            return std.fmt.bufPrint(output, "{{\"available\":false,\"status\":\"idle\"}}", .{});
        };
        defer file.close(self.io);
        const stat = try file.stat(self.io);
        const size: usize = @intCast(stat.size);
        if (size == 0 or size > output.len) {
            return std.fmt.bufPrint(output, "{{\"available\":false,\"status\":\"idle\"}}", .{});
        }
        const read = try file.readPositionalAll(self.io, output[0..size], 0);
        return output[0..read];
    }

    fn readInitStatusCmd(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation;
        const self: *PetdexState = @ptrCast(@alignCast(context));
        const path = try std.fs.path.join(self.allocator, &.{ self.config_dir, "runtime", "init-status.json" });
        defer self.allocator.free(path);
        var file = std.Io.Dir.openFileAbsolute(self.io, path, .{}) catch {
            return std.fmt.bufPrint(output, "{{\"needsInit\":false,\"reason\":null,\"checkedAt\":0}}", .{});
        };
        defer file.close(self.io);
        const stat = try file.stat(self.io);
        const size: usize = @intCast(stat.size);
        if (size == 0 or size > output.len) {
            return std.fmt.bufPrint(output, "{{\"needsInit\":false,\"reason\":null,\"checkedAt\":0}}", .{});
        }
        const read = try file.readPositionalAll(self.io, output[0..size], 0);
        return output[0..read];
    }

    fn triggerUpdateCmd(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation;
        const self: *PetdexState = @ptrCast(@alignCast(context));
        // Read the per-session token the sidecar wrote to ~/.petdex/
        // runtime/update-token (mode 0600). Forward it as a header so
        // a drive-by website can't trigger this endpoint via no-cors.
        const token_path = try std.fs.path.join(self.allocator, &.{ self.config_dir, "runtime", "update-token" });
        defer self.allocator.free(token_path);
        var token_file = std.Io.Dir.openFileAbsolute(self.io, token_path, .{}) catch {
            return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"no_token\"}}", .{});
        };
        defer token_file.close(self.io);
        var token_buf: [128]u8 = undefined;
        const token_read = token_file.readPositionalAll(self.io, &token_buf, 0) catch {
            return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"token_read\"}}", .{});
        };
        const token = std.mem.trim(u8, token_buf[0..token_read], " \t\r\n");
        if (token.len == 0) {
            return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"empty_token\"}}", .{});
        }

        // Build "X-Petdex-Update-Token: <token>" header arg.
        const header_arg = try std.fmt.allocPrint(
            self.allocator,
            "X-Petdex-Update-Token: {s}",
            .{token},
        );
        defer self.allocator.free(header_arg);

        // Spawn `curl -fsS -X POST -H "..." http://127.0.0.1:7777/update`
        // and wait for its exit code. We used to detach this and return
        // ok:true unconditionally, which masked sidecar-down failures
        // (Hunter 2026-05-11: clicked update card, nothing happened, no
        // way to tell why). The POST body is empty and the sidecar
        // returns 202 within milliseconds — synchronous wait is fine.
        const argv = &[_][]const u8{
            "curl",
            "-fsS",
            "-m",
            "5",
            "-X",
            "POST",
            "-H",
            header_arg,
            "http://127.0.0.1:7777/update",
        };
        var child = std.process.spawn(self.io, .{
            .argv = argv,
            .stdin = .ignore,
            .stdout = .ignore,
            .stderr = .ignore,
        }) catch |err| {
            return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"spawn_{s}\"}}", .{@errorName(err)});
        };
        const term = child.wait(self.io) catch |err| {
            return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"wait_{s}\"}}", .{@errorName(err)});
        };
        switch (term) {
            .exited => |code| {
                if (code == 0) {
                    return std.fmt.bufPrint(output, "{{\"ok\":true}}", .{});
                }
                // curl exit 7 = could not connect (sidecar dead). Surface
                // the code so the WebView can render an actionable error.
                return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"curl_exit_{d}\"}}", .{code});
            },
            else => return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"curl_abnormal_exit\"}}", .{}),
        }
    }

    // Forward a {state, duration} payload to the sidecar so the
    // mascot sprite reflects WebView-side events (install fails, etc.).
    // Without this, all mascot state changes flow through external
    // hooks (claude-code, opencode posting to /state); WebView-internal
    // failures had no way to drive the sprite. Hunter 2026-05-11:
    // "deepling install failed but mascot kept smiling".
    //
    // Same auth pattern as triggerUpdateCmd: read the per-session token
    // and forward it as a header so a drive-by website can't bypass.
    fn setMascotStateCmd(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        const self: *PetdexState = @ptrCast(@alignCast(context));
        const state = jsonStringField(invocation.request.payload, "state") orelse return error.MissingState;

        const token_path = try std.fs.path.join(self.allocator, &.{ self.config_dir, "runtime", "update-token" });
        defer self.allocator.free(token_path);
        var token_file = std.Io.Dir.openFileAbsolute(self.io, token_path, .{}) catch {
            return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"no_token\"}}", .{});
        };
        defer token_file.close(self.io);
        var token_buf: [128]u8 = undefined;
        const token_read = token_file.readPositionalAll(self.io, &token_buf, 0) catch {
            return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"token_read\"}}", .{});
        };
        const token = std.mem.trim(u8, token_buf[0..token_read], " \t\r\n");
        if (token.len == 0) {
            return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"empty_token\"}}", .{});
        }

        const header_arg = try std.fmt.allocPrint(
            self.allocator,
            "X-Petdex-Update-Token: {s}",
            .{token},
        );
        defer self.allocator.free(header_arg);

        // Build {"state":"<state>","duration":3000} body. Duration
        // bounded so an install-failure sprite doesn't pin the mascot
        // forever — the next idle tick reverts it.
        const body = try std.fmt.allocPrint(
            self.allocator,
            "{{\"state\":\"{s}\",\"duration\":3000}}",
            .{state},
        );
        defer self.allocator.free(body);

        const argv = &[_][]const u8{
            "curl",
            "-fsS",
            "-m",
            "3",
            "-X",
            "POST",
            "-H",
            header_arg,
            "-H",
            "Content-Type: application/json",
            "-d",
            body,
            "http://127.0.0.1:7777/state",
        };
        var child = std.process.spawn(self.io, .{
            .argv = argv,
            .stdin = .ignore,
            .stdout = .ignore,
            .stderr = .ignore,
        }) catch |err| {
            return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"spawn_{s}\"}}", .{@errorName(err)});
        };
        const term = child.wait(self.io) catch |err| {
            return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"wait_{s}\"}}", .{@errorName(err)});
        };
        switch (term) {
            .exited => |code| {
                if (code == 0) {
                    return std.fmt.bufPrint(output, "{{\"ok\":true}}", .{});
                }
                return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"curl_exit_{d}\"}}", .{code});
            },
            else => return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"curl_abnormal_exit\"}}", .{}),
        }
    }
};

const petdex_origins = [_][]const u8{ "zero://app", "zero://inline" };
const petdex_command_policies = [_]zero_native.BridgeCommandPolicy{
    .{ .name = "petdex.set_active", .origins = &petdex_origins },
    .{ .name = "petdex.quit", .origins = &petdex_origins },
    .{ .name = "petdex.read_runtime_state", .origins = &petdex_origins },
    .{ .name = "petdex.read_runtime_bubble", .origins = &petdex_origins },
    .{ .name = "petdex.read_incoming_url", .origins = &petdex_origins },
    .{ .name = "petdex.install_pet", .origins = &petdex_origins },
    .{ .name = "petdex.refresh_pets", .origins = &petdex_origins },
    .{ .name = "petdex.read_update_info", .origins = &petdex_origins },
    .{ .name = "petdex.read_init_status", .origins = &petdex_origins },
    .{ .name = "petdex.trigger_update", .origins = &petdex_origins },
    .{ .name = "petdex.respawn_sidecar", .origins = &petdex_origins },
    .{ .name = "petdex.set_mascot_state", .origins = &petdex_origins },
};

fn jsonStringField(payload: []const u8, key: []const u8) ?[]const u8 {
    var key_buf: [64]u8 = undefined;
    const needle = std.fmt.bufPrint(&key_buf, "\"{s}\":\"", .{key}) catch return null;
    const start = std.mem.indexOf(u8, payload, needle) orelse return null;
    const value_start = start + needle.len;
    const end = std.mem.indexOfScalarPos(u8, payload, value_start, '"') orelse return null;
    return payload[value_start..end];
}

fn jsonUintField(json: []const u8, key: []const u8) ?usize {
    var key_buf: [48]u8 = undefined;
    const needle = std.fmt.bufPrint(&key_buf, "\"{s}\":", .{key}) catch return null;
    const start = std.mem.indexOf(u8, json, needle) orelse return null;
    var i = start + needle.len;
    while (i < json.len and std.ascii.isWhitespace(json[i])) i += 1;
    if (i >= json.len) return null;
    var end = i;
    while (end < json.len and std.ascii.isDigit(json[end])) end += 1;
    if (end == i) return null;
    return std.fmt.parseInt(usize, json[i..end], 10) catch null;
}

// Counts string elements in a JSON array field (e.g. `"missing":["a","b"]`).
fn jsonStringArrayLength(json: []const u8, key: []const u8) ?usize {
    var key_buf: [48]u8 = undefined;
    const needle = std.fmt.bufPrint(&key_buf, "\"{s}\":[", .{key}) catch return null;
    const start = std.mem.indexOf(u8, json, needle) orelse return null;
    var i = start + needle.len;
    while (i < json.len and std.ascii.isWhitespace(json[i])) i += 1;
    if (i >= json.len or json[i] == ']') return 0;
    var count: usize = 0;
    while (i < json.len and json[i] != ']') {
        if (json[i] == '"') {
            count += 1;
            i += 1;
            while (i < json.len and json[i] != '"') i += 1;
        }
        i += 1;
    }
    return count;
}

// Counts object elements in a JSON array field (e.g. `"failed":[{"slug":"a"},…]`).
fn jsonObjectArrayLength(json: []const u8, key: []const u8) ?usize {
    var key_buf: [48]u8 = undefined;
    const needle = std.fmt.bufPrint(&key_buf, "\"{s}\":[", .{key}) catch return null;
    const start = std.mem.indexOf(u8, json, needle) orelse return null;
    var i = start + needle.len;
    while (i < json.len and std.ascii.isWhitespace(json[i])) i += 1;
    if (i >= json.len or json[i] == ']') return 0;
    var count: usize = 0;
    while (i < json.len and json[i] != ']') {
        if (json[i] == '{') count += 1;
        i += 1;
    }
    return count;
}

fn countRequestedSlugsOnDisk(io: std.Io, roots: []const []u8, slugs: []const []const u8) usize {
    var count: usize = 0;
    for (slugs) |slug| {
        var found = false;
        for (roots) |root_path| {
            var dir = std.Io.Dir.openDirAbsolute(io, root_path, .{ .iterate = true }) catch continue;
            defer dir.close(io);
            if (hasSpritesheet(io, dir, slug)) {
                found = true;
                break;
            }
        }
        if (found) count += 1;
    }
    return count;
}

fn readFileAll(io: std.Io, allocator: std.mem.Allocator, file: std.Io.File, max_bytes: usize) ![]u8 {
    const stat = try file.stat(io);
    const size: usize = @intCast(stat.size);
    if (size > max_bytes) return error.FileTooLarge;
    const buf = try allocator.alloc(u8, size);
    errdefer allocator.free(buf);
    const read = try file.readPositionalAll(io, buf, 0);
    if (read != size) return error.ShortRead;
    return buf;
}

fn readOptionalInstallMachineReport(allocator: std.mem.Allocator, io: std.Io, path: []const u8) ?[]const u8 {
    var file = std.Io.Dir.openFileAbsolute(io, path, .{}) catch return null;
    defer file.close(io);
    const raw = readFileAll(io, allocator, file, 8192) catch return null;
    const trimmed = std.mem.trim(u8, raw, " \t\r\n");
    const owned = allocator.dupe(u8, trimmed) catch {
        allocator.free(raw);
        return null;
    };
    allocator.free(raw);
    if (owned.len == 0 or owned[0] != '{') {
        allocator.free(owned);
        return null;
    }
    return owned;
}

fn resolveInstalledCount(
    report: ?[]const u8,
    disk_installed_count: usize,
) usize {
    if (report) |r| {
        if (jsonUintField(r, "installed_count")) |n| return n;
    }
    return disk_installed_count;
}

fn tryAppendInstallIssueNote(
    buf: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
    report: ?[]const u8,
    requested_count: usize,
    installed: usize,
) !void {
    const missing: usize = if (report) |r| jsonStringArrayLength(r, "missing") orelse 0 else 0;
    const failed: usize = if (report) |r| jsonObjectArrayLength(r, "failed") orelse 0 else 0;
    const gap: usize = if (installed < requested_count) requested_count - installed else 0;
    const other: usize = if (gap > missing + failed) gap - missing - failed else 0;

    var msg: std.ArrayList(u8) = .empty;
    defer msg.deinit(allocator);
    var part_buf: [64]u8 = undefined;
    if (missing > 0) {
        const part = try std.fmt.bufPrint(&part_buf, "{d} skipped (not found). ", .{missing});
        try msg.appendSlice(allocator, part);
    }
    if (failed > 0) {
        const part = try std.fmt.bufPrint(&part_buf, "{d} failed to download. ", .{failed});
        try msg.appendSlice(allocator, part);
    }
    if (other > 0) {
        const part = try std.fmt.bufPrint(&part_buf, "{d} not installed. ", .{other});
        try msg.appendSlice(allocator, part);
    }
    if (msg.items.len == 0) return;

    try buf.appendSlice(allocator, ",\"issue_note\":\"");
    try appendJsonEscaped(buf, allocator, msg.items);
    try buf.appendSlice(allocator, "\"");
}

fn formatInstallPetBridgeJson(
    allocator: std.mem.Allocator,
    output: []u8,
    ok: bool,
    err_opt: ?[]const u8,
    report: ?[]const u8,
    requested_count: usize,
    disk_installed_count: usize,
) ![]const u8 {
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(allocator);
    var num_buf: [24]u8 = undefined;
    const installed = resolveInstalledCount(report, disk_installed_count);
    try buf.appendSlice(allocator, "{\"ok\":");
    try buf.appendSlice(allocator, if (ok) "true" else "false");
    if (err_opt) |e| {
        try buf.appendSlice(allocator, ",\"error\":\"");
        try appendJsonEscaped(&buf, allocator, e);
        try buf.appendSlice(allocator, "\"");
    }
    const req_str = try std.fmt.bufPrint(&num_buf, "{d}", .{requested_count});
    try buf.appendSlice(allocator, ",\"requested_count\":");
    try buf.appendSlice(allocator, req_str);
    if (report) |r| {
        try buf.appendSlice(allocator, ",\"install_report\":");
        try buf.appendSlice(allocator, r);
    }
    if (ok) {
        const inst_str = try std.fmt.bufPrint(&num_buf, "{d}", .{installed});
        try buf.appendSlice(allocator, ",\"installed_count\":");
        try buf.appendSlice(allocator, inst_str);
    } else if (report) |r| {
        if (jsonUintField(r, "installed_count")) |installed_from_report| {
            const inst_str = try std.fmt.bufPrint(&num_buf, "{d}", .{installed_from_report});
            try buf.appendSlice(allocator, ",\"installed_count\":");
            try buf.appendSlice(allocator, inst_str);
        }
    }
    try tryAppendInstallIssueNote(&buf, allocator, report, requested_count, installed);
    try buf.appendSlice(allocator, "}");
    if (buf.items.len > output.len) return error.BufferTooSmall;
    @memcpy(output[0..buf.items.len], buf.items);
    return output[0..buf.items.len];
}

fn writeFileAll(io: std.Io, dir: std.Io.Dir, name: []const u8, bytes: []const u8) !void {
    var file = try dir.createFile(io, name, .{ .truncate = true });
    defer file.close(io);
    try file.writePositionalAll(io, bytes, 0);
}

fn ensureDir(io: std.Io, path: []const u8) !void {
    std.Io.Dir.createDirAbsolute(io, path, .default_dir) catch |err| switch (err) {
        error.PathAlreadyExists => {},
        else => return err,
    };
}

// Same as ensureDir but with mode 0700 (rwx for owner only). Used for
// directories that hold WebView assets / runtime state we don't want
// other local users reading or pre-staging symlinks into. On Windows
// the mode is ignored; per-user isolation comes from the parent
// directory living under %USERPROFILE%.
fn ensurePrivateDir(allocator: std.mem.Allocator, io: std.Io, path: []const u8) !void {
    const private_perms = std.Io.File.Permissions.fromMode(0o700);
    std.Io.Dir.createDirAbsolute(io, path, private_perms) catch |err| switch (err) {
        // If it already exists, tighten the mode in case a previous
        // version created it with a wider default. chmod is a no-op
        // on Windows (mode_t is u0 there). std.Io.Dir doesn't expose
        // chmod directly, so we go through libc with a NUL-terminated
        // path.
        error.PathAlreadyExists => {
            if (@sizeOf(std.posix.mode_t) > 0) {
                const path_z = try allocator.dupeZ(u8, path);
                defer allocator.free(path_z);
                _ = std.c.chmod(path_z.ptr, 0o700);
            }
        },
        else => return err,
    };
}

fn pathExists(io: std.Io, absolute_path: []const u8) bool {
    var dir = std.Io.Dir.openDirAbsolute(io, absolute_path, .{}) catch return false;
    defer dir.close(io);
    return true;
}

// Returns every existing pets root in priority order. Callers must
// own and free the inner slices. Empty result means no canonical
// pets root exists at all (fresh install, or HOME without .petdex
// or .codex). Existing-but-empty roots are still returned — the
// caller filters via listPetsAcrossRoots.
//
// Why not the old "first existing" behavior: an empty/broken
// ~/.petdex/pets dir (left over from an aborted install, for
// example) used to mask a populated ~/.codex/pets, and the binary
// would exit "No pets". Reading both roots and merging fixes that.
fn resolvePetsRoots(allocator: std.mem.Allocator, io: std.Io, env_map: *std.process.Environ.Map) ![][]u8 {
    const home = env_map.get("HOME") orelse return error.NoHome;
    var roots: std.ArrayList([]u8) = .empty;
    errdefer {
        for (roots.items) |r| allocator.free(r);
        roots.deinit(allocator);
    }
    const petdex_path = try std.fs.path.join(allocator, &.{ home, ".petdex", "pets" });
    if (pathExists(io, petdex_path)) {
        try roots.append(allocator, petdex_path);
    } else {
        allocator.free(petdex_path);
    }
    const codex_path = try std.fs.path.join(allocator, &.{ home, ".codex", "pets" });
    if (pathExists(io, codex_path)) {
        try roots.append(allocator, codex_path);
    } else {
        allocator.free(codex_path);
    }
    return roots.toOwnedSlice(allocator);
}

fn resolveConfigDir(allocator: std.mem.Allocator, io: std.Io, env_map: *std.process.Environ.Map) ![]u8 {
    const home = env_map.get("HOME") orelse return error.NoHome;
    const dir = try std.fs.path.join(allocator, &.{ home, ".petdex" });
    try ensureDir(io, dir);
    return dir;
}

fn resolveSidecarDir(allocator: std.mem.Allocator, env_map: *std.process.Environ.Map) ![]u8 {
    // Local development override: lets the author run the binary against
    // the in-tree sidecar without copying server.js to ~/.petdex/sidecar/.
    if (env_map.get("PETDEX_SIDECAR_DIR")) |override| {
        return try allocator.dupe(u8, override);
    }
    // .app bundle: when shipped as Petdex.app the sidecar is bundled at
    // Contents/Resources/sidecar/ so the user doesn't need a separate
    // `petdex install desktop` step. We detect this by checking whether
    // the executable lives at .../Contents/MacOS/<binary> — a path that
    // can only exist inside an .app — and resolve sidecar relative to
    // that.
    if (try resolveBundledSidecarDir(allocator)) |bundled| return bundled;
    // Bare-binary install path (legacy v0.1.0): the CLI installs the
    // sidecar bundle at ~/.petdex/sidecar/server.js.
    const home = env_map.get("HOME") orelse return error.NoHome;
    return try std.fs.path.join(allocator, &.{ home, ".petdex", "sidecar" });
}

// Returns Contents/Resources/sidecar IFF the running executable is
// inside an .app bundle. Otherwise returns null and the caller falls
// back to the legacy ~/.petdex/sidecar path.
fn resolveBundledSidecarDir(allocator: std.mem.Allocator) !?[]u8 {
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    var size: u32 = path_buf.len;
    // Darwin-specific. _NSGetExecutablePath fills the buffer with the
    // path of the running executable. Returns 0 on success; -1 means
    // size was too small (we never hit that with max_path_bytes).
    if (std.c._NSGetExecutablePath(&path_buf, &size) != 0) return null;
    // Find the NUL byte and slice to the actual length.
    const exe_path = std.mem.sliceTo(@as([*:0]u8, @ptrCast(&path_buf)), 0);
    // Look for ".app/Contents/MacOS/" anywhere in the path.
    const needle = "/Contents/MacOS/";
    const idx = std.mem.indexOf(u8, exe_path, needle) orelse return null;
    const contents_root = exe_path[0 .. idx + "/Contents".len];
    return try std.fs.path.join(allocator, &.{ contents_root, "Resources", "sidecar" });
}

fn readActiveSlug(allocator: std.mem.Allocator, io: std.Io, config_dir: []const u8) !?[]u8 {
    const path = try std.fs.path.join(allocator, &.{ config_dir, "active.json" });
    defer allocator.free(path);
    var file = std.Io.Dir.openFileAbsolute(io, path, .{}) catch return null;
    defer file.close(io);
    const bytes = try readFileAll(io, allocator, file, MAX_ACTIVE_BYTES);
    defer allocator.free(bytes);
    const slug = jsonStringField(bytes, "slug") orelse return null;
    return try allocator.dupe(u8, slug);
}

fn writeActiveSlug(io: std.Io, config_dir: []const u8, slug: []const u8) !void {
    var dir = try std.Io.Dir.openDirAbsolute(io, config_dir, .{});
    defer dir.close(io);
    var buf: [512]u8 = undefined;
    const json_text = try std.fmt.bufPrint(&buf, "{{\"slug\":\"{s}\"}}\n", .{slug});
    try writeFileAll(io, dir, "active.json", json_text);
}

fn isValidSlug(slug: []const u8) bool {
    if (slug.len == 0 or slug.len > MAX_SLUG_LEN) return false;
    for (slug) |ch| {
        const ok = (ch >= 'a' and ch <= 'z') or
            (ch >= 'A' and ch <= 'Z') or
            (ch >= '0' and ch <= '9') or
            ch == '-' or ch == '_';
        if (!ok) return false;
    }
    return true;
}

fn freeDeepLink(allocator: std.mem.Allocator, deeplink: DeepLink) void {
    switch (deeplink) {
        .none => {},
        .activate => |slug| allocator.free(slug),
        .install => |slugs| {
            var owned = slugs;
            for (owned.items) |s| allocator.free(s);
            owned.deinit(allocator);
        },
    }
}

fn readDeepLinkFromPath(allocator: std.mem.Allocator, io: std.Io, path: []const u8) !DeepLink {
    var file = std.Io.Dir.openFileAbsolute(io, path, .{}) catch return DeepLink{ .none = {} };
    defer file.close(io);
    const bytes = readFileAll(io, allocator, file, MAX_ACTIVE_BYTES) catch return DeepLink{ .none = {} };
    defer allocator.free(bytes);
    return parseDeepLinkFromUrl(allocator, bytes) catch DeepLink{ .none = {} };
}

fn readDeepLinkFromUrlFile(allocator: std.mem.Allocator, io: std.Io, env: *const std.process.Environ.Map) !DeepLink {
    const home = env.get("HOME") orelse return DeepLink{ .none = {} };
    const path = try std.fs.path.join(allocator, &.{ home, ".petdex-desktop", "runtime", "incoming-url.txt" });
    defer allocator.free(path);
    const deeplink = try readDeepLinkFromPath(allocator, io, path);
    std.Io.Dir.deleteFileAbsolute(io, path) catch {};
    return deeplink;
}

fn readDeepLinkFromUrlArg(allocator: std.mem.Allocator, args: std.process.Args) !DeepLink {
    var iter = std.process.Args.Iterator.initAllocator(args, allocator) catch return DeepLink{ .none = {} };
    defer iter.deinit();
    var idx: usize = 0;
    while (iter.next()) |arg_z| : (idx += 1) {
        if (idx == 0) continue;
        const arg: []const u8 = arg_z;
        const prefix = "petdex://";
        if (arg.len <= prefix.len or !std.mem.startsWith(u8, arg, prefix)) continue;
        return parseDeepLinkFromUrl(allocator, arg) catch DeepLink{ .none = {} };
    }
    return DeepLink{ .none = {} };
}

fn parseDeepLinkFromUrl(allocator: std.mem.Allocator, raw: []const u8) !DeepLink {
    const trimmed = std.mem.trim(u8, raw, " \t\r\n");
    const prefix = "petdex://";
    if (trimmed.len <= prefix.len or !std.mem.startsWith(u8, trimmed, prefix)) {
        return DeepLink{ .none = {} };
    }
    var rest = trimmed[prefix.len..];
    if (std.mem.endsWith(u8, rest, "/")) rest = rest[0 .. rest.len - 1];
    if (rest.len == 0) return DeepLink{ .none = {} };

    const q_mark = std.mem.indexOfScalar(u8, rest, '?');
    const path = if (q_mark) |i| rest[0..i] else rest;
    const query = if (q_mark) |i| rest[i + 1 ..] else "";

    if (std.mem.eql(u8, path, "install")) {
        return try parseInstallSlugsFromQuery(allocator, query);
    }

    if (query.len > 0 or std.mem.indexOfScalar(u8, path, '/') != null) {
        return DeepLink{ .none = {} };
    }
    if (!isValidSlug(path)) return DeepLink{ .none = {} };
    return DeepLink{ .activate = try allocator.dupe(u8, path) };
}

fn parseInstallSlugsFromQuery(allocator: std.mem.Allocator, query: []const u8) !DeepLink {
    var slugs: std.ArrayList([]const u8) = .empty;
    errdefer {
        for (slugs.items) |s| allocator.free(s);
        slugs.deinit(allocator);
    }

    var pair_iter = std.mem.splitScalar(u8, query, '&');
    while (pair_iter.next()) |pair| {
        if (pair.len == 0) continue;
        if (std.mem.startsWith(u8, pair, "slugs=")) {
            const value = pair["slugs=".len..];
            var decoded_buf: [MAX_SLUGS_QUERY_BYTES]u8 = undefined;
            const csv = percentDecodeSlug(value, &decoded_buf) orelse value;
            var slug_iter = std.mem.splitScalar(u8, csv, ',');
            while (slug_iter.next()) |part| {
                const slug = std.mem.trim(u8, part, " \t");
                try appendInstallSlug(allocator, &slugs, slug);
            }
        } else if (std.mem.startsWith(u8, pair, "slug=")) {
            const value = pair["slug=".len..];
            var decoded: [MAX_SLUG_LEN + 8]u8 = undefined;
            const slug = percentDecodeSlug(value, &decoded) orelse continue;
            try appendInstallSlug(allocator, &slugs, slug);
        }
    }

    if (slugs.items.len == 0) return DeepLink{ .none = {} };
    return DeepLink{ .install = slugs };
}

fn appendInstallSlug(allocator: std.mem.Allocator, slugs: *std.ArrayList([]const u8), slug: []const u8) !void {
    if (slugs.items.len >= MAX_INSTALL_SLUGS) return;
    if (!isValidSlug(slug)) return;
    for (slugs.items) |existing| {
        if (std.mem.eql(u8, existing, slug)) return;
    }
    try slugs.append(allocator, try allocator.dupe(u8, slug));
}

fn hexNibble(c: u8) ?u4 {
    if (c >= '0' and c <= '9') return @intCast(c - '0');
    if (c >= 'a' and c <= 'f') return @intCast(c - 'a' + 10);
    if (c >= 'A' and c <= 'F') return @intCast(c - 'A' + 10);
    return null;
}

fn percentDecodeSlug(encoded: []const u8, out: []u8) ?[]const u8 {
    var len: usize = 0;
    var i: usize = 0;
    while (i < encoded.len) : (i += 1) {
        if (encoded[i] == '%' and i + 2 < encoded.len) {
            const hi = hexNibble(encoded[i + 1]) orelse return null;
            const lo = hexNibble(encoded[i + 2]) orelse return null;
            if (len >= out.len) return null;
            out[len] = @as(u8, hi) * 16 + @as(u8, lo);
            len += 1;
            i += 2;
        } else {
            if (len >= out.len) return null;
            out[len] = encoded[i];
            len += 1;
        }
    }
    return out[0..len];
}

fn parseInstallSlugsFromPayload(allocator: std.mem.Allocator, payload: []const u8) !std.ArrayList([]const u8) {
    var slugs: std.ArrayList([]const u8) = .empty;
    errdefer {
        for (slugs.items) |s| allocator.free(s);
        slugs.deinit(allocator);
    }

    if (jsonStringField(payload, "slugs")) |csv| {
        var iter = std.mem.splitScalar(u8, csv, ',');
        while (iter.next()) |part| {
            const slug = std.mem.trim(u8, part, " \t");
            try appendInstallSlug(allocator, &slugs, slug);
        }
    }
    if (slugs.items.len == 0) {
        if (jsonStringField(payload, "slug")) |slug| {
            try appendInstallSlug(allocator, &slugs, slug);
        }
    }
    return slugs;
}

fn formatDeepLinkJson(allocator: std.mem.Allocator, deeplink: DeepLink, output: []u8) ![]const u8 {
    switch (deeplink) {
        .none => return std.fmt.bufPrint(output, "{{\"kind\":\"none\",\"slug\":\"\"}}", .{}),
        .activate => |slug| return std.fmt.bufPrint(output, "{{\"kind\":\"activate\",\"slug\":\"{s}\"}}", .{slug}),
        .install => |*slug_list| {
            var buf: std.ArrayList(u8) = .empty;
            defer buf.deinit(allocator);
            try buf.appendSlice(allocator, "{\"kind\":\"install\",\"slug\":\"\",\"slugs\":[");
            for (slug_list.items, 0..) |slug, i| {
                if (i > 0) try buf.appendSlice(allocator, ",");
                try buf.appendSlice(allocator, "\"");
                try appendJsonEscaped(&buf, allocator, slug);
                try buf.appendSlice(allocator, "\"");
            }
            try buf.appendSlice(allocator, "]}");
            if (buf.items.len > output.len) return error.BufferTooSmall;
            @memcpy(output[0..buf.items.len], buf.items);
            return output[0..buf.items.len];
        },
    }
}

fn deepLinkToUrl(allocator: std.mem.Allocator, deeplink: DeepLink) !?[]u8 {
    switch (deeplink) {
        .none => return null,
        .activate => |slug| return try std.fmt.allocPrint(allocator, "petdex://{s}", .{slug}),
        .install => |*slug_list| {
            var buf: std.ArrayList(u8) = .empty;
            errdefer buf.deinit(allocator);
            try buf.appendSlice(allocator, "petdex://install");
            for (slug_list.items, 0..) |slug, i| {
                if (i == 0) {
                    try buf.appendSlice(allocator, "?");
                } else {
                    try buf.appendSlice(allocator, "&");
                }
                try buf.appendSlice(allocator, "slug=");
                try buf.appendSlice(allocator, slug);
            }
            const slice = try buf.toOwnedSlice(allocator);
            return slice;
        },
    }
}

fn writePendingDeepLink(io: std.Io, allocator: std.mem.Allocator, env: *const std.process.Environ.Map, deeplink: DeepLink) !void {
    const url = try deepLinkToUrl(allocator, deeplink);
    defer if (url) |u| allocator.free(u);
    const url_text = url orelse return;

    const home = env.get("HOME") orelse return;
    const runtime_dir = try std.fs.path.join(allocator, &.{ home, ".petdex-desktop", "runtime" });
    defer allocator.free(runtime_dir);
    try ensurePrivateDir(allocator, io, runtime_dir);
    const path = try std.fs.path.join(allocator, &.{ runtime_dir, "pending-deeplink.txt" });
    defer allocator.free(path);

    var file = try std.Io.Dir.createFileAbsolute(io, path, .{ .truncate = true });
    defer file.close(io);
    try file.writePositionalAll(io, url_text, 0);
}

// True only if the pet directory contains a readable sprite file.
// listPets() and the bridge picker rely on this so that an incomplete
// install (e.g. an aborted `petdex install` that left a slug folder
// without a spritesheet) is filtered out instead of becoming a
// startup-killing default. Without this guard, sorting by slug could
// pick the broken pet first; setActiveCmd would also persist it to
// active.json before loadSpritesheet failed, poisoning future
// launches until the user manually edited the file.
// True only if the pet has a spritesheet file that loadSpritesheet
// could actually read — that is, present AND within MAX_PET_BYTES.
// Just checking openFile() would let a 50 MB spritesheet.webp pass
// the listing filter, sort to the top alphabetically, and then
// crash startup with FileTooLarge at main()'s loadSpritesheet call.
// Mirroring the size cap here keeps the listing in lockstep with
// what the loader can actually consume.
fn hasSpritesheet(io: std.Io, parent: std.Io.Dir, slug: []const u8) bool {
    var pet_dir = parent.openDir(io, slug, .{}) catch return false;
    defer pet_dir.close(io);
    if (checkSpritesheetVariant(io, pet_dir, slug, "spritesheet.webp")) return true;
    if (checkSpritesheetVariant(io, pet_dir, slug, "spritesheet.png")) return true;
    return false;
}

// Helper extracted from hasSpritesheet because Zig 0.16 forbids
// `defer file.close()` inside an `inline for` body — the defer is
// runtime, the loop is comptime, and the mix produces "comptime
// control flow inside runtime block". Folding the body into a
// regular fn keeps each variant's defer scope clean.
fn checkSpritesheetVariant(
    io: std.Io,
    pet_dir: std.Io.Dir,
    slug: []const u8,
    name: []const u8,
) bool {
    var file = pet_dir.openFile(io, name, .{}) catch return false;
    defer file.close(io);
    const stat = file.stat(io) catch return false;
    if (stat.size > MAX_PET_BYTES) {
        std.debug.print(
            "Skipping pet '{s}': {s} is {d} bytes, exceeds {d} byte cap\n",
            .{ slug, name, stat.size, MAX_PET_BYTES },
        );
        return false;
    }
    return true;
}

fn listPets(allocator: std.mem.Allocator, io: std.Io, pets_dir: []const u8) !std.ArrayList(Pet) {
    var dir = try std.Io.Dir.openDirAbsolute(io, pets_dir, .{ .iterate = true });
    defer dir.close(io);
    return listPetsFromDir(allocator, io, dir, pets_dir);
}

// Iterates each root in priority order and returns the merged list.
// Slug conflicts (same slug installed in BOTH .petdex and .codex)
// resolve to the first occurrence — i.e. .petdex wins, since it
// comes first in resolvePetsRoots. This matches the CLI install
// behavior: `petdex install <slug>` writes to both roots, so they
// should hold byte-identical copies and which root we pick from
// doesn't matter when both have it. When only one root has it, we
// surface that root's pet.
fn listPetsAcrossRoots(
    allocator: std.mem.Allocator,
    io: std.Io,
    roots: []const []u8,
) !std.ArrayList(Pet) {
    var pets: std.ArrayList(Pet) = .empty;
    errdefer {
        for (pets.items) |p| {
            allocator.free(p.slug);
            allocator.free(p.display_name);
            allocator.free(p.root);
        }
        pets.deinit(allocator);
    }

    var seen_slugs: std.StringHashMap(void) = .init(allocator);
    defer seen_slugs.deinit();

    for (roots) |root_path| {
        var dir = std.Io.Dir.openDirAbsolute(io, root_path, .{ .iterate = true }) catch continue;
        defer dir.close(io);
        var iter = dir.iterate();
        while (try iter.next(io)) |entry| {
            if (entry.kind != .directory) continue;
            if (seen_slugs.contains(entry.name)) continue;
            if (!hasSpritesheet(io, dir, entry.name)) {
                std.debug.print(
                    "Skipping pet '{s}' in {s}: no spritesheet.webp or spritesheet.png\n",
                    .{ entry.name, root_path },
                );
                continue;
            }
            const slug = try allocator.dupe(u8, entry.name);
            errdefer allocator.free(slug);
            const display_name = try readDisplayName(allocator, io, dir, entry.name) orelse try allocator.dupe(u8, entry.name);
            errdefer allocator.free(display_name);
            const root_copy = try allocator.dupe(u8, root_path);
            errdefer allocator.free(root_copy);
            try pets.append(allocator, .{
                .slug = slug,
                .display_name = display_name,
                .root = root_copy,
            });
            try seen_slugs.put(slug, {});
        }
    }

    std.mem.sort(Pet, pets.items, {}, petLessThan);
    return pets;
}

// Same as listPets but takes an already-open Dir. Split out so tests
// can drive it against a tmpDir without going through realpath() to
// recover an absolute path. Production code paths through listPets
// and listPetsAcrossRoots; the picker filtering and skip-logging
// behavior live here.
fn listPetsFromDir(allocator: std.mem.Allocator, io: std.Io, dir: std.Io.Dir, root_path: []const u8) !std.ArrayList(Pet) {
    var pets: std.ArrayList(Pet) = .empty;
    errdefer {
        for (pets.items) |p| {
            allocator.free(p.slug);
            allocator.free(p.display_name);
            allocator.free(p.root);
        }
        pets.deinit(allocator);
    }

    var iter = dir.iterate();
    while (try iter.next(io)) |entry| {
        if (entry.kind != .directory) continue;
        // Skip entries without a usable sprite. Logging the skip is
        // helpful when a user wonders why their freshly-installed pet
        // doesn't show up in the picker.
        if (!hasSpritesheet(io, dir, entry.name)) {
            std.debug.print(
                "Skipping pet '{s}': no spritesheet.webp or spritesheet.png\n",
                .{entry.name},
            );
            continue;
        }
        const slug = try allocator.dupe(u8, entry.name);
        errdefer allocator.free(slug);
        const display_name = try readDisplayName(allocator, io, dir, entry.name) orelse try allocator.dupe(u8, entry.name);
        errdefer allocator.free(display_name);
        const root_copy = try allocator.dupe(u8, root_path);
        try pets.append(allocator, .{
            .slug = slug,
            .display_name = display_name,
            .root = root_copy,
        });
    }

    std.mem.sort(Pet, pets.items, {}, petLessThan);
    return pets;
}

fn petLessThan(_: void, a: Pet, b: Pet) bool {
    return std.mem.lessThan(u8, a.slug, b.slug);
}

// pet.json is typically ~200 bytes (slug + displayName + a few
// optional metadata fields), but it's user-authored and not strictly
// validated, so we leave headroom for hand-edited files with longer
// descriptions. 32 KB is generous enough that no real pet.json will
// hit it and small enough to bound a malformed file's read time.
const MAX_PET_JSON_BYTES: usize = 32 * 1024;

// display_name is optional — every caller falls back to the slug
// when this returns null. So any failure (oversized file, truncated
// read, parse error, transient I/O) MUST be downgraded to null
// rather than propagated, otherwise one bad pet.json on disk would
// fail listPetsAcrossRoots entirely and prevent the desktop from
// starting even when an unrelated pet is the active one.
fn readDisplayName(allocator: std.mem.Allocator, io: std.Io, parent: std.Io.Dir, slug: []const u8) !?[]u8 {
    const path = std.fs.path.join(allocator, &.{ slug, "pet.json" }) catch return null;
    defer allocator.free(path);
    var file = parent.openFile(io, path, .{}) catch return null;
    defer file.close(io);
    const bytes = readFileAll(io, allocator, file, MAX_PET_JSON_BYTES) catch return null;
    defer allocator.free(bytes);
    const display = jsonStringField(bytes, "displayName") orelse return null;
    return allocator.dupe(u8, display) catch null;
}

// Sprite payload returned by both loadSpritesheet and
// loadSpritesheetAcrossRoots. Named struct so Zig keeps a single
// nominal type instead of two anonymous structs that can't be
// interchanged.
const SpritePayload = struct { ext: []const u8, bytes: []u8 };

// Find the slug across all roots in priority order, return the
// first sprite that loads. Used by setActiveCmd because the slug
// the picker handed us could live in either ~/.petdex/pets or
// ~/.codex/pets and we don't carry the source root through the
// bridge invocation payload.
fn loadSpritesheetAcrossRoots(
    allocator: std.mem.Allocator,
    io: std.Io,
    roots: []const []u8,
    slug: []const u8,
) !SpritePayload {
    for (roots) |root_path| {
        if (loadSpritesheet(allocator, io, root_path, slug)) |sprite| {
            return sprite;
        } else |_| {
            // Try the next root.
        }
    }
    return error.NoSpritesheet;
}

fn loadSpritesheet(allocator: std.mem.Allocator, io: std.Io, pets_dir: []const u8, slug: []const u8) !SpritePayload {
    var dir = try std.Io.Dir.openDirAbsolute(io, pets_dir, .{});
    defer dir.close(io);
    var pet_dir = try dir.openDir(io, slug, .{});
    defer pet_dir.close(io);

    if (pet_dir.openFile(io, "spritesheet.webp", .{})) |file| {
        defer file.close(io);
        return .{ .ext = "webp", .bytes = try readFileAll(io, allocator, file, MAX_PET_BYTES) };
    } else |_| {}

    if (pet_dir.openFile(io, "spritesheet.png", .{})) |file| {
        defer file.close(io);
        return .{ .ext = "png", .bytes = try readFileAll(io, allocator, file, MAX_PET_BYTES) };
    } else |_| {}

    return error.NoSpritesheet;
}

fn copyAllSpritesheets(allocator: std.mem.Allocator, io: std.Io, asset_root: []const u8, pets: []const Pet) !void {
    var root_dir = try std.Io.Dir.openDirAbsolute(io, asset_root, .{});
    defer root_dir.close(io);

    var copied: u32 = 0;
    var skipped: u32 = 0;
    for (pets) |p| {
        const abs_sub = try std.fs.path.join(allocator, &.{ asset_root, p.slug });
        defer allocator.free(abs_sub);
        ensureDir(io, abs_sub) catch {};

        // Each pet now carries the absolute root it lives under, so
        // the freshness check + sprite read use that root directly
        // instead of assuming a single global pets_dir.
        if (isSpritesheetFresh(allocator, io, p.root, abs_sub, p.slug)) {
            skipped += 1;
            continue;
        }

        const sprite = loadSpritesheet(allocator, io, p.root, p.slug) catch continue;
        defer allocator.free(sprite.bytes);

        var sub_dir = std.Io.Dir.openDirAbsolute(io, abs_sub, .{}) catch continue;
        defer sub_dir.close(io);
        const sprite_name = if (std.mem.eql(u8, sprite.ext, "png")) "spritesheet.png" else "spritesheet.webp";
        writeFileAll(io, sub_dir, sprite_name, sprite.bytes) catch {};
        if (!std.mem.eql(u8, sprite.ext, "webp")) {
            writeFileAll(io, sub_dir, "spritesheet.webp", sprite.bytes) catch {};
        }
        copied += 1;
    }
    std.debug.print("Spritesheets: {d} copied, {d} cached\n", .{ copied, skipped });
}

fn isSpritesheetFresh(allocator: std.mem.Allocator, io: std.Io, pets_dir: []const u8, cached_dir: []const u8, slug: []const u8) bool {
    const cached_path = std.fs.path.join(allocator, &.{ cached_dir, "spritesheet.webp" }) catch return false;
    defer allocator.free(cached_path);
    var cached_file = std.Io.Dir.openFileAbsolute(io, cached_path, .{}) catch return false;
    defer cached_file.close(io);
    const cached_stat = cached_file.stat(io) catch return false;

    const source_dir = std.fs.path.join(allocator, &.{ pets_dir, slug }) catch return false;
    defer allocator.free(source_dir);
    inline for (.{ "spritesheet.webp", "spritesheet.png" }) |name| {
        const source_path = std.fs.path.join(allocator, &.{ source_dir, name }) catch return false;
        defer allocator.free(source_path);
        if (std.Io.Dir.openFileAbsolute(io, source_path, .{})) |source_file| {
            defer source_file.close(io);
            const source_stat = source_file.stat(io) catch return false;
            return cached_stat.mtime.nanoseconds >= source_stat.mtime.nanoseconds;
        } else |_| {}
    }
    return false;
}

fn buildPetdexJson(allocator: std.mem.Allocator, pets: []const Pet, active_slug: []const u8) ![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(allocator);
    try buf.appendSlice(allocator, "{\"pets\":[");
    for (pets, 0..) |p, i| {
        if (i > 0) try buf.appendSlice(allocator, ",");
        try buf.appendSlice(allocator, "{\"slug\":\"");
        try appendJsonEscaped(&buf, allocator, p.slug);
        try buf.appendSlice(allocator, "\",\"displayName\":\"");
        try appendJsonEscaped(&buf, allocator, p.display_name);
        try buf.appendSlice(allocator, "\"}");
    }
    try buf.appendSlice(allocator, "],\"active\":\"");
    try appendJsonEscaped(&buf, allocator, active_slug);
    const dims = try std.fmt.allocPrint(allocator, "\",\"compactWidth\":{d},\"compactHeight\":{d},\"menuWidth\":{d},\"menuHeight\":{d}}}", .{
        @as(u32, @intFromFloat(WINDOW_W)),
        @as(u32, @intFromFloat(WINDOW_H)),
        MENU_W,
        MENU_H,
    });
    defer allocator.free(dims);
    try buf.appendSlice(allocator, dims);
    return buf.toOwnedSlice(allocator);
}

fn appendJsonEscaped(buf: *std.ArrayList(u8), allocator: std.mem.Allocator, s: []const u8) !void {
    // JSON-escape plus HTML/script-context defenses:
    //   - `<` becomes `<` so `</script>` inside a string can never close
    //     the surrounding <script type="application/json"> tag.
    //   - `>` becomes `>` for symmetry against `]]>`-style breakouts.
    //   - U+2028 (LS) and U+2029 (PS) become / because some
    //     JS parsers historically treated them as line terminators in
    //     string literals.
    // Pet display names come from user-installed pet.json files so we
    // treat them as untrusted.
    var i: usize = 0;
    while (i < s.len) : (i += 1) {
        const c = s[i];
        switch (c) {
            '"' => try buf.appendSlice(allocator, "\\\""),
            '\\' => try buf.appendSlice(allocator, "\\\\"),
            '\n' => try buf.appendSlice(allocator, "\\n"),
            '\r' => try buf.appendSlice(allocator, "\\r"),
            '\t' => try buf.appendSlice(allocator, "\\t"),
            '<' => try buf.appendSlice(allocator, "\\u003c"),
            '>' => try buf.appendSlice(allocator, "\\u003e"),
            // U+2028 in UTF-8 is 0xE2 0x80 0xA8; U+2029 is 0xE2 0x80 0xA9.
            0xE2 => {
                if (i + 2 < s.len and s[i + 1] == 0x80 and (s[i + 2] == 0xA8 or s[i + 2] == 0xA9)) {
                    if (s[i + 2] == 0xA8) {
                        try buf.appendSlice(allocator, "\\u2028");
                    } else {
                        try buf.appendSlice(allocator, "\\u2029");
                    }
                    i += 2;
                } else {
                    try buf.append(allocator, c);
                }
            },
            else => try buf.append(allocator, c),
        }
    }
}

fn buildHtml(allocator: std.mem.Allocator, petdex_json: []const u8) ![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(allocator);
    try buf.appendSlice(allocator, html_head);
    try buf.appendSlice(allocator, petdex_json);
    try buf.appendSlice(allocator, html_tail);
    return buf.toOwnedSlice(allocator);
}

fn prepareAssetRoot(
    allocator: std.mem.Allocator,
    io: std.Io,
    config_dir: []const u8,
    html: []const u8,
    sprite_ext: []const u8,
    sprite_bytes: []const u8,
) ![]u8 {
    // Anchor WebView assets under ~/.petdex/runtime/webview, not
    // $TMPDIR/petdex-desktop. The TMPDIR path was shared (predictable
    // name, world-writable parent on most setups) and let another
    // local user pre-create it with symlinks like
    // index.html -> /victim/important.txt; the truncate=true write
    // here would then nuke whatever the symlink pointed to. HOME is
    // per-user, and runtime/ is created with mode 0700 so the assets
    // can't be read or replaced by anyone else either.
    const runtime = try std.fs.path.join(allocator, &.{ config_dir, "runtime" });
    defer allocator.free(runtime);
    try ensurePrivateDir(allocator, io, runtime);

    const root = try std.fs.path.join(allocator, &.{ config_dir, "runtime", "webview" });
    errdefer allocator.free(root);
    try ensurePrivateDir(allocator, io, root);

    var root_dir = try std.Io.Dir.openDirAbsolute(io, root, .{});
    defer root_dir.close(io);

    try writeFileAll(io, root_dir, "index.html", html);
    const sprite_name = if (std.mem.eql(u8, sprite_ext, "png")) "spritesheet.png" else "spritesheet.webp";
    try writeFileAll(io, root_dir, sprite_name, sprite_bytes);
    if (!std.mem.eql(u8, sprite_ext, "webp")) {
        try writeFileAll(io, root_dir, "spritesheet.webp", sprite_bytes);
    }

    const agents_dir_path = try std.fs.path.join(allocator, &.{ root, "agents" });
    defer allocator.free(agents_dir_path);
    try ensurePrivateDir(allocator, io, agents_dir_path);
    var agents_dir = try std.Io.Dir.openDirAbsolute(io, agents_dir_path, .{});
    defer agents_dir.close(io);
    for (agent_assets) |asset| {
        try writeFileAll(io, agents_dir, asset.name, asset.bytes);
    }

    return root;
}

const PetDesktopApp = struct {
    asset_root: []const u8,

    fn app(self: *@This()) zero_native.App {
        return .{
            .context = self,
            .name = "petdex-desktop",
            .source = zero_native.WebViewSource.assets(.{
                .root_path = self.asset_root,
                .entry = "index.html",
                .origin = "zero://app",
                .spa_fallback = false,
            }),
        };
    }
};

pub fn main(init: std.process.Init) !void {
    var gpa: std.heap.DebugAllocator(.{}) = .init;
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const config_dir = try resolveConfigDir(allocator, init.io, init.environ_map);
    defer allocator.free(config_dir);

    const pets_roots = resolvePetsRoots(allocator, init.io, init.environ_map) catch |err| {
        std.debug.print("No pets found. Install one with `npx petdex install <slug>`.\n", .{});
        return err;
    };
    defer {
        for (pets_roots) |r| allocator.free(r);
        allocator.free(pets_roots);
    }
    if (pets_roots.len == 0) {
        std.debug.print("No pets root exists. Install one with `npx petdex install <slug>`.\n", .{});
        return error.NoPetsDirectory;
    }

    var pets = try listPetsAcrossRoots(allocator, init.io, pets_roots);
    defer {
        for (pets.items) |p| {
            allocator.free(p.slug);
            allocator.free(p.display_name);
            allocator.free(p.root);
        }
        pets.deinit(allocator);
    }
    if (pets.items.len == 0) {
        std.debug.print("No pets in any root. Install one with `npx petdex install <slug>`.\n", .{});
        return error.NoPets;
    }

    const stored_active = try readActiveSlug(allocator, init.io, config_dir);
    defer if (stored_active) |s| allocator.free(s);

    // Custom URL scheme: `open petdex://<slug>` launches the app via
    // an AppleEvent (kAEGetURL). zero-native's appkit_host writes the
    // URL to ~/.petdex-desktop/runtime/incoming-url.txt before the
    // run loop pumps. We read it here + also check argv as a fallback
    // for direct binary invocations (`./petdex-desktop petdex://kebo`).
    const startup_deeplink = blk: {
        const from_file = readDeepLinkFromUrlFile(allocator, init.io, init.environ_map) catch DeepLink{ .none = {} };
        if (from_file != .none) break :blk from_file;
        break :blk readDeepLinkFromUrlArg(allocator, init.minimal.args) catch DeepLink{ .none = {} };
    };
    defer freeDeepLink(allocator, startup_deeplink);
    switch (startup_deeplink) {
        .activate => |slug| {
            var found = false;
            for (pets.items) |p| {
                if (std.mem.eql(u8, p.slug, slug)) {
                    found = true;
                    break;
                }
            }
            if (found) {
                try writeActiveSlug(init.io, config_dir, slug);
                std.debug.print("Activated pet from URL: {s}\n", .{slug});
            } else {
                try writePendingDeepLink(init.io, allocator, init.environ_map, startup_deeplink);
                std.debug.print("Queued activate/install for URL slug: {s}\n", .{slug});
            }
        },
        .install => {
            try writePendingDeepLink(init.io, allocator, init.environ_map, startup_deeplink);
            std.debug.print("Queued batch install from URL\n", .{});
        },
        .none => {},
    }

    // Re-read active slug — may have just been overwritten by the URL.
    const final_stored = try readActiveSlug(allocator, init.io, config_dir);
    defer if (final_stored) |s| allocator.free(s);

    const active_slug = blk: {
        if (final_stored) |s| {
            for (pets.items) |p| {
                if (std.mem.eql(u8, p.slug, s)) break :blk s;
            }
        }
        if (stored_active) |s| {
            for (pets.items) |p| {
                if (std.mem.eql(u8, p.slug, s)) break :blk s;
            }
        }
        break :blk pets.items[0].slug;
    };

    // Find the root that owns the active slug — could be either
    // .petdex/pets or .codex/pets.
    const active_root = blk: {
        for (pets.items) |p| {
            if (std.mem.eql(u8, p.slug, active_slug)) break :blk p.root;
        }
        // Should be unreachable: active_slug was selected from pets.items.
        break :blk pets.items[0].root;
    };

    std.debug.print("Loading pet: {s} ({d} installed)\n", .{ active_slug, pets.items.len });

    const sprite = try loadSpritesheet(allocator, init.io, active_root, active_slug);
    defer allocator.free(sprite.bytes);

    const petdex_json = try buildPetdexJson(allocator, pets.items, active_slug);
    defer allocator.free(petdex_json);

    const html_doc = try buildHtml(allocator, petdex_json);
    defer allocator.free(html_doc);

    const asset_root = try prepareAssetRoot(allocator, init.io, config_dir, html_doc, sprite.ext, sprite.bytes);
    defer allocator.free(asset_root);

    try copyAllSpritesheets(allocator, init.io, asset_root, pets.items);

    // Spawn the HTTP sidecar so external CLIs (Claude Code, Codex, Gemini, OpenCode,
    // shell scripts) can drive the mascot via POST /state. The CLI installs
    // server.js to ~/.petdex/sidecar/server.js alongside the binary.
    const sidecar_dir = try resolveSidecarDir(allocator, init.environ_map);
    defer allocator.free(sidecar_dir);
    try spawnSidecar(allocator, init.io, sidecar_dir, init.environ_map);

    // Duplicate pets_roots into a state-owned slice so PetdexState's
    // deinit can free it independently of the local lifetime of
    // pets_roots above. Each entry is also dup'd so we don't share
    // pointers.
    var roots_for_state = try allocator.alloc([]u8, pets_roots.len);
    {
        var i: usize = 0;
        errdefer {
            for (roots_for_state[0..i]) |r| allocator.free(r);
            allocator.free(roots_for_state);
        }
        while (i < pets_roots.len) : (i += 1) {
            roots_for_state[i] = try allocator.dupe(u8, pets_roots[i]);
        }
    }

    var state = PetdexState{
        .allocator = allocator,
        .io = init.io,
        .config_dir = try allocator.dupe(u8, config_dir),
        .pets_roots = roots_for_state,
        .asset_root = try allocator.dupe(u8, asset_root),
        .sidecar_dir = try allocator.dupe(u8, sidecar_dir),
        .env_map = init.environ_map,
    };
    defer state.deinit();

    var app = PetDesktopApp{ .asset_root = asset_root };

    const main_window: zero_native.WindowOptions = .{
        .label = "pet",
        .title = "Petdex",
        .default_frame = zero_native.geometry.RectF.init(0, 0, WINDOW_W, WINDOW_H),
        .resizable = false,
        .restore_state = true,
        .frameless = true,
        .transparent = true,
        .always_on_top = true,
    };

    const security_policy: zero_native.SecurityPolicy = .{
        .navigation = .{ .allowed_origins = &.{ "zero://app", "zero://inline" } },
        .permissions = &.{"window"},
    };

    try runner.runWithOptions(app.app(), .{
        .app_name = "Petdex",
        .window_title = "Petdex",
        .bundle_id = "run.crafter.petdex-desktop",
        .icon_path = "assets/icon.icns",
        .main_window = main_window,
        .security = security_policy,
        .js_window_api = true,
        .bridge = state.bridge(),
    }, init);
}

// ---- tests ----------------------------------------------------------
//
// These pin the opencode-bot review fixes:
//   - listPets must skip pet directories that don't have a sprite,
//     so a half-installed pet can't become the sorted default and
//     crash startup.
//   - hasSpritesheet must answer false for empty dirs and true for
//     either supported extension.
//   - ensurePrivateDir must create the directory with mode 0700 and
//     tighten an existing wider-mode dir back to 0700.
//
// We use std.testing.tmpDir for a per-test isolated workspace and the
// global std.testing.io runtime.

const testing = std.testing;
const testing_io = std.testing.io;

fn writeTestFile(dir: std.Io.Dir, name: []const u8, contents: []const u8) !void {
    var f = try dir.createFile(testing_io, name, .{ .truncate = true });
    defer f.close(testing_io);
    try f.writePositionalAll(testing_io, contents, 0);
}

test "hasSpritesheet: false when pet dir has neither png nor webp" {
    var tmp = testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    try tmp.dir.createDirPath(testing_io, "broken");
    try testing.expect(!hasSpritesheet(testing_io, tmp.dir, "broken"));
}

test "hasSpritesheet: true when only spritesheet.webp exists" {
    var tmp = testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    try tmp.dir.createDirPath(testing_io, "good");
    var sub = try tmp.dir.openDir(testing_io, "good", .{});
    defer sub.close(testing_io);
    try writeTestFile(sub, "spritesheet.webp", "PRETEND-WEBP");

    try testing.expect(hasSpritesheet(testing_io, tmp.dir, "good"));
}

test "hasSpritesheet: true when only spritesheet.png exists" {
    var tmp = testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    try tmp.dir.createDirPath(testing_io, "png-only");
    var sub = try tmp.dir.openDir(testing_io, "png-only", .{});
    defer sub.close(testing_io);
    try writeTestFile(sub, "spritesheet.png", "PRETEND-PNG");

    try testing.expect(hasSpritesheet(testing_io, tmp.dir, "png-only"));
}

test "hasSpritesheet: rejects spritesheets that exceed MAX_PET_BYTES" {
    // Without this guard, a pet with a 50 MB spritesheet would pass
    // the listing filter (the file opens fine), sort to the top of
    // pets.items alphabetically, and crash startup with FileTooLarge
    // when loadSpritesheet ran. Now the listing filter mirrors the
    // loader's size cap so the bad pet never becomes the default.
    //
    // We don't want to actually allocate 16 MB+ of test bytes, so
    // we use a temporary lower cap by writing just over MAX_PET_BYTES
    // is not feasible — instead, this test verifies the IS-rejected
    // path by reading the file we wrote at a stat-able size near
    // the boundary. The real production path uses the same stat.size
    // comparison, so any test that exercises the comparison branch
    // is enough.
    //
    // We write 16 MB + 1 byte. That's 16 MiB of zeroes — manageable
    // on dev/CI disks and inside the test allocator's lifetime.
    var tmp = testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    try tmp.dir.createDirPath(testing_io, "huge-sprite");
    var sub = try tmp.dir.openDir(testing_io, "huge-sprite", .{});
    defer sub.close(testing_io);

    const oversize = MAX_PET_BYTES + 1;
    const big = try testing.allocator.alloc(u8, oversize);
    defer testing.allocator.free(big);
    @memset(big, 0);
    try writeTestFile(sub, "spritesheet.webp", big);

    // The big file exists and opens fine, but stat.size > MAX_PET_BYTES.
    // Old hasSpritesheet would have returned true; new one returns false.
    try testing.expect(!hasSpritesheet(testing_io, tmp.dir, "huge-sprite"));
}

test "listPetsFromDir: oversized spritesheet pets are excluded from the listing" {
    // End-to-end version of the above: an oversized pet must NOT
    // appear in pets.items, because if it did it could become the
    // sorted default and main() would crash before any other pet
    // got a chance to render.
    var tmp = testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    // Pet a: oversized — must be skipped.
    try tmp.dir.createDirPath(testing_io, "aa-bloated");
    var bloated = try tmp.dir.openDir(testing_io, "aa-bloated", .{});
    defer bloated.close(testing_io);
    const bloated_bytes = try testing.allocator.alloc(u8, MAX_PET_BYTES + 1);
    defer testing.allocator.free(bloated_bytes);
    @memset(bloated_bytes, 0);
    try writeTestFile(bloated, "spritesheet.webp", bloated_bytes);

    // Pet b: small and valid — must be the only one returned.
    try tmp.dir.createDirPath(testing_io, "bb-good");
    var good = try tmp.dir.openDir(testing_io, "bb-good", .{});
    defer good.close(testing_io);
    try writeTestFile(good, "spritesheet.webp", "WEBP");

    var pets = try listPetsFromDir(testing.allocator, testing_io, tmp.dir, "/test-root");
    defer {
        for (pets.items) |p| {
            testing.allocator.free(p.slug);
            testing.allocator.free(p.display_name);
            testing.allocator.free(p.root);
        }
        pets.deinit(testing.allocator);
    }

    try testing.expectEqual(@as(usize, 1), pets.items.len);
    try testing.expectEqualStrings("bb-good", pets.items[0].slug);
}

test "listPetsFromDir: filters out pet dirs without a spritesheet" {
    var tmp = testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    // Pet a is broken (no sprite) — must NOT appear in the result.
    try tmp.dir.createDirPath(testing_io, "aa-broken");

    // Pet b has a webp — must appear.
    try tmp.dir.createDirPath(testing_io, "bb-good");
    {
        var sub = try tmp.dir.openDir(testing_io, "bb-good", .{});
        defer sub.close(testing_io);
        try writeTestFile(sub, "spritesheet.webp", "WEBP");
    }

    // Pet c has a png — must appear.
    try tmp.dir.createDirPath(testing_io, "cc-png");
    {
        var sub = try tmp.dir.openDir(testing_io, "cc-png", .{});
        defer sub.close(testing_io);
        try writeTestFile(sub, "spritesheet.png", "PNG");
    }

    var pets = try listPetsFromDir(testing.allocator, testing_io, tmp.dir, "/test-root");
    defer {
        for (pets.items) |p| {
            testing.allocator.free(p.slug);
            testing.allocator.free(p.display_name);
            testing.allocator.free(p.root);
        }
        pets.deinit(testing.allocator);
    }

    try testing.expectEqual(@as(usize, 2), pets.items.len);
    // Sort is alphabetical, so bb-good < cc-png. The aa-broken entry
    // — which would have sorted FIRST and become the startup-killing
    // default in the unfiltered version — must not appear at all.
    try testing.expectEqualStrings("bb-good", pets.items[0].slug);
    try testing.expectEqualStrings("cc-png", pets.items[1].slug);
}

test "listPetsFromDir: returns empty list when every pet dir is broken" {
    var tmp = testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    try tmp.dir.createDirPath(testing_io, "broken-a");
    try tmp.dir.createDirPath(testing_io, "broken-b");

    var pets = try listPetsFromDir(testing.allocator, testing_io, tmp.dir, "/test-root");
    defer {
        for (pets.items) |p| {
            testing.allocator.free(p.slug);
            testing.allocator.free(p.display_name);
            testing.allocator.free(p.root);
        }
        pets.deinit(testing.allocator);
    }

    try testing.expectEqual(@as(usize, 0), pets.items.len);
}

test "listPetsFromDir: prefers pet.json display_name over slug" {
    var tmp = testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    try tmp.dir.createDirPath(testing_io, "fox");
    var sub = try tmp.dir.openDir(testing_io, "fox", .{});
    defer sub.close(testing_io);
    try writeTestFile(sub, "spritesheet.webp", "WEBP");
    try writeTestFile(sub, "pet.json", "{\"displayName\":\"Foxy\"}");

    var pets = try listPetsFromDir(testing.allocator, testing_io, tmp.dir, "/test-root");
    defer {
        for (pets.items) |p| {
            testing.allocator.free(p.slug);
            testing.allocator.free(p.display_name);
            testing.allocator.free(p.root);
        }
        pets.deinit(testing.allocator);
    }

    try testing.expectEqual(@as(usize, 1), pets.items.len);
    try testing.expectEqualStrings("fox", pets.items[0].slug);
    try testing.expectEqualStrings("Foxy", pets.items[0].display_name);
}

test "listPetsFromDir: assigns the supplied root to every pet" {
    var tmp = testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    try tmp.dir.createDirPath(testing_io, "alpha");
    var alpha = try tmp.dir.openDir(testing_io, "alpha", .{});
    defer alpha.close(testing_io);
    try writeTestFile(alpha, "spritesheet.webp", "WEBP");

    try tmp.dir.createDirPath(testing_io, "bravo");
    var bravo = try tmp.dir.openDir(testing_io, "bravo", .{});
    defer bravo.close(testing_io);
    try writeTestFile(bravo, "spritesheet.png", "PNG");

    const sentinel_root = "/this/specific/path";
    var pets = try listPetsFromDir(testing.allocator, testing_io, tmp.dir, sentinel_root);
    defer {
        for (pets.items) |p| {
            testing.allocator.free(p.slug);
            testing.allocator.free(p.display_name);
            testing.allocator.free(p.root);
        }
        pets.deinit(testing.allocator);
    }

    // Pets must remember which root they came from. setActiveCmd
    // and copyAllSpritesheets both rely on this to load sprites
    // from the correct root when ~/.petdex/pets and ~/.codex/pets
    // both exist.
    try testing.expectEqual(@as(usize, 2), pets.items.len);
    try testing.expectEqualStrings(sentinel_root, pets.items[0].root);
    try testing.expectEqualStrings(sentinel_root, pets.items[1].root);
}

test "listPetsFromDir: malformed pet.json falls back to slug, doesn't fail the listing" {
    // A user with two installed pets where one has a bad pet.json
    // (truncated, oversized, junk bytes) used to crash the whole
    // listing — readDisplayName propagated FileTooLarge / parse
    // errors through `try`. Now any failure inside readDisplayName
    // degrades to "no displayName" and the slug is used instead.
    var tmp = testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    // Pet a: completely valid.
    try tmp.dir.createDirPath(testing_io, "fox");
    var fox = try tmp.dir.openDir(testing_io, "fox", .{});
    defer fox.close(testing_io);
    try writeTestFile(fox, "spritesheet.webp", "WEBP");
    try writeTestFile(fox, "pet.json", "{\"displayName\":\"Fox\"}");

    // Pet b: junk bytes where pet.json should be (binary, no JSON).
    // jsonStringField won't find "displayName" and we expect a slug
    // fallback, NOT a failure that takes the whole listing down.
    try tmp.dir.createDirPath(testing_io, "broken-meta");
    var bm = try tmp.dir.openDir(testing_io, "broken-meta", .{});
    defer bm.close(testing_io);
    try writeTestFile(bm, "spritesheet.webp", "WEBP");
    try writeTestFile(bm, "pet.json", "\x00\x01\x02not json at all");

    var pets = try listPetsFromDir(testing.allocator, testing_io, tmp.dir, "/test-root");
    defer {
        for (pets.items) |p| {
            testing.allocator.free(p.slug);
            testing.allocator.free(p.display_name);
            testing.allocator.free(p.root);
        }
        pets.deinit(testing.allocator);
    }

    try testing.expectEqual(@as(usize, 2), pets.items.len);
    // Sort is alphabetical: broken-meta < fox.
    try testing.expectEqualStrings("broken-meta", pets.items[0].slug);
    try testing.expectEqualStrings("broken-meta", pets.items[0].display_name);
    try testing.expectEqualStrings("fox", pets.items[1].slug);
    try testing.expectEqualStrings("Fox", pets.items[1].display_name);
}

test "listPetsFromDir: oversized pet.json falls back to slug, doesn't fail the listing" {
    // Stress the size cap path: a pet.json larger than MAX_PET_JSON_BYTES
    // returns null from readDisplayName instead of bubbling
    // FileTooLarge through every caller. The user should still see
    // the pet (with its slug as the label) rather than have the
    // whole desktop refuse to start.
    var tmp = testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();

    try tmp.dir.createDirPath(testing_io, "huge");
    var huge = try tmp.dir.openDir(testing_io, "huge", .{});
    defer huge.close(testing_io);
    try writeTestFile(huge, "spritesheet.webp", "WEBP");

    // 64 KB > 32 KB cap. Build it as a giant string of garbage so we
    // don't have to allocate a real Vec.
    const oversized = try testing.allocator.alloc(u8, 64 * 1024);
    defer testing.allocator.free(oversized);
    @memset(oversized, 'X');
    try writeTestFile(huge, "pet.json", oversized);

    var pets = try listPetsFromDir(testing.allocator, testing_io, tmp.dir, "/test-root");
    defer {
        for (pets.items) |p| {
            testing.allocator.free(p.slug);
            testing.allocator.free(p.display_name);
            testing.allocator.free(p.root);
        }
        pets.deinit(testing.allocator);
    }

    try testing.expectEqual(@as(usize, 1), pets.items.len);
    try testing.expectEqualStrings("huge", pets.items[0].slug);
    // Display name fell back to slug because pet.json was too big.
    try testing.expectEqualStrings("huge", pets.items[0].display_name);
}

test "parseDeepLinkFromUrl: single activate slug" {
    const a = std.testing.allocator;
    const dl = try parseDeepLinkFromUrl(a, "petdex://boba");
    defer freeDeepLink(a, dl);
    try std.testing.expect(dl == .activate);
    try std.testing.expectEqualStrings("boba", dl.activate);
}

test "parseDeepLinkFromUrl: batch install via repeated slug params" {
    const a = std.testing.allocator;
    const dl = try parseDeepLinkFromUrl(a, "petdex://install?slug=boba&slug=doraemon");
    defer freeDeepLink(a, dl);
    try std.testing.expect(dl == .install);
    try std.testing.expectEqual(@as(usize, 2), dl.install.items.len);
    try std.testing.expectEqualStrings("boba", dl.install.items[0]);
    try std.testing.expectEqualStrings("doraemon", dl.install.items[1]);
}

test "parseDeepLinkFromUrl: batch install via slugs csv" {
    const a = std.testing.allocator;
    const dl = try parseDeepLinkFromUrl(a, "petdex://install?slugs=mochi,kebo");
    defer freeDeepLink(a, dl);
    try std.testing.expect(dl == .install);
    try std.testing.expectEqual(@as(usize, 2), dl.install.items.len);
}

test "parseDeepLinkFromUrl: batch install via percent-encoded slugs csv" {
    const a = std.testing.allocator;
    const dl = try parseDeepLinkFromUrl(a, "petdex://install?slugs=mochi%2Ckebo");
    defer freeDeepLink(a, dl);
    try std.testing.expect(dl == .install);
    try std.testing.expectEqual(@as(usize, 2), dl.install.items.len);
    try std.testing.expectEqualStrings("mochi", dl.install.items[0]);
    try std.testing.expectEqualStrings("kebo", dl.install.items[1]);
}

test "parseDeepLinkFromUrl: rejects path with slash" {
    const a = std.testing.allocator;
    const dl = try parseDeepLinkFromUrl(a, "petdex://foo/bar");
    defer freeDeepLink(a, dl);
    try std.testing.expect(dl == .none);
}

test "parseDeepLinkFromUrl: caps batch install at MAX_INSTALL_SLUGS" {
    const a = std.testing.allocator;
    var url: std.ArrayList(u8) = .empty;
    defer url.deinit(a);
    try url.appendSlice(a, "petdex://install?");
    var param_buf: [32]u8 = undefined;
    for (0..30) |i| {
        if (i > 0) try url.appendSlice(a, "&");
        const param = try std.fmt.bufPrint(&param_buf, "slug=p{d}", .{i});
        try url.appendSlice(a, param);
    }
    const dl = try parseDeepLinkFromUrl(a, url.items);
    defer freeDeepLink(a, dl);
    try std.testing.expect(dl == .install);
    try std.testing.expectEqual(MAX_INSTALL_SLUGS, dl.install.items.len);
    try std.testing.expectEqualStrings("p0", dl.install.items[0]);
    try std.testing.expectEqualStrings("p23", dl.install.items[MAX_INSTALL_SLUGS - 1]);
}
