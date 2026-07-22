import "server-only";

import { STATIC_PETS, staticSpriteDataUri } from "@/lib/static-pets";
import {
  pickRandomPet,
  type RandomPetCandidate,
} from "@/lib/random-pet-selection";

export type RandomPet = RandomPetCandidate;

export async function getRandomPetPool(): Promise<RandomPet[]> {
  return STATIC_PETS.map((pet) => ({
    slug: pet.slug,
    displayName: pet.displayName,
    description: pet.description,
    spritesheetPath: staticSpriteDataUri(pet.slug),
  }));
}

export async function getRandomPet(): Promise<RandomPet | null> {
  const pool = await getRandomPetPool();
  return pickRandomPet(pool);
}
