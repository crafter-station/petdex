import { describe, expect, it } from "bun:test";

import { fallbackHandle, findUserIdByFallbackHandle } from "./handles";

describe("profile fallback handles", () => {
  it("resolves a Clerk user without a Petdex database row", async () => {
    const userId = "user_2abc1234target42";
    const calls: number[] = [];

    const result = await findUserIdByFallbackHandle(
      fallbackHandle(userId),
      async ({ offset }) => {
        calls.push(offset);
        return offset === 0
          ? { data: [{ id: "user_unrelated" }], totalCount: 2 }
          : { data: [{ id: userId }], totalCount: 2 };
      },
    );

    expect(result).toBe(userId);
    expect(calls).toEqual([0, 1]);
  });

  it("rejects ambiguous fallback handles", async () => {
    const suffix = "same1234";
    const result = await findUserIdByFallbackHandle(suffix, async () => ({
      data: [{ id: `user_first${suffix}` }, { id: `user_second${suffix}` }],
      totalCount: 2,
    }));

    expect(result).toBeNull();
  });

  it("ignores Clerk query matches from other user fields", async () => {
    const result = await findUserIdByFallbackHandle("arthaey1", async () => ({
      data: [{ id: "user_different" }],
      totalCount: 1,
    }));

    expect(result).toBeNull();
  });
});
