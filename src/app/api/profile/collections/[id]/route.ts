import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, eq, type SQLWrapper } from "drizzle-orm";

import { canManageCreatorCollections } from "@/lib/collection-access";
import {
  normalizeCollectionPatch,
  resolveCollectionCover,
} from "@/lib/collection-input";
import { revalidateCollectionTags } from "@/lib/db/cached-aggregates";
import { db, executeAtomic, schema } from "@/lib/db/client";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { id: string };

// Edit one of the caller's personal collections. Featured/admin
// collections are NOT editable here even if owner_id matches — those
// are admin-curated.
export async function PATCH(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(await canManageCreatorCollections(userId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;

  const collection = await db.query.petCollections.findFirst({
    where: eq(schema.petCollections.id, id),
  });
  if (!collection || collection.ownerId !== userId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (collection.featured) {
    return NextResponse.json(
      { error: "featured_not_editable" },
      { status: 403 },
    );
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
  const { petSlugs, ...patch } = body;
  const membershipWrites: SQLWrapper[] = [];

  if (petSlugs !== undefined) {
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
    if (petSlugs.some((slug) => !allowedSlugs.has(slug))) {
      return NextResponse.json({ error: "invalid_pet_slugs" }, { status: 400 });
    }
    if (body.coverPetSlug && !petSlugs.includes(body.coverPetSlug)) {
      return NextResponse.json(
        { error: "cover_not_in_collection" },
        { status: 400 },
      );
    }

    membershipWrites.push(
      db
        .delete(schema.petCollectionItems)
        .where(eq(schema.petCollectionItems.collectionId, id)),
    );
    if (petSlugs.length > 0) {
      membershipWrites.push(
        db.insert(schema.petCollectionItems).values(
          petSlugs.map((petSlug, index) => ({
            collectionId: id,
            petSlug,
            position: index + 1,
          })),
        ),
      );
    }

    patch.coverPetSlug = resolveCollectionCover(
      petSlugs,
      body.coverPetSlug,
      collection.coverPetSlug,
    );
  } else if (body.coverPetSlug !== undefined) {
    // Cover-only update — verify the slug is currently in the collection.
    const items = await db
      .select({ slug: schema.petCollectionItems.petSlug })
      .from(schema.petCollectionItems)
      .where(eq(schema.petCollectionItems.collectionId, id));
    const set = new Set(items.map((r) => r.slug));
    if (body.coverPetSlug && !set.has(body.coverPetSlug)) {
      return NextResponse.json(
        { error: "cover_not_in_collection" },
        { status: 400 },
      );
    }
    patch.coverPetSlug = body.coverPetSlug ?? null;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
  }

  await executeAtomic([
    db
      .update(schema.petCollections)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.petCollections.id, id)),
    ...membershipWrites,
  ]);

  await revalidateCollectionTags(collection.slug);

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;

  const collection = await db.query.petCollections.findFirst({
    where: eq(schema.petCollections.id, id),
  });
  if (!collection || collection.ownerId !== userId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (collection.featured) {
    return NextResponse.json(
      { error: "featured_not_deletable" },
      { status: 403 },
    );
  }

  await db
    .delete(schema.petCollections)
    .where(eq(schema.petCollections.id, id));

  await revalidateCollectionTags(collection.slug);

  return NextResponse.json({ ok: true });
}
