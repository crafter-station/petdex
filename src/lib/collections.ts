import { cacheLife, cacheTag } from "next/cache";

import { and, asc, desc, eq, getTableColumns, inArray } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { getMetricsBySlugs, type Metrics } from "@/lib/db/metrics";
import { type PetWithMetrics, rowToPet } from "@/lib/pets";

const EMPTY_METRICS: Metrics = {
  installCount: 0,
  zipDownloadCount: 0,
  likeCount: 0,
};

export type PetCollection = typeof schema.petCollections.$inferSelect;

export type PetCollectionWithPets = PetCollection & {
  pets: PetWithMetrics[];
};

export async function getFeaturedCollections(
  limit = 3,
): Promise<PetCollectionWithPets[]> {
  "use cache";
  cacheLife("hours");
  cacheTag("gallery");
  cacheTag("collections");

  let rows: PetCollection[];
  try {
    rows = await db
      .select()
      .from(schema.petCollections)
      .where(eq(schema.petCollections.featured, true))
      .orderBy(asc(schema.petCollections.title))
      .limit(limit);
  } catch (error) {
    if (isMissingCollectionTableError(error)) return [];
    throw error;
  }

  return hydrateCollections(rows, 6);
}

export async function getAllCollections(): Promise<PetCollectionWithPets[]> {
  "use cache";
  cacheLife("hours");
  cacheTag("collections");

  let rows: PetCollection[];
  try {
    rows = await db
      .select()
      .from(schema.petCollections)
      .orderBy(asc(schema.petCollections.title));
  } catch (error) {
    if (isMissingCollectionTableError(error)) return [];
    throw error;
  }

  return hydrateCollections(rows);
}

export async function getCollection(
  slug: string,
): Promise<PetCollectionWithPets | null> {
  "use cache";
  cacheLife("hours");
  cacheTag("collections");
  cacheTag(`collection:${slug}`);

  let row: PetCollection | undefined;
  try {
    row = await db.query.petCollections.findFirst({
      where: eq(schema.petCollections.slug, slug.toLowerCase()),
    });
  } catch (error) {
    if (isMissingCollectionTableError(error)) return null;
    throw error;
  }
  if (!row) return null;
  const [collection] = await hydrateCollections([row]);
  return collection ?? null;
}

export async function getOwnerCollection(
  ownerId: string,
): Promise<PetCollectionWithPets | null> {
  let rows: PetCollection[];
  try {
    rows = await db
      .select()
      .from(schema.petCollections)
      .where(eq(schema.petCollections.ownerId, ownerId))
      .orderBy(
        desc(schema.petCollections.featured),
        asc(schema.petCollections.title),
      )
      .limit(1);
  } catch (error) {
    if (isMissingCollectionTableError(error)) return null;
    throw error;
  }

  const [collection] = await hydrateCollections(rows);
  return collection ?? null;
}

async function hydrateCollections(
  collections: PetCollection[],
  petLimitPerCollection?: number,
): Promise<PetCollectionWithPets[]> {
  if (collections.length === 0) return [];

  const ids = collections.map((collection) => collection.id);
  const petColumns = getTableColumns(schema.submittedPets);
  let rows: Array<
    typeof schema.submittedPets.$inferSelect & {
      collectionId: string;
      position: number;
    }
  >;
  try {
    rows = await db
      .select({
        collectionId: schema.petCollectionItems.collectionId,
        position: schema.petCollectionItems.position,
        ...petColumns,
      })
      .from(schema.petCollectionItems)
      .innerJoin(
        schema.submittedPets,
        eq(schema.petCollectionItems.petSlug, schema.submittedPets.slug),
      )
      .where(
        and(
          inArray(schema.petCollectionItems.collectionId, ids),
          eq(schema.submittedPets.status, "approved"),
        ),
      )
      .orderBy(
        asc(schema.petCollectionItems.collectionId),
        asc(schema.petCollectionItems.position),
      );
  } catch (error) {
    if (isMissingCollectionTableError(error)) {
      return collections.map((collection) => ({ ...collection, pets: [] }));
    }
    throw error;
  }

  const slugs = rows.map((row) => row.slug);
  const metrics = slugs.length ? await getMetricsBySlugs(slugs) : new Map();
  const grouped = new Map<string, PetWithMetrics[]>();

  for (const row of rows) {
    const group = grouped.get(row.collectionId) ?? [];
    if (
      petLimitPerCollection !== undefined &&
      group.length >= petLimitPerCollection
    ) {
      continue;
    }
    group.push({
      ...rowToPet(row),
      metrics: metrics.get(row.slug) ?? EMPTY_METRICS,
    });
    grouped.set(row.collectionId, group);
  }

  return collections.map((collection) => ({
    ...collection,
    pets: grouped.get(collection.id) ?? [],
  }));
}

// Featured collections that DON'T already include the given pet, plus
// the slugs of pending suggestions the owner already submitted. Powers
// the "Suggest for a collection" panel on /pets/[slug] for owners.
export async function getCollectionCandidatesForPet(
  petSlug: string,
  ownerId: string,
): Promise<{
  candidates: Array<{ slug: string; title: string }>;
  alreadyRequested: string[];
}> {
  try {
    const allFeatured = await db
      .select({
        id: schema.petCollections.id,
        slug: schema.petCollections.slug,
        title: schema.petCollections.title,
      })
      .from(schema.petCollections)
      .where(eq(schema.petCollections.featured, true))
      .orderBy(asc(schema.petCollections.title));

    const memberRows = await db
      .select({ collectionId: schema.petCollectionItems.collectionId })
      .from(schema.petCollectionItems)
      .where(eq(schema.petCollectionItems.petSlug, petSlug));
    const memberSet = new Set(memberRows.map((r) => r.collectionId));

    const candidates = allFeatured
      .filter((c) => !memberSet.has(c.id))
      .map((c) => ({ slug: c.slug, title: c.title }));

    const pendingRows = await db
      .select({ collectionId: schema.petCollectionRequests.collectionId })
      .from(schema.petCollectionRequests)
      .where(
        and(
          eq(schema.petCollectionRequests.petSlug, petSlug),
          eq(schema.petCollectionRequests.requestedBy, ownerId),
          eq(schema.petCollectionRequests.status, "pending"),
        ),
      );
    const pendingIds = new Set(pendingRows.map((r) => r.collectionId));
    const alreadyRequested = allFeatured
      .filter((c) => pendingIds.has(c.id))
      .map((c) => c.slug);

    return { candidates, alreadyRequested };
  } catch (error) {
    if (isMissingCollectionTableError(error)) {
      return { candidates: [], alreadyRequested: [] };
    }
    throw error;
  }
}

// Look up which collections contain a given pet slug. Used on the pet
// detail page to surface "part of N collections" backlinks. Returns
// only featured collections to avoid leaking community drafts.
export async function getCollectionsContainingPet(
  petSlug: string,
): Promise<Array<Pick<PetCollection, "slug" | "title" | "ownerId">>> {
  "use cache";
  cacheLife("hours");
  cacheTag("collections");
  cacheTag(`pet:${petSlug}`);

  try {
    const rows = await db
      .select({
        slug: schema.petCollections.slug,
        title: schema.petCollections.title,
        ownerId: schema.petCollections.ownerId,
      })
      .from(schema.petCollectionItems)
      .innerJoin(
        schema.petCollections,
        eq(schema.petCollectionItems.collectionId, schema.petCollections.id),
      )
      .where(
        and(
          eq(schema.petCollectionItems.petSlug, petSlug),
          eq(schema.petCollections.featured, true),
        ),
      )
      .orderBy(asc(schema.petCollections.title));
    return rows;
  } catch (error) {
    if (isMissingCollectionTableError(error)) return [];
    throw error;
  }
}

function isMissingCollectionTableError(error: unknown): boolean {
  const cause =
    error && typeof error === "object" && "cause" in error
      ? (error as { cause?: unknown }).cause
      : error;
  if (!cause || typeof cause !== "object") return false;
  const code = "code" in cause ? (cause as { code?: unknown }).code : null;
  return code === "42P01";
}
