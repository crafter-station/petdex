import "server-only";

import { and, asc, desc, eq, isNull } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { withNextDataCache } from "@/lib/next-data-cache";
import type { PetStateId } from "@/lib/pet-states";
import type {
  PetStickerFormat,
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
        treatments: row.publication?.treatments as PetStickerTreatment[],
      })),
  };
}

export async function getStickerArtifactAccess(
  slug: string,
  state: PetStateId,
  format: PetStickerFormat,
  treatment: PetStickerTreatment,
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
    !hasPublishedStickerArtifact(row.publication, state, format, treatment)
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
