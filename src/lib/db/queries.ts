import { and, desc, eq, ilike, or } from "drizzle-orm";

import { db, schema } from "./client";
import type { SubmissionReview, SubmittedPet } from "./schema";

export type SubmittedPetWithReview = SubmittedPet & {
  latestReview: SubmissionReview | null;
};

export async function listSubmittedPetsByStatus(
  status: SubmittedPet["status"],
): Promise<SubmittedPet[]> {
  return db
    .select()
    .from(schema.submittedPets)
    .where(eq(schema.submittedPets.status, status))
    .orderBy(desc(schema.submittedPets.createdAt));
}

export async function listAllSubmittedPets(): Promise<SubmittedPet[]> {
  return db
    .select()
    .from(schema.submittedPets)
    .orderBy(desc(schema.submittedPets.createdAt));
}

export async function listApprovedSubmittedPetsForModeration({
  limit,
  offset,
  query,
}: {
  limit: number;
  offset: number;
  query?: string;
}): Promise<SubmittedPet[]> {
  const filters = [eq(schema.submittedPets.status, "approved")];
  const normalizedQuery = query?.trim();
  if (normalizedQuery) {
    const like = `%${normalizedQuery}%`;
    const searchFilter = or(
      ilike(schema.submittedPets.slug, like),
      ilike(schema.submittedPets.displayName, like),
      ilike(schema.submittedPets.description, like),
      ilike(schema.submittedPets.ownerId, like),
      ilike(schema.submittedPets.creditName, like),
      ilike(schema.submittedPets.creditUrl, like),
    );
    if (searchFilter) filters.push(searchFilter);
  }

  return db
    .select()
    .from(schema.submittedPets)
    .where(and(...filters))
    .orderBy(
      desc(schema.submittedPets.approvedAt),
      desc(schema.submittedPets.createdAt),
    )
    .limit(limit)
    .offset(offset);
}

export async function listAllSubmittedPetsWithLatestReview(): Promise<
  SubmittedPetWithReview[]
> {
  const [pets, reviews] = await Promise.all([
    listAllSubmittedPets(),
    db
      .select()
      .from(schema.submissionReviews)
      .orderBy(desc(schema.submissionReviews.createdAt)),
  ]);

  const latestByPet = new Map<string, SubmissionReview>();
  for (const review of reviews) {
    if (!latestByPet.has(review.submittedPetId)) {
      latestByPet.set(review.submittedPetId, review);
    }
  }

  return pets.map((pet) => ({
    ...pet,
    latestReview: latestByPet.get(pet.id) ?? null,
  }));
}

export async function getSubmittedPetById(
  id: string,
): Promise<SubmittedPet | null> {
  const row = await db.query.submittedPets.findFirst({
    where: eq(schema.submittedPets.id, id),
  });
  return row ?? null;
}
