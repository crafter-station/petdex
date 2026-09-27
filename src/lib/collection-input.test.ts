import { describe, expect, it } from "bun:test";

import {
  collectionInputErrorCode,
  isCollectionRequestBody,
  MAX_COLLECTION_PETS,
  normalizeCollectionCover,
  normalizeCollectionExternalUrl,
  normalizeCollectionInput,
  normalizeCollectionPatch,
  resolveCollectionCover,
} from "@/lib/collection-input";

describe("resolveCollectionCover", () => {
  it("preserves an existing cover when a partial pet edit keeps it", () => {
    // `undefined` is the omitted state: the request did not name the field.
    expect(resolveCollectionCover(undefined, ["first", "hero"], "hero")).toBe(
      "hero",
    );
    // The stored cover is no longer a member, so the write falls back.
    expect(resolveCollectionCover(undefined, ["first"], "hero")).toBe("first");
    // No stored cover at all.
    expect(resolveCollectionCover(undefined, ["first", "hero"], null)).toBe(
      "first",
    );
    expect(resolveCollectionCover(undefined, [], null)).toBeNull();
  });

  it("keeps a blank cover as an explicit clear rather than defaulting", () => {
    // The regression this pins: `null` (blank) and `undefined` (omitted) were
    // both normalized to null and then read as an omission, so a request that
    // asked to clear the cover fell through to the default below and silently
    // set it to the first member instead. A write the caller never asked for,
    // answered with 200. Every caller that sends --pets alongside a blank
    // --cover took this path.
    expect(resolveCollectionCover(null, ["first", "hero"], "hero")).toBeNull();
    expect(resolveCollectionCover(null, ["first"], "hero")).toBeNull();
    expect(resolveCollectionCover(null, ["first", "hero"], null)).toBeNull();
  });

  it("sets the named cover", () => {
    expect(resolveCollectionCover("hero", ["first", "hero"], "first")).toBe(
      "hero",
    );
  });
});

describe("normalizeCollectionInput", () => {
  it("trims fields, lowercases and deduplicates pet slugs", () => {
    expect(
      normalizeCollectionInput({
        title: "  My set ",
        description: "  pets  ",
        petSlugs: [" Boba ", "boba", "Dora"],
      }),
    ).toEqual({
      title: "My set",
      description: "pets",
      petSlugs: ["boba", "dora"],
    });
  });

  it("rejects invalid title and description lengths", () => {
    expect(() => normalizeCollectionInput({ title: "x" })).toThrow(
      "title_length",
    );
    expect(() =>
      normalizeCollectionInput({
        title: "valid",
        description: "x".repeat(281),
      }),
    ).toThrow("description_length");
  });

  it("rejects non-string descriptions", () => {
    expect(() =>
      normalizeCollectionInput({ title: "valid", description: 123 }),
    ).toThrow("description_type");
    expect(() =>
      normalizeCollectionInput({ title: "valid", description: null }),
    ).toThrow("description_type");
  });

  it("rejects malformed pet slug values", () => {
    expect(() =>
      normalizeCollectionInput({ title: "valid", petSlugs: ["bad slug"] }),
    ).toThrow("pet_slug");
  });

  it("accepts object request bodies and rejects null or invalid flags", () => {
    expect(isCollectionRequestBody({ title: "valid" })).toBe(true);
    expect(isCollectionRequestBody(null)).toBe(false);
    expect(isCollectionRequestBody([])).toBe(false);
    expect(
      isCollectionRequestBody({ title: "valid", allApproved: "yes" }),
    ).toBe(false);
  });

  it("normalizes optional external URLs and cover slugs", () => {
    expect(normalizeCollectionExternalUrl(" https://example.test/path ")).toBe(
      "https://example.test/path",
    );
    expect(normalizeCollectionExternalUrl("http://example.test/path")).toBe(
      false,
    );
    expect(normalizeCollectionExternalUrl("https://127.0.0.1:8080/")).toBe(
      false,
    );
    expect(
      normalizeCollectionExternalUrl(
        "https://169.254.169.254/latest/meta-data",
      ),
    ).toBe(false);
    expect(normalizeCollectionExternalUrl("https://localhost/")).toBe(false);
    expect(normalizeCollectionExternalUrl("https://[::1]/")).toBe(false);
    expect(normalizeCollectionExternalUrl("https://service.internal/")).toBe(
      false,
    );
    expect(normalizeCollectionExternalUrl("javascript:alert(1)")).toBe(false);
    expect(normalizeCollectionExternalUrl("")).toBeNull();
    expect(normalizeCollectionCover(" Boba ")).toBe("boba");
    expect(normalizeCollectionCover("")).toBeNull();
    expect(normalizeCollectionCover(42)).toBe(false);
  });

  it("rejects an oversized pet list as a shape error before walking it", () => {
    // Each element goes through a trim, a regex and a Set, so a huge array is
    // a cheap CPU amplification vector if the bound is only checked by the
    // caller after this returns. 500k entries took ~300ms before this guard.
    // The rejection is a payload-shape error: the collection cap is a growth
    // limit over the deduplicated list and cannot be decided here, so
    // reporting collection_pet_limit would misdescribe the request.
    const oversized = Array.from(
      { length: 500_000 },
      (_, index) => `pet-${index % MAX_COLLECTION_PETS}`,
    );

    expect(() =>
      normalizeCollectionInput({ title: "Pets", petSlugs: oversized }),
    ).toThrow("pet_slugs");
  });

  it("never rejects a legal deduplicated list for being duplicated", () => {
    // The bounds are payload size guards, so they must sit far above any
    // legitimate list however many times a client repeats it. A cap-sized
    // selection sent with a high repeat factor is still a legal request: the
    // list dedupes to exactly the cap. Pinning the old ceiling at 200 made a
    // 24-slug list rejected once each slug appeared 9 times, and reported it
    // as a cap violation.
    const base = Array.from(
      { length: MAX_COLLECTION_PETS },
      (_, index) => `pet-${index}`,
    );

    for (const repeats of [2, 10, 100, 500]) {
      const duplicated = base.flatMap((slug) =>
        Array.from({ length: repeats }, () => slug),
      );

      expect(() =>
        normalizeCollectionInput({ title: "Pets", petSlugs: duplicated }),
      ).not.toThrow();
      expect(
        normalizeCollectionInput({ title: "Pets", petSlugs: duplicated })
          .petSlugs,
      ).toHaveLength(MAX_COLLECTION_PETS);
    }
  });

  it("bounds the payload by total length, not just by entry count", () => {
    // Entry count alone leaves the expensive case open: few entries, each an
    // enormous string, still goes through a trim and a regex per entry. The
    // character ceiling is what holds the validation cost down.
    expect(() =>
      normalizeCollectionInput({
        title: "Pets",
        petSlugs: ["a".repeat(200_000)],
      }),
    ).toThrow("pet_slugs");
    // A single long-but-plausible slug is still fine.
    expect(
      normalizeCollectionInput({
        title: "Pets",
        petSlugs: [`a${"b".repeat(60)}`],
      }).petSlugs,
    ).toHaveLength(1);
  });

  it("does not enforce the collection cap itself", () => {
    // The cap is a growth limit that depends on what the row already stores,
    // so it cannot be decided here: a collection created before the cap
    // existed must still be able to submit its unchanged member list. Callers
    // apply collectionPetLimitExceeded() once they know the stored members.
    const overCap = Array.from(
      { length: MAX_COLLECTION_PETS + 6 },
      (_, index) => `pet-${index}`,
    );

    expect(
      normalizeCollectionInput({ title: "Pets", petSlugs: overCap }).petSlugs,
    ).toHaveLength(MAX_COLLECTION_PETS + 6);
  });

  it("still accepts exactly the pet cap", () => {
    const atCap = Array.from(
      { length: MAX_COLLECTION_PETS },
      (_, index) => `pet-${index}`,
    );

    expect(
      normalizeCollectionInput({ title: "Pets", petSlugs: atCap }).petSlugs,
    ).toHaveLength(MAX_COLLECTION_PETS);
  });

  it("validates a non-array pet list as a type error, not a limit", () => {
    expect(() =>
      normalizeCollectionInput({ title: "Pets", petSlugs: "boba" }),
    ).toThrow("pet_slugs");
  });
});

describe("collectionInputErrorCode", () => {
  // The routes used to return `(error as Error).message` verbatim, so any
  // throw this validator did not anticipate — a driver error, a future
  // helper — reached the client as a 400 body. The mapping is a whitelist.
  it("passes through every code the validator is allowed to raise", () => {
    const raised = new Set<string>();
    const capture = (input: Parameters<typeof normalizeCollectionInput>[0]) => {
      try {
        normalizeCollectionInput(input);
      } catch (error) {
        raised.add(collectionInputErrorCode(error));
      }
    };

    capture({ title: "x" });
    capture({ title: "valid", description: 1 });
    capture({ title: "valid", description: "x".repeat(281) });
    capture({ title: "valid", petSlugs: "boba" });
    capture({ title: "valid", petSlugs: ["bad slug"] });
    capture({
      title: "valid",
      petSlugs: Array.from({ length: 500_000 }, (_, index) => `pet-${index}`),
    });

    // collection_pet_limit is deliberately absent: the validator no longer
    // raises it. The cap is a growth limit that depends on the stored members,
    // so it is decided by collectionPetLimitExceeded() in the routes, and this
    // list stays the set of codes the validator alone can produce.
    expect([...raised].sort()).toEqual([
      "description_length",
      "description_type",
      "pet_slug",
      "pet_slugs",
      "title_length",
    ]);
    for (const code of raised) expect(code).not.toBe("invalid_body");
  });

  it("collapses anything unrecognized to invalid_body", () => {
    expect(collectionInputErrorCode(new Error("connection terminated"))).toBe(
      "invalid_body",
    );
    expect(
      collectionInputErrorCode(
        new Error("duplicate key value violates unique constraint"),
      ),
    ).toBe("invalid_body");
    expect(collectionInputErrorCode(new Error(""))).toBe("invalid_body");
    expect(collectionInputErrorCode("title_length")).toBe("invalid_body");
    expect(collectionInputErrorCode(null)).toBe("invalid_body");
    expect(collectionInputErrorCode(undefined)).toBe("invalid_body");
  });
});

describe("normalizeCollectionPatch", () => {
  it("validates only the fields the request carries", () => {
    // The edit routes used to substitute the stored value for every omitted
    // field and run the full validator over the merge. A row whose stored
    // description exceeded the limit — the database permits it, and the ops
    // scripts write directly — then failed description_length on a rename or a
    // cover-only edit, naming a field the request never contained, and
    // resending the value did not help because the stored one was already over.
    // The row became uneditable through the API.
    expect(normalizeCollectionPatch({ title: "New name" })).toEqual({
      title: "New name",
    });
    expect(normalizeCollectionPatch({})).toEqual({});
    expect(normalizeCollectionPatch({ description: "" })).toEqual({
      description: "",
    });
  });

  it("leaves an omitted field absent rather than defaulting it", () => {
    // Absent must stay absent: that is how the callers tell "not sent" from
    // "sent blank", and a defaulted "" would overwrite the stored value on a
    // partial edit.
    expect(normalizeCollectionPatch({ title: "ok" })).not.toHaveProperty(
      "description",
    );
    expect(normalizeCollectionPatch({ description: "ok" })).not.toHaveProperty(
      "title",
    );
    expect(normalizeCollectionPatch({ petSlugs: ["a"] })).toEqual({
      petSlugs: ["a"],
    });
  });

  it("still refuses a value the request actually sent", () => {
    expect(() => normalizeCollectionPatch({ title: "a" })).toThrow(
      "title_length",
    );
    expect(() =>
      normalizeCollectionPatch({ description: "x".repeat(281) }),
    ).toThrow("description_length");
    expect(() => normalizeCollectionPatch({ description: 42 })).toThrow(
      "description_type",
    );
    expect(() => normalizeCollectionPatch({ petSlugs: "a,b" })).toThrow(
      "pet_slugs",
    );
  });

  it("normalizes the values it does validate", () => {
    expect(
      normalizeCollectionPatch({
        title: "  My set ",
        petSlugs: [" Boba ", "boba", "Dora"],
      }),
    ).toEqual({ title: "My set", petSlugs: ["boba", "dora"] });
  });
});
