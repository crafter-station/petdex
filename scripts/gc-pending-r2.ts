// Garbage-collect stale owner-edit uploads.
//
// Dry run by default:
//   bun scripts/gc-pending-r2.ts [--age-hours 24]
// Apply deletions explicitly:
//   bun scripts/gc-pending-r2.ts --age-hours 24 --apply

import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { neon } from "@neondatabase/serverless";

import { parsePendingGcArgs } from "../src/lib/gc-pending-args";
import { isPendingAssetKey } from "../src/lib/pending-asset";
import { PENDING_ASSET_GC_LOCK_KEY } from "../src/lib/pending-asset-gc";
import {
  deleteR2Objects,
  R2_BUCKET,
  type R2DeleteFailure,
  r2,
  summarizeR2DeleteBatch,
} from "../src/lib/r2";
import { keyFromR2PublicUrl } from "../src/lib/r2-public-url";
import { requiredEnv } from "./env";

const { apply: APPLY, ageHours: AGE_HOURS } = parsePendingGcArgs(
  process.argv.slice(2),
);
const sql = neon(requiredEnv("DATABASE_URL"));

type ObjectRow = { key: string; lastModified: Date };

async function listObjects(): Promise<ObjectRow[]> {
  const objects: ObjectRow[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await r2.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: "pets/",
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key && object.LastModified) {
        objects.push({ key: object.Key, lastModified: object.LastModified });
      }
    }
    continuationToken = page.IsTruncated
      ? page.NextContinuationToken
      : undefined;
  } while (continuationToken);
  return objects;
}

async function referencedKeys(): Promise<Set<string>> {
  const rows = (await sql`
    SELECT spritesheet_url, pet_json_url, zip_url,
           pending_spritesheet_url, pending_pet_json_url, pending_zip_url
    FROM submitted_pets
  `) as Array<Record<string, string | null>>;
  const keys = new Set<string>();
  for (const row of rows) {
    for (const column of [
      "spritesheet_url",
      "pet_json_url",
      "zip_url",
      "pending_spritesheet_url",
      "pending_pet_json_url",
      "pending_zip_url",
    ]) {
      const key = keyFromR2PublicUrl(row[column]);
      if (key && isPendingAssetKey(key)) keys.add(key);
    }
  }
  return keys;
}

async function claimOrphanedKeys(keys: string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const results = await sql.transaction(
    (tx) => [
      tx`SELECT pg_advisory_xact_lock(${PENDING_ASSET_GC_LOCK_KEY})`,
      tx`
        WITH candidates(key) AS (
          SELECT unnest(${keys}::text[])
        ),
        referenced_keys(key) AS (
          SELECT split_part(
            regexp_replace(split_part(value, '?', 1), '^https?://[^/]+/', ''),
            '#',
            1
          )
          FROM submitted_pets AS pet
          CROSS JOIN LATERAL unnest(ARRAY[
            pet.spritesheet_url,
            pet.pet_json_url,
            pet.zip_url,
            pet.pending_spritesheet_url,
            pet.pending_pet_json_url,
            pet.pending_zip_url
          ]) AS urls(value)
          WHERE value IS NOT NULL
        ),
        eligible(key) AS (
          SELECT candidate.key
          FROM candidates AS candidate
          WHERE NOT EXISTS (
            SELECT 1
            FROM referenced_keys AS reference
            WHERE reference.key = candidate.key
          )
        ),
        inserted AS (
          INSERT INTO pending_asset_gc_claims (key)
          SELECT eligible.key
          FROM eligible
          ON CONFLICT (key) DO NOTHING
          RETURNING key
        )
        SELECT key FROM inserted
        UNION
        SELECT claim.key
        FROM pending_asset_gc_claims AS claim
        INNER JOIN eligible ON eligible.key = claim.key
      `,
    ],
    { isolationLevel: "Serializable" },
  );
  const rows = results[1] as Array<{ key: string }>;
  return rows.map((row) => row.key);
}

type DeleteSummary = {
  deletedKeys: string[];
  failures: R2DeleteFailure[];
};

async function deleteInBatches(keys: string[]): Promise<DeleteSummary> {
  const summary: DeleteSummary = { deletedKeys: [], failures: [] };
  for (let offset = 0; offset < keys.length; offset += 1000) {
    const batch = keys.slice(offset, offset + 1000);
    try {
      const result = await deleteR2Objects(batch);
      const batchSummary = summarizeR2DeleteBatch(batch, result);
      summary.deletedKeys.push(...batchSummary.deletedKeys);
      summary.failures.push(...batchSummary.failures);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.failures.push(
        ...batch.map((key) => ({
          key,
          code: "request_failed",
          message,
        })),
      );
    }
  }
  return summary;
}

async function main(): Promise<void> {
  const cutoff = Date.now() - AGE_HOURS * 60 * 60 * 1000;
  const objects = await listObjects();
  const referenced = await referencedKeys();
  const candidates = objects.filter(
    (object) =>
      object.lastModified.getTime() < cutoff && isPendingAssetKey(object.key),
  );
  const orphaned = candidates.filter((object) => !referenced.has(object.key));

  console.log(
    JSON.stringify({
      mode: APPLY ? "apply" : "dry-run",
      ageHours: AGE_HOURS,
      scanned: objects.length,
      candidates: candidates.length,
      referenced: candidates.length - orphaned.length,
      orphaned: orphaned.length,
    }),
  );

  if (!APPLY || orphaned.length === 0) return;
  const claimedKeys = await claimOrphanedKeys(
    orphaned.map((object) => object.key),
  );
  const summary = await deleteInBatches(claimedKeys);
  console.log(
    JSON.stringify({
      claimed: claimedKeys.length,
      deleted: summary.deletedKeys.length,
      failed: summary.failures.length,
      failures: summary.failures,
    }),
  );
  if (summary.failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("gc-pending-r2 failed:", error);
  process.exitCode = 1;
});
