import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, count, eq } from "drizzle-orm";

import {
  canManageCreatorCollections,
  MAX_OWNER_COLLECTIONS,
} from "@/lib/collection-access";
import {
  normalizeCollectionPatch,
  resolveCollectionCover,
} from "@/lib/collection-input";
import { revalidateCollectionTags } from "@/lib/db/cached-aggregates";
import { db, executeAtomic, schema } from "@/lib/db/client";
import { validateProfileHandle } from "@/lib/profiles";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Create a new personal collection. Personal = featured=false. Caps
// at MAX_OWNER_COLLECTIONS per creator.
export async function POST(req: Request): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(await canManageCreatorCollections(userId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = normalizeCollectionPatch(input);
  if ("error" in parsed)
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  const body = parsed.value;
  if (!body.title || !body.petSlugs)
    return NextResponse.json(
      { error: !body.title ? "title_length" : "empty_pet_list" },
      { status: 400 },
    );
  const { title, petSlugs, description = "", externalUrl = null } = body;

  // Cap check — only count owner's personal (unfeatured) ones. Featured
  // ones are admin-curated promotions and don't count.
  const ownedCount = await db
    .select({ c: count() })
    .from(schema.petCollections)
    .where(
      and(
        eq(schema.petCollections.ownerId, userId),
        eq(schema.petCollections.featured, false),
      ),
    );
  if (Number(ownedCount[0]?.c ?? 0) >= MAX_OWNER_COLLECTIONS) {
    return NextResponse.json(
      { error: "collection_cap_reached", max: MAX_OWNER_COLLECTIONS },
      { status: 400 },
    );
  }

  const profile = await db.query.userProfiles.findFirst({
    where: eq(schema.userProfiles.userId, userId),
  });
  const slug = await collectionSlugForOwner(profile?.handle ?? title, userId);
  const id = `col_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;

  const approvedPets = await db
    .select({ slug: schema.submittedPets.slug })
    .from(schema.submittedPets)
    .where(
      and(
        eq(schema.submittedPets.ownerId, userId),
        eq(schema.submittedPets.status, "approved"),
      ),
    );
  const allowedSlugs = new Set(approvedPets.map((p) => p.slug));
  if (petSlugs.some((slug) => !allowedSlugs.has(slug)))
    return NextResponse.json({ error: "invalid_pet_slugs" }, { status: 400 });
  if (body.coverPetSlug && !petSlugs.includes(body.coverPetSlug))
    return NextResponse.json(
      { error: "cover_not_in_collection" },
      { status: 400 },
    );
  const coverPetSlug = resolveCollectionCover(petSlugs, body.coverPetSlug);

  await executeAtomic([
    db.insert(schema.petCollections).values({
      id,
      slug,
      title,
      description,
      ownerId: userId,
      externalUrl,
      coverPetSlug,
      featured: false,
    }),
    db.insert(schema.petCollectionItems).values(
      petSlugs.map((petSlug, index) => ({
        collectionId: id,
        petSlug,
        position: index + 1,
      })),
    ),
  ]);

  await revalidateCollectionTags(slug);

  return NextResponse.json({
    ok: true,
    collection: {
      id,
      slug,
      title,
      description,
      externalUrl,
      coverPetSlug,
      petSlugs,
    },
  });
}

async function collectionSlugForOwner(
  seed: string,
  userId: string,
): Promise<string> {
  let base = slugify(seed);
  if (!base || validateProfileHandle(base) === "reserved") {
    base = `collection-${userId.slice(-8).toLowerCase()}`;
  }
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const existing = await db.query.petCollections.findFirst({
      where: eq(schema.petCollections.slug, candidate),
    });
    if (!existing) return candidate;
  }
  return `collection-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
