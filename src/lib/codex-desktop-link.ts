/** codex:// deep link builder for installing a Petdex pet into Codex Desktop. */

/**
 * Codex Desktop ships for macOS and Windows, unlike Petdex Desktop
 * (mac-only), so this checks both instead of reusing isMacDesktop from
 * petdex-desktop-link.ts.
 */
export function isCodexDesktopOs(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent ?? "";
  const platform =
    (navigator as Navigator & { platform?: string }).platform ?? "";
  const isIos =
    /iPhone|iPad|iPod/i.test(platform) || /iPhone|iPad|iPod/i.test(ua);
  const looksLikeIpadDesktopMode =
    platform === "MacIntel" &&
    typeof navigator.maxTouchPoints === "number" &&
    navigator.maxTouchPoints > 1;
  if (isIos || looksLikeIpadDesktopMode) return false;
  const isMac = /^Mac/i.test(platform) || /Mac OS X/i.test(ua);
  const isWindows = /^Win/i.test(platform) || /Windows/i.test(ua);
  return isMac || isWindows;
}

export type CodexInstallPet = {
  displayName: string;
  description: string;
  spritesheetUrl: string;
  /**
   * Atlas layout, 1 or 2. Required, not defaulted: the app's parser defaults
   * a missing value to layout 1, so a wrong guess misreads every frame of the
   * other layout, and Petdex ships both. The catalog is mostly v1 today
   * (~4631 of 4876 approved pets), so the old `?? 2` fallback sent the wrong
   * layout for the majority. Pass the pet's own `spriteVersionNumber`.
   */
  spriteVersionNumber: 1 | 2;
};

/**
 * `codex://pets/install?name=…&description=…&imageUrl=…&spriteVersionNumber=…`
 *
 * The shape was read out of ChatGPT.app's own bundle rather than inferred:
 * see `docs/chatgpt-pet-integration.md` for the parser, the file it lives in,
 * and how to re-derive all of this when OpenAI ships an update.
 *
 * Four rules from that parser, each of which silently voids the link:
 *   - the host must be `pets` and the single path segment `install`
 *   - only these four parameters are allowed; ONE extra rejects the whole URL
 *   - `imageUrl` must be `https:`
 *   - `spriteVersionNumber` must parse to 1 or 2
 *
 * `imageUrl` is a plain spritesheet URL, which is the whole reason this works:
 * the app accepts any host, so a pet served from Petdex R2 installs the same
 * way one served from OpenAI does. Its downloader passes `redirect: "manual"`
 * and throws on a redirect status, so the URL has to answer 200 directly, as
 * `image/png` or `image/webp`, under 20MB.
 *
 * Sending it is still not the same as it working: the modal that consumes the
 * link sits behind a Statsig gate that is currently off, so a correct link
 * lands and nothing happens. Always offer the petdex:// path beside it — see
 * openCodexDeepLink.
 */
export function buildCodexInstallUrl(pet: CodexInstallPet): string {
  const query = new URLSearchParams({
    name: pet.displayName,
    description: pet.description,
    imageUrl: pet.spritesheetUrl,
    // Must be the pet's real layout. The app defaults a missing value to 1,
    // and Petdex ships both layouts (v1 8x9, v2 8x11), so sending the wrong
    // number misreads every frame. There is no safe default here.
    spriteVersionNumber: String(pet.spriteVersionNumber),
  });
  return `codex://pets/install?${query.toString()}`;
}

/**
 * Navigate to a codex:// URL, falling back when nothing handles the scheme.
 *
 * Same blur-race as openPetdexDeepLink: a registered handler moves focus off
 * the page before the timer fires, an unregistered one leaves focus put and the
 * fallback runs. The window is longer here because Codex Desktop is a heavier
 * app than Petdex Desktop and a cold launch can outrun a 1200ms bet.
 */
export function openCodexDeepLink(
  deepLink: string,
  fallbackHref: string,
  onBeforeNavigate?: () => void,
): void {
  onBeforeNavigate?.();
  let cancelled = false;
  const timeout = window.setTimeout(() => {
    if (cancelled) return;
    window.location.href = fallbackHref;
  }, 2000);
  const onBlur = () => {
    cancelled = true;
    window.clearTimeout(timeout);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("pagehide", onBlur);
  };
  window.addEventListener("blur", onBlur);
  window.addEventListener("pagehide", onBlur);
  window.location.href = deepLink;
}
