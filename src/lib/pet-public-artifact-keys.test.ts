import { describe, expect, it } from "bun:test";

import { petPreviewKey } from "@/lib/pet-preview";
import { petPublicArtifactKeys } from "@/lib/pet-public-artifact-keys";
import {
  legacyPetStickerRedirectUrls,
  PET_STICKER_FORMATS,
  PET_STICKER_STATES,
  PET_STICKER_TREATMENTS,
  petStickerFilename,
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
      "https://petdex.dev/api/pets/claude-crab/sticker?download=1",
      "https://petdex.dev/api/pets/claude-crab/sticker?format=gif",
      "https://petdex.dev/api/pets/claude-crab/sticker?format=gif&download=1",
      "https://petdex.dev/api/pets/claude-crab/sticker?format=png",
      "https://petdex.dev/api/pets/claude-crab/sticker?format=png&download=1",
    ]);
  });

  it("keeps web and WhatsApp artifact contracts distinct", () => {
    expect(
      petStickerKey("claude-crab", "waiting", "webp", "outline", "whatsapp"),
    ).toBe("pets/claude-crab/stickers/whatsapp/waiting-outline.webp");
    expect(
      petStickerFilename(
        "claude-crab",
        "waiting",
        "webp",
        "outline",
        "whatsapp",
      ),
    ).toBe("claude-crab-waiting-outline-whatsapp-sticker.webp");
    expect(
      petStickerFilename("claude-crab", "idle", "png", "clean", "web"),
    ).toBe("claude-crab-sticker.png");
  });
});
