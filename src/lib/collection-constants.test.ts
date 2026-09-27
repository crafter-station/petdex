import { describe, expect, it } from "bun:test";

import {
  collectionPetLimitExceeded,
  limitCollectionPetSlugs,
  MAX_COLLECTION_PETS,
  MAX_OWNER_COLLECTIONS,
} from "@/lib/collection-constants";
import { normalizeCollectionInput } from "@/lib/collection-input";

describe("collection pet limits", () => {
  it("keeps selections at the server limit and preserves the cover", () => {
    const slugs = Array.from(
      { length: MAX_COLLECTION_PETS + 2 },
      (_, index) => `pet-${index}`,
    );

    const limited = limitCollectionPetSlugs(slugs, slugs.at(-1) ?? null);

    expect(limited).toHaveLength(MAX_COLLECTION_PETS);
    expect(limited).toContain(slugs.at(-1));
    expect(new Set(limited).size).toBe(MAX_COLLECTION_PETS);
  });

  it("deduplicates selections without changing valid lists", () => {
    expect(limitCollectionPetSlugs(["boba", "boba", "dora"])).toEqual([
      "boba",
      "dora",
    ]);
  });
});

describe("collection limits shared with the client", () => {
  // Both caps are read by client components (the owner manager renders the
  // collection cap, the editor enforces the pet cap), so neither may live in
  // a server-only module.
  it("exports both caps from the client-safe module", () => {
    expect(MAX_OWNER_COLLECTIONS).toBe(10);
    expect(MAX_COLLECTION_PETS).toBe(24);
  });

  it("keeps the server-only module from being the source of the caps", async () => {
    const source = await Bun.file(
      new URL("./collection-access.ts", import.meta.url),
    ).text();

    expect(source).toContain("server-only");
    // Anchored to line starts so a commented-out re-export cannot satisfy it.
    expect(source).not.toMatch(/^export const MAX_OWNER_COLLECTIONS =/m);
    expect(source).toMatch(/^export \{ MAX_OWNER_COLLECTIONS \};$/m);
  });
});

describe("collectionPetLimitExceeded", () => {
  const cap = (n: number) =>
    Array.from({ length: n }, (_, index) => `pet-${index}`);

  it("allows any list within the cap, for a create or an edit", () => {
    expect(collectionPetLimitExceeded(cap(0), null)).toBe(false);
    expect(collectionPetLimitExceeded(cap(MAX_COLLECTION_PETS), null)).toBe(
      false,
    );
    expect(
      collectionPetLimitExceeded(
        cap(MAX_COLLECTION_PETS),
        cap(MAX_COLLECTION_PETS),
      ),
    ).toBe(false);
  });

  it("rejects an over-cap list when there is no stored row", () => {
    expect(collectionPetLimitExceeded(cap(MAX_COLLECTION_PETS + 1), null)).toBe(
      true,
    );
  });

  it("rejects growth past the cap on an existing row", () => {
    const stored = cap(MAX_COLLECTION_PETS);
    expect(collectionPetLimitExceeded([...stored, "pet-new"], stored)).toBe(
      true,
    );
  });

  it("keeps a collection created before the cap editable", () => {
    // The regression this predicate exists for: a stored collection holding
    // more than the cap must still accept an unchanged member list, so a
    // title-only edit does not become impossible.
    const stored = cap(MAX_COLLECTION_PETS + 6);

    expect(collectionPetLimitExceeded(stored, stored)).toBe(false);
    // And it may shrink, including straight past the cap.
    expect(collectionPetLimitExceeded(stored.slice(0, 5), stored)).toBe(false);
    expect(
      collectionPetLimitExceeded(cap(MAX_COLLECTION_PETS + 1), stored),
    ).toBe(false);
  });

  it("is reachable through the route flow, not just as a pure function", () => {
    // The regression this guards: the validator used to throw on the 25th
    // distinct slug, so the over-cap compatibility branch below was dead code
    // and a stored collection over the cap could not be edited at all. Drive
    // the validator first, exactly as the routes do.
    const stored = Array.from(
      { length: MAX_COLLECTION_PETS + 6 },
      (_, index) => `pet-${index}`,
    );

    const input = normalizeCollectionInput({
      title: "My pets",
      petSlugs: stored,
    });

    expect(input.petSlugs).toHaveLength(MAX_COLLECTION_PETS + 6);
    expect(collectionPetLimitExceeded(input.petSlugs, stored)).toBe(false);
  });

  it("rejects an over-cap list that swaps a member for a new one", () => {
    const stored = cap(MAX_COLLECTION_PETS + 6);
    const swapped = [...stored.slice(0, -1), "pet-new"];

    expect(swapped).toHaveLength(MAX_COLLECTION_PETS + 6);
    expect(collectionPetLimitExceeded(swapped, stored)).toBe(true);
  });
});
