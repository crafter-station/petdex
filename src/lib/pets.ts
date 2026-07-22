// No database in this repo — every pet is static data (see static-pets.ts).

import {
  FEATURED_PET_SLUGS,
  STATIC_PETS,
  STATIC_PETS_BY_SLUG,
  staticSpriteDataUri,
} from "@/lib/static-pets";

export type PetMetrics = {
  installCount: number;
  zipDownloadCount: number;
  likeCount: number;
};

export type PetWithMetrics = {
  slug: string;
  displayName: string;
  description: string;
  spritesheetPath: string;
  metrics: PetMetrics;
};

const EMPTY_METRICS: PetMetrics = {
  installCount: 0,
  zipDownloadCount: 0,
  likeCount: 0,
};

function toPetWithMetrics(slug: string): PetWithMetrics | null {
  const pet = STATIC_PETS_BY_SLUG.get(slug);
  if (!pet) return null;
  return {
    slug: pet.slug,
    displayName: pet.displayName,
    description: pet.description,
    spritesheetPath: staticSpriteDataUri(pet.slug),
    metrics: EMPTY_METRICS,
  };
}

export async function getFeaturedPetsWithMetrics(
  limit = 6,
): Promise<PetWithMetrics[]> {
  return FEATURED_PET_SLUGS.slice(0, limit)
    .map(toPetWithMetrics)
    .filter((pet): pet is PetWithMetrics => pet !== null);
}

export type LatestApprovedPet = {
  slug: string;
  displayName: string;
  approvedAt: string | null;
};

export async function getLatestApprovedPets(
  limit = 5,
): Promise<LatestApprovedPet[]> {
  return STATIC_PETS.slice()
    .sort((a, b) => (a.approvedAt < b.approvedAt ? 1 : -1))
    .slice(0, limit)
    .map((pet) => ({
      slug: pet.slug,
      displayName: pet.displayName,
      approvedAt: pet.approvedAt,
    }));
}
