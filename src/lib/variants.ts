import { cache } from "react";

import { eq } from "drizzle-orm";

import { AGGREGATE_KEYS, cachedAggregate } from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";
import { getDexNumberMap } from "@/lib/dex";
import { withNextDataCache } from "@/lib/next-data-cache";
import { toCurrentR2PublicUrl } from "@/lib/r2-public-url";

export const VARIANT_DISTANCE_THRESHOLD = 14;
export const VARIANT_MAX_RESULTS = 6;

export type Variant = {
  slug: string;
  displayName: string;
  spritesheetUrl: string;
  distance: number;
  dexNumber: number | null;
};

type VariantIndexRow = {
  slug: string;
  displayName: string;
  spritesheetUrl: string;
  dhash: string | null;
  source: "submit" | "discover" | "claimed";
};

const VARIANT_INDEX_TTL_SECONDS = 600;

const getVariantIndex = cache(async (): Promise<VariantIndexRow[]> => {
  return withNextDataCache(
    async () =>
      cachedAggregate(
        {
          key: AGGREGATE_KEYS.variantIndex,
          ttlSeconds: VARIANT_INDEX_TTL_SECONDS,
        },
        async () => {
          const rows = await db.query.submittedPets.findMany({
            columns: {
              slug: true,
              displayName: true,
              spritesheetUrl: true,
              dhash: true,
              source: true,
            },
            where: eq(schema.submittedPets.status, "approved"),
          });

          return rows.map((row) => ({
            slug: row.slug,
            displayName: row.displayName,
            spritesheetUrl: toCurrentR2PublicUrl(row.spritesheetUrl),
            dhash: row.dhash,
            source: row.source,
          }));
        },
      ),
    ["petdex-variant-index"],
    { tags: ["petdex:variant-index"], revalidate: VARIANT_INDEX_TTL_SECONDS },
  )();
});

export const getVariantsFor = cache(
  async (slug: string): Promise<Variant[]> => {
    const rows = await getVariantIndex();
    const currentPet = rows.find((row) => row.slug === slug);

    if (!currentPet) {
      throw new Error("PET_NOT_FOUND");
    }

    if (!currentPet.dhash) {
      return [];
    }

    const selfHash = BigInt(`0x${currentPet.dhash}`);
    const dexMap = await getDexNumberMap();

    return rows
      .filter(
        (row): row is VariantIndexRow & { dhash: string } =>
          row.source !== "discover" &&
          row.slug !== currentPet.slug &&
          Boolean(row.dhash),
      )
      .map((row) => ({
        slug: row.slug,
        displayName: row.displayName,
        spritesheetUrl: row.spritesheetUrl,
        distance: hammingDistance(selfHash, row.dhash),
        dexNumber: dexMap.get(row.slug) ?? null,
      }))
      .filter((row) => row.distance <= VARIANT_DISTANCE_THRESHOLD)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, VARIANT_MAX_RESULTS);
  },
);

function hammingDistance(selfHash: bigint, otherHash: string): number {
  let xor = selfHash ^ BigInt(`0x${otherHash}`);
  let distance = 0;
  const zero = BigInt(0);
  const one = BigInt(1);

  while (xor !== zero) {
    distance += Number(xor & one);
    xor >>= one;
  }

  return distance;
}
