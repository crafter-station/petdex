import { describe, expect, it } from "bun:test";

import { resolveSprite } from "./pet-sprite";

const PREVIEW = "https://assets.petdex.dev/pets/curly-dog-lady/preview.webp";
const ATLAS = "https://assets.petdex.dev/pets/curly-dog-lady/spritesheet.webp";

const base = {
  preferredSrc: PREVIEW,
  fallbackSrc: ATLAS,
  failedSrc: null as string | null,
  preferredLayout: "row" as const,
  cycleStates: false,
};

describe("resolveSprite", () => {
  it("draws the preview until it fails", () => {
    const result = resolveSprite(base);
    expect(result.useFallback).toBe(false);
    expect(result.src).toBe(PREVIEW);
    expect(result.layout).toBe("row");
  });

  it("swaps to the atlas when the preview errors", () => {
    const result = resolveSprite({ ...base, failedSrc: PREVIEW });
    expect(result.useFallback).toBe(true);
    expect(result.src).toBe(ATLAS);
    expect(result.layout).toBe("atlas");
  });

  it("cycles states on a fallback card, matching one that never had a preview", () => {
    const recovered = resolveSprite({ ...base, failedSrc: PREVIEW });
    const neverHadPreview = resolveSprite({
      ...base,
      preferredSrc: ATLAS,
      fallbackSrc: undefined,
      preferredLayout: "atlas",
      cycleStates: true,
    });
    expect(recovered.cycleStates).toBe(true);
    expect(recovered.cycleStates).toBe(neverHadPreview.cycleStates);
  });

  it("keeps a working preview on its caller's fixed state", () => {
    expect(resolveSprite(base).cycleStates).toBe(false);
  });

  it("ignores a stale failure recorded against a different src", () => {
    const result = resolveSprite({ ...base, failedSrc: "https://old.example" });
    expect(result.useFallback).toBe(false);
    expect(result.src).toBe(PREVIEW);
  });

  it("stays on the preview when no fallback is supplied", () => {
    const result = resolveSprite({
      ...base,
      fallbackSrc: undefined,
      failedSrc: PREVIEW,
    });
    expect(result.useFallback).toBe(false);
    expect(result.src).toBe(PREVIEW);
    expect(result.layout).toBe("row");
  });
});
