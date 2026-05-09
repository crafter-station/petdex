import { NextResponse } from "next/server";

export const runtime = "nodejs";
// Cache the resolved desktop release URL for 5 minutes. Releases ship
// rarely, the GitHub API has its own per-IP rate limit, and this
// endpoint is hit on every "Download for macOS" click on /download.
// stale-while-revalidate keeps clicks instant during a release
// rollout window.
export const revalidate = 300;

const RELEASES_API =
  "https://api.github.com/repos/crafter-station/petdex/releases?per_page=20";
const DESKTOP_TAG_PREFIX = "desktop-v";
// Fallback when the GitHub API is unreachable or the repo has no
// desktop release yet. The releases page itself isn't ideal (it can
// show a non-desktop release at the top) but it's strictly better
// than 5xx-ing the user.
const RELEASES_PAGE =
  "https://github.com/crafter-station/petdex/releases";

type GhRelease = {
  tag_name?: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
};

async function resolveDesktopRelease(): Promise<string> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return RELEASES_PAGE;
    const data = (await res.json()) as GhRelease[];
    if (!Array.isArray(data)) return RELEASES_PAGE;
    // GH lists newest-first. Skip drafts (not public) and prereleases
    // (we don't ship those for desktop yet) and pick the first
    // desktop-v* tag we see.
    const hit = data.find(
      (r) =>
        !r.draft &&
        !r.prerelease &&
        typeof r.tag_name === "string" &&
        r.tag_name.startsWith(DESKTOP_TAG_PREFIX),
    );
    if (hit?.html_url) return hit.html_url;
    if (hit?.tag_name) {
      return `https://github.com/crafter-station/petdex/releases/tag/${hit.tag_name}`;
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
