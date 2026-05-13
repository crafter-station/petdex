import {
  and,
  asc,
  desc,
  sql as dsql,
  eq,
  getTableColumns,
  gte,
  inArray,
} from "drizzle-orm";

import {
  cachedAggregate,
  collectionBacklinksCacheKey,
} from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";
import { getMetricsBySlugs, type Metrics } from "@/lib/db/metrics";
import { type PetWithMetrics, rowToPet } from "@/lib/pets";

const EMPTY_METRICS: Metrics = {
  installCount: 0,
  zipDownloadCount: 0,
  likeCount: 0,
};
const COLLECTION_BACKLINKS_TTL_SECONDS = 600;

export type PetCollection = typeof schema.petCollections.$inferSelect;

export type PetCollectionWithPets = PetCollection & {
  pets: PetWithMetrics[];
};

export async function getFeaturedCollections(
  limit = 3,
): Promise<PetCollectionWithPets[]> {
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

// Fetch a specific set of collections by slug. Order of the returned
// array matches the order of the input slugs. Missing slugs are
// silently skipped. Used by the home page to show a curated strip
// without paying for a full alphabetical scan + JS filter.
export async function getCollectionsBySlugs(
  slugs: string[],
  petsPerCollection = 6,
): Promise<PetCollectionWithPets[]> {
  if (slugs.length === 0) return [];
  let rows: PetCollection[];
  try {
    rows = await db
      .select()
      .from(schema.petCollections)
      .where(inArray(schema.petCollections.slug, slugs));
  } catch (error) {
    if (isMissingCollectionTableError(error)) return [];
    throw error;
  }
  const order = new Map(slugs.map((s, i) => [s, i]));
  rows = rows
    .filter((r) => order.has(r.slug))
    .sort((a, b) => (order.get(a.slug) ?? 0) - (order.get(b.slug) ?? 0));
  return hydrateCollections(rows, petsPerCollection);
}

export async function getAllCollections(): Promise<PetCollectionWithPets[]> {
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

// Returns featured collections that have at least `minPets` approved
// pets, with a small sample for the cover preview. Used by the public
// /collections listing — keeps the page fast even with hundreds of
// collections by filtering at the SQL level.
export async function getCollectionsForListing(
  minPets = 4,
  petsPerPreview = 6,
): Promise<(PetCollectionWithPets & { petCount: number })[]> {
  let rows: (PetCollection & { petCount: number })[];
  try {
    const result = await db
      .select({
        ...getTableColumns(schema.petCollections),
        petCount: dsql<number>`count(${schema.petCollectionItems.petSlug})`.as(
          "pet_count",
        ),
      })
      .from(schema.petCollections)
      .leftJoin(
        schema.petCollectionItems,
        eq(schema.petCollectionItems.collectionId, schema.petCollections.id),
      )
      .where(eq(schema.petCollections.featured, true))
      .groupBy(schema.petCollections.id)
      .having(
        gte(dsql<number>`count(${schema.petCollectionItems.petSlug})`, minPets),
      )
      .orderBy(
        desc(dsql`count(${schema.petCollectionItems.petSlug})`),
        asc(schema.petCollections.title),
      );
    rows = result.map((r) => ({
      ...r,
      petCount: Number(r.petCount),
    }));
  } catch (error) {
    if (isMissingCollectionTableError(error)) return [];
    throw error;
  }

  const hydrated = await hydrateCollections(rows, petsPerPreview);
  // Re-attach the pet count we computed (hydrate doesn't carry it).
  const countBySlug = new Map(rows.map((r) => [r.slug, r.petCount]));
  return hydrated.map((c) => ({
    ...c,
    petCount: countBySlug.get(c.slug) ?? c.pets.length,
  }));
}

export async function getCollection(
  slug: string,
): Promise<PetCollectionWithPets | null> {
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

// Personal collections owned by a creator. NOT filtered by featured —
// these are intentionally private (only surfaced on /u/<owner-handle>).
// Featured = true on an owner collection means an admin has promoted it
// to /collections; that's a separate concern handled by the curation
// workflow, not the owner editor.
export async function getOwnerCollections(
  ownerId: string,
  petsPerPreview = 6,
): Promise<(PetCollectionWithPets & { petCount: number })[]> {
  let rows: (PetCollection & { petCount: number })[];
  try {
    const result = await db
      .select({
        ...getTableColumns(schema.petCollections),
        petCount: dsql<number>`count(${schema.petCollectionItems.petSlug})`.as(
          "pet_count",
        ),
      })
      .from(schema.petCollections)
      .leftJoin(
        schema.petCollectionItems,
        eq(schema.petCollectionItems.collectionId, schema.petCollections.id),
      )
      .where(eq(schema.petCollections.ownerId, ownerId))
      .groupBy(schema.petCollections.id)
      .orderBy(
        // Curated/promoted first (admin-curated takes priority on
        // the visitor view), then most recently edited.
        desc(schema.petCollections.featured),
        desc(schema.petCollections.updatedAt),
        asc(schema.petCollections.title),
      );
    rows = result.map((r) => ({ ...r, petCount: Number(r.petCount) }));
  } catch (error) {
    if (isMissingCollectionTableError(error)) return [];
    throw error;
  }

  const hydrated = await hydrateCollections(rows, petsPerPreview);
  const countBySlug = new Map(rows.map((r) => [r.slug, r.petCount]));
  return hydrated.map((c) => ({
    ...c,
    petCount: countBySlug.get(c.slug) ?? c.pets.length,
  }));
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
  return cachedAggregate(
    {
      key: collectionBacklinksCacheKey(petSlug),
      ttlSeconds: COLLECTION_BACKLINKS_TTL_SECONDS,
    },
    async () => {
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
            eq(
              schema.petCollectionItems.collectionId,
              schema.petCollections.id,
            ),
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
    },
  );
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
