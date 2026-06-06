import { describe, expect, it } from "bun:test";

import { petPublicArtifactKeys } from "@/lib/pet-public-artifact-keys";
import {
  PET_STICKER_FORMATS,
  PET_STICKER_STATES,
} from "@/lib/pet-sticker-artifacts";
import { petThumbnailKey } from "@/lib/pet-thumbnail";

describe("pet public artifact keys", () => {
  it("covers thumbnails, every sticker derivative, and packs", () => {
    const keys = petPublicArtifactKeys("cai-chao");

    expect(keys).toContain(petThumbnailKey("cai-chao"));
    expect(keys).toContain("pets/cai-chao/wastickers.zip");

    for (const state of PET_STICKER_STATES) {
      for (const format of PET_STICKER_FORMATS) {
        expect(keys).toContain(`pets/cai-chao/stickers/${state}.${format}`);
      }
    }

    expect(new Set(keys).size).toBe(keys.length);
  });
});
