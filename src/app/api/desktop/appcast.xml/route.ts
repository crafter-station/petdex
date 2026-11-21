import { NextResponse } from "next/server";

import {
  type GhRelease,
  pickAssetForPlatform,
  releasePageUrl,
} from "@/lib/desktop-release";

export const runtime = "nodejs";
export const revalidate = 300;

const RELEASES_API_BASE =
  "https://api.github.com/repos/crafter-station/petdex/releases";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function fetchLatestDesktopRelease(): Promise<GhRelease | null> {
  try {
    const res = await fetch(`${RELEASES_API_BASE}?per_page=30&page=1`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const releases = (await res.json()) as GhRelease[];
    if (!Array.isArray(releases)) return null;
    return (
      releases.find(
        (r) =>
          !r.draft &&
          !r.prerelease &&
          typeof r.tag_name === "string" &&
          r.tag_name.startsWith("desktop-v"),
      ) ?? null
    );
  } catch {
    return null;
  }
}

export async function GET(): Promise<Response> {
  const release = await fetchLatestDesktopRelease();
  const items: string[] = [];

  if (release?.tag_name) {
    const version = release.tag_name.replace(/^desktop-v/, "");
    const arm64Asset = pickAssetForPlatform(release, "darwin-arm64");
    const enclosureUrl =
      arm64Asset?.browser_download_url ?? releasePageUrl(release);
    const notesUrl = releasePageUrl(release);
    const pubDate = new Date().toUTCString();

    items.push(`    <item>
      <title>Petdex ${escapeXml(version)}</title>
      <pubDate>${escapeXml(pubDate)}</pubDate>
      <sparkle:releaseNotesLink>${escapeXml(notesUrl)}</sparkle:releaseNotesLink>
      <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
      <enclosure
        url="${escapeXml(enclosureUrl)}"
        sparkle:version="${escapeXml(version)}"
        sparkle:shortVersionString="${escapeXml(version)}"
        type="application/octet-stream"
      />
    </item>`);
  }

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Petdex Desktop Updates</title>
    <link>https://petdex.dev/download</link>
    <description>Native macOS updates for Petdex Desktop by Crafter Station.</description>
    <language>en</language>
${items.join("\n")}
  </channel>
</rss>
`;

  return new NextResponse(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}
