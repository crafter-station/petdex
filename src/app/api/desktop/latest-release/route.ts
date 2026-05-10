import { NextResponse } from "next/server";

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
const RELEASES_PAGE =
  "https://github.com/crafter-station/petdex/releases";

// Hard-pin the redirect target to the petdex repo on github.com. The
// `html_url` on the response is technically attacker-controlled (a
// compromised GH response, an MITM, or a future API shape change
// could surface a non-GH URL), and forwarding it blindly into a 307
// turns this endpoint into an open redirect. Anything that fails the
// prefix check falls back to the static releases page, which is
// always safe.
const SAFE_URL_PREFIX = "https://github.com/crafter-station/petdex/";

function isTrustedReleaseUrl(url: string): boolean {
  return url.startsWith(SAFE_URL_PREFIX);
}

type GhRelease = {
  tag_name?: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
};

async function resolveDesktopRelease(): Promise<string> {
  try {
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
      if (!res.ok) return RELEASES_PAGE;
      const data = (await res.json()) as GhRelease[];
      if (!Array.isArray(data) || data.length === 0) return RELEASES_PAGE;
      const hit = data.find(
        (r) =>
          !r.draft &&
          !r.prerelease &&
          typeof r.tag_name === "string" &&
          r.tag_name.startsWith(DESKTOP_TAG_PREFIX),
      );
      if (hit) {
        // Trust html_url only when it points back at our own repo on
        // github.com. Anything else gets discarded in favor of a URL
        // we construct ourselves from the tag name (which we already
        // validated by prefix, so it's a-z0-9.- safe).
        if (hit.html_url && isTrustedReleaseUrl(hit.html_url)) {
          return hit.html_url;
        }
        if (hit.tag_name) {
          return `${SAFE_URL_PREFIX}releases/tag/${hit.tag_name}`;
        }
        return RELEASES_PAGE;
      }
      // Short page = end of list, no point asking for the next.
      if (data.length < RELEASES_PAGE_SIZE) return RELEASES_PAGE;
    }
    return RELEASES_PAGE;
  } catch {
    return RELEASES_PAGE;
  }
}

// 307 redirect (preserves method, doesn't get cached as a permanent
// move) to the newest desktop-v* release page. Anchored at a stable
// app URL so the /download link doesn't bake the GitHub URL into HTML
// and we can swap the resolution logic without touching the page.
export async function GET(): Promise<Response> {
  const target = await resolveDesktopRelease();
  return NextResponse.redirect(target, 307);
}
