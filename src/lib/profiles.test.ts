import { describe, expect, it } from "bun:test";

import {
  isPinOnlyProfilePatch,
  normalizeProfileDisplayName,
  normalizeProfileHandle,
  validateProfileHandle,
} from "./profiles";

describe("profile identity helpers", () => {
  it("normalizes display names", () => {
    expect(normalizeProfileDisplayName("  Kevin   Wu  ")).toBe("Kevin Wu");
    expect(normalizeProfileDisplayName("   ")).toBeNull();
  });

  it("normalizes handles", () => {
    expect(normalizeProfileHandle(" AmirDayyef ")).toBe("amirdayyef");
    expect(normalizeProfileHandle("   ")).toBeNull();
  });

  it("accepts safe handles", () => {
    expect(validateProfileHandle("kevwuzy")).toBe("ok");
    expect(validateProfileHandle("gray_craft-7")).toBe("ok");
  });

  it("rejects unsafe handles", () => {
    expect(validateProfileHandle("u")).toBe("too_short");
    expect(validateProfileHandle("my pets")).toBe("invalid_format");
    expect(validateProfileHandle("-kevwuzy")).toBe("invalid_format");
    expect(validateProfileHandle("admin")).toBe("reserved");
  });

  it("classifies pin-only profile patches", () => {
    expect(isPinOnlyProfilePatch({ featuredPetSlugs: ["boba"] })).toBe(true);
    expect(isPinOnlyProfilePatch({ pin: { slug: "boba" } })).toBe(true);
    expect(isPinOnlyProfilePatch({ unpin: { slug: "boba" } })).toBe(true);
  });

  it("does not classify identity edits as pin-only patches", () => {
    expect(
      isPinOnlyProfilePatch({
        featuredPetSlugs: ["boba"],
        bio: "tiny pets",
      }),
    ).toBe(false);
    expect(isPinOnlyProfilePatch({ displayName: "Petdex" })).toBe(false);
    expect(isPinOnlyProfilePatch(null)).toBe(false);
  });
});
