import type { PetStateId } from "@/lib/pet-states";
import {
  isValidPetSlug,
  PET_STICKER_STATES,
  PET_STICKER_TREATMENTS,
  type PetStickerTreatment,
} from "@/lib/pet-sticker-artifacts";

export const STICKER_REACTION_STATES = [
  "waiting",
  "running",
  "review",
  "failed",
  "jumping",
] as const satisfies readonly PetStateId[];

export const STICKER_DECK_LIMIT = 12;

export type StickerDeckItem = {
  pet: string;
  state: PetStateId;
  treatment: PetStickerTreatment;
};

export function parseStickerExplorerSelection(
  params: URLSearchParams,
  availablePets: string[],
): StickerDeckItem {
  const pet = params.get("pet");
  const reaction = params.get("reaction");
  const treatment = params.get("treatment");
  return {
    pet: pet && availablePets.includes(pet) ? pet : (availablePets[0] ?? ""),
    state: PET_STICKER_STATES.includes(reaction as PetStateId)
      ? (reaction as PetStateId)
      : "waiting",
    treatment: PET_STICKER_TREATMENTS.includes(treatment as PetStickerTreatment)
      ? (treatment as PetStickerTreatment)
      : "outline",
  };
}

export function serializeStickerSelection(item: StickerDeckItem): string {
  return `${item.pet}.${item.state}.${item.treatment}`;
}

export function parseStickerDeck(
  raw: string | null,
  availablePets: string[],
): StickerDeckItem[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const items: StickerDeckItem[] = [];
  for (const value of raw.split(",")) {
    const parts = value.split(".");
    if (parts.length !== 3) continue;
    const [pet, state, treatment] = parts;
    if (
      !isValidPetSlug(pet) ||
      !availablePets.includes(pet) ||
      !PET_STICKER_STATES.includes(state as PetStateId) ||
      !PET_STICKER_TREATMENTS.includes(treatment as PetStickerTreatment)
    ) {
      continue;
    }
    const item = {
      pet,
      state: state as PetStateId,
      treatment: treatment as PetStickerTreatment,
    };
    const key = serializeStickerSelection(item);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length === STICKER_DECK_LIMIT) break;
  }
  return items;
}

export function upsertStickerExplorerParams(
  params: URLSearchParams,
  selection: StickerDeckItem,
  deck: StickerDeckItem[],
): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set("reaction", selection.state);
  next.set("pet", selection.pet);
  next.set("treatment", selection.treatment);
  if (deck.length > 0) {
    next.set("deck", deck.map(serializeStickerSelection).join(","));
  } else {
    next.delete("deck");
  }
  return next;
}
