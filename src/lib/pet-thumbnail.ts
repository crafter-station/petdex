import { keyFromR2PublicUrl, R2_PUBLIC_BASE } from "@/lib/r2-public-url";

export const PET_THUMBNAIL_FRAME_WIDTH = 192;
export const PET_THUMBNAIL_FRAME_HEIGHT = 208;
export const PET_THUMBNAIL_SIZE = 80;
export const PET_THUMBNAIL_CACHE_HEADER =
  "public, max-age=31536000, s-maxage=31536000, immutable";
export const PET_THUMBNAIL_REDIRECT_CACHE_HEADER =
  "public, max-age=86400, s-maxage=604800";

export function petThumbnailKey(slug: string): string {
  return `pets/${slug}/thumb.webp`;
}

export function petThumbnailUrl(slug: string): string {
  return `${R2_PUBLIC_BASE}/${petThumbnailKey(slug)}`;
}

export function petThumbnailUrlForSource(
  slug: string,
  spritesheetPath: string,
): string | null {
  return keyFromR2PublicUrl(spritesheetPath) ? petThumbnailUrl(slug) : null;
}
