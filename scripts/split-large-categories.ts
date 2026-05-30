// Splits large category collections (>=100 pets) into themed
// sub-collections by intersecting with secondary categories from the
// same merged map. Read by:
//   scripts/.merged-classifications.json
//
// Strategy:
//   For each "big" category (>=100 pets), find pets in that category
//   that ALSO appear in a "secondary" category with >=8 pets in the
//   intersection. Create sub-collection `category-<big>-<secondary>`.
//
// The parent collection (category-<big>) keeps every pet — sub
// collections are additive, not exclusive.
//
// Run after seed-all-collections.ts:
//   bun --env-file .env.local scripts/split-large-categories.ts --dry
//   bun --env-file .env.local scripts/split-large-categories.ts

import { readFileSync } from "node:fs";

import { neon } from "@neondatabase/serverless";

import { requiredEnv } from "./env";

const sql = neon(requiredEnv("DATABASE_URL"));
const dryRun = process.argv.includes("--dry");

const BIG_THRESHOLD = Number(
  process.argv.find((a) => a.startsWith("--big-threshold="))?.split("=")[1] ??
    100,
);
const INTERSECTION_MIN = Number(
  process.argv
    .find((a) => a.startsWith("--intersection-min="))
    ?.split("=")[1] ?? 8,
);

type Merged = {
  generatedAt: string;
  franchises: Record<string, string[]>;
  categories: Record<string, string[]>;
};

const data = JSON.parse(
  readFileSync("./scripts/.merged-classifications.json", "utf8"),
) as Merged;

const allCategories = data.categories;
const big = Object.entries(allCategories)
  .filter(([, slugs]) => slugs.length >= BIG_THRESHOLD)
  .sort(([, a], [, b]) => b.length - a.length);

console.log(
  `\n${big.length} big categories (>=${BIG_THRESHOLD}). Splitting on intersections >=${INTERSECTION_MIN}.\n`,
);

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function titleFor(big: string, secondary: string): string {
  // Try to make a natural title. "cat" + "cozy" → "Cozy Cats".
  // Heuristic: vibe modifiers (cozy/edgy/playful etc) read better as prefix.
  const VIBE_PREFIX = new Set([
    "cozy",
    "playful",
    "calm",
    "edgy",
    "wholesome",
    "mischievous",
    "chaotic",
    "mystical",
    "heroic",
    "kawaii",
    "melancholic",
    "focused",
    "warrior",
    "retro",
    "gothic",
    "punk",
    "cyberpunk",
  ]);
  const cap = (s: string) =>
    s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  if (VIBE_PREFIX.has(secondary)) return `${cap(secondary)} ${cap(big)}`;
  return `${cap(big)} · ${cap(secondary)}`;
}

let totalSubs = 0;

for (const [bigCat, bigSlugs] of big) {
  const bigSet = new Set(bigSlugs);
  const intersections: { secondary: string; slugs: string[] }[] = [];
  for (const [other, otherSlugs] of Object.entries(allCategories)) {
    if (other === bigCat) continue;
    const overlap = otherSlugs.filter((s) => bigSet.has(s));
    if (overlap.length >= INTERSECTION_MIN) {
      intersections.push({ secondary: other, slugs: overlap });
    }
  }
  intersections.sort((a, b) => b.slugs.length - a.slugs.length);

  console.log(
    `\n# ${bigCat} (${bigSlugs.length}) → ${intersections.length} sub-collections`,
  );
  for (const { secondary, slugs } of intersections) {
    const subSlug = `category-${slugify(bigCat)}-${slugify(secondary)}`;
    const title = titleFor(bigCat, secondary);
    const desc = `${slugs.length} ${secondary.replace(/-/g, " ")} ${bigCat.replace(/-/g, " ")} from across the Petdex catalog.`;
    console.log(`  ${subSlug.padEnd(50)} ${slugs.length}  →  ${title}`);

    if (dryRun) continue;

    const existing = await sql`
      SELECT id FROM pet_collections WHERE slug = ${subSlug} LIMIT 1
    `;

    let collectionId: string;
    if (existing.length > 0) {
      collectionId = existing[0].id;
      await sql`
        UPDATE pet_collections
        SET title = ${title},
            description = ${desc},
            featured = true,
            cover_pet_slug = ${slugs[0]},
            updated_at = now()
        WHERE id = ${collectionId}
      `;
    } else {
      collectionId = `col_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
      await sql`
        INSERT INTO pet_collections (
          id, slug, title, description, cover_pet_slug, featured
        ) VALUES (
          ${collectionId}, ${subSlug}, ${title}, ${desc}, ${slugs[0]}, true
        )
      `;
    }

    let position = 0;
    for (const petSlug of slugs) {
      await sql`
        INSERT INTO pet_collection_items (
          collection_id, pet_slug, position
        ) VALUES (${collectionId}, ${petSlug}, ${position++})
        ON CONFLICT (collection_id, pet_slug) DO NOTHING
      `;
    }
    totalSubs++;
  }
}

console.log(
  `\ndone${dryRun ? " (DRY)" : ""} — ${totalSubs} sub-collections ${dryRun ? "preview" : "created"}`,
);
