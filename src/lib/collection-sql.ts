import { sql } from "drizzle-orm";

/**
 * Resolve an omitted cover against the row being updated, not a stale
 * application snapshot. The caller runs this expression while holding the
 * collection advisory lock and replaces the item list in the same mutation.
 */
export function collectionCoverForPetSlugsQuery(petSlugs: readonly string[]) {
  if (petSlugs.length === 0) return sql`NULL`;
  const values = sql.join(
    petSlugs.map((petSlug) => sql`${petSlug}`),
    sql`, `,
  );
  return sql`
    CASE
      WHEN "cover_pet_slug" IS NOT NULL
        AND "cover_pet_slug" IN (${values})
      THEN "cover_pet_slug"
      ELSE ${petSlugs[0]}
    END
  `;
}
