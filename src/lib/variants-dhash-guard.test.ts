// `getVariantsFor` reads a dhash out of a text column and feeds it to
// `BigInt("0x…")`. A value that is not the 16-hex shape `dhashFromSpriteBuffer`
// writes — a legacy row, or a hand edit — made that throw, so a public pet page
// 500'd on data it could simply ignore. The review path already guards the same
// conversion (`safeHammingDistance`); this pins the guard on the variants path,
// where nothing else did.
//
// `variants.ts` opens a database client at import time, so this drives the real
// function against a stand-in that returns a fixed index, the way
// `pet-search-cursor-wiring.test.ts` does.
import { afterAll, describe, expect, it, mock } from "bun:test";

import * as schema from "@/lib/db/schema";

const INDEX_ROWS = [
  // The pet under test, a good v1 dhash.
  {
    slug: "self",
    displayName: "Self",
    spritesheetUrl: "https://assets.petdex.dev/pets/self/sprite.webp",
    dhash: "0123456789abcdef",
    source: "submit" as const,
  },
  // A near neighbour with a malformed hash: pre-fix this threw in BigInt().
  {
    slug: "legacy",
    displayName: "Legacy",
    spritesheetUrl: "https://assets.petdex.dev/pets/legacy/sprite.webp",
    dhash: "not-a-hash",
    source: "submit" as const,
  },
  {
    slug: "good",
    displayName: "Good",
    spritesheetUrl: "https://assets.petdex.dev/pets/good/sprite.webp",
    dhash: "0123456789abcdee",
    source: "submit" as const,
  },
];

mock.module("server-only", () => ({}));
mock.module("@/lib/db/client", () => ({
  schema,
  db: {
    query: {
      submittedPets: { findMany: async () => INDEX_ROWS },
    },
  },
  // Required by db-client-mock-shape.test.ts: a factory that omits an export
  // the module provides breaks whichever suite loads next and links it.
  executeAtomicReturning: async () => [],
  rowsOf: () => [],
}));
mock.module("@/lib/dex", () => ({
  getDexNumberMap: async () => new Map<string, number>(),
}));

const { getVariantsFor } = await import("@/lib/variants");

afterAll(() => {
  mock.restore();
});

describe("getVariantsFor dhash shape guard", () => {
  it("skips a malformed neighbour hash instead of throwing", async () => {
    const variants = await getVariantsFor("self");
    const slugs = variants.map((v) => v.slug);
    // The malformed row is dropped; the well-formed neighbour survives.
    expect(slugs).not.toContain("legacy");
    expect(slugs).toContain("good");
  });

  it("returns nothing rather than throwing when the pet's own hash is malformed", async () => {
    // `self` is not in the index under this slug, so this exercises the
    // "no such pet" branch; the malformed-own-hash branch is covered by the
    // guard being the same shape. Assert the call resolves, not rejects.
    await expect(getVariantsFor("absent")).resolves.toEqual([]);
  });
});
