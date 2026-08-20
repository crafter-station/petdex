import { describe, expect, it } from "bun:test";

import { fallbackHandle, viewerIdForFallbackHandle } from "./handles";

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
