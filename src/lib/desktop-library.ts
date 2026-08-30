import { and, desc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { petThumbnailUrlForSource } from "@/lib/pet-thumbnail";

export type DesktopLibraryPet = {
  id?: string;
  slug: string;
  displayName: string;
  status: "pending" | "approved" | "rejected" | "caught";
  thumbnailUrl?: string;
};

const desktopLibraryLimit = 64;

export async function getDesktopLibrary(userId: string): Promise<{
  owned: DesktopLibraryPet[];
  caught: DesktopLibraryPet[];
}> {
  const [owned, caught] = await Promise.all([
    db
      .select({
        id: schema.submittedPets.id,
        slug: schema.submittedPets.slug,
        displayName: schema.submittedPets.displayName,
        status: schema.submittedPets.status,
        spritesheetUrl: schema.submittedPets.spritesheetUrl,
      })
      .from(schema.submittedPets)
      .where(eq(schema.submittedPets.ownerId, userId))
      .orderBy(desc(schema.submittedPets.createdAt))
      .limit(desktopLibraryLimit),
    db
      .select({
        slug: schema.submittedPets.slug,
        displayName: schema.submittedPets.displayName,
        spritesheetUrl: schema.submittedPets.spritesheetUrl,
      })
      .from(schema.petLikes)
      .innerJoin(
        schema.submittedPets,
        eq(schema.submittedPets.slug, schema.petLikes.petSlug),
      )
      .where(
        and(
          eq(schema.petLikes.userId, userId),
          eq(schema.submittedPets.status, "approved"),
        ),
      )
      .orderBy(desc(schema.petLikes.createdAt))
      .limit(desktopLibraryLimit),
  ]);

  return {
    owned: owned.map(({ spritesheetUrl, ...pet }) => ({
      ...pet,
      ...(pet.status === "approved"
        ? {
            thumbnailUrl:
              petThumbnailUrlForSource(pet.slug, spritesheetUrl) ?? undefined,
          }
        : {}),
    })),
    caught: caught.map(({ spritesheetUrl, ...pet }) => ({
      ...pet,
      status: "caught" as const,
      thumbnailUrl:
        petThumbnailUrlForSource(pet.slug, spritesheetUrl) ?? undefined,
    })),
  };
}
