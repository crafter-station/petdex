import { afterEach, describe, expect, it } from "bun:test";

import {
  petPreviewKey,
  petPreviewUrl,
  petPreviewUrlForSource,
} from "@/lib/pet-preview";

const originalFlag = process.env.NEXT_PUBLIC_PETDEX_PET_PREVIEWS_ENABLED;

afterEach(() => {
  if (originalFlag === undefined) {
    delete process.env.NEXT_PUBLIC_PETDEX_PET_PREVIEWS_ENABLED;
  } else {
    process.env.NEXT_PUBLIC_PETDEX_PET_PREVIEWS_ENABLED = originalFlag;
  }
});

describe("pet preview artifact helpers", () => {
  it("builds the public preview key and URL", () => {
    expect(petPreviewKey("cai-chao")).toBe("pets/cai-chao/preview.webp");
    expect(petPreviewUrl("cai-chao")).toBe(
      "https://assets.petdex.dev/pets/cai-chao/preview.webp",
    );
  });

  it("only derives preview URLs for recognized R2 sources when enabled", () => {
    process.env.NEXT_PUBLIC_PETDEX_PET_PREVIEWS_ENABLED = "true";

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

  it("returns null while the feature flag is off", () => {
    delete process.env.NEXT_PUBLIC_PETDEX_PET_PREVIEWS_ENABLED;

    expect(
      petPreviewUrlForSource(
        "cai-chao",
        "https://assets.petdex.dev/pets/cai-chao/spritesheet.webp",
      ),
    ).toBeNull();
  });
});
