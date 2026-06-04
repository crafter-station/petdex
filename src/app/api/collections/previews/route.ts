import { NextResponse } from "next/server";

import { getCollectionListingPreviewsBySlugs } from "@/lib/collections";

export const runtime = "nodejs";

const MIN_PETS = 4;
const PETS_PER_PREVIEW = 6;
const MAX_SLUGS = 24;
const CACHE_CONTROL =
  "public, max-age=60, s-maxage=86400, stale-while-revalidate=604800";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const slugs = parsePreviewSlugs(url.searchParams.get("slugs"));
  if (slugs.length === 0) {
    return NextResponse.json(
      { collections: [] },
      { headers: { "Cache-Control": CACHE_CONTROL } },
    );
  }

  const collections = await getCollectionListingPreviewsBySlugs(
    slugs,
    MIN_PETS,
    PETS_PER_PREVIEW,
  );

  return NextResponse.json(
    {
      collections: collections.map((collection) => ({
        slug: collection.slug,
        pets: collection.pets.map((pet) => ({
          slug: pet.slug,
          displayName: pet.displayName,
          spritesheetPath: pet.spritesheetPath,
        })),
      })),
    },
    { headers: { "Cache-Control": CACHE_CONTROL } },
  );
}

function parsePreviewSlugs(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const slugs: string[] = [];
  for (const value of raw.split(",")) {
    const slug = value.trim().toLowerCase();
    if (!SLUG_RE.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
    if (slugs.length >= MAX_SLUGS) break;
  }
  return slugs;
}
