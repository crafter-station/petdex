import { NextResponse } from "next/server";

import { getRandomPetPool } from "@/lib/random-pet-pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RANDOM_CACHE_CONTROL =
  "public, max-age=30, s-maxage=60, stale-while-revalidate=300";
const RANDOM_VARY = "Accept";

// GET /api/pets/random?exclude=current-slug
//
// Picks a random approved pet (excluding the optional `exclude` slug).
// Behaviour depends on the Accept header:
//   - Accept: application/json -> JSON `{ slug }` payload (used by the
//     keyboard shortcut so the client can router.push without an
//     opaque 302 redirect).
//   - default                  -> 302 to /pets/<slug> (used by the
//     plain <a href> shuffle pill so a click without JS still works).
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const exclude = url.searchParams.get("exclude") ?? "";
  const wantsJson = (req.headers.get("accept") ?? "").includes(
    "application/json",
  );

  const pool = await getRandomPetPool();
  const candidates = exclude
    ? pool.filter((pet) => pet.slug !== exclude)
    : pool;
  const next = candidates[Math.floor(Math.random() * candidates.length)];

  if (wantsJson) {
    if (!next) {
      return NextResponse.json({ error: "no pets available" }, { status: 404 });
    }
    return NextResponse.json(
      {
        slug: next.slug,
        displayName: next.displayName,
        description: next.description,
        spritesheetPath: next.spritesheetPath,
        href: `/pets/${next.slug}`,
        installHref: `/install/${next.slug}`,
      },
      {
        headers: {
          "Cache-Control": RANDOM_CACHE_CONTROL,
          Vary: RANDOM_VARY,
        },
      },
    );
  }

  if (!next) {
    return NextResponse.redirect(new URL("/", req.url), {
      status: 302,
      headers: { "Cache-Control": "private, no-store", Vary: RANDOM_VARY },
    });
  }
  return NextResponse.redirect(new URL(`/pets/${next.slug}`, req.url), {
    status: 302,
    headers: { "Cache-Control": RANDOM_CACHE_CONTROL, Vary: RANDOM_VARY },
  });
}
