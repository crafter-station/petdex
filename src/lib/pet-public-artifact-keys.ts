import {
  PET_STICKER_FORMATS,
  PET_STICKER_STATES,
  petStickerKey,
  petStickerPackKey,
} from "@/lib/pet-sticker-artifacts";
import { petThumbnailKey } from "@/lib/pet-thumbnail";

export function petPublicArtifactKeys(slug: string): string[] {
  return [
    petThumbnailKey(slug),
    ...PET_STICKER_STATES.flatMap((state) =>
      PET_STICKER_FORMATS.map((format) => petStickerKey(slug, state, format)),
    ),
    petStickerPackKey(slug),
  ];
}
