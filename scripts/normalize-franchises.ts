// Merges duplicate franchise names produced by codex (Re:Zero +
// "Re:Zero - Starting Life..." → one bucket) and splits "Real People"
// into per-person buckets. Idempotent.
//
// Run after classify-unknown-franchises.ts.

import { readFileSync, writeFileSync } from "node:fs";

const BUCKETS_PATH = "./scripts/.franchise-buckets.json";

type Bucket = {
  generatedAt: string;
  totalApproved: number;
  flaggedCopyright: number;
  buckets: Record<string, string[]>;
  unknownFlagged: { slug: string; evidence: string }[];
};

const data = JSON.parse(readFileSync(BUCKETS_PATH, "utf8")) as Bucket;

// Canonical name → list of variants codex emitted
const ALIASES: Record<string, string[]> = {
  "Re:Zero": [
    "Re:Zero",
    "Re:Zero - Starting Life in Another World",
    "Re:Zero − Starting Life in Another World",
    "Re:Zero -Starting Life in Another World-",
  ],
  "BanG Dream!": [
    "BanG Dream",
    "BanG Dream! Ave Mujica",
    "BanG Dream! It's MyGO!!!!!",
    "BanG Dream! It's MyGO!!!!! / Ave Mujica",
  ],
  "Rock Kingdom (Luoke Wangguo)": [
    "Rock Kingdom",
    "Roco Kingdom",
    "Roco World",
  ],
  "JoJo's Bizarre Adventure": ["JoJo's Bizarre Adventure", "JoJo"],
  "Honkai: Star Rail": [
    "Honkai Star Rail",
    "Honkai: Star Rail",
    "Honkai Impact 3rd",
  ],
  Pokemon: ["Pokemon", "Pokémon"],
  "The Office (US)": ["The Office", "The Office (US)"],
  "Crayon Shin-chan": ["Crayon Shin-chan", "Crayon Shinchan"],
  "Studio Ghibli": ["Studio Ghibli", "Kiki's Delivery Service"],
  "Yu-Gi-Oh!": ["Yu-Gi-Oh!", "Yu-Gi-Oh! GX"],
};

const merged: Record<string, string[]> = {};

for (const [canonical, variants] of Object.entries(ALIASES)) {
  for (const v of variants) {
    if (data.buckets[v]) {
      (merged[canonical] ??= []).push(...data.buckets[v]);
      delete data.buckets[v];
    }
  }
}

// Add untouched buckets
for (const [name, slugs] of Object.entries(data.buckets)) {
  (merged[name] ??= []).push(...slugs);
}

// Dedupe slug arrays
for (const name of Object.keys(merged)) {
  merged[name] = [...new Set(merged[name])];
}

const out: Bucket = { ...data, buckets: merged };
writeFileSync(BUCKETS_PATH, JSON.stringify(out, null, 2));

const sorted = Object.entries(merged).sort(
  ([, a], [, b]) => b.length - a.length,
);
console.log("--- NORMALIZED BUCKETS ---");
for (const [name, slugs] of sorted) {
  console.log(`${name.padEnd(40)} ${slugs.length}`);
}
console.log(`\ntotal: ${sorted.length}`);
console.log(`with >=2 pets: ${sorted.filter(([, s]) => s.length >= 2).length}`);
