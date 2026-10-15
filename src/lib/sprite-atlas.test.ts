import { describe, expect, it } from "bun:test";

import {
  canonicalSpriteDimensions,
  detectSpriteAtlas,
  isDecodableSpriteSize,
  MAX_DECODABLE_SPRITE_HEIGHT,
  MAX_DECODABLE_SPRITE_WIDTH,
} from "@/lib/sprite-atlas";

describe("sprite atlas geometry", () => {
  it("recognizes classic and v2 canonical dimensions", () => {
    expect(detectSpriteAtlas(1536, 1872)).toMatchObject({
      version: 1,
      rows: 9,
      scale: 1,
    });
    expect(detectSpriteAtlas(1536, 2288)).toMatchObject({
      version: 2,
      rows: 11,
      scale: 1,
    });
  });

  it("recognizes preserved-ratio scaled sheets", () => {
    expect(detectSpriteAtlas(768, 936)).toMatchObject({
      version: 1,
      scale: 0.5,
    });
    expect(detectSpriteAtlas(3072, 4576)).toMatchObject({
      version: 2,
      scale: 2,
    });
  });

  it("keeps exact ratios for safe dimensions whose products exceed Number precision", () => {
    const scale = 4_000_000_000_000;
    const width = 1536 * scale;
    const height = 1872 * scale;
    expect(Number.isSafeInteger(width)).toBeTrue();
    expect(Number.isSafeInteger(height)).toBeTrue();
    expect(width * 1872).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(height * 1536).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(detectSpriteAtlas(width, height)).toMatchObject({
      version: 1,
      rows: 9,
      scale,
    });
  });

  it("rejects malformed, unsafe, and ambiguous dimensions", () => {
    expect(detectSpriteAtlas(1536, 2000)).toBeNull();
    expect(detectSpriteAtlas(256, 312)).toBeNull();
    expect(detectSpriteAtlas("1536", 1872)).toBeNull();
    expect(detectSpriteAtlas(Number.NaN, 1872)).toBeNull();
    expect(detectSpriteAtlas(Number.MAX_SAFE_INTEGER, 1872)).toBeNull();
  });

  it("keeps canonical dimensions tied to the declared version", () => {
    expect(canonicalSpriteDimensions(1)).toEqual({ width: 1536, height: 1872 });
    expect(canonicalSpriteDimensions(2)).toEqual({ width: 1536, height: 2288 });
  });
});

describe("isDecodableSpriteSize", () => {
  // `detectSpriteAtlas` accepts any integer scale and submission validation
  // only floors the declared dimensions, so a ratio-valid sheet can be huge
  // and still fit the 8 MB byte cap (a 13824x16848 flat PNG is 920 KB). Each
  // decode path — the colour extractor's Vibrant/Jimp load, the dHash crop —
  // then allocates an RGBA buffer for the whole sheet; measured ~1.7 GB RSS
  // and ~43 s of blocked CPU for one such upload. This is the ceiling that
  // refuses it before any decoder sees the bytes.
  it("accepts every layout the product actually ships", () => {
    for (const scale of [1, 2, 3]) {
      expect(
        isDecodableSpriteSize(192 * 8 * scale, 208 * 9 * scale),
        `v1 x${scale}`,
      ).toBe(true);
      expect(
        isDecodableSpriteSize(192 * 8 * scale, 208 * 11 * scale),
        `v2 x${scale}`,
      ).toBe(true);
    }
  });

  it("refuses a sheet beyond the largest accepted layout", () => {
    // 4x v2: height 9152 > 6864.
    expect(isDecodableSpriteSize(6144, 9152)).toBe(false);
    // The measured attack size: ratio-valid, 232.9 MP, 920 KB on the wire.
    expect(isDecodableSpriteSize(13824, 16848)).toBe(false);
  });

  it("refuses a width inside the cap paired with a height that overflows the pixel budget", () => {
    expect(
      isDecodableSpriteSize(
        MAX_DECODABLE_SPRITE_WIDTH,
        MAX_DECODABLE_SPRITE_HEIGHT + 1,
      ),
    ).toBe(false);
  });

  it("refuses missing, zero, and non-finite dimensions", () => {
    expect(isDecodableSpriteSize(undefined, 100)).toBe(false);
    expect(isDecodableSpriteSize(100, null)).toBe(false);
    expect(isDecodableSpriteSize(0, 100)).toBe(false);
    expect(isDecodableSpriteSize(Number.NaN, 100)).toBe(false);
    expect(isDecodableSpriteSize(Number.POSITIVE_INFINITY, 100)).toBe(false);
  });
});
