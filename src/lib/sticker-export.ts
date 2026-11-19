import "server-only";

import { and, asc, desc, eq, isNull } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { withNextDataCache } from "@/lib/next-data-cache";
import type { PetStateId } from "@/lib/pet-states";
import type {
  PetStickerFormat,
  PetStickerProfile,
  PetStickerTreatment,
} from "@/lib/pet-sticker-artifacts";
import {
  hasPublishedStickerArtifact,
  isCurrentStickerExportAllowed,
  isCurrentStickerPublication,
  isStickerExplorerEnabled,
  isStickerExportDisabled,
  STICKER_EXPORT_SCOPE,
} from "@/lib/sticker-export-policy";

export type StickerCollectionPet = {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  dominantColor: string | null;
  states: PetStateId[];
  formats: PetStickerFormat[];
  profiles: PetStickerProfile[];
  treatments: PetStickerTreatment[];
};

export type StickerCollection = {
  slug: string;
  title: string;
  description: string;
  pets: StickerCollectionPet[];
};

export type StickerArtifactAccess =
  | { status: "disabled" }
  | { status: "not_found" }
  | { status: "ineligible" }
  | { status: "missing" }
  | { status: "ok"; petId: string; slug: string };

export async function getStickerCollection(
  rawSlug: string,
): Promise<StickerCollection | null> {
  if (!isStickerExplorerEnabled()) return null;
  const slug = rawSlug.trim().toLowerCase();
  const collection = await db.query.petCollections.findFirst({
    where: and(
      eq(schema.petCollections.slug, slug),
      isNull(schema.petCollections.ownerId),
    ),
  });
  if (!collection) return null;

  const rows = await db
    .select({
      id: schema.submittedPets.id,
      slug: schema.submittedPets.slug,
      displayName: schema.submittedPets.displayName,
      description: schema.submittedPets.description,
      dominantColor: schema.submittedPets.dominantColor,
      status: schema.submittedPets.status,
      spriteSha256: schema.submittedPets.spriteSha256,
      approval: schema.petExportApprovals,
      publication: schema.petStickerPublications,
    })
    .from(schema.petCollectionItems)
    .innerJoin(
      schema.submittedPets,
      eq(schema.petCollectionItems.petSlug, schema.submittedPets.slug),
    )
    .leftJoin(
      schema.petExportApprovals,
      and(
        eq(schema.petExportApprovals.petId, schema.submittedPets.id),
        eq(schema.petExportApprovals.scope, STICKER_EXPORT_SCOPE),
      ),
    )
    .leftJoin(
      schema.petStickerPublications,
      eq(schema.petStickerPublications.petId, schema.submittedPets.id),
    )
    .where(eq(schema.petCollectionItems.collectionId, collection.id))
    .orderBy(asc(schema.petCollectionItems.position));

  return {
    slug: collection.slug,
    title: collection.title,
    description: collection.description,
    pets: rows
      .filter(
        (row) =>
          isCurrentStickerExportAllowed(row, row.approval) &&
          isCurrentStickerPublication(row, row.publication),
      )
      .map((row) => ({
        id: row.id,
        slug: row.slug,
        displayName: row.displayName,
        description: row.description,
        dominantColor: row.dominantColor,
        states: row.publication?.states as PetStateId[],
        formats: row.publication?.formats as PetStickerFormat[],
        profiles: row.publication?.profiles as PetStickerProfile[],
        treatments: row.publication?.treatments as PetStickerTreatment[],
      })),
  };
}

export type StickerSitemapEntry = {
  slug: string;
  updatedAt: Date | null;
};

/**
 * The sticker collections worth listing in `sitemap.xml`.
 *
 * The page behind `/stickers/[collection]` reaches 200 and inherits
 * `index, follow` from the layout exactly when the explorer is on and the
 * collection has at least one pet the current policy publishes — the
 * `pets.length === 0` guard calls `notFound()` otherwise. So the sitemap has
 * to reproduce both conditions, or it advertises 404s; that is the same
 * two-way pairing the vibe and kind entries rely on, and the reason this
 * reuses `isStickerExplorerEnabled` and the per-pet predicates rather than
 * listing slugs.
 *
 * Explorer off means the whole route 404s, so the list is empty rather than
 * a set of entries for pages that do not exist. `STICKER_EXPORT_DISABLED`
 * is read inside `isStickerExplorerEnabled`, so a kill switch also removes
 * these entries.
 *
 * Redis-free on purpose: a Redis call anywhere in the sitemap's call graph
 * makes Next render `/sitemap.xml` dynamically and moves `<lastmod>` to
 * request time. `db.query` and the `unstable_cache`d read below do not.
 */
export async function getStickerSitemapEntries(): Promise<
  StickerSitemapEntry[]
> {
  if (!isStickerExplorerEnabled()) return [];
  return withNextDataCache(
    async () => {
      try {
        const rows = await db
          .select({
            id: schema.petCollections.id,
            slug: schema.petCollections.slug,
            updatedAt: schema.petCollections.updatedAt,
            status: schema.submittedPets.status,
            spriteSha256: schema.submittedPets.spriteSha256,
            approval: schema.petExportApprovals,
            publication: schema.petStickerPublications,
          })
          .from(schema.petCollections)
          .innerJoin(
            schema.petCollectionItems,
            eq(
              schema.petCollectionItems.collectionId,
              schema.petCollections.id,
            ),
          )
          .innerJoin(
            schema.submittedPets,
            eq(schema.petCollectionItems.petSlug, schema.submittedPets.slug),
          )
          .leftJoin(
            schema.petExportApprovals,
            and(
              eq(schema.petExportApprovals.petId, schema.submittedPets.id),
              eq(schema.petExportApprovals.scope, STICKER_EXPORT_SCOPE),
            ),
          )
          .leftJoin(
            schema.petStickerPublications,
            eq(schema.petStickerPublications.petId, schema.submittedPets.id),
          )
          // Owner-scoped collections are not sticker collections; the page
          // filters them the same way `getStickerCollection` does.
          .where(isNull(schema.petCollections.ownerId))
          .orderBy(asc(schema.petCollections.slug));

        // A collection is listed when at least one of its pets survives the
        // same filter `getStickerCollection` applies, so the sitemap and a
        // reachable page are the same set. `Set` collapses the one entry per
        // qualifying pet that the join produces.
        const populated = new Set<string>();
        const updatedAt = new Map<string, Date | null>();
        for (const row of rows) {
          updatedAt.set(row.slug, row.updatedAt);
          if (
            isCurrentStickerExportAllowed(row, row.approval) &&
            isCurrentStickerPublication(row, row.publication)
          ) {
            populated.add(row.slug);
          }
        }
        return [...populated]
          .map((slug) => ({ slug, updatedAt: updatedAt.get(slug) ?? null }))
          .sort((a, b) => a.slug.localeCompare(b.slug));
      } catch (error) {
        if (isMissingStickerTableError(error)) return [];
        throw error;
      }
    },
    ["petdex-sticker-sitemap-entries"],
    { tags: ["collection:list", "sticker:collections"], revalidate: 86400 },
  )();
}

export async function getStickerArtifactAccess(
  slug: string,
  state: PetStateId,
  format: PetStickerFormat,
  treatment: PetStickerTreatment,
  profile: PetStickerProfile = "web",
): Promise<StickerArtifactAccess> {
  if (isStickerExportDisabled()) return { status: "disabled" };
  const loadAccess = withNextDataCache(
    async () => {
      const rows = await db
        .select({
          pet: schema.submittedPets,
          approval: schema.petExportApprovals,
          publication: schema.petStickerPublications,
        })
        .from(schema.submittedPets)
        .leftJoin(
          schema.petExportApprovals,
          and(
            eq(schema.petExportApprovals.petId, schema.submittedPets.id),
            eq(schema.petExportApprovals.scope, STICKER_EXPORT_SCOPE),
          ),
        )
        .leftJoin(
          schema.petStickerPublications,
          eq(schema.petStickerPublications.petId, schema.submittedPets.id),
        )
        .where(
          and(
            eq(schema.submittedPets.slug, slug),
            eq(schema.submittedPets.status, "approved"),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    ["sticker-artifact-access", slug],
    { tags: [`pet:${slug}`, `sticker:${slug}`], revalidate: 60 },
  );
  const row = await loadAccess();
  if (!row) return { status: "not_found" };
  if (!isCurrentStickerExportAllowed(row.pet, row.approval)) {
    return { status: "ineligible" };
  }
  if (
    !isCurrentStickerPublication(row.pet, row.publication) ||
    !row.publication ||
    !hasPublishedStickerArtifact(
      row.publication,
      state,
      format,
      treatment,
      profile,
    )
  ) {
    return { status: "missing" };
  }
  return { status: "ok", petId: row.pet.id, slug: row.pet.slug };
}

export async function getPetStickerAvailability(slug: string): Promise<{
  available: boolean;
  collectionSlug: string | null;
}> {
  if (!isStickerExplorerEnabled()) {
    return { available: false, collectionSlug: null };
  }
  const idle = await getStickerArtifactAccess(slug, "idle", "webp", "clean");
  if (idle.status !== "ok") return { available: false, collectionSlug: null };
  const collection = await db
    .select({ slug: schema.petCollections.slug })
    .from(schema.petCollectionItems)
    .innerJoin(
      schema.petCollections,
      eq(schema.petCollectionItems.collectionId, schema.petCollections.id),
    )
    .where(
      and(
        eq(schema.petCollectionItems.petSlug, slug),
        isNull(schema.petCollections.ownerId),
      ),
    )
    .orderBy(
      desc(schema.petCollections.featured),
      asc(schema.petCollections.slug),
    )
    .limit(1);
  return { available: true, collectionSlug: collection[0]?.slug ?? null };
}

/**
 * Postgres `undefined_table`. A deployment whose schema predates the sticker
 * tables has no collections to list, and the sitemap should render without them
 * rather than fail — the same tolerance `src/lib/collections.ts` applies.
 */
function isMissingStickerTableError(error: unknown): boolean {
  const cause =
    error && typeof error === "object" && "cause" in error
      ? (error as { cause?: unknown }).cause
      : error;
  if (!cause || typeof cause !== "object") return false;
  const code = "code" in cause ? (cause as { code?: unknown }).code : null;
  return code === "42P01";
}
