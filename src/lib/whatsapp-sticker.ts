import sharp from "sharp";

export const WHATSAPP_STICKER_SIZE = 512;
export const WHATSAPP_STICKER_MAX_BYTES = 500_000;
export const WHATSAPP_STICKER_MAX_DURATION_MS = 10_000;
export const WHATSAPP_STICKER_MIN_FRAME_MS = 8;
export const WHATSAPP_TRAY_SIZE = 96;
export const WHATSAPP_TRAY_MAX_BYTES = 50_000;

export type WhatsAppStickerFacts = {
  format: string | undefined;
  width: number | undefined;
  height: number | undefined;
  pages: number;
  delays: number[];
  bytes: number;
};

export function whatsappStickerErrors(facts: WhatsAppStickerFacts): string[] {
  const errors: string[] = [];
  if (facts.format !== "webp") errors.push("format must be WebP");
  if (
    facts.width !== WHATSAPP_STICKER_SIZE ||
    facts.height !== WHATSAPP_STICKER_SIZE
  ) {
    errors.push("dimensions must be 512x512");
  }
  if (facts.bytes > WHATSAPP_STICKER_MAX_BYTES) {
    errors.push("file must be 500KB or smaller");
  }
  if (facts.pages < 2) errors.push("sticker must be animated");
  if (facts.delays.length !== facts.pages) {
    errors.push("every frame must expose a duration");
  }
  if (facts.delays.some((delay) => delay < WHATSAPP_STICKER_MIN_FRAME_MS)) {
    errors.push("frame duration must be at least 8ms");
  }
  if (
    facts.delays.reduce((total, delay) => total + delay, 0) >
    WHATSAPP_STICKER_MAX_DURATION_MS
  ) {
    errors.push("animation must be 10 seconds or shorter");
  }
  return errors;
}

export async function assertWhatsAppSticker(buffer: Buffer): Promise<void> {
  const metadata = await sharp(buffer, { animated: true }).metadata();
  const pages = metadata.pages ?? 1;
  const delays = metadata.delay ?? [];
  const errors = whatsappStickerErrors({
    format: metadata.format,
    width: metadata.width,
    height: metadata.pageHeight ?? metadata.height,
    pages,
    delays,
    bytes: buffer.byteLength,
  });
  if (errors.length > 0) throw new Error(errors.join("; "));
}

export async function assertWhatsAppTray(buffer: Buffer): Promise<void> {
  const metadata = await sharp(buffer).metadata();
  const errors: string[] = [];
  if (metadata.format !== "png") errors.push("tray must be PNG");
  if (
    metadata.width !== WHATSAPP_TRAY_SIZE ||
    metadata.height !== WHATSAPP_TRAY_SIZE
  ) {
    errors.push("tray dimensions must be 96x96");
  }
  if (buffer.byteLength > WHATSAPP_TRAY_MAX_BYTES) {
    errors.push("tray must be 50KB or smaller");
  }
  if (errors.length > 0) throw new Error(errors.join("; "));
}
