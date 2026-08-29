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
