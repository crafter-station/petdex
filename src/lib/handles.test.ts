import { describe, expect, it } from "bun:test";

import {
  fallbackHandle,
  isFallbackHandleShape,
  viewerIdForFallbackHandle,
} from "./handles";

describe("profile fallback handles", () => {
  it("resolves the signed-in viewer without a Petdex database row", () => {
    const userId = "user_2abc1234target42";

    expect(viewerIdForFallbackHandle(fallbackHandle(userId), userId)).toBe(
      userId,
    );
  });

  it("does not resolve another viewer or an anonymous request", () => {
    expect(
      viewerIdForFallbackHandle("target42", "user_2abc1234different"),
    ).toBeNull();
    expect(viewerIdForFallbackHandle("target42", null)).toBeNull();
  });

  it("normalizes the requested fallback handle", () => {
    expect(
      viewerIdForFallbackHandle(" TARGET42 ", "user_2abc1234target42"),
    ).toBe("user_2abc1234target42");
  });
});

// `handleForUser` builds `/u/<handle>` links out of `fallbackHandle` for any
// owner without a profile row, and the /u/[handle] page resolves them back
// through the id-suffix sweep, which gates on the shape predicate below. When
// the two disagree the link 404s for the user it was generated for — which is
// what happened to `user_seed_dev` (`seed_dev` failed a `/^[a-z0-9]+$/` gate),
// so the seeded pets' credit chip pointed at a dead profile on production.
describe("fallback handle shape round-trips", () => {
  it("accepts every tail a fallback handle can produce", () => {
    for (const userId of [
      "user_2abc1234target42",
      "user_seed_dev",
      "user_mock_contributor",
      "user_2xyz-dash",
    ]) {
      expect(
        isFallbackHandleShape(fallbackHandle(userId)),
        `${userId} → ${fallbackHandle(userId)} must survive the reverse lookup`,
      ).toBe(true);
    }
  });

  it("still rejects handles that are not a fallback tail", () => {
    expect(isFallbackHandleShape("petdex-seed")).toBe(false); // wrong length
    expect(isFallbackHandleShape("seed dev")).toBe(false); // space
    expect(isFallbackHandleShape("SEED_DEV")).toBe(false); // not normalized
    expect(isFallbackHandleShape("seed/dev")).toBe(false); // path separator
  });
});
