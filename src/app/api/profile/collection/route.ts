import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, asc, eq, type SQLWrapper } from "drizzle-orm";

import { canManageCreatorCollections } from "@/lib/collection-access";
import {
  normalizeCollectionPatch,
  resolveCollectionCover,
} from "@/lib/collection-input";
import {
  invalidateCollectionBacklinks,
  revalidateCollectionTags,
} from "@/lib/db/cached-aggregates";
import { db, executeAtomic, schema } from "@/lib/db/client";
import { validateProfileHandle } from "@/lib/profiles";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PETS = 24;

export async function PATCH(req: Request): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await canManageCreatorCollections(userId)))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = normalizeCollectionPatch(input);
  if ("error" in parsed)
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { petSlugs, ...patch } = parsed.value;
  if (Object.keys(parsed.value).length === 0)
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });

  const [collection] = await db
    .select()
    .from(schema.petCollections)
    .where(eq(schema.petCollections.ownerId, userId))
    .limit(1);
  const oldItems = collection
    ? await db
        .select({ slug: schema.petCollectionItems.petSlug })
        .from(schema.petCollectionItems)
        .where(eq(schema.petCollectionItems.collectionId, collection.id))
        .orderBy(asc(schema.petCollectionItems.position))
    : [];
  const oldSlugs = oldItems.map((row) => row.slug);
  if (!collection && (!patch.title || !petSlugs))
    return NextResponse.json(
      { error: !patch.title ? "title_length" : "empty_pet_list" },
      { status: 400 },
    );

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
    const allowed = new Set(approvedPets.map((pet) => pet.slug));
    if (petSlugs.some((slug) => !allowed.has(slug)))
      return NextResponse.json({ error: "invalid_pet_slugs" }, { status: 400 });
    if (
      petSlugs.length > MAX_PETS &&
      petSlugs.some((slug) => !oldSlugs.includes(slug))
    )
      return NextResponse.json(
        { error: "collection_pet_limit" },
        { status: 400 },
      );
    patch.coverPetSlug = resolveCollectionCover(
      petSlugs,
      patch.coverPetSlug,
      collection?.coverPetSlug,
    );
  }
  const members = petSlugs ?? oldSlugs;
  if (patch.coverPetSlug && !members.includes(patch.coverPetSlug))
    return NextResponse.json(
      { error: "cover_not_in_collection" },
      { status: 400 },
    );

  let saved: typeof schema.petCollections.$inferInsert;
  let parentWrite: SQLWrapper;
  if (collection) {
    saved = { ...collection, ...patch, updatedAt: new Date() };
    parentWrite = db
      .update(schema.petCollections)
      .set({ ...patch, updatedAt: saved.updatedAt })
      .where(eq(schema.petCollections.id, collection.id));
  } else {
    const profile = await db.query.userProfiles.findFirst({
      where: eq(schema.userProfiles.userId, userId),
    });
    const title = patch.title ?? "";
    saved = {
      id: `col_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`,
      slug: await collectionSlugForOwner(profile?.handle ?? title, userId),
      title,
      description: patch.description ?? "",
      externalUrl: patch.externalUrl ?? null,
      coverPetSlug: patch.coverPetSlug ?? null,
      ownerId: userId,
      featured: false,
    };
    parentWrite = db.insert(schema.petCollections).values(saved);
  }
  const writes: [SQLWrapper, ...SQLWrapper[]] = [parentWrite];
  if (petSlugs !== undefined) {
    writes.push(
      db
        .delete(schema.petCollectionItems)
        .where(eq(schema.petCollectionItems.collectionId, saved.id)),
    );
    writes.push(
      db.insert(schema.petCollectionItems).values(
        petSlugs.map((petSlug, index) => ({
          collectionId: saved.id,
          petSlug,
          position: index + 1,
        })),
      ),
    );
  }
  await executeAtomic(writes);
  if (collection?.featured)
    await invalidateCollectionBacklinks(...oldSlugs, ...members);
  await revalidateCollectionTags(saved.slug);
  return NextResponse.json({
    ok: true,
    collection: {
      id: saved.id,
      slug: saved.slug,
      title: saved.title,
      description: saved.description,
      externalUrl: saved.externalUrl,
      coverPetSlug: saved.coverPetSlug,
      petSlugs: members,
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
    if (!existing || existing.ownerId === userId) return candidate;
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
