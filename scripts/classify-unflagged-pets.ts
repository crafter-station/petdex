// Classify the 1200+ approved pets the IP reviewer did NOT flag.
// Most of these are original work (no franchise), but some are:
//   - IP that slipped past the reviewer
//   - Belong to topical groups (animals, mecha, food, office, etc)
//
// Asks codex per pet for:
//   - franchise: best-guess franchise OR "ORIGINAL"
//   - categories: 1-3 tags from a fixed taxonomy
//
// Cached per slug in scripts/.unflagged-cache.json. Idempotent.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { neon } from "@neondatabase/serverless";

import { requiredEnv } from "./env";

const sql = neon(requiredEnv("DATABASE_URL"));
const CACHE_PATH = "./scripts/.unflagged-cache.json";

type Pet = {
  slug: string;
  display_name: string;
  description: string;
  kind: string;
};

type ClassifiedRow = {
  franchise: string;
  categories: string[];
};

type Cache = Record<string, ClassifiedRow>;
const cache: Cache = existsSync(CACHE_PATH)
  ? JSON.parse(readFileSync(CACHE_PATH, "utf8"))
  : {};

const CATEGORIES_DOC = `
TAXONOMY (pick 1-3 of these for "categories", in priority order):

Animals: cat, dog, bird, fish, reptile, dinosaur, dragon, horse, bear,
  rabbit, fox, panda, raccoon, hedgehog, hamster, frog, octopus, monkey,
  bug, sea-creature, farm-animal, exotic-animal

Fantasy: witch, mage, wizard, knight, warrior, elf, fairy, demon, angel,
  ghost, vampire, undead, goblin, slime, eldritch

Sci-Fi: robot, mecha, cyborg, alien, spaceship, ai, hacker, terminal,
  hologram, glitch

Food / Drink: coffee, tea, boba, dessert, fruit, snack, ramen, sushi,
  burger, pizza, candy, drink

Office / Coding: developer, designer, intern, manager, qa, devops,
  coffee-coder, study, paperwork, terminal-life

Music / Idol: idol, vocaloid, kpop, jpop, rock-band, rapper, dj, dancer

Sports: soccer, basketball, baseball, skateboarding, gym, runner

Pop Culture (original riffs, not specific franchises): meme, vaporwave,
  cyberpunk, kawaii, lofi, retro, pixel-art, glitchcore, y2k, gothic,
  punk, streetwear

Vibe (use as secondary): cozy, edgy, melancholic, heroic, chaotic,
  mystical, wholesome, mischievous, focused, playful, calm
`;

async function callCodex(items: Pet[]): Promise<Record<string, ClassifiedRow>> {
  const prompt = `You classify pixel-art companion pets for a developer-facing gallery.

For each item, return a JSON object with:
  - "franchise": the canonical English name of the source franchise if the
    pet is clearly fan-art of a known anime/game/movie/show/brand/celebrity.
    Use "ORIGINAL" if it's an original creation. Be conservative: prefer
    "ORIGINAL" if the franchise is uncertain or only stylistically similar.
  - "categories": 1-3 short kebab-case tags from the taxonomy below, in
    priority order (most specific first).

${CATEGORIES_DOC}

Output ONLY a single JSON object on the LAST line of your response,
mapping slug to {franchise, categories}. No prose, no code fences.

Items:
${items
  .map(
    (it) =>
      `- slug: ${it.slug}\n  name: ${it.display_name}\n  kind: ${it.kind}\n  description: ${(it.description ?? "").slice(0, 220)}`,
  )
  .join("\n")}`;

  return new Promise((resolve, reject) => {
    const proc = spawn(
      "codex",
      ["exec", "--skip-git-repo-check", "--sandbox", "read-only"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`codex exit=${code}: ${stderr.slice(-500)}`));
      }
      // Find the LAST balanced JSON object that contains slug-keyed entries.
      // Regex of nested objects is unreliable; do a manual brace-balanced
      // scan from the end of stdout.
      const candidates: Record<string, ClassifiedRow>[] = [];
      let depth = 0;
      let start = -1;
      for (let i = 0; i < stdout.length; i++) {
        const ch = stdout[i];
        if (ch === "{") {
          if (depth === 0) start = i;
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0 && start >= 0) {
            const candidate = stdout.slice(start, i + 1);
            try {
              const parsed = JSON.parse(candidate);
              if (
                parsed &&
                typeof parsed === "object" &&
                !Array.isArray(parsed)
              ) {
                const firstKey = Object.keys(parsed)[0];
                const firstVal = parsed[firstKey];
                if (
                  firstVal &&
                  typeof firstVal === "object" &&
                  "franchise" in firstVal &&
                  "categories" in firstVal
                ) {
                  candidates.push(parsed);
                }
              }
            } catch {
              // not parseable, skip
            }
            start = -1;
          }
        }
      }
      const best = candidates[candidates.length - 1];
      if (!best) {
        return reject(
          new Error(
            `no parseable slug→{franchise,categories} JSON in codex output:\n${stdout.slice(-1000)}`,
          ),
        );
      }
      resolve(best);
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

const allUnflagged = (await sql`
  SELECT slug, display_name, description, kind
  FROM submitted_pets sp
  WHERE sp.status='approved'
  AND NOT EXISTS (
    SELECT 1 FROM submission_reviews sr
    WHERE sr.submitted_pet_id = sp.id
    AND sr.checks->'policy'->'flags' @> '[{"category":"copyright_trademark_risk"}]'::jsonb
  )
`) as Pet[];

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;
const todo = allUnflagged.filter((p) => !cache[p.slug]).slice(0, limit);

console.log(
  `total unflagged: ${allUnflagged.length} | cached: ${allUnflagged.length - allUnflagged.filter((p) => !cache[p.slug]).length} | todo this run: ${todo.length}`,
);

const BATCH = 12;

for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  const num = Math.floor(i / BATCH) + 1;
  const total = Math.ceil(todo.length / BATCH);
  console.log(`\nbatch ${num}/${total} (${batch.length} items)`);
  try {
    const result = await callCodex(batch);
    for (const it of batch) {
      const row = result[it.slug];
      if (row && row.franchise && Array.isArray(row.categories)) {
        cache[it.slug] = row;
        console.log(
          `  ${it.slug.padEnd(30)} → ${row.franchise.padEnd(22)} [${row.categories.join(", ")}]`,
        );
      } else {
        console.log(`  ${it.slug.padEnd(30)} → (no answer, marking ORIGINAL/uncategorized)`);
        cache[it.slug] = { franchise: "ORIGINAL", categories: [] };
      }
    }
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error(`  batch failed: ${err}`);
  }
}

// Summary
const franchiseCounts: Record<string, number> = {};
const categoryCounts: Record<string, number> = {};
for (const slug of Object.keys(cache)) {
  const row = cache[slug];
  franchiseCounts[row.franchise] = (franchiseCounts[row.franchise] ?? 0) + 1;
  for (const c of row.categories) {
    categoryCounts[c] = (categoryCounts[c] ?? 0) + 1;
  }
}

console.log("\n--- TOP FRANCHISES IN UNFLAGGED (excl ORIGINAL) ---");
for (const [name, c] of Object.entries(franchiseCounts)
  .filter(([n]) => n !== "ORIGINAL")
  .sort(([, a], [, b]) => b - a)
  .slice(0, 30)) {
  console.log(`  ${c.toString().padStart(4)}  ${name}`);
}

console.log(`\nORIGINAL pets: ${franchiseCounts.ORIGINAL ?? 0}`);

console.log("\n--- TOP CATEGORIES ---");
for (const [name, c] of Object.entries(categoryCounts)
  .sort(([, a], [, b]) => b - a)
  .slice(0, 40)) {
  console.log(`  ${c.toString().padStart(4)}  ${name}`);
}
