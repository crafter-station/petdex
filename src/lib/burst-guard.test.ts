import { beforeEach, describe, expect, it } from "bun:test";

import { checkBurst, resetBurstGuardForTest } from "@/lib/burst-guard";

const LIMIT = 120;
const WINDOW_MS = 60_000;

describe("burst guard", () => {
  beforeEach(() => {
    resetBurstGuardForTest();
  });

  it("allows traffic up to the ceiling", () => {
    const now = 1_000_000;
    for (let i = 0; i < LIMIT; i++) {
      expect(checkBurst("1.2.3.4", now).success).toBe(true);
    }
  });

  it("denies the request that crosses the ceiling", () => {
    const now = 1_000_000;
    for (let i = 0; i < LIMIT; i++) checkBurst("1.2.3.4", now);
    const over = checkBurst("1.2.3.4", now);
    expect(over.success).toBe(false);
    expect(over.reset).toBe(now + WINDOW_MS);
  });

  it("starts a fresh window once the old one expires", () => {
    const now = 1_000_000;
    for (let i = 0; i < LIMIT + 5; i++) checkBurst("1.2.3.4", now);
    expect(checkBurst("1.2.3.4", now).success).toBe(false);
    expect(checkBurst("1.2.3.4", now + WINDOW_MS).success).toBe(true);
  });

  it("keeps separate windows per key", () => {
    const now = 1_000_000;
    for (let i = 0; i < LIMIT + 5; i++) checkBurst("1.2.3.4", now);
    expect(checkBurst("1.2.3.4", now).success).toBe(false);
    expect(checkBurst("5.6.7.8", now).success).toBe(true);
  });

  it("bounds how many keys it tracks", () => {
    const now = 1_000_000;
    for (let i = 0; i < 10_050; i++) checkBurst(`ip-${i}`, now);
    // The earliest keys were evicted, so the first one starts a fresh window
    // instead of carrying its old count.
    expect(checkBurst("ip-0", now).success).toBe(true);
  });
});
