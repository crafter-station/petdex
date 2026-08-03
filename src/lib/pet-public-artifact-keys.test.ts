import { describe, expect, it } from "bun:test";

import { petPreviewKey } from "@/lib/pet-preview";
import { petPublicArtifactKeys } from "@/lib/pet-public-artifact-keys";
import {
  PET_STICKER_FORMATS,
  PET_STICKER_STATES,
  PET_STICKER_TREATMENTS,
  petStickerKey,
} from "@/lib/pet-sticker-artifacts";
import { petThumbnailKey } from "@/lib/pet-thumbnail";

describe("pet public artifact keys", () => {
  it("covers thumbnails, previews, every sticker derivative, and packs", () => {
    const keys = petPublicArtifactKeys("cai-chao");

    expect(keys).toContain(petThumbnailKey("cai-chao"));
    expect(keys).toContain(petPreviewKey("cai-chao"));
    expect(keys).toContain("pets/cai-chao/wastickers.zip");

    for (const state of PET_STICKER_STATES) {
      for (const format of PET_STICKER_FORMATS) {
        for (const treatment of PET_STICKER_TREATMENTS) {
          expect(keys).toContain(
            petStickerKey("cai-chao", state, format, treatment),
          );
        }
      }
    }

    expect(new Set(keys).size).toBe(keys.length);
  });
});
