import type { PetStateId } from "@/lib/pet-states";
import { R2_PUBLIC_BASE } from "@/lib/r2-public-url";

export type PetStickerFormat = "webp" | "gif" | "png";
export type PetStickerProfile = "web" | "whatsapp";
export type PetStickerTreatment = "clean" | "outline";

export const PET_STICKER_CACHE_HEADER =
  "public, max-age=31536000, s-maxage=31536000, immutable";
export const PET_STICKER_UNAVAILABLE_CACHE_HEADER =
  "public, max-age=300, s-maxage=300";

export const PET_STICKER_STATES = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
] as const satisfies readonly PetStateId[];

export const PET_STICKER_FORMATS = [
  "webp",
  "gif",
  "png",
] as const satisfies readonly PetStickerFormat[];

export const PET_STICKER_TREATMENTS = [
  "clean",
  "outline",
] as const satisfies readonly PetStickerTreatment[];

export const PET_STICKER_PROFILES = [
  "web",
  "whatsapp",
] as const satisfies readonly PetStickerProfile[];

export function isValidPetSlug(slug: string): boolean {
  return /^[a-z0-9-]{1,80}$/.test(slug);
}

export function parsePetStickerState(value: string | null): PetStateId {
  if (!value) return "idle";
  return PET_STICKER_STATES.includes(value as PetStateId)
    ? (value as PetStateId)
    : "idle";
}

export function parsePetStickerFormat(value: string | null): PetStickerFormat {
  if (!value) return "webp";
  return PET_STICKER_FORMATS.includes(value as PetStickerFormat)
    ? (value as PetStickerFormat)
    : "webp";
}

export function parseExactPetStickerState(
  value: string | null,
): PetStateId | null {
  if (!value) return null;
  return PET_STICKER_STATES.includes(value as PetStateId)
    ? (value as PetStateId)
    : null;
}

export function parseExactPetStickerFormat(
  value: string | null,
): PetStickerFormat | null {
  if (!value) return null;
  return PET_STICKER_FORMATS.includes(value as PetStickerFormat)
    ? (value as PetStickerFormat)
    : null;
}

export function parseExactPetStickerTreatment(
  value: string | null,
): PetStickerTreatment | null {
  if (!value) return null;
  return PET_STICKER_TREATMENTS.includes(value as PetStickerTreatment)
    ? (value as PetStickerTreatment)
    : null;
}

export function parseExactPetStickerProfile(
  value: string | null,
): PetStickerProfile | null {
  if (!value) return null;
  return PET_STICKER_PROFILES.includes(value as PetStickerProfile)
    ? (value as PetStickerProfile)
    : null;
}

export function petStickerKey(
  slug: string,
  state: PetStateId = "idle",
  format: PetStickerFormat = "webp",
  treatment: PetStickerTreatment = "clean",
  profile: PetStickerProfile = "web",
): string {
  const suffix = treatment === "outline" ? "-outline" : "";
  const profilePath = profile === "whatsapp" ? "whatsapp/" : "";
  return `pets/${slug}/stickers/${profilePath}${state}${suffix}.${format}`;
}

export function petStickerUrl(
  slug: string,
  state: PetStateId = "idle",
  format: PetStickerFormat = "webp",
  treatment: PetStickerTreatment = "clean",
  profile: PetStickerProfile = "web",
): string {
  return `${R2_PUBLIC_BASE}/${petStickerKey(slug, state, format, treatment, profile)}`;
}

export function petStickerFilename(
  slug: string,
  state: PetStateId = "idle",
  format: PetStickerFormat = "webp",
  treatment: PetStickerTreatment = "clean",
  profile: PetStickerProfile = "web",
): string {
  const suffix = state === "idle" ? "" : `-${state}`;
  const treatmentSuffix = treatment === "outline" ? "-outline" : "";
  const profileSuffix = profile === "whatsapp" ? "-whatsapp" : "";
  return `${slug}${suffix}${treatmentSuffix}${profileSuffix}-sticker.${format}`;
}

export function legacyPetStickerRedirectUrls(slug: string): string[] {
  const base = `https://petdex.dev/api/pets/${slug}/sticker`;
  return [base, `${base}?format=gif`, `${base}?format=png`];
}

export function petStickerTrayKey(slug: string): string {
  return `pets/${slug}/stickers/whatsapp/tray.png`;
}

export function petStickerTrayUrl(slug: string): string {
  return `${R2_PUBLIC_BASE}/${petStickerTrayKey(slug)}`;
}

export function petStickerTrayFilename(slug: string): string {
  return `${slug}-whatsapp-tray.png`;
}
