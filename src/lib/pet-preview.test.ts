import { describe, expect, it } from "bun:test";

import {
  petPreviewKey,
  petPreviewUrl,
  petPreviewUrlForSource,
} from "@/lib/pet-preview";

describe("pet preview artifact helpers", () => {
  it("builds the public preview key and URL", () => {
    expect(petPreviewKey("cai-chao")).toBe("pets/cai-chao/preview.webp");
    expect(petPreviewUrl("cai-chao")).toBe(
      "https://assets.petdex.dev/pets/cai-chao/preview.webp",
    );
  });

  it("only derives preview URLs for recognized R2 sources", () => {
    expect(
      petPreviewUrlForSource(
        "cai-chao",
        "https://assets.petdex.dev/pets/cai-chao/spritesheet.webp",
      ),
    ).toBe("https://assets.petdex.dev/pets/cai-chao/preview.webp");
    expect(
      petPreviewUrlForSource(
        "cai-chao",
        "https://example.com/pets/cai-chao/spritesheet.webp",
      ),
    ).toBeNull();
  });
});
