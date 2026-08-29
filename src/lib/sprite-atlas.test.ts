import { describe, expect, it } from "bun:test";

import {
  canonicalSpriteDimensions,
  detectSpriteAtlas,
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
