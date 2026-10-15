export const SPRITE_COLUMNS = 8;
export const SPRITE_FRAME_WIDTH = 192;
export const SPRITE_FRAME_HEIGHT = 208;

export type SpriteAtlasVersion = 1 | 2;

export type SpriteAtlasLayout = {
  version: SpriteAtlasVersion;
  rows: 9 | 11;
  width: number;
  height: number;
  scale: number;
};

const layouts = [
  { version: 1 as const, rows: 9 as const },
  { version: 2 as const, rows: 11 as const },
];

/**
 * The largest a decodable sprite may be, in pixels and per side.
 *
 * `detectSpriteAtlas` accepts any integer scale, and submission validation
 * only floors the declared dimensions — so a ratio-valid sheet can declare
 * (and be uploaded as) 13824x16848 = 232.9 MP in well under the 8 MB byte cap.
 * Every decode path that touches the bytes — the colour extractor through
 * Vibrant/Jimp, the dHash crop, the visual review — then allocates an RGBA
 * buffer for the whole sheet, which measured ~1.7 GB RSS and ~43 s of blocked
 * CPU for one such upload.
 *
 * The ceiling is 3x, not "any scale the product ships". The largest canonical
 * layout is the v2 8x11 sheet, and 3x that is 4608x6864 = 31.6 MP — an RGBA
 * decode of ~121 MB, the most a single request may allocate here. 4x already
 * exceeds this per-side bound on the v2 height (9152 > 6144), so three times
 * is the last scale that fits; a real re-export never goes past 2x (3072x4576).
 * Same class of ceiling the policy-OCR path already enforces
 * (`submission-review-image.ts`, 4576px / 16.7 MP).
 */
export const MAX_DECODABLE_SPRITE_WIDTH =
  3 * SPRITE_COLUMNS * SPRITE_FRAME_WIDTH; // 4608
// The tallest accepted layout is the v2 8x11 sheet, so at a legal ratio a
// bounded width bounds the height and the pixel count together.
const MAX_SPRITE_ROWS = 11;
export const MAX_DECODABLE_SPRITE_HEIGHT =
  3 * MAX_SPRITE_ROWS * SPRITE_FRAME_HEIGHT; // 6864
export const MAX_DECODABLE_SPRITE_PIXELS =
  MAX_DECODABLE_SPRITE_WIDTH * MAX_DECODABLE_SPRITE_HEIGHT;

/** True when an image of these dimensions is safe to decode. */
export function isDecodableSpriteSize(
  width: number | undefined | null,
  height: number | undefined | null,
): boolean {
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return false;
  }
  return (
    width <= MAX_DECODABLE_SPRITE_WIDTH &&
    height <= MAX_DECODABLE_SPRITE_HEIGHT &&
    width * height <= MAX_DECODABLE_SPRITE_PIXELS
  );
}

/**
 * Identify a supported atlas from its dimensions without decoding pixels.
 * Scaled sheets are accepted only when each row and column still lands on an
 * integer cell boundary. Callers that render fixed 192x208 cells can then
 * normalize them without introducing fractional crop boundaries.
 */
export function detectSpriteAtlas(
  width: unknown,
  height: unknown,
): SpriteAtlasLayout | null {
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  for (const layout of layouts) {
    const canonicalWidth = SPRITE_COLUMNS * SPRITE_FRAME_WIDTH;
    const canonicalHeight = layout.rows * SPRITE_FRAME_HEIGHT;
    const widthBigInt = BigInt(width);
    const heightBigInt = BigInt(height);
    const canonicalWidthBigInt = BigInt(canonicalWidth);
    const canonicalHeightBigInt = BigInt(canonicalHeight);
    if (
      width % SPRITE_COLUMNS !== 0 ||
      height % layout.rows !== 0 ||
      widthBigInt * canonicalHeightBigInt !==
        heightBigInt * canonicalWidthBigInt
    )
      continue;

    return {
      ...layout,
      width,
      height,
      scale: width / canonicalWidth,
    };
  }

  return null;
}

export function canonicalSpriteDimensions(version: SpriteAtlasVersion) {
  return {
    width: SPRITE_COLUMNS * SPRITE_FRAME_WIDTH,
    height: (version === 2 ? 11 : 9) * SPRITE_FRAME_HEIGHT,
  };
}
