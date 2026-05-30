import sharp from "sharp";

import { petStates } from "@/lib/pet-states";

const SPRITESHEET_COLUMNS = 8;
const SPRITESHEET_ROWS = 9;
const POLICY_CELL_W = 192;
const POLICY_CELL_H = 208;
const EXPECTED_SPRITESHEET_W = SPRITESHEET_COLUMNS * POLICY_CELL_W;
const EXPECTED_SPRITESHEET_H = SPRITESHEET_ROWS * POLICY_CELL_H;
const POLICY_BACKGROUND = { r: 120, g: 120, b: 120 };
const MAX_POLICY_SOURCE_DIMENSION = 4096;
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

    if (
      metadata.width !== EXPECTED_SPRITESHEET_W ||
      metadata.height !== EXPECTED_SPRITESHEET_H
    ) {
      return {
        ok: false,
        reason: `Spritesheet must be ${EXPECTED_SPRITESHEET_W}x${EXPECTED_SPRITESHEET_H} for policy OCR review.`,
      };
    }

    const source = await sharp(spriteBuffer).ensureAlpha().raw().toBuffer();
    const contactSheet = renderPolicyContactSheet(source);
    const sheet = await sharp(contactSheet, {
      raw: {
        width: EXPECTED_SPRITESHEET_W,
        height: EXPECTED_SPRITESHEET_H,
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

function renderPolicyContactSheet(source: Buffer): Buffer {
  const output = Buffer.alloc(
    EXPECTED_SPRITESHEET_W * EXPECTED_SPRITESHEET_H * 4,
  );
  for (let index = 0; index < output.length; index += 4) {
    output[index] = POLICY_BACKGROUND.r;
    output[index + 1] = POLICY_BACKGROUND.g;
    output[index + 2] = POLICY_BACKGROUND.b;
    output[index + 3] = 255;
  }

  for (const state of petStates) {
    const top = state.row * POLICY_CELL_H;
    for (let column = 0; column < state.frames; column++) {
      const left = column * POLICY_CELL_W;
      copyCellOverBackground(source, output, left, top);
    }
  }

  return output;
}

function copyCellOverBackground(
  source: Buffer,
  output: Buffer,
  left: number,
  top: number,
): void {
  for (let y = 0; y < POLICY_CELL_H; y++) {
    for (let x = 0; x < POLICY_CELL_W; x++) {
      const offset = ((top + y) * EXPECTED_SPRITESHEET_W + left + x) * 4;
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
