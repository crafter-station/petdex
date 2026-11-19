// Server-side auto-tag classifier. Same prompt as scripts/auto-tag.ts but runs
// through AI Gateway so it works inside Vercel serverless.
//
// Returns null on failure — caller is responsible for fallback (leave kind/
// vibes/tags as-is). Never throws.

import { generateText } from "ai";

import { containsBlockedKeyword } from "@/lib/keyword-blocklist";
import { PET_KINDS, PET_VIBES, type PetKind, type PetVibe } from "@/lib/types";

const VIBE_SET = new Set<string>(PET_VIBES);
const KIND_SET = new Set<string>(PET_KINDS);

const MODEL = "openai/gpt-5-mini";
const CLASSIFY_TIMEOUT_MS = 15000;

export type Classification = {
  kind: PetKind;
  vibes: PetVibe[];
  tags: string[];
};

export async function classifyPet(
  displayName: string,
  description: string,
): Promise<Classification | null> {
  const prompt = buildPrompt(displayName, description);

  try {
    const result = await generateText({
      model: MODEL,
      system:
        "You are a strict JSON classifier. Output ONLY the requested JSON object, no prose, no markdown fences.",
      messages: [{ role: "user", content: prompt }],
      // classifyPet runs synchronously inside the approval side-effects, so a
      // stalled gateway would pin the whole decision. The other AI calls in
      // this tree all carry a deadline (embeddings, edit-policy,
      // submission-review); this one did not.
      abortSignal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
    });
    const raw = result.text;
    const json = JSON.parse(raw);
    return validate(json);
  } catch (err) {
    console.warn(
      "[auto-tag] classification failed:",
      (err as Error).message?.slice(0, 200),
    );
    return null;
  }
}

function buildPrompt(displayName: string, description: string): string {
  return [
    "You classify animated pixel pet metadata for a public gallery.",
    "",
    "Schema (output JSON exactly with these keys):",
    '  { "kind": "creature" | "object" | "character",',
    '    "vibes": string[],   // 1 to 3 items, lowercased',
    '    "tags": string[] }   // 3 to 5 items, lowercased, single words or kebab-case',
    "",
    "Constraints:",
    `  - kind must be one of: ${PET_KINDS.join(", ")}`,
    `  - vibes must be a subset of: ${PET_VIBES.join(", ")}`,
    "  - tags must be discoverable descriptors. NO generic 'pet','codex','animated','creature','character','object'.",
    "  - prefer concrete features: species, profession, color, theme, IP reference if obvious",
    "  - do NOT invent vibes outside the allowed list",
    "",
    "Examples:",
    '  Input: "A tiny otter sipping bubble tea while keeping you company"',
    '  Output: {"kind":"creature","vibes":["cozy","playful"],"tags":["otter","drink","bubble-tea","cozy"]}',
    "",
    '  Input: "A tiny friendly office paperclip assistant"',
    '  Output: {"kind":"object","vibes":["wholesome","cheerful"],"tags":["paperclip","office","helper","retro"]}',
    "",
    "Now classify this pet:",
    `  name: ${JSON.stringify(displayName)}`,
    `  description: ${JSON.stringify(description)}`,
  ].join("\n");
}

function validate(obj: unknown): Classification | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (!KIND_SET.has(String(o.kind))) return null;

  const rawVibes = Array.isArray(o.vibes) ? o.vibes : [];
  const vibes = rawVibes
    .map((v) => String(v).toLowerCase().trim())
    .filter((v) => VIBE_SET.has(v))
    .slice(0, 3) as PetVibe[];
  if (vibes.length === 0) return null;

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
        // The repo's abuse blocklist too, not only the fixed list below. The
        // model reads creator-controlled displayName/description, so a
        // prompt-injection can steer it into emitting a blocklisted token as a
        // tag — and tags are the one field this path writes that did not
        // already go through `containsBlockedKeyword` at submit (the text
        // fields do; the edit path re-runs it over tags at pet-edit.ts). Tags
        // are rendered on the pet page, indexed for search, and scanned by
        // neither the submit-time check nor `takedown-by-keyword`, so a word
        // that lands here has no other net.
        !containsBlockedKeyword(t) &&
        ![
          // Generic / redundant — every pet is one of these.
          "pet",
          "codex",
          "creature",
          "character",
          "object",
          "animated",
          // Status / authority words an attacker could prompt-inject the
          // model into emitting to fake legitimacy in the gallery.
          "featured",
          "official",
          "verified",
          "staff",
          "admin",
          "petdex",
          "approved",
          "sponsored",
          // Content-warning words we don't surface as discovery tags.
          "nsfw",
          "nsfl",
        ].includes(t),
    )
    .slice(0, 5);
  if (tags.length < 2) return null;

  return { kind: o.kind as PetKind, vibes, tags };
}
