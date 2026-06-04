import "server-only";

import { and, eq, ne } from "drizzle-orm";

import { AGGREGATE_KEYS, cachedAggregate } from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";
import {
  pickRandomPet,
  type RandomPetCandidate,
} from "@/lib/random-pet-selection";

const RANDOM_POOL_TTL_SECONDS = 300;

export type RandomPet = RandomPetCandidate;

export async function getRandomPetPool(): Promise<RandomPet[]> {
  return cachedAggregate(
    {
      key: AGGREGATE_KEYS.randomPetPool,
      ttlSeconds: RANDOM_POOL_TTL_SECONDS,
    },
    async () =>
      db
        .select({
          slug: schema.submittedPets.slug,
          displayName: schema.submittedPets.displayName,
          description: schema.submittedPets.description,
          spritesheetPath: schema.submittedPets.spritesheetUrl,
        })
        .from(schema.submittedPets)
        .where(
          and(
            eq(schema.submittedPets.status, "approved"),
            ne(schema.submittedPets.source, "discover"),
          ),
        ),
  );
}

export async function getRandomPet(): Promise<RandomPet | null> {
  const pool = await getRandomPetPool();
  return pickRandomPet(pool);
}
