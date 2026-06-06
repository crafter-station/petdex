import { getCollectionsForListing } from "@/lib/collections";
import { petThumbnailUrlForSource } from "@/lib/pet-thumbnail";

export type CollectionPreviewSnapshotPet = {
  slug: string;
  displayName: string;
  spritesheetPath: string;
  thumbUrl?: string;
};

export type CollectionPreviewSnapshotCollection = {
  slug: string;
  pets: CollectionPreviewSnapshotPet[];
};

export type CollectionPreviewSnapshot = {
  v: 1;
  generatedAt: string;
  minPets: number;
  petsPerPreview: number;
  total: number;
  collections: CollectionPreviewSnapshotCollection[];
};

export async function buildCollectionPreviewSnapshot(
  minPets = 4,
  petsPerPreview = 6,
): Promise<CollectionPreviewSnapshot> {
  const collections = await getCollectionsForListing(minPets, petsPerPreview);
  const items = collections.map((collection) => ({
    slug: collection.slug,
    pets: collection.pets.map((pet) => ({
      slug: pet.slug,
      displayName: pet.displayName,
      spritesheetPath: pet.spritesheetPath,
      thumbUrl:
        petThumbnailUrlForSource(pet.slug, pet.spritesheetPath) ?? undefined,
    })),
  }));

  return {
    v: 1,
    generatedAt: new Date().toISOString(),
    minPets,
    petsPerPreview,
    total: items.length,
    collections: items,
  };
}
