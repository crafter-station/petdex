import sharp from "sharp";

import {
  detectSpriteAtlas,
  isDecodableSpriteSize,
  SPRITE_FRAME_HEIGHT,
  SPRITE_FRAME_WIDTH,
} from "@/lib/sprite-atlas";

/**
 * 64-bit dHash of a spritesheet's first idle frame, as a 16-char hex string.
 *
 * The hash must not depend on the sheet's pixel scale. `detectSpriteAtlas`
 * accepts integer-scaled sheets (a 3072x3744 v1 atlas is legal), and a fixed
 * 192x208 crop of a 2x sheet samples only the top-left quarter of the first
 * frame — a different image, so the same artwork re-uploaded at another scale
 * hashed differently and slipped past visual dedup (a 1x/2x pair measured a
 * Hamming distance of 39). Crop the full first cell at the sheet's own scale
 * and let the 9x8 resize normalize it, so scale is factored out.
 *
 * Kept out of both callers' modules so the review path (which loads its DB
 * module lazily) does not pull in a DB import just to hash pixels.
 */
export async function dhashFromSpriteBuffer(
  buf: Buffer,
): Promise<string | null> {
  try {
    const meta = await sharp(buf).metadata();
    // A ratio-valid sheet can be arbitrarily large and still fit the byte cap,
    // so bound the decode before the extract below reads pixels (measured: a
    // 232.9 MP flat PNG is 920 KB and decodes to hundreds of MB).
    if (!isDecodableSpriteSize(meta.width, meta.height)) return null;
    const atlas = detectSpriteAtlas(meta.width, meta.height);
    const scale = atlas ? atlas.scale : 1;
    const cellWidth = Math.round(SPRITE_FRAME_WIDTH * scale);
    const cellHeight = Math.round(SPRITE_FRAME_HEIGHT * scale);
    const frame = await sharp(buf)
      .extract({ left: 0, top: 0, width: cellWidth, height: cellHeight })
      .resize(9, 8, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer();
    let bits = "";
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const left = frame[row * 9 + col];
        const right = frame[row * 9 + col + 1];
        bits += left < right ? "1" : "0";
      }
    }
    return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
  } catch {
    return null;
  }
}
