// Merges results from the two classification passes:
//   1. .franchise-buckets.json (IP-flagged pets with franchise)
//   2. .unflagged-cache.json (codex pass over the rest, with franchise +
//      categories)
//
// Produces a unified franchise → [petSlugs] map plus a category →
// [petSlugs] map for topical (non-franchise) collections.
//
// Output: scripts/.merged-classifications.json
//
// Run after both classify scripts finish.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const FRANCHISE_BUCKETS = "./scripts/.franchise-buckets.json";
const UNFLAGGED_CACHE = "./scripts/.unflagged-cache.json";
const OUT = "./scripts/.merged-classifications.json";

type FranchiseBuckets = {
  buckets: Record<string, string[]>;
  unknownFlagged: { slug: string; evidence: string }[];
};

type UnflaggedRow = { franchise: string; categories: string[] };
type UnflaggedCache = Record<string, UnflaggedRow>;

if (!existsSync(FRANCHISE_BUCKETS) || !existsSync(UNFLAGGED_CACHE)) {
  console.error("missing one of:", FRANCHISE_BUCKETS, UNFLAGGED_CACHE);
  process.exit(1);
}

const flagged = JSON.parse(
  readFileSync(FRANCHISE_BUCKETS, "utf8"),
) as FranchiseBuckets;
const unflagged = JSON.parse(
  readFileSync(UNFLAGGED_CACHE, "utf8"),
) as UnflaggedCache;

// Start with already-merged franchise buckets from pass 1.
const franchises: Record<string, Set<string>> = {};
for (const [name, slugs] of Object.entries(flagged.buckets)) {
  franchises[name] = new Set(slugs);
}

const categories: Record<string, Set<string>> = {};

for (const [slug, row] of Object.entries(unflagged)) {
  if (
    row.franchise &&
    row.franchise !== "ORIGINAL" &&
    row.franchise !== "NONE"
  ) {
    (franchises[row.franchise] ??= new Set()).add(slug);
  }
  for (const cat of row.categories ?? []) {
    if (!cat || typeof cat !== "string") continue;
    (categories[cat] ??= new Set()).add(slug);
  }
}

// Convert sets to sorted arrays
const franchiseOut: Record<string, string[]> = {};
for (const [name, set] of Object.entries(franchises)) {
  franchiseOut[name] = [...set].sort();
}
const categoryOut: Record<string, string[]> = {};
for (const [name, set] of Object.entries(categories)) {
  categoryOut[name] = [...set].sort();
}

writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      franchises: franchiseOut,
      categories: categoryOut,
    },
    null,
    2,
  ),
);

const sortedFranchises = Object.entries(franchiseOut).sort(
  ([, a], [, b]) => b.length - a.length,
);
console.log("--- TOP FRANCHISES (merged) ---");
for (const [name, slugs] of sortedFranchises.slice(0, 30)) {
  console.log(`  ${slugs.length.toString().padStart(4)}  ${name}`);
}
console.log(`total franchises: ${sortedFranchises.length}`);
console.log(
  `with >=2 pets: ${sortedFranchises.filter(([, s]) => s.length >= 2).length}`,
);

const sortedCategories = Object.entries(categoryOut).sort(
  ([, a], [, b]) => b.length - a.length,
);
console.log("\n--- TOP CATEGORIES ---");
for (const [name, slugs] of sortedCategories.slice(0, 25)) {
  console.log(`  ${slugs.length.toString().padStart(4)}  ${name}`);
}
console.log(`total categories: ${sortedCategories.length}`);
console.log(
  `with >=4 pets (collection-worthy): ${sortedCategories.filter(([, s]) => s.length >= 4).length}`,
);

console.log(`\nwrote ${OUT}`);
