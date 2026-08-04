import { describe, expect, it } from "bun:test";

import {
  labelForSpriteVersion,
  normalizeSpriteVersionNumber,
  parseSpriteVersionNumber,
} from "@/lib/sprite-version";

describe("parseSpriteVersionNumber", () => {
  it("defaults a missing pet.json spriteVersionNumber to v1", () => {
    expect(parseSpriteVersionNumber({})).toEqual({ ok: true, version: 1 });
  });

  it("reads spriteVersionNumber 2 as v2", () => {
    expect(parseSpriteVersionNumber({ spriteVersionNumber: 2 })).toEqual({
      ok: true,
      version: 2,
    });
  });

  it("rejects unsupported spriteVersionNumber values", () => {
    expect(parseSpriteVersionNumber({ spriteVersionNumber: 3 })).toEqual({
      ok: false,
      value: 3,
    });
  });

  it("rejects null instead of treating it as a missing field", () => {
    expect(parseSpriteVersionNumber({ spriteVersionNumber: null })).toEqual({
      ok: false,
      value: null,
    });
  });
});

describe("labelForSpriteVersion", () => {
  it("names the atlas contract a gallery badge should show", () => {
    expect(labelForSpriteVersion(1)).toBe("Classic v1 · 8x9");
    expect(labelForSpriteVersion(2)).toBe("Hatch v2 · 8x11");
  });
});

describe("normalizeSpriteVersionNumber", () => {
  it("rejects null because only a missing field defaults to v1", () => {
    expect(normalizeSpriteVersionNumber(null)).toEqual({
      ok: false,
      value: null,
    });
  });
});
