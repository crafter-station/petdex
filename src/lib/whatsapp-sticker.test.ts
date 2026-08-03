import { describe, expect, it } from "bun:test";

import { whatsappStickerErrors } from "@/lib/whatsapp-sticker";

describe("WhatsApp sticker compliance", () => {
  it("accepts an animated WebP inside every official limit", () => {
    expect(
      whatsappStickerErrors({
        format: "webp",
        width: 512,
        height: 512,
        pages: 6,
        delays: [180, 180, 180, 180, 180, 180],
        bytes: 43_376,
      }),
    ).toEqual([]);
  });

  it("reports dimensions, size, animation, frame, and duration failures", () => {
    expect(
      whatsappStickerErrors({
        format: "gif",
        width: 240,
        height: 240,
        pages: 1,
        delays: [10_001],
        bytes: 500_001,
      }),
    ).toEqual([
      "format must be WebP",
      "dimensions must be 512x512",
      "file must be 500KB or smaller",
      "sticker must be animated",
      "animation must be 10 seconds or shorter",
    ]);
  });

  it("requires timing metadata for every frame", () => {
    expect(
      whatsappStickerErrors({
        format: "webp",
        width: 512,
        height: 512,
        pages: 2,
        delays: [7],
        bytes: 1,
      }),
    ).toEqual([
      "every frame must expose a duration",
      "frame duration must be at least 8ms",
    ]);
  });
});
