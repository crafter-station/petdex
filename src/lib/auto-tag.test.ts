import { describe, expect, it, mock } from "bun:test";

// The classifier feeds creator-controlled displayName/description to the model
// and writes the returned tags straight onto the approved row. Tags are the
// one field on that path that did not already pass through the repo's abuse
// blocklist at submit (the text fields do, and the edit path re-runs it over
// tags), and a prompt-injection is exactly how an attacker reaches them
// indirectly. These pin that a blocklisted token the model emits is dropped.

let modelReply = "";

// `mock.module` is process-wide and first-registration-wins, so this factory
// hands its shape to every later suite in the run. `ai` is imported by
// `embeddings.ts` (`embed`), `submission-review.ts`, `pet-sound.ts`, and
// `auto-tag.ts` (`generateText`), and a stub that names only `generateText`
// makes those others fail with `Export named 'embed' not found` — not here, in
// whichever file loads next. Spread the real module and override only the one
// function under test, so the partial shape cannot leak.
const realAi = await import("ai");
mock.module("ai", () => ({
  ...realAi,
  generateText: async () => ({ text: modelReply }),
}));

const { classifyPet } = await import("@/lib/auto-tag");

function reply(tags: string[]) {
  modelReply = JSON.stringify({
    kind: "creature",
    vibes: ["cozy"],
    tags,
  });
}

describe("classifyPet tag moderation", () => {
  it("drops a blocklisted token the model emits", async () => {
    // "ikun"/"xiaomi" are on the abuse list; the classifier must not write
    // them as discovery tags.
    reply(["cozy", "ikun", "sleepy"]);
    const cls = await classifyPet("A cat", "A very round cat.");
    expect(cls).not.toBeNull();
    expect(cls?.tags).toEqual(["cozy", "sleepy"]);
  });

  it("drops a Chinese-phrase hit too", async () => {
    reply(["cozy", "小米", "sleepy"]);
    const cls = await classifyPet("A cat", "A very round cat.");
    expect(cls?.tags).toEqual(["cozy", "sleepy"]);
  });

  it("returns null when blocklisted tags leave fewer than two", async () => {
    reply(["ikun", "xiaomi", "leijun"]);
    const cls = await classifyPet("A cat", "A very round cat.");
    expect(cls).toBeNull();
  });

  it("keeps ordinary tags and does not over-reach on benign substrings", async () => {
    // "skunk"/"akin" contain "kun" but the list matches on word boundaries,
    // so they must survive.
    reply(["skunk", "akin", "cozy"]);
    const cls = await classifyPet("A cat", "A very round cat.");
    expect(cls?.tags).toEqual(["skunk", "akin", "cozy"]);
  });
});
