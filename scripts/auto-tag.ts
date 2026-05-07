// Auto-tag approved community pets with kind/vibes/tags via Codex.
//
// For each approved pet that has empty tags + vibes (or kind === "creature"
// default), call `codex exec` with a strict JSON prompt and persist the
// result.
//
// Usage:
//   bun scripts/auto-tag.ts --dry        # preview classifications, don't write
//   bun scripts/auto-tag.ts              # apply
//   bun scripts/auto-tag.ts --slug X     # only one pet
//   bun scripts/auto-tag.ts --force      # re-tag pets that already have tags
//
// Idempotent by default: skips rows that already have non-empty tags AND
// non-empty vibes. Pass --force to re-tag everything.

import { spawn } from "node:child_process";

import { eq } from "drizzle-orm";

import { db, schema } from "../src/lib/db/client";
import {
  PET_KINDS,
  PET_VIBES,
  type PetKind,
  type PetVibe,
} from "../src/lib/types";

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry");
const FORCE = args.has("--force");
const onlySlugIdx = process.argv.indexOf("--slug");
const ONLY_SLUG = onlySlugIdx >= 0 ? process.argv[onlySlugIdx + 1] : undefined;

const VIBE_SET = new Set<string>(PET_VIBES);
const KIND_SET = new Set<string>(PET_KINDS);

type Classification = {
  kind: PetKind;
  vibes: PetVibe[];
  tags: string[];
};

function buildPrompt(displayName: string, description: string): string {
  return [
    "You are a strict classifier for animated pixel pet metadata. Output ONLY a single JSON object, no prose, no markdown fences.",
    "",
    "Schema:",
    '  { "kind": "creature" | "object" | "character",',
    '    "vibes": string[],   // 1 to 3 items, lowercased',
    '    "tags": string[] }   // 3 to 5 items, lowercased, single words or kebab-case',
    "",
    "Constraints:",
    `  - kind must be one of: ${PET_KINDS.join(", ")}`,
    `  - vibes must be a subset of: ${PET_VIBES.join(", ")}`,
    "  - tags must be discoverable descriptors. NO generic 'pet','codex','animated','creature','character','object'.",
    "  - prefer concrete features: species, profession, color, theme, IP-reference if obvious",
    "  - do NOT invent vibes outside the allowed list",
    "",
    "Examples:",
    '  Input: "A tiny otter sipping bubble tea while keeping you company"',
    '  Output: {"kind":"creature","vibes":["cozy","playful"],"tags":["otter","drink","bubble-tea","cozy"]}',
    "",
    '  Input: "A tiny friendly office paperclip assistant"',
    '  Output: {"kind":"object","vibes":["wholesome","cheerful"],"tags":["paperclip","office","helper","retro"]}',
    "",
    `Now classify this pet:`,
    `  name: ${JSON.stringify(displayName)}`,
    `  description: ${JSON.stringify(description)}`,
    "",
    "Output the JSON only.",
  ].join("\n");
}

function callCodex(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "codex",
      ["exec", "--skip-git-repo-check", "--", prompt],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`codex exit ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      resolve(stdout);
    });
    child.on("error", reject);
  });
}

function extractJson(raw: string): unknown {
  // Codex sometimes wraps in fences or prose. Grab first {...} block.
  const start = raw.indexOf("{");
  if (start < 0) throw new Error(`no json in output: ${raw.slice(0, 200)}`);
  let depth = 0;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`unbalanced json: ${raw.slice(0, 200)}`);
  return JSON.parse(raw.slice(start, end + 1));
}

function validate(obj: unknown): Classification {
  if (!obj || typeof obj !== "object") throw new Error("not an object");
  const o = obj as Record<string, unknown>;
  if (!KIND_SET.has(String(o.kind)))
    throw new Error(`invalid kind: ${String(o.kind)}`);

  const rawVibes = Array.isArray(o.vibes) ? o.vibes : [];
  const vibes = rawVibes
    .map((v) => String(v).toLowerCase().trim())
    .filter((v) => VIBE_SET.has(v))
    .slice(0, 3) as PetVibe[];
  if (vibes.length === 0) throw new Error("no valid vibes");

  const rawTags = Array.isArray(o.tags) ? o.tags : [];
  const tags = rawTags
    .map((t) =>
      String(t)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(
      (t) =>
        t.length > 0 &&
        t.length <= 30 &&
        ![
          "pet",
          "codex",
          "creature",
          "character",
          "object",
          "animated",
        ].includes(t),
    )
    .slice(0, 5);
  if (tags.length < 2) throw new Error("too few valid tags");

  return { kind: o.kind as PetKind, vibes, tags };
}

async function main() {
  const all = await db.select().from(schema.submittedPets);
  let candidates = all.filter((r) => r.status === "approved");
  if (ONLY_SLUG) candidates = candidates.filter((r) => r.slug === ONLY_SLUG);
  if (!FORCE) {
    candidates = candidates.filter((r) => {
      const v = (r.vibes as string[]) ?? [];
      const t = (r.tags as string[]) ?? [];
      return v.length === 0 || t.length === 0;
    });
  }

  console.log(
    `${DRY ? "[DRY] " : ""}auto-tag ${candidates.length} pets (force=${FORCE}, slug=${ONLY_SLUG ?? "*"})`,
  );

  let ok = 0;
  let failed = 0;

  for (const row of candidates) {
    const prompt = buildPrompt(row.displayName, row.description);
    process.stdout.write(`  ${row.slug.padEnd(24)} ... `);
    try {
      const raw = await callCodex(prompt);
      const json = extractJson(raw);
      const cls = validate(json);
      console.log(
        `kind=${cls.kind.padEnd(9)} vibes=[${cls.vibes.join(",")}] tags=[${cls.tags.join(",")}]`,
      );
      if (!DRY) {
        await db
          .update(schema.submittedPets)
          .set({ kind: cls.kind, vibes: cls.vibes, tags: cls.tags })
          .where(eq(schema.submittedPets.id, row.id));
      }
      ok++;
    } catch (err) {
      console.log(`FAIL: ${(err as Error).message.slice(0, 80)}`);
      failed++;
    }
  }

  console.log(`done. ok=${ok} failed=${failed}`);
}

await main();
