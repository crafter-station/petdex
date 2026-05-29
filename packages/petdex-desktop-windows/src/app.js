// Wait for petdex:ready before accessing __PETDEX__
await new Promise(resolve => {
  if (window.__PETDEX__) return resolve();
  window.addEventListener('petdex:ready', resolve, { once: true });
});

const COLS = 8, ROWS = 9;
const STATES = {
  idle:           { row: 0, frames: [{c:0,d:280},{c:1,d:110},{c:2,d:110},{c:3,d:140},{c:4,d:140},{c:5,d:320}], slow: 6 },
  "running-right":{ row: 1, count: 8, dur: 120, last: 220 },
  "running-left": { row: 2, count: 8, dur: 120, last: 220 },
  waving:         { row: 3, count: 4, dur: 140, last: 280 },
  jumping:        { row: 4, count: 5, dur: 140, last: 280 },
  failed:         { row: 5, count: 8, dur: 140, last: 240 },
  waiting:        { row: 6, count: 6, dur: 150, last: 260 },
  running:        { row: 7, count: 6, dur: 120, last: 220 },
  review:         { row: 8, count: 6, dur: 150, last: 280 },
};

function buildFrames(s) {
  if (s.frames) { const slow = s.slow || 1; return s.frames.map(f => ({ c: f.c, r: s.row, d: f.d * slow })); }
  return Array.from({length: s.count}, (_,i) => ({ c: i, r: s.row, d: i === s.count - 1 ? s.last : s.dur }));
}

function pos(c, r) { return `${c/(COLS-1)*100}% ${r/(ROWS-1)*100}%`; }

const pet = document.getElementById('pet');
const stageEl = pet.parentElement;
if (stageEl) {
  stageEl.style.top = '34px';
  stageEl.style.left = '8px';
  stageEl.style.position = 'fixed';
}

let currentState = 'idle';
let stateTimer = null;
function play(state) {
  if (state === currentState) return;
  currentState = state;
  pet.dataset.state = state;
  if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
  const def = STATES[state] || STATES.idle;
  const frames = buildFrames(def);
  let i = 0;
  pet.style.backgroundPosition = pos(frames[0].c, frames[0].r);
  if (frames.length === 1) return;
  const tick = () => {
    stateTimer = setTimeout(() => {
      i = (i + 1) % frames.length;
      pet.style.backgroundPosition = pos(frames[i].c, frames[i].r);
      tick();
    }, frames[i].d);
  };
  tick();
}
play('idle');

// Load spritesheet via Tauri asset protocol
async function loadSpritesheet() {
  try {
    const url = await window.assetUrlFor('spritesheet.webp');
    pet.style.backgroundImage = `url('${url}')`;
  } catch (e) {
    console.error('Failed to load spritesheet:', e);
  }
}
loadSpritesheet();

let lastSidecarCounter = 0;
let sidecarRevertTimer = null;
async function pollSidecarState() {
  if (!(window.zero && window.zero.invoke)) return;
  if (dragging || momentumTimer != null) return;
  try {
    const r = await window.zero.invoke('petdex.read_runtime_state', {});
    if (!r || typeof r.counter !== 'number') return;
    if (r.counter === lastSidecarCounter) return;
    lastSidecarCounter = r.counter;
    const desired = typeof r.state === 'string' ? r.state : 'idle';
    if (sidecarRevertTimer) { clearTimeout(sidecarRevertTimer); sidecarRevertTimer = null; }
    play(desired);
  } catch (e) {}
}
setInterval(pollSidecarState, 200);

let lastBubbleCounter = 0;
let bubbleEl = null;
let bubbleAvatarEl = null;
let bubbleTextEl = null;
const AGENT_AVATARS = {
  'claude-code': 'agents/claude-code.svg',
  'codex': 'agents/codex.svg',
  'gemini': 'agents/gemini.svg',
  'opencode': 'agents/opencode.svg',
};

function agentAvatarSrc(source) {
  return AGENT_AVATARS[source] || 'agents/fallback.svg';
}

function ensureBubble() {
  if (bubbleEl) return bubbleEl;
  bubbleEl = document.createElement('div');
  bubbleEl.id = 'pet-bubble';
  bubbleEl.style.cssText = 'position:fixed;padding:4px 8px;border-radius:10px;background:#ffffff;color:#111;font:600 11px system-ui,-apple-system,sans-serif;line-height:1.2;box-shadow:0 2px 6px rgba(0,0,0,0.30);text-align:left;white-space:normal;max-width:190px;display:flex;align-items:center;gap:6px;opacity:0;transition:opacity 180ms ease;pointer-events:none;z-index:5;';
  bubbleAvatarEl = document.createElement('img');
  bubbleAvatarEl.alt = 'Agent avatar';
  bubbleAvatarEl.decoding = 'async';
  bubbleAvatarEl.style.cssText = 'width:20px;height:20px;flex:0 0 auto;object-fit:cover;display:block;';
  bubbleTextEl = document.createElement('span');
  bubbleTextEl.style.cssText = 'display:block;min-width:0;word-break:keep-all;overflow-wrap:break-word;';
  bubbleEl.appendChild(bubbleAvatarEl);
  bubbleEl.appendChild(bubbleTextEl);
  document.body.appendChild(bubbleEl);
  return bubbleEl;
}

function setBubbleContent(text, agentSource) {
  ensureBubble();
  const source = typeof agentSource === 'string' ? agentSource : '';
  bubbleAvatarEl.src = agentAvatarSrc(source);
  bubbleAvatarEl.alt = source ? source + ' avatar' : 'Agent avatar';
  bubbleTextEl.textContent = text;
}

function positionBubbleNearPet(el) {
  const rect = pet.getBoundingClientRect();
  const bw = el.offsetWidth || 100;
  const bh = el.offsetHeight || 22;
  const ww = window.innerWidth;
  const gap = 14;
  const petCenterX = rect.left + rect.width / 2;
  const realBw = el.offsetWidth;
  const desiredLeft = petCenterX - realBw / 2;
  const left = Math.max(4, Math.min(ww - realBw - 4, desiredLeft));
  const stageEl = pet.parentElement;
  const currentPetTop = stageEl ? parseInt(stageEl.style.top || '34', 10) : 34;
  let top = rect.top - bh - gap;
  if (top < 2) {
    const newPetTop = bh + gap + 4;
    if (stageEl && newPetTop > currentPetTop) {
      stageEl.style.top = newPetTop + 'px';
      const rect2 = pet.getBoundingClientRect();
      top = Math.max(2, rect2.top - bh - gap);
    } else {
      top = Math.max(2, top);
    }
  }
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

async function pollBubble() {
  if (!(window.zero && window.zero.invoke)) return;
  if (menuEl) {
    if (bubbleEl) bubbleEl.style.opacity = '0';
    return;
  }
  try {
    const r = await window.zero.invoke('petdex.read_runtime_bubble', {});
    if (!r || typeof r.counter !== 'number') return;
    if (r.counter === lastBubbleCounter) {
      if (bubbleEl && bubbleEl.style.opacity === '0' && bubbleTextEl && bubbleTextEl.textContent) {
        positionBubbleNearPet(bubbleEl);
        bubbleEl.style.opacity = '1';
      }
      return;
    }
    lastBubbleCounter = r.counter;
    const text = typeof r.text === 'string' ? r.text : '';
    const el = ensureBubble();
    if (text) {
      const stageEl = pet.parentElement;
      if (stageEl && stageEl.style.top !== '34px') {
        stageEl.style.top = '34px';
      }
      setBubbleContent(text, r.agent_source);
      positionBubbleNearPet(el);
      el.style.opacity = '1';
    } else {
      el.style.opacity = '0';
      const stageEl = pet.parentElement;
      if (stageEl && stageEl.style.top !== '34px') {
        stageEl.style.top = '34px';
      }
    }
  } catch (e) {}
}
setInterval(pollBubble, 200);
pollBubble();

// Update
let lastUpdateStatus = '';
let updateCard = null;
let needsInitFlag = false;
function ensureUpdateCard() {
  if (updateCard) return updateCard;
  updateCard = document.createElement('div');
  updateCard.id = 'update-card';
  updateCard.style.cssText = 'position:fixed;left:6px;right:6px;bottom:6px;padding:6px 9px;border-radius:9px;background:#ffffff;color:#111;font:600 11px system-ui,-apple-system,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,0.30);display:none;cursor:pointer;pointer-events:auto;line-height:1.25;text-align:center;';
  updateCard.addEventListener('click', async () => {
    if (!(window.zero && window.zero.invoke)) return;
    try {
      const r = await window.zero.invoke('petdex.trigger_update', {});
      if (r && r.ok === false) {
        const code = (r.error || '');
        if (code.indexOf('curl_exit_') === 0 || code === 'no_token' || code === 'token_read' || code === 'empty_token') {
          renderUpdate({ status: 'error', message: 'Sidecar offline. Run: npx petdex@latest update' });
          return;
        }
        renderUpdate({ status: 'error', message: 'Update failed (' + code + '). Run: npx petdex@latest update' });
        return;
      }
      renderUpdate({ status: 'running', message: 'Updating...' });
    } catch (e) {
      renderUpdate({ status: 'error', message: 'Update failed. Run: npx petdex@latest update' });
    }
  });
  document.body.appendChild(updateCard);
  return updateCard;
}

function renderUpdate(info) {
  const card = ensureUpdateCard();
  if (needsInitFlag) { card.style.display = 'none'; return; }
  if (info.status === 'idle' || (!info.available && info.status !== 'error' && info.status !== 'done')) {
    card.style.display = 'none';
    return;
  }
  let text = '';
  if (info.status === 'available') {
    text = 'Update ' + (info.latest || 'available') + ' - click to install';
  } else if (info.status === 'running') {
    text = info.message || 'Updating...';
  } else if (info.status === 'done') {
    text = info.message || 'Update installed. Restart Petdex.';
  } else if (info.status === 'error') {
    text = info.message || 'Update failed.';
  }
  card.textContent = text;
  card.style.display = 'block';
}

async function pollUpdate() {
  if (!(window.zero && window.zero.invoke)) return;
  try {
    const info = await window.zero.invoke('petdex.read_update_info', {});
    if (!info || typeof info !== 'object') return;
    const sig = info.status + ':' + (info.latest || '') + ':' + (info.message || '');
    if (sig === lastUpdateStatus) return;
    lastUpdateStatus = sig;
    renderUpdate(info);
  } catch (e) {}
}
setInterval(pollUpdate, 5000);
pollUpdate();

// Init banner
let initCard = null;
let initToastTimer = null;
function ensureInitCard() {
  if (initCard) return initCard;
  initCard = document.createElement('div');
  initCard.id = 'init-card';
  initCard.style.cssText = 'position:fixed;left:6px;right:6px;bottom:6px;padding:6px 9px;border-radius:9px;background:#ffffff;color:#111;font:600 11px system-ui,-apple-system,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,0.30);display:none;cursor:pointer;pointer-events:auto;line-height:1.25;text-align:center;';
  initCard.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText('npx petdex init');
    } catch (e) {}
    showInitToast('Command copied. Paste in your terminal.');
  });
  document.body.appendChild(initCard);
  return initCard;
}

function showInitToast(msg) {
  if (initToastTimer) { clearTimeout(initToastTimer); initToastTimer = null; }
  const card = ensureInitCard();
  const prev = card.textContent;
  card.textContent = msg;
  initToastTimer = setTimeout(() => {
    card.textContent = prev;
    initToastTimer = null;
  }, 3000);
}

function renderInitBanner(needsInit) {
  needsInitFlag = needsInit;
  const card = ensureInitCard();
  if (needsInit) {
    card.textContent = 'Run `petdex init` to wire your agents';
    card.style.display = 'block';
    const uc = document.getElementById('update-card');
    if (uc) uc.style.display = 'none';
  } else {
    card.style.display = 'none';
  }
}

async function pollInitStatus() {
  if (!(window.zero && window.zero.invoke)) return;
  try {
    const info = await window.zero.invoke('petdex.read_init_status', {});
    if (!info || typeof info !== 'object') return;
    renderInitBanner(info.needsInit === true);
  } catch (e) {}
}
setInterval(pollInitStatus, 5000);
pollInitStatus();

// Sidecar watchdog
let sidecarFails = 0;
let lastRespawnAt = 0;
async function probeSidecar() {
  try {
    const r = await fetch('http://127.0.0.1:7777/health', {
      signal: AbortSignal.timeout(500),
    });
    if (r.ok) {
      sidecarFails = 0;
      return;
    }
  } catch (e) {}
  sidecarFails += 1;
  if (sidecarFails < 3) return;
  const now = Date.now();
  if (now - lastRespawnAt < 4000) return;
  lastRespawnAt = now;
  try {
    await window.zero.invoke('petdex.respawn_sidecar', {});
    sidecarFails = 0;
  } catch (e) {}
}
setInterval(probeSidecar, 5000);

// Drag + momentum
const TICK_MS = 16, FRICTION = 0.88, MIN_VEL = 65, MAX_DURATION = 900;
const SAMPLE_WINDOW_MS = 100, THRESHOLD = 4;
let dragging = false;
let lastX = 0, lastY = 0;
let samples = [];
let resetTimer = null;
let momentumTimer = null;

async function moveWindowClamped(dx, dy) {
  if (!(window.zero && window.zero.invoke)) return { hitX: false, hitY: false };
  try {
    const r = await window.zero.invoke('zero-native.window.move', { dx, dy, clampToVisibleFrame: true });
    return { hitX: !!(r && r.hitX), hitY: !!(r && r.hitY) };
  } catch (e) { return { hitX: false, hitY: false }; }
}

function pushSample(e) {
  const t = performance.now();
  samples.push({ x: e.screenX, y: e.screenY, t });
  samples = samples.filter(s => t - s.t <= SAMPLE_WINDOW_MS);
}

function computeVelocity() {
  if (samples.length < 2) return null;
  const last = samples[samples.length - 1];
  const first = samples.find(s => last.t - s.t > 16);
  if (first == null) return null;
  const dtSec = (last.t - first.t) / 1000;
  if (dtSec <= 0) return null;
  return { x: (last.x - first.x) / dtSec, y: (last.y - first.y) / dtSec };
}

function cancelMomentum() { if (momentumTimer != null) { clearTimeout(momentumTimer); momentumTimer = null; } }

function throwWithVelocity(vx, vy) {
  if (!Number.isFinite(vx) || !Number.isFinite(vy) || (vx === 0 && vy === 0)) return;
  cancelMomentum();
  let elapsed = 0;
  const tick = async () => {
    momentumTimer = null;
    elapsed += TICK_MS;
    const r = await moveWindowClamped(vx * TICK_MS / 1000, vy * TICK_MS / 1000);
    if (r.hitX) vx = 0;
    if (r.hitY) vy = 0;
    if (vx >= MIN_VEL) play('running-right'); else if (vx <= -MIN_VEL) play('running-left');
    vx *= FRICTION; vy *= FRICTION;
    if (elapsed >= MAX_DURATION || Math.hypot(vx, vy) < MIN_VEL) {
      play('waving');
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => play('idle'), 1200);
      return;
    }
    momentumTimer = setTimeout(tick, TICK_MS);
  };
  momentumTimer = setTimeout(tick, TICK_MS);
}

pet.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  closeMenu();
  dragging = true;
  lastX = e.screenX; lastY = e.screenY;
  samples = [];
  pushSample(e);
  pet.classList.add('dragging');
  pet.setPointerCapture(e.pointerId);
  play('jumping');
  if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
  cancelMomentum();
  // Let OS handle window drag for smooth movement
  if (window.zero && window.zero.invoke) {
    window.zero.invoke('zero-native.window.start_dragging', {}).catch(() => {});
  }
  e.preventDefault();
});

pet.addEventListener('mousedown', (e) => { if (e.button !== 0) e.preventDefault(); });
pet.addEventListener('auxclick', (e) => e.preventDefault());

pet.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.screenX - lastX, dy = e.screenY - lastY;
  lastX = e.screenX; lastY = e.screenY;
  pushSample(e);
  // OS handles window movement via start_dragging; we only sample for momentum
  if (dx >= THRESHOLD) play('running-right'); else if (dx <= -THRESHOLD) play('running-left');
});

function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  pet.classList.remove('dragging');
  try { pet.releasePointerCapture(e.pointerId); } catch (_) {}
  const v = computeVelocity();
  if (v != null && Math.hypot(v.x, v.y) >= MIN_VEL) throwWithVelocity(v.x, v.y);
  else { play('waving'); resetTimer = setTimeout(() => play('idle'), 1200); }
}

pet.addEventListener('pointerup', endDrag);
pet.addEventListener('pointercancel', endDrag);

// Pet picker
let menuEl = null;
async function resizeWindowTo(w, h) {
  if (!(window.zero && window.zero.invoke)) return;
  try { await window.zero.invoke('zero-native.window.resize', { width: w, height: h, anchor: 'top-left' }); } catch (e) {}
}

function closeMenu() {
  if (menuEl) { menuEl.remove(); menuEl = null; }
  const data = window.__PETDEX__ || {};
  if (data.compactWidth && data.compactHeight) resizeWindowTo(data.compactWidth, data.compactHeight);
}

async function selectPet(slug) {
  const data = window.__PETDEX__ || {};
  if (slug === data.active) { closeMenu(); return; }
  closeMenu();
  try {
    await window.zero.invoke('petdex.set_active', { slug });
    location.reload();
  } catch (e) {}
}

// Virtual scroll
const COLUMNS = 3;
const ROW_HEIGHT = 64;
const ROW_BUFFER = 2;

function makeVirtualGrid(scroller, spacer, viewport, getItems, active, onSelect) {
  let observer = null;
  let cellCache = new Map();
  async function loadThumb(cell) {
    const slug = cell.dataset.slug;
    if (!slug) return;
    const thumb = cell.firstChild;
    if (thumb && !thumb.style.backgroundImage) {
      try {
        const url = await window.assetUrlFor(`${slug}/spritesheet.webp`);
        thumb.style.backgroundImage = `url('${url}')`;
      } catch (e) {
        // Fallback: try png
        try {
          const url = await window.assetUrlFor(`${slug}/spritesheet.png`);
          thumb.style.backgroundImage = `url('${url}')`;
        } catch (_) {}
      }
    }
  }
  function unloadThumb(cell) {
    const thumb = cell.firstChild;
    if (thumb) thumb.style.backgroundImage = '';
  }
  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          loadThumb(entry.target).catch(() => {});
        } else {
          unloadThumb(entry.target);
        }
      }
    }, { root: scroller, rootMargin: '50px 0px' });
  }
  function buildCell(p) {
    const cell = document.createElement('div');
    cell.className = 'cell' + (p.slug === active() ? ' active' : '');
    cell.dataset.slug = p.slug;
    cell.title = p.displayName || p.slug;
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = p.displayName || p.slug;
    cell.appendChild(thumb);
    cell.appendChild(label);
    cell.addEventListener('click', (ev) => { ev.stopPropagation(); onSelect(p.slug); });
    if (observer) observer.observe(cell);
    else loadThumb(cell);
    return cell;
  }
  function render() {
    const items = getItems();
    if (items.length === 0) {
      spacer.style.height = '0px';
      viewport.innerHTML = '';
      viewport.style.transform = 'translateY(0px)';
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'no pets';
      empty.style.gridColumn = '1 / -1';
      viewport.appendChild(empty);
      return;
    }
    const totalRows = Math.ceil(items.length / COLUMNS);
    spacer.style.height = (totalRows * ROW_HEIGHT) + 'px';
    const scrollTop = scroller.scrollTop;
    const viewportHeight = scroller.clientHeight;
    const firstVisibleRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - ROW_BUFFER);
    const lastVisibleRow = Math.min(totalRows - 1, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + ROW_BUFFER);
    const startIdx = firstVisibleRow * COLUMNS;
    const endIdx = Math.min(items.length, (lastVisibleRow + 1) * COLUMNS);
    if (observer) for (const c of viewport.children) observer.unobserve(c);
    viewport.innerHTML = '';
    viewport.style.transform = `translateY(${firstVisibleRow * ROW_HEIGHT}px)`;
    for (let i = startIdx; i < endIdx; i++) {
      viewport.appendChild(buildCell(items[i]));
    }
  }
  scroller.addEventListener('scroll', () => requestAnimationFrame(render), { passive: true });
  return { render, dispose: () => { if (observer) observer.disconnect(); } };
}

function positionMenuFromData(petRect) {
  const data = window.__PETDEX__ || {};
  const menuW = 180;
  const menuH = 320;
  const gap = 8;
  const winW = data.menuWidth || window.innerWidth;
  const winH = data.menuHeight || window.innerHeight;
  let left = petRect.right + gap;
  let top = petRect.top;
  if (left + menuW > winW - 4) left = petRect.left - menuW - gap;
  if (left < 4) left = 4;
  if (top + menuH > winH - 4) top = winH - menuH - 4;
  if (top < 4) top = 4;
  menuEl.style.left = left + 'px';
  menuEl.style.top = top + 'px';
}

let virtualGrid = null;
function openMenu() {
  if (menuEl) { menuEl.remove(); menuEl = null; }
  if (virtualGrid) { virtualGrid.dispose(); virtualGrid = null; }
  const data = window.__PETDEX__ || { pets: [], active: null };
  const petRect = pet.getBoundingClientRect();
  if (data.menuWidth && data.menuHeight) {
    resizeWindowTo(data.menuWidth, data.menuHeight);
  }
  menuEl = document.createElement('div');
  menuEl.className = 'menu';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = `search ${data.pets.length} pets`;
  const count = document.createElement('div');
  count.className = 'count';
  const scroller = document.createElement('div');
  scroller.className = 'scroller';
  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  const viewport = document.createElement('div');
  viewport.className = 'viewport';
  scroller.appendChild(spacer);
  scroller.appendChild(viewport);
  let currentItems = data.pets;
  function applyFilter(query) {
    const filter = query.trim().toLowerCase();
    currentItems = filter ? data.pets.filter(p =>
      p.slug.toLowerCase().includes(filter) ||
      (p.displayName || '').toLowerCase().includes(filter)
    ) : data.pets;
    count.textContent = currentItems.length === data.pets.length
      ? `${data.pets.length} pets`
      : `${currentItems.length} of ${data.pets.length}`;
    scroller.scrollTop = 0;
    if (virtualGrid) virtualGrid.render();
  }
  const footer = document.createElement('div');
  footer.className = 'footer';
  const quit = document.createElement('div');
  quit.className = 'quit';
  quit.textContent = 'quit';
  quit.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const confirmRow = document.createElement('div');
    confirmRow.className = 'quit-confirm';
    const label = document.createElement('span');
    label.textContent = 'sure?';
    const yes = document.createElement('button');
    yes.textContent = 'quit';
    yes.addEventListener('click', (e) => {
      e.stopPropagation();
      try { window.zero.invoke('petdex.quit', {}); } catch (err) {}
    });
    const no = document.createElement('button');
    no.className = 'cancel';
    no.textContent = 'no';
    no.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmRow.replaceWith(quit);
    });
    confirmRow.appendChild(label);
    confirmRow.appendChild(no);
    confirmRow.appendChild(yes);
    quit.replaceWith(confirmRow);
  });
  footer.appendChild(quit);
  menuEl.appendChild(input);
  menuEl.appendChild(count);
  menuEl.appendChild(scroller);
  menuEl.appendChild(footer);
  document.body.appendChild(menuEl);
  virtualGrid = makeVirtualGrid(scroller, spacer, viewport, () => currentItems, () => data.active, selectPet);
  applyFilter('');
  positionMenuFromData(petRect);
  input.addEventListener('input', () => applyFilter(input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  setTimeout(() => input.focus(), 0);
}

pet.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopImmediatePropagation();
  openMenu();
});

document.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('blur', closeMenu);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
document.addEventListener('click', (e) => {
  if (menuEl && !menuEl.contains(e.target) && e.target !== pet) closeMenu();
}, true);

// Deep link
window.addEventListener('petdex:deep-link', (event) => {
  const slug = event.detail;
  if (slug) activateOrInstall(slug);
});

async function activateOrInstall(slug) {
  if (!(window.zero && window.zero.invoke)) return;
  try {
    await window.zero.invoke('petdex.set_active', { slug });
    location.reload();
    return;
  } catch (_) {}
  showLocalBubble('Installing ' + slug + '...');
  try {
    const r = await window.zero.invoke('petdex.install_pet', { slug });
    if (r && r.ok) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await window.zero.invoke('petdex.set_active', { slug });
          location.reload();
          return;
        } catch (e) {
          if (attempt === 0) {
            await new Promise(r => setTimeout(r, 500));
            continue;
          }
          showLocalBubble('Installed. Restart Petdex to use ' + slug);
          return;
        }
      }
      return;
    }
    const err = (r && r.error) || 'unknown';
    try { window.zero.invoke('petdex.set_mascot_state', { state: 'failed' }); } catch (_) {}
    showLocalBubble('Install failed: ' + err);
  } catch (e) {
    try { window.zero.invoke('petdex.set_mascot_state', { state: 'failed' }); } catch (_) {}
    showLocalBubble('Install crashed');
  }
}

function showLocalBubble(text) {
  const el = ensureBubble();
  setBubbleContent(text, null);
  positionBubbleNearPet(el);
  el.style.opacity = '1';
}

window.addEventListener('resize', () => {
  if (menuEl) return;
  if (bubbleEl && bubbleEl.style.opacity === '1') positionBubbleNearPet(bubbleEl);
});
