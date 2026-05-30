// Big collection re-org. Runs in 4 phases, each individually
// dry-runnable. Idempotent on re-run for the parts that matter.
//
// Phase 1 - WIPE: drop every category-X-Y sub-collection. Cascade
//           deletes their pet_collection_items rows.
//
// Phase 2 - RESEED: re-generate sub-collections from
//           .merged-classifications.json with new thresholds:
//             BIG_THRESHOLD=60   -> only categories with >=60 pets
//                                  get sub-collections at all
//             INTERSECT_MIN=15   -> intersection must have >=15 pets
//
// Phase 3 - HIERARCHY: assign each pet to ONE primary collection
//           using priority: franchise > sub-category > category >
//           other. Removes pet_collection_items rows that violate it.
//           Pets without any classification stay where they are.
//
// Phase 4 - VERIFY: report final state — collections by kind, pets per
//           pet, top duplicates, biggest collections.
//
// Usage:
//   bun --env-file .env.local scripts/reorganize-collections.ts --phase=1 --dry
//   bun --env-file .env.local scripts/reorganize-collections.ts --phase=1
//   bun --env-file .env.local scripts/reorganize-collections.ts --phase=2 --dry
//   bun --env-file .env.local scripts/reorganize-collections.ts --phase=2
//   bun --env-file .env.local scripts/reorganize-collections.ts --phase=3 --dry
//   bun --env-file .env.local scripts/reorganize-collections.ts --phase=3
//   bun --env-file .env.local scripts/reorganize-collections.ts --phase=4

import { readFileSync } from "node:fs";

import { neon } from "@neondatabase/serverless";

import { requiredEnv } from "./env";

const sql = neon(requiredEnv("DATABASE_URL"));
const dryRun = process.argv.includes("--dry");
const phaseArg = process.argv.find((a) => a.startsWith("--phase="));
if (!phaseArg) {
  console.error("missing --phase=<1|2|3|4>");
  process.exit(1);
}
const phase = Number(phaseArg.split("=")[1]);

const BIG_THRESHOLD = 60;
const INTERSECT_MIN = 15;

type Merged = {
  generatedAt: string;
  franchises: Record<string, string[]>;
  categories: Record<string, string[]>;
};

function loadMerged(): Merged {
  return JSON.parse(
    readFileSync("./scripts/.merged-classifications.json", "utf8"),
  ) as Merged;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

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

function titleFor(big: string, secondary: string): string {
  const cap = (s: string) =>
    s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  if (VIBE_PREFIX.has(secondary)) return `${cap(secondary)} ${cap(big)}`;
  return `${cap(big)} · ${cap(secondary)}`;
}

// =============== PHASE 1 — WIPE sub-collections ==================

async function phase1() {
  console.log(
    `\n=== PHASE 1: Wipe sub-collections (mode=${dryRun ? "DRY" : "APPLY"}) ===\n`,
  );
  // Sub-collection slugs are exactly category-<a>-<b> with one extra
  // dash beyond the prefix. Match via regex on the database side.
  const targets = await sql`
    SELECT pc.slug, pc.id, count(pi.pet_slug)::int AS n
    FROM pet_collections pc
    LEFT JOIN pet_collection_items pi ON pi.collection_id = pc.id
    WHERE pc.slug LIKE 'category-%'
      AND pc.slug ~ '^category-[a-z0-9]+(-[a-z0-9]+)+$'
      AND substring(pc.slug from '^category-[^-]+(.*)$') LIKE '-%'
    GROUP BY pc.id, pc.slug
    ORDER BY n DESC
  `;
  // Stricter filter in JS — only match category-<base>-<other> shape
  // (one base segment, then one or more secondary segments). The base
  // segments we know are single tokens (cat, cozy, etc).
  const baseTokens = new Set<string>([
    "playful",
    "kawaii",
    "wholesome",
    "heroic",
    "cozy",
    "mystical",
    "calm",
    "developer",
    "cat",
    "warrior",
    "focused",
    "mischievous",
    "edgy",
    "dog",
    "meme",
    "robot",
    "bird",
    "chaotic",
    "exotic-animal",
    "retro",
    "mage",
    "ai",
    "study",
    "melancholic",
    "dragon",
    "pixel-art",
    "streetwear",
    "manager",
    "gothic",
    "paperwork",
    "sea-creature",
    "mecha",
    "eldritch",
    "cyborg",
    "idol",
    "bear",
    "fox",
    "demon",
    "hacker",
    "alien",
    "rabbit",
    "cyberpunk",
    "bug",
    "monkey",
    "fairy",
    "jpop",
    "elf",
    "fruit",
    "hologram",
    "designer",
    "ghost",
    "terminal-life",
    "frog",
    "panda",
    "sci-fi",
    "coffee-coder",
    "snack",
    "terminal",
    "farm-animal",
    "rapper",
    "dancer",
    "runner",
    "dinosaur",
    "rock-band",
    "fish",
  ]);
  const subSlugs = (
    targets as Array<{ slug: string; id: string; n: number }>
  ).filter((row) => {
    const stripped = row.slug.slice("category-".length);
    // Try every base token as prefix; if remainder starts with `-`, it's a sub
    for (const base of baseTokens) {
      if (stripped === base) return false; // base itself
      if (stripped.startsWith(`${base}-`)) {
        const remainder = stripped.slice(base.length + 1);
        if (remainder.length > 0) return true;
      }
    }
    return false;
  });

  console.log(`Will delete ${subSlugs.length} sub-collections.\n`);
  if (subSlugs.length > 0) {
    console.log("Top 10 to delete:");
    for (const r of subSlugs.slice(0, 10)) {
      console.log(`  ${r.slug.padEnd(45)} ${r.n} items (cascade-deleted)`);
    }
    if (subSlugs.length > 10) console.log(`  … +${subSlugs.length - 10} more`);
  }

  if (!dryRun) {
    const ids = subSlugs.map((r) => r.id);
    let deleted = 0;
    for (const id of ids) {
      await sql`DELETE FROM pet_collections WHERE id = ${id}`;
      deleted++;
    }
    console.log(`\ndeleted ${deleted} collections (items cascade-removed)`);
  }
}

// =============== PHASE 2 — RESEED sub-collections =================

async function phase2() {
  console.log(
    `\n=== PHASE 2: Reseed sub-collections (BIG=${BIG_THRESHOLD}, INTERSECT=${INTERSECT_MIN}, mode=${dryRun ? "DRY" : "APPLY"}) ===\n`,
  );
  const data = loadMerged();
  const allCategories = data.categories;
  const big = Object.entries(allCategories)
    .filter(([, slugs]) => slugs.length >= BIG_THRESHOLD)
    .sort(([, a], [, b]) => b.length - a.length);

  console.log(`${big.length} big categories qualify for splits.\n`);
  const seenPair = new Set<string>();
  let totalSubs = 0;

  for (const [bigCat, bigSlugs] of big) {
    const bigSet = new Set(bigSlugs);
    const intersections: { secondary: string; slugs: string[] }[] = [];
    for (const [other, otherSlugs] of Object.entries(allCategories)) {
      if (other === bigCat) continue;
      // De-dupe symmetric intersections (cat-cozy / cozy-cat = same set)
      const pair = [bigCat, other].sort().join("|");
      if (seenPair.has(pair)) continue;
      const overlap = otherSlugs.filter((s) => bigSet.has(s));
      if (overlap.length >= INTERSECT_MIN) {
        intersections.push({ secondary: other, slugs: overlap });
        seenPair.add(pair);
      }
    }
    intersections.sort((a, b) => b.slugs.length - a.slugs.length);

    if (intersections.length === 0) continue;
    console.log(
      `\n# ${bigCat} (${bigSlugs.length}) → ${intersections.length} subs`,
    );
    for (const { secondary, slugs } of intersections) {
      const subSlug = `category-${slugify(bigCat)}-${slugify(secondary)}`;
      const title = titleFor(bigCat, secondary);
      const desc = `${slugs.length} ${secondary.replace(/-/g, " ")} ${bigCat.replace(/-/g, " ")} from across the Petdex catalog.`;
      console.log(`  ${subSlug.padEnd(46)} ${slugs.length}  →  ${title}`);
      totalSubs++;

      if (dryRun) continue;

      const existing = await sql`
        SELECT id FROM pet_collections WHERE slug = ${subSlug} LIMIT 1
      `;
      let collectionId: string;
      if (existing.length > 0) {
        collectionId = existing[0].id;
        await sql`
          UPDATE pet_collections
          SET title = ${title}, description = ${desc}, featured = true,
              cover_pet_slug = ${slugs[0]}, updated_at = now()
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
    }
  }

  console.log(
    `\n${totalSubs} sub-collections ${dryRun ? "would be" : ""} seeded`,
  );
}

// =============== PHASE 3 — HIERARCHY enforcement ==================

async function phase3() {
  console.log(
    `\n=== PHASE 3: Enforce one-collection-per-pet hierarchy (mode=${dryRun ? "DRY" : "APPLY"}) ===\n`,
  );
  console.log("Priority: franchise > sub-category > category > other\n");

  // Pull all current memberships joined with collection metadata
  const rows = (await sql`
    SELECT pi.pet_slug, pi.collection_id, pc.slug AS collection_slug
    FROM pet_collection_items pi
    JOIN pet_collections pc ON pc.id = pi.collection_id
  `) as Array<{
    pet_slug: string;
    collection_id: string;
    collection_slug: string;
  }>;

  function rank(slug: string): number {
    if (slug.startsWith("franchise-")) return 0;
    if (slug.startsWith("category-")) {
      const rest = slug.slice("category-".length);
      // sub-category if has at least one dash beyond "category-"
      return rest.includes("-") ? 1 : 2;
    }
    return 3;
  }

  // Group memberships per pet
  const byPet = new Map<
    string,
    Array<{ collection_id: string; collection_slug: string }>
  >();
  for (const r of rows) {
    const arr = byPet.get(r.pet_slug) ?? [];
    arr.push({
      collection_id: r.collection_id,
      collection_slug: r.collection_slug,
    });
    byPet.set(r.pet_slug, arr);
  }

  let toRemove = 0;
  let petsAffected = 0;
  const removalsByCollection = new Map<string, number>();
  const sampleRemovals: string[] = [];

  for (const [pet, memberships] of byPet) {
    if (memberships.length <= 1) continue;
    // Find best (lowest rank, ties broken by largest collection size — but
    // we don't have size here. Tiebreak alphabetically for stability.)
    memberships.sort((a, b) => {
      const ra = rank(a.collection_slug);
      const rb = rank(b.collection_slug);
      if (ra !== rb) return ra - rb;
      return a.collection_slug.localeCompare(b.collection_slug);
    });
    const [keep, ...drop] = memberships;
    petsAffected++;
    for (const d of drop) {
      toRemove++;
      removalsByCollection.set(
        d.collection_slug,
        (removalsByCollection.get(d.collection_slug) ?? 0) + 1,
      );
      if (sampleRemovals.length < 10) {
        sampleRemovals.push(
          `${pet}: keep ${keep.collection_slug}, drop ${d.collection_slug}`,
        );
      }
      if (!dryRun) {
        await sql`
          DELETE FROM pet_collection_items
          WHERE collection_id = ${d.collection_id} AND pet_slug = ${pet}
        `;
      }
    }
  }

  console.log(`pets affected: ${petsAffected}`);
  console.log(
    `pet_collection_items rows ${dryRun ? "would be" : ""} removed: ${toRemove}\n`,
  );
  console.log("Sample (first 10):");
  for (const s of sampleRemovals) console.log(`  ${s}`);

  console.log("\nTop 15 collections losing items:");
  const sorted = [...removalsByCollection.entries()].sort(
    (a, b) => b[1] - a[1],
  );
  for (const [slug, n] of sorted.slice(0, 15)) {
    console.log(`  -${n.toString().padStart(4)}  ${slug}`);
  }

  // After hierarchy move, base categories often hollow out (most of
  // their pets get pulled up into a sub-category or franchise that
  // takes priority). Drop any collection that's left with <10 pets.
  // Skip franchises — those already have a >=4 threshold elsewhere
  // and we don't want to nuke small but coherent IPs like Pokemon (5).
  const HOLLOW_THRESHOLD = 10;
  const hollow = (await sql`
    SELECT pc.id, pc.slug, count(pi.pet_slug)::int AS n
    FROM pet_collections pc
    LEFT JOIN pet_collection_items pi ON pi.collection_id = pc.id
    WHERE pc.featured = true
      AND pc.slug NOT LIKE 'franchise-%'
      AND pc.slug NOT IN ('anime-heroes')
    GROUP BY pc.id, pc.slug
    HAVING count(pi.pet_slug) < ${HOLLOW_THRESHOLD}
    ORDER BY n
  `) as Array<{ id: string; slug: string; n: number }>;

  console.log(
    `\n${hollow.length} non-franchise collections ${dryRun ? "would be" : ""} dropped for going below ${HOLLOW_THRESHOLD} pets:`,
  );
  for (const r of hollow.slice(0, 20)) {
    console.log(`  ${r.n.toString().padStart(3)}  ${r.slug}`);
  }
  if (hollow.length > 20) console.log(`  … +${hollow.length - 20} more`);

  if (!dryRun) {
    for (const h of hollow) {
      await sql`DELETE FROM pet_collections WHERE id = ${h.id}`;
    }
    console.log(`\nremoved ${hollow.length} hollow collections`);
  }
}

// =============== PHASE 4 — VERIFY ================================

async function phase4() {
  console.log("\n=== PHASE 4: Verify final state ===\n");
  const k = (await sql`
    SELECT
      CASE
        WHEN slug LIKE 'franchise-%' THEN 'franchise'
        WHEN slug ~ '^category-[^-]+$' THEN 'category-base'
        WHEN slug LIKE 'category-%' THEN 'category-sub'
        ELSE 'other'
      END AS kind,
      count(*)::int AS n
    FROM pet_collections WHERE featured = true
    GROUP BY 1 ORDER BY 2 DESC
  `) as Array<{ kind: string; n: number }>;
  console.log("Featured collections by kind:");
  for (const row of k) console.log(`  ${row.kind.padEnd(15)} ${row.n}`);

  const sizes = (await sql`
    SELECT pc.slug, count(pi.pet_slug)::int AS n
    FROM pet_collections pc
    LEFT JOIN pet_collection_items pi ON pi.collection_id = pc.id
    WHERE pc.featured = true
    GROUP BY pc.slug
    ORDER BY n DESC LIMIT 15
  `) as Array<{ slug: string; n: number }>;
  console.log("\nTop 15 by pet count:");
  for (const r of sizes)
    console.log(`  ${r.n.toString().padStart(4)}  ${r.slug}`);

  const dist = (await sql`
    SELECT n, count(*)::int AS pets
    FROM (
      SELECT count(distinct collection_id) AS n
      FROM pet_collection_items
      GROUP BY pet_slug
    ) x GROUP BY n ORDER BY n
  `) as Array<{ n: number; pets: number }>;
  console.log("\nPets-per-collection distribution:");
  for (const r of dist) {
    console.log(
      `  in ${r.n.toString().padStart(2)} collection${r.n === 1 ? " " : "s"}: ${r.pets} pets`,
    );
  }

  const total = (await sql`
    SELECT count(distinct pet_slug)::int AS n FROM pet_collection_items
  `) as Array<{ n: number }>;
  console.log(`\ntotal pets in any collection: ${total[0].n}`);
}

if (phase === 1) await phase1();
else if (phase === 2) await phase2();
else if (phase === 3) await phase3();
else if (phase === 4) await phase4();
else {
  console.error(`unknown phase: ${phase}`);
  process.exit(1);
}
