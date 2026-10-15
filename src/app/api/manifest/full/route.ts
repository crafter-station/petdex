import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";

import { getAllPetsPackPath } from "@/lib/downloads";
import { logManifestFetch } from "@/lib/manifest-telemetry";
import { getAllApprovedPets } from "@/lib/pets";
import { publicOrigin } from "@/lib/public-origin";
import { manifestFullRatelimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-user data on a URL that carries no user identity, so no intermediary may
// reuse any branch of it — including the failures. A bare 401/429 is
// heuristically cacheable on a GET, and the deployment runs a
// cache-everything rule in front.
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

// Authenticated, full-fat manifest. Only returns when the caller is
// signed in. Surfaces description, tags, vibes, install commands,
// page URLs and counts — anything richer than the slim public path.
//
// Rate-limited per userId because the response is heavy (full DB scan)
// and the endpoint cannot be edge-cached — every hit wakes a function.
export async function GET(req: Request): Promise<Response> {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: PRIVATE_HEADERS },
    );
  }
  const lim = await manifestFullRatelimit.limit(userId);
  if (!lim.success) {
    return NextResponse.json(
      { error: "rate_limited", retryAfter: lim.reset },
      {
        status: 429,
        headers: {
          ...PRIVATE_HEADERS,
          "Retry-After": String(
            Math.max(1, Math.ceil((lim.reset - Date.now()) / 1000)),
          ),
        },
      },
    );
  }
  void logManifestFetch(req, "full");

  const origin = publicOrigin(req);
  const pets = await getAllApprovedPets();

  const items = pets.map((pet) => ({
    slug: pet.slug,
    displayName: pet.displayName,
    description: pet.description,
    kind: pet.kind,
    vibes: pet.vibes,
    tags: pet.tags,
    featured: pet.featured ?? false,
    source: pet.source,
    submittedBy: pet.submittedBy?.name ?? null,
    installCommand: `curl -sSf ${origin}/install/${pet.slug} | sh`,
    pageUrl: `${origin}/pets/${pet.slug}`,
    spritesheetUrl: pet.spritesheetPath,
    petJsonUrl: pet.petJsonPath,
    zipUrl: pet.zipUrl ?? null,
    spriteVersionNumber: pet.spriteVersionNumber,
  }));

  return NextResponse.json(
    {
      generatedAt: new Date().toISOString(),
      total: items.length,
      featured: items.filter((p) => p.featured).length,
      allPetsPackPath: getAllPetsPackPath(),
      pets: items,
    },
    {
      headers: {
        // Per-user since this is auth-gated; no shared edge cache.
        "Cache-Control": "private, max-age=30",
        "X-Robots-Tag": "noindex, nofollow",
      },
    },
  );
}
