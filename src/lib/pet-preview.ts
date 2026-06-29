import { keyFromR2PublicUrl, R2_PUBLIC_BASE } from "@/lib/r2-public-url";

export const PET_PREVIEW_FRAME_WIDTH = 192;
export const PET_PREVIEW_FRAME_HEIGHT = 208;
export const PET_PREVIEW_FRAME_COUNT = 6;
export const PET_PREVIEW_QUALITY = 70;
export const PET_PREVIEW_CACHE_HEADER =
  "public, max-age=31536000, s-maxage=31536000, immutable";

// The preview strip is the first animation row cropped from the canonical
// spritesheet, so the rendered surface is exactly one frame strip wide.
export const PET_PREVIEW_SHEET_WIDTH =
  PET_PREVIEW_FRAME_WIDTH * PET_PREVIEW_FRAME_COUNT;
export const PET_PREVIEW_SHEET_HEIGHT = PET_PREVIEW_FRAME_HEIGHT;

export function petPreviewKey(slug: string): string {
  return `pets/${slug}/preview.webp`;
}

export function petPreviewUrl(slug: string): string {
  return `${R2_PUBLIC_BASE}/${petPreviewKey(slug)}`;
}

// Previews are an opt-in optimization: the cropped strip only exists in R2
// after the backfill script runs. Gating the card swap behind a flag lets
// the code ship without pointing any card at a possibly-missing preview,
// which is what regressed the first attempt (cards 404'd then fell back at
// runtime). NEXT_PUBLIC_ so the gallery client bundle can read it too —
// same dual-var pattern as NEXT_PUBLIC_PETDEX_ADMIN_USER_IDS.
export function isPetPreviewEnabled(): boolean {
  return process.env.NEXT_PUBLIC_PETDEX_PET_PREVIEWS_ENABLED === "true";
}

export function petPreviewUrlForSource(
  slug: string,
  spritesheetPath: string,
): string | null {
  if (!isPetPreviewEnabled()) return null;
  return keyFromR2PublicUrl(spritesheetPath) ? petPreviewUrl(slug) : null;
}
