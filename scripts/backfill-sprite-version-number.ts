// Backfill submitted_pets.sprite_version_number from each stored pet.json.
// Missing spriteVersionNumber means v1 by contract; only 1 and 2 are valid.
//
// Run:
//   bun --env-file .env.local scripts/backfill-sprite-version-number.ts

import { neon } from "@neondatabase/serverless";

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
    const res = await fetch(row.pet_json_url);
    if (!res.ok) {
      failed.push({ slug: row.slug, reason: `fetch ${res.status}` });
      continue;
    }
    const petJson = (await res.json()) as Record<string, unknown>;
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
