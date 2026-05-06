import { NextResponse } from "next/server";

import { logManifestFetch } from "@/lib/manifest-telemetry";
import { getAllApprovedPets } from "@/lib/pets";

// Cache the slim manifest at the edge for 5 minutes with a 1h
// stale-while-revalidate window. Pet listings turn over slowly and the
// CLI hits this endpoint on every `petdex list` / `petdex install`
// invocation. Without edge cache every CLI install woke a function and
// burned an invocation; the s-maxage hint below was previously
// neutralized by force-dynamic.

// Slim public manifest. Returns only the fields the CLI strictly
// needs: slug, displayName, kind, submittedBy display name, and the
// asset URLs for `petdex install`. Everything richer (description,
// tags, vibes, install command strings, page URLs, counts, source,
// IDs) lives behind /api/manifest/full which requires auth.
//
// The shape stays a JSON object with `pets: [...]` so older CLI
// versions keep working — they just won't see fields they never read.
export async function GET(req: Request): Promise<Response> {
  void logManifestFetch(req, "slim");
  const pets = await getAllApprovedPets();

  const items = pets.map((pet) => ({
    slug: pet.slug,
    displayName: pet.displayName,
    kind: pet.kind,
    submittedBy: pet.submittedBy?.name ?? null,
    spritesheetUrl: pet.spritesheetPath,
    petJsonUrl: pet.petJsonPath,
    zipUrl: pet.zipUrl ?? null,
  }));

  return NextResponse.json(
    {
      generatedAt: new Date().toISOString(),
      total: items.length,
      pets: items,
    },
    {
      headers: {
        // Edge serves the cached payload for 5 minutes, falls back to
        // a stale copy for up to an hour while it revalidates in the
        // background. Browsers / CLIs see a fresh-ish list every 60s.
        "Cache-Control":
          "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
        "X-Robots-Tag": "noindex, nofollow",
      },
    },
  );
}
