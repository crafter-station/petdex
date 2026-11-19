import { cache } from "react";

import { and, desc, eq, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { getMetricsBySlugs } from "@/lib/db/metrics";
import { type PetWithMetrics, rowToPet } from "@/lib/pets";

export const getCaughtSlugSet = cache(
  async (userId: string | null): Promise<Set<string>> => {
    if (!userId) return new Set();

    const rows = await db
      .select({ slug: schema.petLikes.petSlug })
      .from(schema.petLikes)
      .where(eq(schema.petLikes.userId, userId));

    return new Set(rows.map((row) => row.slug));
  },
);

export const getCatchProgress = cache(
  async (
    userId: string | null,
  ): Promise<{ caught: number; total: number; pct: number }> => {
    // Numerator and denominator must agree on which pets count. The total
    // excludes `source = 'discover'` (imported pets, not part of the
    // collectible set), so the caught count has to exclude them too — a like
    // on a discover pet is storable and its page is live (`getPet` and the
    // like route both gate only on `status`), so counting it here pushed a
    // user past 100%: measured "2/1 (200%)" for one submit-pet like plus one
    // discover-pet like. Join and filter the same way the total does.
    const [caughtResult, totalResult] = await Promise.all([
      userId
        ? (db.execute(sql`
            SELECT count(*)::int AS count
            FROM pet_likes
            JOIN submitted_pets ON submitted_pets.slug = pet_likes.pet_slug
            WHERE pet_likes.user_id = ${userId}
              AND submitted_pets.status = 'approved'
              AND submitted_pets.source <> 'discover'
          `) as Promise<{ rows: Array<{ count: number }> }>)
        : Promise.resolve({ rows: [{ count: 0 }] }),
      db.execute(sql`
        SELECT count(*)::int AS count
        FROM submitted_pets
        WHERE status = 'approved'
          AND source <> 'discover'
      `) as Promise<{ rows: Array<{ count: number }> }>,
    ]);

    const caught = caughtResult.rows[0]?.count ?? 0;
    const total = totalResult.rows[0]?.count ?? 0;
    const pct = total > 0 ? Math.round((caught / total) * 100) : 0;

    return { caught, total, pct };
  },
);

// Pets the user has liked, joined to submitted_pets so we only return
// rows that are still approved (so a takedown of a liked pet does not
// surface a broken card). Most-recent like first. Used by /my-pets to
// show the actual sprites behind the album counter.
export const getLikedPetsForUser = cache(
  async (userId: string | null): Promise<PetWithMetrics[]> => {
    if (!userId) return [];

    const rows = await db
      .select({
        pet: schema.submittedPets,
        likedAt: schema.petLikes.createdAt,
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
      .orderBy(desc(schema.petLikes.createdAt));

    if (rows.length === 0) return [];

    const slugs = rows.map((r) => r.pet.slug);
    const metrics = await getMetricsBySlugs(slugs);

    return rows.map((row) => ({
      ...rowToPet(row.pet),
      metrics: metrics.get(row.pet.slug) ?? {
        installCount: 0,
        likeCount: 0,
        zipDownloadCount: 0,
      },
    }));
  },
);
