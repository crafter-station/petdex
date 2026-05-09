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
    \\<script>
    \\window.__PETDEX__ =
;

const html_tail =
    \\;
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
    pets_dir: []u8,
    asset_root: []u8,
    bridge_handlers: [3]zero_native.BridgeHandler = undefined,

    fn deinit(self: *PetdexState) void {
        self.allocator.free(self.config_dir);
        self.allocator.free(self.pets_dir);
        self.allocator.free(self.asset_root);
    }

    fn bridge(self: *PetdexState) zero_native.BridgeDispatcher {
        self.bridge_handlers = .{
            .{ .name = "petdex.set_active", .context = self, .invoke_fn = setActiveCmd },
            .{ .name = "petdex.quit", .context = self, .invoke_fn = quitCmd },
            .{ .name = "petdex.read_runtime_state", .context = self, .invoke_fn = readRuntimeStateCmd },
        };
        return .{
            .policy = .{ .enabled = true, .commands = &petdex_command_policies },
            .registry = .{ .handlers = &self.bridge_handlers },
        };
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
        try writeActiveSlug(self.io, self.config_dir, slug);

        const sprite = try loadSpritesheet(self.allocator, self.io, self.pets_dir, slug);
        defer self.allocator.free(sprite.bytes);
        var root_dir = try std.Io.Dir.openDirAbsolute(self.io, self.asset_root, .{});
        defer root_dir.close(self.io);
        try writeFileAll(self.io, root_dir, "spritesheet.webp", sprite.bytes);
        if (!std.mem.eql(u8, sprite.ext, "webp")) {
            const sprite_name = if (std.mem.eql(u8, sprite.ext, "png")) "spritesheet.png" else "spritesheet.webp";
            try writeFileAll(self.io, root_dir, sprite_name, sprite.bytes);
        }
        return std.fmt.bufPrint(output, "{{\"ok\":true}}", .{});
    }

    fn quitCmd(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = context;
        _ = invocation;
        std.process.exit(0);
        return std.fmt.bufPrint(output, "{{\"ok\":true}}", .{});
    }
};

const petdex_origins = [_][]const u8{ "zero://app", "zero://inline" };
const petdex_command_policies = [_]zero_native.BridgeCommandPolicy{
    .{ .name = "petdex.set_active", .origins = &petdex_origins },
    .{ .name = "petdex.quit", .origins = &petdex_origins },
    .{ .name = "petdex.read_runtime_state", .origins = &petdex_origins },
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

fn pathExists(io: std.Io, absolute_path: []const u8) bool {
    var dir = std.Io.Dir.openDirAbsolute(io, absolute_path, .{}) catch return false;
    defer dir.close(io);
    return true;
}

fn resolvePetsDir(allocator: std.mem.Allocator, io: std.Io, env_map: *std.process.Environ.Map) ![]u8 {
    const home = env_map.get("HOME") orelse return error.NoHome;
    const petdex_path = try std.fs.path.join(allocator, &.{ home, ".petdex", "pets" });
    if (pathExists(io, petdex_path)) return petdex_path;
    allocator.free(petdex_path);
    const codex_path = try std.fs.path.join(allocator, &.{ home, ".codex", "pets" });
    if (pathExists(io, codex_path)) return codex_path;
    allocator.free(codex_path);
    return error.NoPetsDirectory;
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

fn listPets(allocator: std.mem.Allocator, io: std.Io, pets_dir: []const u8) !std.ArrayList(Pet) {
    var pets: std.ArrayList(Pet) = .empty;
    errdefer {
        for (pets.items) |p| {
            allocator.free(p.slug);
            allocator.free(p.display_name);
        }
        pets.deinit(allocator);
    }

    var dir = try std.Io.Dir.openDirAbsolute(io, pets_dir, .{ .iterate = true });
    defer dir.close(io);

    var iter = dir.iterate();
    while (try iter.next(io)) |entry| {
        if (entry.kind != .directory) continue;
        const slug = try allocator.dupe(u8, entry.name);
        const display_name = try readDisplayName(allocator, io, dir, entry.name) orelse try allocator.dupe(u8, entry.name);
        try pets.append(allocator, .{ .slug = slug, .display_name = display_name });
    }

    std.mem.sort(Pet, pets.items, {}, petLessThan);
    return pets;
}

fn petLessThan(_: void, a: Pet, b: Pet) bool {
    return std.mem.lessThan(u8, a.slug, b.slug);
}

fn readDisplayName(allocator: std.mem.Allocator, io: std.Io, parent: std.Io.Dir, slug: []const u8) !?[]u8 {
    const path = try std.fs.path.join(allocator, &.{ slug, "pet.json" });
    defer allocator.free(path);
    var file = parent.openFile(io, path, .{}) catch return null;
    defer file.close(io);
    const bytes = try readFileAll(io, allocator, file, MAX_ACTIVE_BYTES);
    defer allocator.free(bytes);
    const display = jsonStringField(bytes, "displayName") orelse return null;
    return try allocator.dupe(u8, display);
}

fn loadSpritesheet(allocator: std.mem.Allocator, io: std.Io, pets_dir: []const u8, slug: []const u8) !struct { ext: []const u8, bytes: []u8 } {
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

fn copyAllSpritesheets(allocator: std.mem.Allocator, io: std.Io, pets_dir: []const u8, asset_root: []const u8, pets: []const Pet) !void {
    var root_dir = try std.Io.Dir.openDirAbsolute(io, asset_root, .{});
    defer root_dir.close(io);

    var copied: u32 = 0;
    var skipped: u32 = 0;
    for (pets) |p| {
        const abs_sub = try std.fs.path.join(allocator, &.{ asset_root, p.slug });
        defer allocator.free(abs_sub);
        ensureDir(io, abs_sub) catch {};

        if (isSpritesheetFresh(allocator, io, pets_dir, abs_sub, p.slug)) {
            skipped += 1;
            continue;
        }

        const sprite = loadSpritesheet(allocator, io, pets_dir, p.slug) catch continue;
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
    for (s) |c| {
        switch (c) {
            '"' => try buf.appendSlice(allocator, "\\\""),
            '\\' => try buf.appendSlice(allocator, "\\\\"),
            '\n' => try buf.appendSlice(allocator, "\\n"),
            '\r' => try buf.appendSlice(allocator, "\\r"),
            '\t' => try buf.appendSlice(allocator, "\\t"),
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
    env_map: *std.process.Environ.Map,
    html: []const u8,
    sprite_ext: []const u8,
    sprite_bytes: []const u8,
) ![]u8 {
    const tmp = env_map.get("TMPDIR") orelse "/tmp/";
    var trimmed_end: usize = tmp.len;
    while (trimmed_end > 0 and tmp[trimmed_end - 1] == '/') trimmed_end -= 1;
    const trimmed = tmp[0..trimmed_end];
    const root = try std.fmt.allocPrint(allocator, "{s}/petdex-desktop", .{trimmed});

    try ensureDir(io, root);
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

    const pets_dir = resolvePetsDir(allocator, init.io, init.environ_map) catch |err| {
        std.debug.print("No pets found. Install one with `npx petdex install <slug>`.\n", .{});
        return err;
    };
    defer allocator.free(pets_dir);

    var pets = try listPets(allocator, init.io, pets_dir);
    defer {
        for (pets.items) |p| {
            allocator.free(p.slug);
            allocator.free(p.display_name);
        }
        pets.deinit(allocator);
    }
    if (pets.items.len == 0) {
        std.debug.print("No pets in {s}. Install one with `npx petdex install <slug>`.\n", .{pets_dir});
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

    std.debug.print("Loading pet: {s} ({d} installed)\n", .{ active_slug, pets.items.len });

    const sprite = try loadSpritesheet(allocator, init.io, pets_dir, active_slug);
    defer allocator.free(sprite.bytes);

    const petdex_json = try buildPetdexJson(allocator, pets.items, active_slug);
    defer allocator.free(petdex_json);

    const html_doc = try buildHtml(allocator, petdex_json);
    defer allocator.free(html_doc);

    const asset_root = try prepareAssetRoot(allocator, init.io, init.environ_map, html_doc, sprite.ext, sprite.bytes);
    defer allocator.free(asset_root);

    try copyAllSpritesheets(allocator, init.io, pets_dir, asset_root, pets.items);

    // Spawn the HTTP sidecar so external CLIs (Claude Code, Codex, Gemini, OpenCode,
    // shell scripts) can drive the mascot via POST /state. The CLI installs
    // server.js to ~/.petdex/sidecar/server.js alongside the binary.
    const sidecar_dir = try resolveSidecarDir(allocator, init.environ_map);
    defer allocator.free(sidecar_dir);
    try spawnSidecar(allocator, init.io, sidecar_dir, init.environ_map);

    var state = PetdexState{
        .allocator = allocator,
        .io = init.io,
        .config_dir = try allocator.dupe(u8, config_dir),
        .pets_dir = try allocator.dupe(u8, pets_dir),
        .asset_root = try allocator.dupe(u8, asset_root),
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
