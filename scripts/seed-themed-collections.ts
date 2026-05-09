// Seeds franchise-based collections from REAL data: reads
// scripts/.franchise-buckets.json (output of extract-franchises.ts)
// and creates one collection per franchise that has >= 2 pets.
//
// Each collection is featured + auto-populated. Re-run safe.
//
// Uses neon() directly (not src/lib/db/client which is server-only)
// so it runs as a standalone Bun script.
//
// Run order:
//   1. bun --env-file .env.local scripts/extract-franchises.ts
//   2. bun --env-file .env.local scripts/seed-themed-collections.ts --dry
//   3. bun --env-file .env.local scripts/seed-themed-collections.ts

import { readFileSync } from "node:fs";

import { neon } from "@neondatabase/serverless";

import { requiredEnv } from "./env";

const sql = neon(requiredEnv("DATABASE_URL"));
const dryRun = process.argv.includes("--dry");
const minPets = Number(
  process.argv.find((a) => a.startsWith("--min="))?.split("=")[1] ?? 2,
);

type Bucket = {
  generatedAt: string;
  totalApproved: number;
  buckets: Record<string, string[]>;
};

const data = JSON.parse(
  readFileSync("./scripts/.franchise-buckets.json", "utf8"),
) as Bucket;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function description(name: string, count: number): string {
  return `${count} community fan submissions inspired by ${name}. Made by Petdex creators.`;
}

const entries = Object.entries(data.buckets)
  .filter(([, slugs]) => slugs.length >= minPets)
  .sort(([, a], [, b]) => b.length - a.length);

if (entries.length === 0) {
  console.error(
    `no franchise has >=${minPets} pets — re-run extractor or lower --min`,
  );
  process.exit(1);
}

console.log(
  `\nseeding ${entries.length} franchise collections (mode=${dryRun ? "DRY" : "APPLY"})\n`,
);

for (const [franchise, petSlugs] of entries) {
  const slug = `franchise-${slugify(franchise)}`;
  const title = franchise;
  const desc = description(franchise, petSlugs.length);

  console.log(`${slug.padEnd(38)} ${petSlugs.length} pets`);

  if (dryRun) {
    console.log(
      `  → ${petSlugs.slice(0, 5).join(", ")}${petSlugs.length > 5 ? "…" : ""}`,
    );
    continue;
  }

  const existing = await sql`
    SELECT id FROM pet_collections WHERE slug = ${slug} LIMIT 1
  `;

  let collectionId: string;
  if (existing.length > 0) {
    collectionId = existing[0].id;
    await sql`
      UPDATE pet_collections
      SET title = ${title},
          description = ${desc},
          featured = true,
          cover_pet_slug = ${petSlugs[0]},
          updated_at = now()
      WHERE id = ${collectionId}
    `;
  } else {
    collectionId = `col_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
    await sql`
      INSERT INTO pet_collections (
        id, slug, title, description, cover_pet_slug, featured
      ) VALUES (
        ${collectionId}, ${slug}, ${title}, ${desc}, ${petSlugs[0]}, true
      )
    `;
  }

  let position = 0;
  for (const petSlug of petSlugs) {
    try {
      await sql`
        INSERT INTO pet_collection_items (
          collection_id, pet_slug, position
        ) VALUES (
          ${collectionId}, ${petSlug}, ${position++}
        )
        ON CONFLICT (collection_id, pet_slug) DO NOTHING
      `;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  skip ${petSlug}: ${msg}`);
    }
  }
}

console.log("\ndone");
