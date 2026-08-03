import type { schema } from "@/lib/db/client";
import {
  PET_STICKER_STATES,
  type PetStickerFormat,
  type PetStickerTreatment,
} from "@/lib/pet-sticker-artifacts";

export const STICKER_EXPORT_SCOPE = "stickers";
export const STICKER_EXPORT_POLICY_VERSION = "sticker-export-v1";
export const STICKER_ARTIFACT_VERSION = "petdex-stickers-v1";
export const STICKER_PUBLIC_FORMATS = ["webp", "png"] as const;
export const STICKER_PUBLIC_TREATMENTS = ["clean", "outline"] as const;

type StickerApproval = typeof schema.petExportApprovals.$inferSelect;
type StickerPublication = typeof schema.petStickerPublications.$inferSelect;

type EligiblePet = {
  status: "pending" | "approved" | "rejected";
  spriteSha256: string | null;
};

export function isStickerExportDisabled(): boolean {
  return readBooleanEnv(process.env.STICKER_EXPORT_DISABLED);
}

export function isStickerExplorerEnabled(): boolean {
  return (
    !isStickerExportDisabled() &&
    readBooleanEnv(process.env.STICKER_EXPLORER_ENABLED)
  );
}

export function isCurrentStickerExportAllowed(
  pet: EligiblePet,
  approval: StickerApproval | null,
): boolean {
  return Boolean(
    pet.status === "approved" &&
      pet.spriteSha256 &&
      approval?.scope === STICKER_EXPORT_SCOPE &&
      approval.status === "allowed" &&
      approval.sourceSha256 === pet.spriteSha256 &&
      approval.policyVersion === STICKER_EXPORT_POLICY_VERSION,
  );
}

export function isCurrentStickerPublication(
  pet: EligiblePet,
  publication: StickerPublication | null,
): boolean {
  return Boolean(
    pet.spriteSha256 &&
      publication?.status === "complete" &&
      publication.sourceSha256 === pet.spriteSha256 &&
      publication.artifactVersion === STICKER_ARTIFACT_VERSION &&
      includesAll(publication.states, PET_STICKER_STATES) &&
      includesAll(publication.formats, STICKER_PUBLIC_FORMATS) &&
      includesAll(publication.treatments, STICKER_PUBLIC_TREATMENTS),
  );
}

export function hasPublishedStickerArtifact(
  publication: StickerPublication,
  state: string,
  format: PetStickerFormat,
  treatment: PetStickerTreatment,
): boolean {
  return (
    publication.states.includes(state) &&
    publication.formats.includes(format) &&
    publication.treatments.includes(treatment)
  );
}

function includesAll(actual: string[], required: readonly string[]): boolean {
  const values = new Set(actual);
  return required.every((value) => values.has(value));
}

function readBooleanEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}
