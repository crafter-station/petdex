import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
// Cache the resolved desktop release URL for 5 minutes. Releases ship
// rarely, the GitHub API has its own per-IP rate limit, and this
// endpoint is hit on every "Download for macOS" click on /download.
// stale-while-revalidate keeps clicks instant during a release
// rollout window.
export const revalidate = 300;

const RELEASES_API_BASE =
  "https://api.github.com/repos/crafter-station/petdex/releases";
const RELEASES_PAGE_SIZE = 30;
// Cap the search at 5 pages = 150 releases. Anything older is stale,
// and a runaway loop would burn the GitHub API rate limit if the
// repo somehow lost every desktop tag.
const RELEASES_MAX_PAGES = 5;
const DESKTOP_TAG_PREFIX = "desktop-v";
// Fallback when the GitHub API is unreachable or the repo has no
// desktop release yet. The releases page itself isn't ideal (it can
// show a non-desktop release at the top) but it's strictly better
// than 5xx-ing the user.
const RELEASES_PAGE = "https://github.com/crafter-station/petdex/releases";

// Hard-pin every redirect target to the petdex repo on github.com.
// The html_url / browser_download_url fields on the response are
// technically attacker-controlled (a compromised GH response, an
// MITM, or a future API shape change could surface a non-GH URL),
// and forwarding them blindly turns this endpoint into an open
// redirect. Anything that fails the prefix check falls back to the
// static releases page, which is always safe.
const SAFE_URL_PREFIX = "https://github.com/crafter-station/petdex/";

function isTrustedUrl(url: string): boolean {
  return url.startsWith(SAFE_URL_PREFIX);
}

type GhAsset = {
  name?: string;
  browser_download_url?: string;
};

type GhRelease = {
  tag_name?: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GhAsset[];
};

async function findLatestDesktopRelease(): Promise<GhRelease | null> {
  // Walk pages newest-first until we hit a desktop-v* tag or
  // exhaust the cap. Most repos resolve on page 1; the loop
  // exists so a long run of web-v*/sidecar-v* releases doesn't
  // hide the latest desktop tag behind page 1.
  for (let page = 1; page <= RELEASES_MAX_PAGES; page++) {
    const url = `${RELEASES_API_BASE}?per_page=${RELEASES_PAGE_SIZE}&page=${page}`;
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as GhRelease[];
    if (!Array.isArray(data) || data.length === 0) return null;
    const hit = data.find(
      (r) =>
        !r.draft &&
        !r.prerelease &&
        typeof r.tag_name === "string" &&
        r.tag_name.startsWith(DESKTOP_TAG_PREFIX),
    );
    if (hit) return hit;
    if (data.length < RELEASES_PAGE_SIZE) return null;
  }
  return null;
}

// Map platform alias → asset filename matchers, in priority order.
// First match wins. We prefer the .dmg because users expect "drag
// to Applications" UX from a download click; the bare binary is
// kept around for the CLI's existing install flow (`petdex install
// desktop`) which isn't changing in this release.
const PLATFORM_ASSET_PATTERNS: Record<string, RegExp[]> = {
  "darwin-arm64": [
    /^Petdex-arm64\.dmg$/, // signed + notarized DMG, drag-to-Applications UX
    /^petdex-desktop-darwin-arm64(\.zip)?$/, // bare binary, legacy CLI flow
  ],
  "darwin-x64": [/^Petdex-x64\.dmg$/, /^petdex-desktop-darwin-x64(\.zip)?$/],
  "linux-x64": [/^petdex-desktop-linux-x64(\.tar\.gz)?$/],
  "linux-arm64": [/^petdex-desktop-linux-arm64(\.tar\.gz)?$/],
  "win32-x64": [/^petdex-desktop-win32-x64\.(exe|zip)$/],
};

function pickAssetForPlatform(
  release: GhRelease,
  platform: string,
): GhAsset | null {
  if (!Array.isArray(release.assets)) return null;
  const patterns = PLATFORM_ASSET_PATTERNS[platform];
  if (!patterns) return null;
  for (const re of patterns) {
    const hit = release.assets.find(
      (a) =>
        typeof a.name === "string" &&
        re.test(a.name) &&
        typeof a.browser_download_url === "string" &&
        isTrustedUrl(a.browser_download_url),
    );
    if (hit) return hit;
  }
  return null;
}

function releasePageUrl(release: GhRelease | null): string {
  if (!release) return RELEASES_PAGE;
  if (release.html_url && isTrustedUrl(release.html_url))
    return release.html_url;
  if (release.tag_name)
    return `${SAFE_URL_PREFIX}releases/tag/${release.tag_name}`;
  return RELEASES_PAGE;
}

/**
 * GET /api/desktop/latest-release
 *
 * Default behavior: 307 to the latest desktop-v* release page on
 * GitHub. This is the "show me where the desktop app lives" UX —
 * the user lands on a page they can browse.
 *
 * `?asset=darwin-arm64` (or any future platform suffix): 307 directly
 * to the platform-specific binary asset's download URL. The browser
 * starts the file save immediately — no extra click on a release
 * page, no asset confusion. This is what /download's "Download for
 * macOS" button uses.
 *
 * Falls back to the release page (or to /releases) on any GitHub
 * API failure or missing asset, so the user always lands somewhere
 * useful.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const asset = req.nextUrl.searchParams.get("asset");
  let release: GhRelease | null = null;
  try {
    release = await findLatestDesktopRelease();
  } catch {
    // fall through with release=null → fallback page
  }

  if (asset) {
    if (release) {
      const hit = pickAssetForPlatform(release, asset);
      if (hit?.browser_download_url) {
        return NextResponse.redirect(hit.browser_download_url, 307);
      }
    }
    // Asked for a specific binary but couldn't resolve. Sending the
    // user to the release page is strictly better than a 404 — they
    // can pick the asset by hand.
    return NextResponse.redirect(releasePageUrl(release), 307);
  }

  return NextResponse.redirect(releasePageUrl(release), 307);
}
