/** macOS desktop detection + petdex:// deep link builders for Petdex Desktop. */

export function isMacDesktop(): boolean {
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
  return /^Mac/i.test(platform) || /Mac OS X/i.test(ua);
}

/** `petdex://<slug>` — swap active pet (auto-install if missing). */
export function buildPetdexActivateUrl(slug: string): string {
  return `petdex://${slug}`;
}

/** `petdex://install?slug=a&slug=b` — batch install without a terminal. */
export function buildPetdexInstallUrl(slugs: string[]): string {
  if (slugs.length === 0) return "petdex://install";
  const query = slugs
    .map((slug) => `slug=${encodeURIComponent(slug)}`)
    .join("&");
  return `petdex://install?${query}`;
}

/** `/download?next=…` value: single `install/<slug>` or comma-separated batch. */
export function buildDownloadInstallNext(slugs: string[]): string {
  if (slugs.length === 0) return "install/";
  if (slugs.length === 1) return `install/${slugs[0]}`;
  return `install/${slugs.join(",")}`;
}

/** Navigate to a petdex:// URL with optional /download fallback (macOS). */
export function openPetdexDeepLink(
  deepLink: string,
  downloadHref: string,
  onBeforeNavigate?: () => void,
): void {
  onBeforeNavigate?.();
  let cancelled = false;
  const timeout = window.setTimeout(() => {
    if (cancelled) return;
    window.location.href = downloadHref;
  }, 1200);
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
