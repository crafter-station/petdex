import { petPreviewKey } from "@/lib/pet-preview";
import {
  PET_STICKER_FORMATS,
  PET_STICKER_STATES,
  PET_STICKER_TREATMENTS,
  petStickerKey,
  petStickerTrayKey,
} from "@/lib/pet-sticker-artifacts";
import { petThumbnailKey } from "@/lib/pet-thumbnail";

export function petPublicArtifactKeys(slug: string): string[] {
  return [
    petThumbnailKey(slug),
    petPreviewKey(slug),
    ...PET_STICKER_STATES.flatMap((state) =>
      PET_STICKER_FORMATS.flatMap((format) =>
        PET_STICKER_TREATMENTS.map((treatment) =>
          petStickerKey(slug, state, format, treatment),
        ),
      ),
    ),
    ...PET_STICKER_STATES.flatMap((state) =>
      PET_STICKER_TREATMENTS.map((treatment) =>
        petStickerKey(slug, state, "webp", treatment, "whatsapp"),
      ),
    ),
    petStickerTrayKey(slug),
    `pets/${slug}/wastickers.zip`,
  ];
}
