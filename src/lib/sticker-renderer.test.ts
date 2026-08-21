import { describe, expect, it } from "bun:test";

import sharp from "sharp";

import {
  applyStickerOutline,
  renderSticker,
  STICKER_SIZES,
} from "@/lib/sticker-renderer";
import { assertWhatsAppSticker } from "@/lib/whatsapp-sticker";

describe("sticker renderer", () => {
  it("adds an opaque white outline without changing source pixels", () => {
    const rgba = Buffer.alloc(5 * 5 * 4);
    const center = (2 * 5 + 2) * 4;
    rgba[center] = 222;
    rgba[center + 1] = 118;
    rgba[center + 2] = 82;
    rgba[center + 3] = 255;

    const output = applyStickerOutline(rgba, 5, 5, 1);

    expect([...output.subarray(center, center + 4)]).toEqual([
      222, 118, 82, 255,
    ]);
    expect([...output.subarray(center - 4, center)]).toEqual([
      255, 255, 255, 255,
    ]);
    expect([...output.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
  });

  it("renders a compliant animated WhatsApp WebP", async () => {
    const frames = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        sharp({
          create: {
            width: 192,
            height: 208,
            channels: 4,
            background: {
              r: 180 + index * 10,
              g: 90,
              b: 60,
              alpha: 1,
            },
          },
        })
          .png()
          .toBuffer(),
      ),
    );
    const spritesheet = await sharp({
      create: {
        width: 192 * 6,
        height: 208,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite(
        frames.map((input, index) => ({ input, left: index * 192, top: 0 })),
      )
      .png()
      .toBuffer();
    const sticker = await renderSticker(spritesheet, {
      state: "idle",
      format: "webp",
      treatment: "outline",
      size: STICKER_SIZES.whatsapp,
    });

    expect(sticker.isAnimated).toBe(true);
    expect(sticker.frameCount).toBe(6);
    await expect(
      assertWhatsAppSticker(sticker.buffer),
    ).resolves.toBeUndefined();
  });
});
