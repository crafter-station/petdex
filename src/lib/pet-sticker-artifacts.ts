import type { PetStateId } from "@/lib/pet-states";
import { R2_PUBLIC_BASE } from "@/lib/r2-public-url";

export type PetStickerFormat = "webp" | "gif" | "png";

export const PET_STICKER_CACHE_HEADER =
  "public, max-age=31536000, s-maxage=31536000, immutable";
export const PET_STICKER_REDIRECT_CACHE_HEADER =
  "public, max-age=86400, s-maxage=604800";
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

export function petStickerKey(
  slug: string,
  state: PetStateId = "idle",
  format: PetStickerFormat = "webp",
): string {
  return `pets/${slug}/stickers/${state}.${format}`;
}

export function petStickerUrl(
  slug: string,
  state: PetStateId = "idle",
  format: PetStickerFormat = "webp",
): string {
  return `${R2_PUBLIC_BASE}/${petStickerKey(slug, state, format)}`;
}

export function petStickerFilename(
  slug: string,
  state: PetStateId = "idle",
  format: PetStickerFormat = "webp",
): string {
  const suffix = state === "idle" ? "" : `-${state}`;
  return `${slug}${suffix}-sticker.${format}`;
}

export function petStickerPackKey(slug: string): string {
  return `pets/${slug}/wastickers.zip`;
}

export function petStickerPackUrl(slug: string): string {
  return `${R2_PUBLIC_BASE}/${petStickerPackKey(slug)}`;
}

export function petStickerPackFilename(slug: string): string {
  return `${slug}-petdex-stickers.zip`;
}
