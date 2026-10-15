// Compute a perceptual hash + a semantic embedding for a single pet row
// and persist them. Designed to run server-side (Node), idempotent
// against re-runs, and fail-soft so the caller never blocks on it.
//
// Used by:
//   - /api/admin/[id] approve path (fire-and-forget after approval)
//   - scripts/compute-similarity.ts for bulk backfill

import { eq } from "drizzle-orm";

import {
  AGGREGATE_KEYS,
  invalidateAggregates,
  invalidatePetCaches,
} from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";
import {
  buildPetEmbeddingText,
  embeddingVectorLiteral,
  embedTextValue,
  PETDEX_EMBEDDING_MODEL,
} from "@/lib/embeddings";
import { fetchR2AssetBuffer } from "@/lib/r2-fetch";
import { toCurrentR2PublicUrl } from "@/lib/r2-public-url";
import { dhashFromSpriteBuffer } from "@/lib/sprite-dhash";
import { isAllowedAssetUrl } from "@/lib/url-allowlist";

// The pixel hashing lives in its own module so the review path can hash a
// sheet without importing this module's DB client; re-exported here so the
// existing `@/lib/similarity` importers keep working.
export { dhashFromSpriteBuffer };

export async function dhashFromSpriteUrl(
  spriteUrl: string,
): Promise<string | null> {
  if (!isAllowedAssetUrl(spriteUrl)) return null;
  try {
    // The allowlist pins the host, but the body is whatever the bucket
    // serves — bounded read with a deadline, same ceiling as the review path.
    const buf = await fetchR2AssetBuffer(spriteUrl);
    if (!buf) return null;
    return dhashFromSpriteBuffer(buf);
  } catch {
    return null;
  }
}

export function hammingDistanceHex(a: string, b: string): number {
  const ZERO = BigInt(0);
  const ONE = BigInt(1);
  let xor = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let distance = 0;
  while (xor !== ZERO) {
    distance += Number(xor & ONE);
    xor >>= ONE;
  }
  return distance;
}

export async function embedPetText(args: {
  displayName: string;
  description: string;
  kind: string;
  tags: string[];
  vibes: string[];
}): Promise<number[] | null> {
  return embedTextValue(buildPetEmbeddingText(args));
}

/** Persist dhash + embedding for the given pet id. */
export async function refreshSimilarityFor(petId: string): Promise<void> {
  const row = await db.query.submittedPets.findFirst({
    where: eq(schema.submittedPets.id, petId),
  });
  if (!row) return;

  const [hash, vec] = await Promise.all([
    // The row's stored URL may still point at a legacy public host, which the
    // allowlist deliberately excludes — so the hash came back null for every
    // such pet and it never got a dhash. Rewrite first: the value that is
    // validated and fetched is then the value the bucket actually serves.
    dhashFromSpriteUrl(toCurrentR2PublicUrl(row.spritesheetUrl)),
    embedPetText({
      displayName: row.displayName,
      description: row.description,
      kind: row.kind,
      tags: (row.tags as string[]) ?? [],
      vibes: (row.vibes as string[]) ?? [],
    }),
  ]);

  if (hash) {
    await db
      .update(schema.submittedPets)
      .set({ dhash: hash })
      .where(eq(schema.submittedPets.id, petId));
    await invalidateAggregates(AGGREGATE_KEYS.variantIndex);
    await invalidatePetCaches(row.slug);
  }
  if (vec) {
    await persistPetEmbedding(petId, vec);
  }
}

export async function persistPetEmbedding(
  petId: string,
  vec: number[],
): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  // Drizzle doesn't model pgvector yet; raw SQL through the shared db
  // client (the same escape hatch dex.ts uses). The bare neon() this
  // replaced opened a second connection pool that skipped the local-driver
  // detection and the postgres-js `.rows` normalization, so a local run
  // wrote through a different path than production — same statement, two
  // code paths, one of them untested.
  const literal = embeddingVectorLiteral(vec);
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`
    UPDATE submitted_pets
    SET embedding = ${literal}::vector,
        embedding_model = ${PETDEX_EMBEDDING_MODEL}
    WHERE id = ${petId}
  `);
}
