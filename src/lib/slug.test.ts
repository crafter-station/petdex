import { describe, expect, test } from "bun:test";

import { deriveSlug, slugify } from "@/lib/slug";

describe("slugify", () => {
  test("keeps latin ids untouched", () => {
    expect(slugify("Lulu Capybara")).toBe("lulu-capybara");
  });

  test("strips CJK to empty", () => {
    expect(slugify("绘梨衣")).toBe("");
  });
});

describe("deriveSlug", () => {
  test("prefers the petId when it slugifies", () => {
    expect(deriveSlug("feifei", "菲菲")).toBe("feifei");
  });

  test("keeps the latin part of a mixed id", () => {
    expect(deriveSlug("绘梨衣-chan", "")).toBe("chan");
  });

  test("falls back to displayName", () => {
    expect(deriveSlug("绘梨衣", "Erii Chan")).toBe("erii-chan");
  });

  test("CJK-only input derives a stable pet-<hash> slug", () => {
    const slug = deriveSlug("绘梨衣", "绘梨衣");
    expect(slug).toMatch(/^pet-[a-z0-9]{7}$/);
    expect(deriveSlug("绘梨衣", "绘梨衣")).toBe(slug);
  });

  test("different CJK ids derive different slugs", () => {
    expect(deriveSlug("绘梨衣")).not.toBe(deriveSlug("菲菲"));
  });

  test("hash falls back to displayName seed when petId is empty", () => {
    expect(deriveSlug("", "菲菲")).toBe(deriveSlug("菲菲"));
  });

  test("returns empty only when both inputs are empty", () => {
    expect(deriveSlug("", "")).toBe("");
    expect(deriveSlug("   ", "")).toBe("");
  });
});
