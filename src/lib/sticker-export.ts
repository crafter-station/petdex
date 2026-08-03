import "server-only";

import { and, asc, desc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
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
    where: eq(schema.petCollections.slug, slug),
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
  const pet = await db.query.submittedPets.findFirst({
    where: and(
      eq(schema.submittedPets.slug, slug),
      eq(schema.submittedPets.status, "approved"),
    ),
  });
  if (!pet) return { status: "not_found" };

  const [approval, publication] = await Promise.all([
    db.query.petExportApprovals.findFirst({
      where: and(
        eq(schema.petExportApprovals.petId, pet.id),
        eq(schema.petExportApprovals.scope, STICKER_EXPORT_SCOPE),
      ),
    }),
    db.query.petStickerPublications.findFirst({
      where: eq(schema.petStickerPublications.petId, pet.id),
    }),
  ]);
  if (!isCurrentStickerExportAllowed(pet, approval ?? null)) {
    return { status: "ineligible" };
  }
  if (
    !isCurrentStickerPublication(pet, publication ?? null) ||
    !publication ||
    !hasPublishedStickerArtifact(publication, state, format, treatment)
  ) {
    return { status: "missing" };
  }
  return { status: "ok", petId: pet.id, slug: pet.slug };
}

export async function getPetStickerAvailability(slug: string): Promise<{
  available: boolean;
  collectionSlug: string | null;
}> {
  const idle = await getStickerArtifactAccess(slug, "idle", "webp", "clean");
  if (idle.status !== "ok") return { available: false, collectionSlug: null };
  const collection = await db
    .select({ slug: schema.petCollections.slug })
    .from(schema.petCollectionItems)
    .innerJoin(
      schema.petCollections,
      eq(schema.petCollectionItems.collectionId, schema.petCollections.id),
    )
    .where(eq(schema.petCollectionItems.petSlug, slug))
    .orderBy(
      desc(schema.petCollections.featured),
      asc(schema.petCollections.slug),
    )
    .limit(1);
  return { available: true, collectionSlug: collection[0]?.slug ?? null };
}
