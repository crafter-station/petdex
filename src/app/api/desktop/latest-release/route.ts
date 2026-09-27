import { type NextRequest, NextResponse } from "next/server";

import {
  buildJsonPayload,
  type GhRelease,
  pickAssetForPlatform,
  releasePageUrl,
} from "@/lib/desktop-release";

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
        r.tag_name.startsWith("desktop-v"),
    );
    if (hit) return hit;
    if (data.length < RELEASES_PAGE_SIZE) return null;
  }
  return null;
}

/**
 * GET /api/desktop/latest-release
 *
 * Default behavior: 307 to the latest desktop-v* release page on
 * GitHub. This is the "show me where the desktop app lives" UX —
 * the user lands on a page they can browse.
 *
 * `?format=json`: returns the latest version, its tag, the release
 * page, and the per-platform asset URLs instead of redirecting. This is
 * what the desktop app polls to learn it is behind (#673); it carries no
 * version of its own at runtime today, so this endpoint is the other
 * half of that check. Old installs call this shape forever, so treat it
 * as additive-only. `version` is null when GitHub cannot be reached,
 * which means "unknown", not "up to date".
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
  const format = req.nextUrl.searchParams.get("format");
  let release: GhRelease | null = null;
  try {
    release = await findLatestDesktopRelease();
  } catch {
    // fall through with release=null → fallback page
  }

  // Checked before `asset` so a client can ask for both without the
  // redirect winning and turning a version check into a file download.
  if (format === "json") {
    return NextResponse.json(buildJsonPayload(release), {
      // A desktop client polls this on its own schedule and must never
      // be told it is current by a stale edge copy after a release.
      // Same 5 minutes as the page cache, explicit because JSON is
      // consumed by long-lived installs rather than one browser click.
      headers: {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=300",
      },
    });
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
