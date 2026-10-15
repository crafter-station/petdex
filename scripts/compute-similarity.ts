// Compute perceptual hash + current-model semantic embedding for every
// approved / pending pet. Re-runs are idempotent: rows already populated
// for PETDEX_EMBEDDING_MODEL are skipped unless --force is passed.
//
// Usage:
//   bun scripts/compute-similarity.ts          # only un-hashed rows
//   bun scripts/compute-similarity.ts --force  # rehash everything
//
// Migration note: 0005 intentionally nulls old 1536-dim text embeddings when
// moving to the required 3072-dim Gemini image-aware embedding model. Re-run
// this script with --force after applying 0005 anywhere 0004 had populated
// embeddings.

import { neon } from "@neondatabase/serverless";

import {
  buildPetEmbeddingText,
  embeddingVectorLiteral,
  embedTextValue,
  PETDEX_EMBEDDING_MODEL,
} from "../src/lib/embeddings";
import { fetchR2AssetBuffer } from "../src/lib/r2-fetch";
import { dhashFromSpriteBuffer } from "../src/lib/sprite-dhash";

const args = new Set(process.argv.slice(2));
const FORCE = args.has("--force");

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const sql = neon(env("DATABASE_URL")); // raw for vector inserts

// Fetch the spritesheet and hash it with the SAME scale-aware helper the
// review path uses (`dhashFromSpriteBuffer`). This script used to carry its own
// copy that always cropped 192×208, so on an integer-scaled atlas (a legal
// 3072×3744 v1 sheet) it sampled a quarter of the first frame and produced a
// different hash than the review path — and a `--force` run rewrote the fixed
// hashes back to the old format.
async function dhash(spriteUrl: string): Promise<string | null> {
  try {
    // Bounded: the URL comes from a DB row, and a stalled or oversized
    // upstream would otherwise hang the run or buffer without limit.
    const buf = await fetchR2AssetBuffer(spriteUrl);
    if (!buf) return null;
    return await dhashFromSpriteBuffer(buf);
  } catch (err) {
    console.warn("  dhash fail:", (err as Error).message);
    return null;
  }
}

async function main() {
  // Process approved + pending. Curated featured already approved.
  const rows = await sql`
    SELECT id, slug, display_name, description, spritesheet_url,
           tags, vibes, kind, dhash
    FROM submitted_pets
    WHERE status IN ('approved','pending')
    ORDER BY created_at ASC
  `;

  console.log(`processing ${rows.length} pets (force=${FORCE})`);

  let processed = 0;
  let skipped = 0;
  // A pet that needed a dhash or an embedding but got `null` back (R2 fetch
  // miss, dead AI key, dimension mismatch) used to print OK and write nothing,
  // so a full run with a misconfigured key read as complete. Count it and exit
  // non-zero, matching the backfills' "counted failure → non-zero" convention.
  let failed = 0;
  for (const row of rows) {
    const r = row as {
      id: string;
      slug: string;
      display_name: string;
      description: string;
      spritesheet_url: string;
      tags: unknown;
      vibes: unknown;
      kind: string;
      dhash: string | null;
    };
    const needsDhash = FORCE || !r.dhash;

    // Check if a current-model embedding exists. We can't use drizzle's
    // findFirst because the vector columns aren't declared in schema.ts.
    const [exist] = await sql`
      SELECT (embedding IS NOT NULL AND embedding_model = ${PETDEX_EMBEDDING_MODEL}) as has_embedding
      FROM submitted_pets WHERE id = ${r.id}
    `;
    const needsEmbed =
      FORCE || !(exist as { has_embedding: boolean }).has_embedding;

    if (!needsDhash && !needsEmbed) {
      skipped++;
      continue;
    }

    process.stdout.write(`[${processed + 1}/${rows.length}] ${r.slug} ... `);

    if (needsDhash) {
      const h = await dhash(r.spritesheet_url);
      if (h) {
        await sql`UPDATE submitted_pets SET dhash = ${h} WHERE id = ${r.id}`;
      } else {
        failed++;
      }
    }

    if (needsEmbed) {
      const tagsArr = Array.isArray(r.tags) ? (r.tags as string[]) : [];
      const vibesArr = Array.isArray(r.vibes) ? (r.vibes as string[]) : [];
      const text = buildPetEmbeddingText({
        displayName: r.display_name,
        description: r.description,
        kind: r.kind,
        tags: tagsArr,
        vibes: vibesArr,
      });
      const v = await embedTextValue(text);
      if (v) {
        const lit = embeddingVectorLiteral(v);
        await sql`
          UPDATE submitted_pets
          SET embedding = ${lit}::vector,
              embedding_model = ${PETDEX_EMBEDDING_MODEL}
          WHERE id = ${r.id}
        `;
      } else {
        failed++;
      }
    }

    processed++;
    process.stdout.write("OK\n");
  }

  console.log(
    `\nprocessed: ${processed}, skipped: ${skipped}, failed: ${failed}`,
  );
  if (failed > 0) process.exitCode = 1;
}

await main();
