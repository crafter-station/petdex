import { describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));

const {
  COLLECTION_SLUG_ATTEMPTS,
  collectionSlugBase,
  collectionSlugCandidates,
} = await import("@/lib/collection-slug");

describe("collection slug base", () => {
  it("slugifies a profile handle into a URL-safe base", () => {
    expect(collectionSlugBase("Lulu Capybara")).toBe("lulu-capybara");
    expect(collectionSlugBase("  Mixed_Case-Name  ")).toBe("mixed-case-name");
  });

  it("keeps the longer collection slug budget instead of the pet slug one", () => {
    const base = collectionSlugBase("a".repeat(80));

    expect(base).toHaveLength(48);
  });

  it("does not end the base in a dash when the cut lands on a separator", () => {
    // The trim runs before the slice, so a cut that lands on a separator used
    // to leave the base ending in a dash — and the numbered candidates then
    // read `name--2` instead of `name-2`. The budget is 48, so 47 characters
    // followed by a space puts the cut exactly on the separator.
    const base = collectionSlugBase(`${"a".repeat(47)} ${"b".repeat(20)}`);

    expect(base).toBe("a".repeat(47));
    expect(base.endsWith("-")).toBe(false);
    expect(collectionSlugCandidates(base, 2)).toEqual([
      "a".repeat(47),
      `${"a".repeat(47)}-2`,
    ]);
  });

  it("falls back to a random collection slug for reserved handles", () => {
    const base = collectionSlugBase("admin");

    expect(base).toMatch(/^collection-[0-9a-f]{32}$/);
  });

  it("falls back to a random collection slug when nothing slugifies", () => {
    expect(collectionSlugBase("绘梨衣")).toMatch(/^collection-[0-9a-f]{32}$/);
    expect(collectionSlugBase("   ")).toMatch(/^collection-[0-9a-f]{32}$/);
  });
});

describe("collection slug candidates", () => {
  it("tries the base first, then numbered suffixes", () => {
    expect(collectionSlugCandidates("boba", 4)).toEqual([
      "boba",
      "boba-2",
      "boba-3",
      "boba-4",
    ]);
  });

  it("probes the same number of candidates the old inline loop did", () => {
    // Hardcoded rather than compared against COLLECTION_SLUG_ATTEMPTS: the
    // old inline loop in the two profile routes probed 20 candidates, and
    // comparing against the constant would pass even if that changed.
    expect(COLLECTION_SLUG_ATTEMPTS).toBe(20);
    expect(collectionSlugCandidates("boba")).toHaveLength(20);
    expect(collectionSlugCandidates("boba").at(-1)).toBe("boba-20");
  });

  it("bounds the number of candidates it will probe", () => {
    expect(collectionSlugCandidates("boba", 3)).toHaveLength(3);
  });

  it("keeps every candidate distinct even at the base length cap", () => {
    // The probe only works if the candidates differ from each other. A base at
    // the cap is the case that would break it: re-applying the cap after
    // appending the suffix collapses every candidate onto the base, so all 20
    // probes would test the same slug and the caller would fall back to a
    // random one. The suffix is therefore allowed past the cap.
    const base = collectionSlugBase("a".repeat(80));

    expect(base).toHaveLength(48);

    const candidates = collectionSlugCandidates(base);

    expect(new Set(candidates).size).toBe(candidates.length);
    // The suffix is what exceeds the base budget; assert the bound rather than
    // a fixed length so a longer suffix form would not silently pass.
    expect(Math.max(...candidates.map((c) => c.length))).toBeLessThanOrEqual(
      48 + "-20".length,
    );
  });
});
