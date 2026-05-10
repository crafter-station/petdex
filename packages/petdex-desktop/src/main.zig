const std = @import("std");

extern fn getpid() c_int;
const runner = @import("runner");
const zero_native = @import("zero-native");

pub const panic = std.debug.FullPanic(zero_native.debug.capturePanic);

const WINDOW_W: f32 = 140;
const WINDOW_H: f32 = 160;
const MENU_W: u32 = 480;
const MENU_H: u32 = 420;
const MAX_PET_BYTES: usize = 16 * 1024 * 1024;
const MAX_ACTIVE_BYTES: usize = 4 * 1024;

const html_head =
    \\<!doctype html>
    \\<html>
    \\<head>
    \\<meta charset="utf-8">
    \\<style>
    \\  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; width: 100%; height: 100%; font-family: -apple-system, system-ui, sans-serif; }
    \\  body { -webkit-user-select: none; user-select: none; pointer-events: none; }
    \\  .stage { position: fixed; top: 8px; left: 8px; pointer-events: none; }
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
    \\  // Layer 1 autoupdate: read update.json (written by the sidecar's
    \\  // periodic GH releases poll) and render a notification card. A
    \\  // single click POSTs to the sidecar's /update endpoint, which
    \\  // spawns `npx petdex update --silent`. We keep this DOM lightweight
    \\  // — a fixed-position card, no animations.
    \\  let lastUpdateStatus = '';
    \\  let updateCard = null;
    \\  function ensureUpdateCard() {
    \\    if (updateCard) return updateCard;
    \\    updateCard = document.createElement('div');
    \\    updateCard.id = 'update-card';
    \\    updateCard.style.cssText = 'position:fixed;left:6px;right:6px;bottom:6px;padding:8px 10px;border-radius:10px;background:rgba(15,18,30,0.92);color:#e8eaf3;font:600 11px system-ui,-apple-system,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.35);backdrop-filter:blur(8px);display:none;cursor:pointer;line-height:1.3;';
    \\    updateCard.addEventListener('click', async () => {
    \\      if (!(window.zero && window.zero.invoke)) return;
    \\      try {
    \\        await window.zero.invoke('petdex.trigger_update', {});
    \\        renderUpdate({ status: 'running', message: 'Updating...' });
    \\      } catch (e) {}
    \\    });
    \\    document.body.appendChild(updateCard);
    \\    return updateCard;
    \\  }
    \\  function renderUpdate(info) {
    \\    const card = ensureUpdateCard();
    \\    if (info.status === 'idle' || (!info.available && info.status !== 'error' && info.status !== 'done')) {
    \\      card.style.display = 'none';
    \\      return;
    \\    }
    \\    let text = '';
    \\    if (info.status === 'available') {
    \\      text = 'Update ' + (info.latest || 'available') + ' — click to install';
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
    \\  function closeMenu() {
    \\    if (menuEl) { menuEl.remove(); menuEl = null; }
    \\    const data = window.__PETDEX__ || {};
    \\    if (data.compactWidth && data.compactHeight) resizeWindowTo(data.compactWidth, data.compactHeight);
    \\  }
    \\  async function selectPet(slug) {
    \\    const data = window.__PETDEX__ || {};
    \\    if (slug === data.active) { closeMenu(); return; }
    \\    closeMenu();
    \\    try {
    \\      await window.zero.invoke('petdex.set_active', { slug });
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
    \\  function openMenu() {
    \\    if (menuEl) { menuEl.remove(); menuEl = null; }
    \\    if (virtualGrid) { virtualGrid.dispose(); virtualGrid = null; }
    \\    const data = window.__PETDEX__ || { pets: [], active: null };
    \\    // Snapshot pet position BEFORE resize triggers any layout shift.
    \\    const petRect = pet.getBoundingClientRect();
    \\    if (data.menuWidth && data.menuHeight) {
    \\      resizeWindowTo(data.menuWidth, data.menuHeight);
    \\    }
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
    \\  pet.addEventListener('contextmenu', (e) => {
    \\    e.preventDefault();
    \\    e.stopImmediatePropagation();
    \\    openMenu();
    \\  });
    \\  // Prevent the system's default contextmenu anywhere (selection helpers, etc.)
    \\  document.addEventListener('contextmenu', (e) => e.preventDefault());
    \\  window.addEventListener('blur', closeMenu);
    \\  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
    \\  document.addEventListener('click', (e) => {
    \\    if (menuEl && !menuEl.contains(e.target) && e.target !== pet) closeMenu();
    \\  }, true);
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
    const path = env_map.get("PATH") orelse return error.NoPath;
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
    bridge_handlers: [6]zero_native.BridgeHandler = undefined,

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
            .{ .name = "petdex.read_update_info", .context = self, .invoke_fn = readUpdateInfoCmd },
            .{ .name = "petdex.trigger_update", .context = self, .invoke_fn = triggerUpdateCmd },
            .{ .name = "petdex.respawn_sidecar", .context = self, .invoke_fn = respawnSidecarCmd },
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
        // detached. curl ships with macOS and most Linux distros, so this
        // beats pulling in a Zig HTTP client for one fire-and-forget POST.
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
        _ = std.process.spawn(self.io, .{
            .argv = argv,
            .stdin = .ignore,
            .stdout = .ignore,
            .stderr = .ignore,
        }) catch |err| {
            return std.fmt.bufPrint(output, "{{\"ok\":false,\"error\":\"{s}\"}}", .{@errorName(err)});
        };
        return std.fmt.bufPrint(output, "{{\"ok\":true}}", .{});
    }
};

const petdex_origins = [_][]const u8{ "zero://app", "zero://inline" };
const petdex_command_policies = [_]zero_native.BridgeCommandPolicy{
    .{ .name = "petdex.set_active", .origins = &petdex_origins },
    .{ .name = "petdex.quit", .origins = &petdex_origins },
    .{ .name = "petdex.read_runtime_state", .origins = &petdex_origins },
    .{ .name = "petdex.read_update_info", .origins = &petdex_origins },
    .{ .name = "petdex.trigger_update", .origins = &petdex_origins },
    .{ .name = "petdex.respawn_sidecar", .origins = &petdex_origins },
};

fn jsonStringField(payload: []const u8, key: []const u8) ?[]const u8 {
    var key_buf: [64]u8 = undefined;
    const needle = std.fmt.bufPrint(&key_buf, "\"{s}\":\"", .{key}) catch return null;
    const start = std.mem.indexOf(u8, payload, needle) orelse return null;
    const value_start = start + needle.len;
    const end = std.mem.indexOfScalarPos(u8, payload, value_start, '"') orelse return null;
    return payload[value_start..end];
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
    const home = env_map.get("HOME") orelse return error.NoHome;
    return try std.fs.path.join(allocator, &.{ home, ".petdex", "sidecar" });
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
    //   - U+2028 (LS) and U+2029 (PS) become  /  because some
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

    const active_slug = blk: {
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
        .focusable = false,
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
