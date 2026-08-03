import { describe, expect, it } from "bun:test";

import { petPreviewKey } from "@/lib/pet-preview";
import { petPublicArtifactKeys } from "@/lib/pet-public-artifact-keys";
import {
  legacyPetStickerRedirectUrls,
  PET_STICKER_FORMATS,
  PET_STICKER_STATES,
  PET_STICKER_TREATMENTS,
  petStickerKey,
  petStickerTrayKey,
} from "@/lib/pet-sticker-artifacts";
import { petThumbnailKey } from "@/lib/pet-thumbnail";

describe("pet public artifact keys", () => {
  it("covers thumbnails, previews, every sticker derivative, and retired artifacts", () => {
    const keys = petPublicArtifactKeys("cai-chao");

    expect(keys).toContain(petThumbnailKey("cai-chao"));
    expect(keys).toContain(petPreviewKey("cai-chao"));
    expect(keys).toContain("pets/cai-chao/wastickers.zip");
    expect(keys).toContain(petStickerTrayKey("cai-chao"));

    for (const state of PET_STICKER_STATES) {
      for (const format of PET_STICKER_FORMATS) {
        for (const treatment of PET_STICKER_TREATMENTS) {
          expect(keys).toContain(
            petStickerKey("cai-chao", state, format, treatment),
          );
        }
      }
      for (const treatment of PET_STICKER_TREATMENTS) {
        expect(keys).toContain(
          petStickerKey("cai-chao", state, "webp", treatment, "whatsapp"),
        );
      }
    }

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers every legacy immutable sticker redirect", () => {
    expect(legacyPetStickerRedirectUrls("claude-crab")).toEqual([
      "https://petdex.dev/api/pets/claude-crab/sticker",
      "https://petdex.dev/api/pets/claude-crab/sticker?format=gif",
      "https://petdex.dev/api/pets/claude-crab/sticker?format=png",
    ]);
  });
});
