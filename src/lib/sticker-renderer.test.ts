import { describe, expect, it } from "bun:test";

import { applyStickerOutline } from "@/lib/sticker-renderer";

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
});
