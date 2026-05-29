import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { listen } from '@tauri-apps/api/event';
import { convertFileSrc } from '@tauri-apps/api/core';

const appWindow = getCurrentWindow();

// Expose window.zero.invoke compatibility layer
window.zero = {
  invoke: async (cmd, args = {}) => {
    // Map zero-native commands to Tauri commands
    if (cmd === 'zero-native.window.move') {
      const { dx, dy, clampToVisibleFrame } = args;
      const pos = await appWindow.outerPosition();
      let x = pos.x + dx;
      let y = pos.y + dy;
      // Clamp to visible frame
      const monitors = await (await import('@tauri-apps/api/window')).availableMonitors();
      let hitX = false, hitY = false;
      if (clampToVisibleFrame && monitors.length > 0) {
        // Simple clamp: ensure within primary monitor
        const primary = monitors[0];
        const size = await appWindow.outerSize();
        if (x < primary.position.x) { x = primary.position.x; hitX = true; }
        if (y < primary.position.y) { y = primary.position.y; hitY = true; }
        if (x + size.width > primary.position.x + primary.size.width) {
          x = primary.position.x + primary.size.width - size.width;
          hitX = true;
        }
        if (y + size.height > primary.position.y + primary.size.height) {
          y = primary.position.y + primary.size.height - size.height;
          hitY = true;
        }
      }
      await appWindow.setPosition({ type: 'Physical', x, y });
      return { hitX, hitY };
    }
    if (cmd === 'zero-native.window.resize') {
      const { width, height } = args;
      await appWindow.setSize({ type: 'Physical', width, height });
      return {};
    }
    if (cmd === 'zero-native.window.start_dragging') {
      await appWindow.startDragging();
      return {};
    }
    // Map petdex.X to Tauri command X
    const tauriCmd = cmd.replace('petdex.', '');
    return await invoke(tauriCmd, args);
  }
};

// Asset URL helper
window.assetUrlFor = async (name) => {
  const path = await invoke('asset_url_for', { name });
  return convertFileSrc(path);
};

// Inject __PETDEX__ data
async function bootstrap() {
  try {
    const data = await invoke('read_petdex_data', {});
    window.__PETDEX__ = data;
  } catch (e) {
    console.error('Failed to load petdex data:', e);
    window.__PETDEX__ = { pets: [], active: null, compactWidth: 140, compactHeight: 180, menuWidth: 480, menuHeight: 420 };
  }
  window.dispatchEvent(new CustomEvent('petdex:ready', { detail: window.__PETDEX__ }));
}

bootstrap();

// Deep link handling
async function handlePetdexUrls(urls) {
  for (const url of urls) {
    const slug = new URL(url).hostname;
    if (/^[a-z0-9_-]{1,64}$/.test(slug)) {
      window.dispatchEvent(new CustomEvent('petdex:deep-link', { detail: slug }));
    }
  }
}

const current = await getCurrent();
if (current) handlePetdexUrls(current);

await onOpenUrl(handlePetdexUrls);

await listen('petdex:deep-link', (event) => {
  handlePetdexUrls([`petdex://${event.payload}`]);
});
