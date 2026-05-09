// Classify the unknown-but-flagged pets via codex exec. Reads the
// `unknownFlagged` list from .franchise-buckets.json, sends evidence
// lines in batches with a strict JSON contract, and merges results
// back into the buckets file.
//
// Idempotent: re-running rebuilds buckets from the same source. Cached
// per-pet in scripts/.franchise-cache.json so partial runs survive.
//
// Run:
//   1. bun --env-file .env.local scripts/extract-franchises.ts
//   2. bun scripts/classify-unknown-franchises.ts
//   3. bun --env-file .env.local scripts/seed-themed-collections.ts --dry

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type Unknown = { slug: string; evidence: string };
type Bucket = {
  generatedAt: string;
  totalApproved: number;
  flaggedCopyright: number;
  buckets: Record<string, string[]>;
  unknownFlagged: Unknown[];
};

const BUCKETS_PATH = "./scripts/.franchise-buckets.json";
const CACHE_PATH = "./scripts/.franchise-cache.json";

const data = JSON.parse(readFileSync(BUCKETS_PATH, "utf8")) as Bucket;

type Cache = Record<string, string>; // slug -> franchise|"NONE"
const cache: Cache = existsSync(CACHE_PATH)
  ? JSON.parse(readFileSync(CACHE_PATH, "utf8"))
  : {};

const todo = data.unknownFlagged.filter((u) => !cache[u.slug]);
console.log(
  `cache hits: ${data.unknownFlagged.length - todo.length} / ${data.unknownFlagged.length}`,
);
console.log(`pending classification: ${todo.length}`);

const BATCH = 25;

function callCodex(items: Unknown[]): Promise<Record<string, string>> {
  const prompt = `You classify pets by their copyright/IP source franchise based on a reviewer's "evidence" line.

For each item, return the most specific named franchise (anime, game, movie, TV show, brand, real person). Use the canonical English name when one exists ("Pokemon" not "ポケモン", "JoJo's Bizarre Adventure" not "JoJo"). If the evidence is ambiguous or names no specific franchise, return "NONE".

Output ONLY a JSON object on the LAST line, mapping slug -> franchise or "NONE". No prose, no code fences, no markdown.

Items:
${items.map((it) => `- slug: ${it.slug}\n  evidence: ${it.evidence.slice(0, 350)}`).join("\n")}`;

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
      // codex exec output: prompt echo + log lines + final answer.
      // Take the LAST parseable JSON object that maps slug strings.
      const matches = stdout.match(/\{[^{}]*\}/g) ?? [];
      let best: Record<string, string> | null = null;
      for (let i = matches.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(matches[i]);
          if (
            parsed &&
            typeof parsed === "object" &&
            !Array.isArray(parsed) &&
            Object.keys(parsed).length > 0 &&
            Object.values(parsed).every((v) => typeof v === "string")
          ) {
            best = parsed as Record<string, string>;
            break;
          }
        } catch {
          // not JSON, skip
        }
      }
      if (!best) {
        return reject(
          new Error(
            `no parseable slug→franchise JSON in codex output:\n${stdout.slice(-800)}`,
          ),
        );
      }
      resolve(best);
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  console.log(
    `\nbatch ${Math.floor(i / BATCH) + 1}/${Math.ceil(todo.length / BATCH)} (${batch.length} items)`,
  );
  try {
    const result = await callCodex(batch);
    for (const it of batch) {
      const franchise = result[it.slug];
      if (typeof franchise === "string" && franchise.length > 0) {
        cache[it.slug] = franchise;
        console.log(`  ${it.slug.padEnd(30)} → ${franchise}`);
      } else {
        console.log(`  ${it.slug.padEnd(30)} → (no answer, marking NONE)`);
        cache[it.slug] = "NONE";
      }
    }
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error(`  batch failed: ${err}`);
    // skip batch, continue — re-run uses cache
  }
}

// Merge cache into buckets
const merged = { ...data.buckets };
const stillUnknown: Unknown[] = [];
for (const u of data.unknownFlagged) {
  const franchise = cache[u.slug];
  if (!franchise || franchise === "NONE") {
    stillUnknown.push(u);
    continue;
  }
  (merged[franchise] ??= []).push(u.slug);
}

const out: Bucket = {
  ...data,
  buckets: merged,
  unknownFlagged: stillUnknown,
};
writeFileSync(BUCKETS_PATH, JSON.stringify(out, null, 2));

console.log("\n--- MERGED BUCKETS ---");
const sorted = Object.entries(merged).sort(
  ([, a], [, b]) => b.length - a.length,
);
for (const [name, slugs] of sorted) {
  console.log(`${name.padEnd(28)} ${slugs.length}`);
}
console.log(`\nstill unknown: ${stillUnknown.length}`);
