import { NextResponse } from "next/server";

import { and, eq, ne } from "drizzle-orm";

import { AGGREGATE_KEYS, cachedAggregate } from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RANDOM_POOL_TTL_SECONDS = 300;

type RandomPet = {
  slug: string;
  displayName: string;
  description: string;
  spritesheetPath: string;
};

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
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }

  if (!next) {
    return NextResponse.redirect(new URL("/", req.url), 302);
  }
  return NextResponse.redirect(new URL(`/pets/${next.slug}`, req.url), 302);
}

async function getRandomPetPool(): Promise<RandomPet[]> {
  return cachedAggregate(
    {
      key: AGGREGATE_KEYS.randomPetPool,
      ttlSeconds: RANDOM_POOL_TTL_SECONDS,
    },
    async () =>
      db
        .select({
          slug: schema.submittedPets.slug,
          displayName: schema.submittedPets.displayName,
          description: schema.submittedPets.description,
          spritesheetPath: schema.submittedPets.spritesheetUrl,
        })
        .from(schema.submittedPets)
        .where(
          and(
            eq(schema.submittedPets.status, "approved"),
            ne(schema.submittedPets.source, "discover"),
          ),
        ),
  );
}
