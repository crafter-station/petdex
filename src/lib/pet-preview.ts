import { keyFromR2PublicUrl, R2_PUBLIC_BASE } from "@/lib/r2-public-url";

export const PET_PREVIEW_FRAME_WIDTH = 192;
export const PET_PREVIEW_FRAME_HEIGHT = 208;
export const PET_PREVIEW_FRAME_COUNT = 6;
export const PET_PREVIEW_QUALITY = 70;
export const PET_PREVIEW_CACHE_HEADER =
  "public, max-age=31536000, s-maxage=31536000, immutable";

export function petPreviewKey(slug: string): string {
  return `pets/${slug}/preview.webp`;
}

export function petPreviewUrl(slug: string): string {
  return `${R2_PUBLIC_BASE}/${petPreviewKey(slug)}`;
}

export function petPreviewUrlForSource(
  slug: string,
  spritesheetPath: string,
): string | null {
  return keyFromR2PublicUrl(spritesheetPath) ? petPreviewUrl(slug) : null;
}
