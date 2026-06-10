const READ_METHODS = new Set(["GET", "HEAD"]);
const LOCALE_RE = /^\/(?:en|es|zh)(?=\/|$)/;

const PUBLIC_HTML_PATHS = new Set([
  "/",
  "/about",
  "/brand",
  "/built-with",
  "/collections",
  "/community",
  "/create",
  "/docs",
  "/download",
  "/leaderboard",
  "/legal/takedown",
  "/legal/telemetry",
  "/requests",
]);

const PUBLIC_API_PATHS = new Set([
  "/api/desktop/latest-release",
  "/api/manifest",
  "/api/manifest/v2",
  "/api/pets/random",
  "/api/pets/search",
]);

export function shouldBypassClerkMiddleware(input: {
  method: string;
  pathname: string;
}): boolean {
  if (!READ_METHODS.has(input.method.toUpperCase())) return false;
  const pathname = normalizePath(input.pathname);
  if (isPublicHtmlPath(pathname)) return true;
  if (isPublicCatalogApiPath(pathname)) return true;
  return false;
}

function normalizePath(pathname: string): string {
  const withoutLocale = pathname.replace(LOCALE_RE, "") || "/";
  if (withoutLocale.length > 1) return withoutLocale.replace(/\/+$/, "");
  return withoutLocale;
}

function isPublicHtmlPath(pathname: string): boolean {
  if (PUBLIC_HTML_PATHS.has(pathname)) return true;
  if (/^\/pets\/[^/]+$/.test(pathname)) return true;
  if (/^\/collections\/[^/]+$/.test(pathname)) return true;
  if (/^\/kind\/[^/]+$/.test(pathname)) return true;
  if (/^\/vibe\/[^/]+$/.test(pathname)) return true;
  return false;
}

function isPublicCatalogApiPath(pathname: string): boolean {
  if (PUBLIC_API_PATHS.has(pathname)) return true;
  if (
    /^\/api\/pets\/[^/]+\/(?:codex-theme|metrics|sticker|thumb|variants|wastickers)$/.test(
      pathname,
    )
  ) {
    return true;
  }
  if (/^\/api\/install-pet\/[^/]+$/.test(pathname)) return true;
  return false;
}
