// Sticker rendering for WeChat / WhatsApp / Discord export.
//
// Each pet has a 9-state spritesheet (see pet-states.ts). We slice the
// requested state's row, extract its frames, and encode an animated WebP
// at 240×240 (sticker target across most platforms; WhatsApp wants 512
// for packs but is tolerant of 240 for individual sends).
//
// WebP animated is preferred over GIF: smaller files, better alpha,
// native WhatsApp pack format. Both WeChat and Discord accept it inline.
//
// Single-frame export (the default 'idle' caller) collapses to a static
// PNG via the same pipeline by skipping the animation envelope.

import { applyPalette, GIFEncoder, quantize } from "gifenc";
import sharp from "sharp";

import { defaultPetState, type PetStateId, petStates } from "@/lib/pet-states";
import { fetchR2Asset } from "@/lib/r2-fetch";

const FRAME_W = 192;
const FRAME_H = 208;
// 240 is the WeChat custom sticker max + smallest common WhatsApp pack
// dimension that survives Tencent's preview crawler. 512 is the WhatsApp
// pack official spec but inflates files 4x for marginal quality gain on
// 192x208 source pixel art.
const OUT_DEFAULT = 240;
const OUT_WHATSAPP_PACK = 512;

const RESIZE_OPTS = {
  fit: "contain" as const,
  kernel: "nearest" as const,
  background: { r: 0, g: 0, b: 0, alpha: 0 },
};

export type StickerFormat = "webp" | "gif" | "png";

export type StickerOptions = {
  state?: PetStateId;
  size?: number;
  format?: StickerFormat;
};

export type StickerOutput = {
  buffer: Buffer;
  contentType: "image/webp" | "image/gif" | "image/png";
  isAnimated: boolean;
  frameCount: number;
};

function getStateSpec(stateId?: PetStateId) {
  if (!stateId) return defaultPetState;
  return petStates.find((s) => s.id === stateId) ?? defaultPetState;
}

export async function fetchSpritesheet(
  spritesheetUrl: string,
): Promise<Buffer> {
  const res = await fetchR2Asset(spritesheetUrl, { redirect: "error" });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Pull the N frames for a row out of the source sheet, each as a Buffer.
async function extractRowFrames(
  source: Buffer,
  row: number,
  frames: number,
): Promise<Buffer[]> {
  const top = row * FRAME_H;
  const out: Buffer[] = [];
  for (let i = 0; i < frames; i++) {
    const buf = await sharp(source)
      .extract({
        left: i * FRAME_W,
        top,
        width: FRAME_W,
        height: FRAME_H,
      })
      .png()
      .toBuffer();
    out.push(buf);
  }
  return out;
}

// Encode an animated GIF from N frame buffers via gifenc.
//
// Returns the GIF bytes directly. The same buffer powers two callers:
//   - 'gif' format clients (WhatsApp Desktop, Slack inline)
//   - 'webp' format clients (everything else) by re-reading via sharp
//
// gifenc is the encoder of choice because sharp 0.34 cannot encode animated
// WebP from raw pixel buffers (setting pages/pageHeight on raw input throws
// `vips_image_get: field "n-pages" not found`). With a real animated GIF on
// disk, sharp({ animated: true }) treats it as proper multi-page input.
async function buildAnimatedGif(
  frames: Buffer[],
  size: number,
  delayMs: number,
): Promise<Buffer> {
  const channels = 4;
  const frameByteLength = size * size * channels;

  // Resize each frame to (size × size) and pull raw RGBA.
  const rawFrames = await Promise.all(
    frames.map((b) =>
      sharp(b).resize(size, size, RESIZE_OPTS).ensureAlpha().raw().toBuffer(),
    ),
  );

  for (const buf of rawFrames) {
    if (buf.length !== frameByteLength) {
      throw new Error(
        `frame byte length mismatch: got ${buf.length}, expected ${frameByteLength}`,
      );
    }
  }

  // Quantize per frame so transparent pixels keep palette index 0.
  // dispose: 2 restores background between frames; without it old frame
  // pixels bleed through transparent regions of the next frame.
  const gif = GIFEncoder();
  for (const buf of rawFrames) {
    const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const palette = quantize(u8, 256, { format: "rgba4444" });
    const indexed = applyPalette(u8, palette, "rgba4444");
    gif.writeFrame(indexed, size, size, {
      palette,
      delay: delayMs,
      transparent: true,
      transparentIndex: 0,
      dispose: 2,
    });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

// Re-encode an animated GIF as animated WebP via sharp.
async function gifToAnimatedWebp(gifBuf: Buffer): Promise<Buffer> {
  return await sharp(gifBuf, { animated: true })
    .webp({
      loop: 0,
      quality: 80,
      effort: 4,
    })
    .toBuffer();
}

async function buildStaticPng(frame: Buffer, size: number): Promise<Buffer> {
  return await sharp(frame)
    .resize(size, size, RESIZE_OPTS)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export type StickerInput = string | Buffer;

export async function renderSticker(
  input: StickerInput,
  options: StickerOptions = {},
): Promise<StickerOutput> {
  const state = getStateSpec(options.state);
  const size = options.size ?? OUT_DEFAULT;
  const format: StickerFormat = options.format ?? "webp";

  // Accept either a URL (fetched once here) or a pre-fetched spritesheet
  // buffer. The pack endpoint fetches once and feeds the same buffer to
  // 9 calls + the tray icon, avoiding 10x egress on the spritesheet host.
  const sheet =
    typeof input === "string" ? await fetchSpritesheet(input) : input;
  const frames = await extractRowFrames(sheet, state.row, state.frames);

  // PNG path: always single-frame static. Caller asked for png explicitly
  // OR the requested state has no animation to extract.
  if (format === "png" || frames.length <= 1) {
    return {
      buffer: await buildStaticPng(frames[0], size),
      contentType: "image/png",
      isAnimated: false,
      frameCount: 1,
    };
  }

  const delayMs = Math.round(state.durationMs / state.frames);
  const gifBuf = await buildAnimatedGif(frames, size, delayMs);

  if (format === "gif") {
    return {
      buffer: gifBuf,
      contentType: "image/gif",
      isAnimated: true,
      frameCount: state.frames,
    };
  }

  return {
    buffer: await gifToAnimatedWebp(gifBuf),
    contentType: "image/webp",
    isAnimated: true,
    frameCount: state.frames,
  };
}

export const STICKER_SIZES = {
  default: OUT_DEFAULT,
  whatsappPack: OUT_WHATSAPP_PACK,
};
