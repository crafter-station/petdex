import sharp from "sharp";

import { petStates } from "@/lib/pet-states";
import {
  canonicalSpriteDimensions,
  detectSpriteAtlas,
  SPRITE_COLUMNS,
  SPRITE_FRAME_HEIGHT,
  SPRITE_FRAME_WIDTH,
} from "@/lib/sprite-atlas";

const POLICY_BACKGROUND = { r: 120, g: 120, b: 120 };
// Preserve the largest integer-cell atlas accepted by sprite-atlas.ts. The
// v2 contract allows a 2x 8x11 sheet (3072x4576), whose height is above the
// old 4096px guard and must still reach the visual review stage.
const MAX_POLICY_SOURCE_DIMENSION = 4576;
const MAX_POLICY_SOURCE_PIXELS = 16_777_216;
const MAX_POLICY_OUTPUT_CHARS = 2 * 1024 * 1024;

export type PolicyReviewImageResult =
  | { ok: true; dataUrl: string }
  | { ok: false; reason: string };

export async function policyReviewImageDataUrl(
  spriteBuffer: Buffer,
): Promise<string | null> {
  const result = await preparePolicyReviewImage(spriteBuffer);
  return result.ok ? result.dataUrl : null;
}

export async function preparePolicyReviewImage(
  spriteBuffer: Buffer,
): Promise<PolicyReviewImageResult> {
  try {
    const metadata = await sharp(spriteBuffer).metadata();
    if (!metadata.width || !metadata.height) {
      return {
        ok: false,
        reason: "Sprite image dimensions could not be read.",
      };
    }
    if (
      metadata.width > MAX_POLICY_SOURCE_DIMENSION ||
      metadata.height > MAX_POLICY_SOURCE_DIMENSION ||
      metadata.width * metadata.height > MAX_POLICY_SOURCE_PIXELS
    ) {
      return {
        ok: false,
        reason: "Spritesheet dimensions exceed policy review limits.",
      };
    }

    const layout = detectSpriteAtlas(metadata.width, metadata.height);
    if (!layout) {
      return {
        ok: false,
        reason:
          "Spritesheet must preserve the 8x9 (1536x1872) or v2 8x11 (1536x2288) atlas ratio for policy OCR review.",
      };
    }

    const canonical = canonicalSpriteDimensions(layout.version);
    const source = await sharp(spriteBuffer)
      .ensureAlpha()
      .resize({
        width: canonical.width,
        height: canonical.height,
        fit: "fill",
        kernel: sharp.kernel.nearest,
      })
      .raw()
      .toBuffer();
    const contactSheet = renderPolicyContactSheet(source, layout.rows);
    const sheet = await sharp(contactSheet, {
      raw: {
        width: canonical.width,
        height: canonical.height,
        channels: 4,
      },
    })
      .png()
      .toBuffer();
    const dataUrl = `data:image/png;base64,${sheet.toString("base64")}`;
    if (dataUrl.length > MAX_POLICY_OUTPUT_CHARS) {
      return {
        ok: false,
        reason: "Policy review contact sheet exceeds model payload budget.",
      };
    }
    return { ok: true, dataUrl };
  } catch {
    return {
      ok: false,
      reason: "Sprite frames could not be prepared for policy review.",
    };
  }
}

function renderPolicyContactSheet(source: Buffer, rows: 9 | 11): Buffer {
  const { width, height } = canonicalSpriteDimensions(rows === 11 ? 2 : 1);
  const output = Buffer.alloc(width * height * 4);
  for (let index = 0; index < output.length; index += 4) {
    output[index] = POLICY_BACKGROUND.r;
    output[index + 1] = POLICY_BACKGROUND.g;
    output[index + 2] = POLICY_BACKGROUND.b;
    output[index + 3] = 255;
  }

  for (const state of petStates) {
    const top = state.row * SPRITE_FRAME_HEIGHT;
    for (let column = 0; column < state.frames; column++) {
      const left = column * SPRITE_FRAME_WIDTH;
      copyCellOverBackground(source, output, width, left, top);
    }
  }

  // v2 adds two rows of look-direction frames. They are not animation
  // states in the classic viewer, but policy review still needs to inspect
  // every visible cell instead of silently dropping those rows.
  if (rows === 11) {
    for (let row = 9; row < 11; row++) {
      for (let column = 0; column < SPRITE_COLUMNS; column++) {
        copyCellOverBackground(
          source,
          output,
          width,
          column * SPRITE_FRAME_WIDTH,
          row * SPRITE_FRAME_HEIGHT,
        );
      }
    }
  }

  return output;
}

function copyCellOverBackground(
  source: Buffer,
  output: Buffer,
  width: number,
  left: number,
  top: number,
): void {
  for (let y = 0; y < SPRITE_FRAME_HEIGHT; y++) {
    for (let x = 0; x < SPRITE_FRAME_WIDTH; x++) {
      const offset = ((top + y) * width + left + x) * 4;
      const alpha = source[offset + 3];
      if (alpha === 0) continue;
      if (alpha === 255) {
        output[offset] = source[offset];
        output[offset + 1] = source[offset + 1];
        output[offset + 2] = source[offset + 2];
        continue;
      }

      const opacity = alpha / 255;
      output[offset] = compositeChannel(
        source[offset],
        POLICY_BACKGROUND.r,
        opacity,
      );
      output[offset + 1] = compositeChannel(
        source[offset + 1],
        POLICY_BACKGROUND.g,
        opacity,
      );
      output[offset + 2] = compositeChannel(
        source[offset + 2],
        POLICY_BACKGROUND.b,
        opacity,
      );
    }
  }
}

function compositeChannel(
  value: number,
  background: number,
  opacity: number,
): number {
  return Math.round(value * opacity + background * (1 - opacity));
}
