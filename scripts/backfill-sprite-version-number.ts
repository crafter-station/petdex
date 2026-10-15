// Backfill submitted_pets.sprite_version_number from each stored pet.json.
// Missing spriteVersionNumber means v1 by contract; only 1 and 2 are valid.
//
// Run:
//   bun --env-file .env.local scripts/backfill-sprite-version-number.ts

import { neon } from "@neondatabase/serverless";

import { fetchR2AssetBuffer } from "../src/lib/r2-fetch";
import { parseSpriteVersionNumber } from "../src/lib/sprite-version";
import { requiredEnv } from "./env";

const sql = neon(requiredEnv("DATABASE_URL"));

type Row = {
  id: string;
  slug: string;
  pet_json_url: string;
};

const rows = (await sql`
  SELECT id, slug, pet_json_url
  FROM submitted_pets
  ORDER BY created_at ASC
`) as Row[];

let updated = 0;
const failed: Array<{ slug: string; reason: string }> = [];

for (const row of rows) {
  try {
    // Bounded: a pet.json is small, and a stalled or oversized upstream must
    // not hang the run.
    const buf = await fetchR2AssetBuffer(row.pet_json_url, {
      maxBytes: 1024 * 1024,
    });
    if (!buf) {
      failed.push({ slug: row.slug, reason: "fetch failed" });
      continue;
    }
    const petJson = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
    const parsed = parseSpriteVersionNumber(petJson);
    if (!parsed.ok) {
      failed.push({
        slug: row.slug,
        reason: `unsupported spriteVersionNumber ${String(parsed.value)}`,
      });
      continue;
    }

    await sql`
      UPDATE submitted_pets
      SET sprite_version_number = ${parsed.version}
      WHERE id = ${row.id}
    `;
    updated += 1;
    console.log(`ok   ${row.slug} -> v${parsed.version}`);
  } catch (err) {
    failed.push({
      slug: row.slug,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

console.log(`done updated=${updated} failed=${failed.length}`);
for (const item of failed) {
  console.log(`fail ${item.slug}: ${item.reason}`);
}
// Exit non-zero when anything failed: a caller scripting this saw exit 0 and
// read the run as complete, while the pets it could not update stayed wrong.
if (failed.length > 0) process.exit(1);
