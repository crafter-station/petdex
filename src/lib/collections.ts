// No database in this repo, and no collections were ever seeded even
// when there was one — this always returned an empty list in mock mode.
// Kept as a function (rather than inlining `[]` at the call site) so
// page.tsx doesn't need to change its shape if collections come back.

import type { PetWithMetrics } from "@/lib/pets";

export type PetCollectionWithPets = {
  slug: string;
  title: string;
  description: string;
  coverPetSlug: string | null;
  pets: PetWithMetrics[];
};

export async function getCollectionsBySlugs(
  _slugs: string[],
  _petsPerCollection = 6,
): Promise<PetCollectionWithPets[]> {
  return [];
}
