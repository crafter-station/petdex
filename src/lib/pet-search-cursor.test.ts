// The gallery's `cursor` parameter becomes a SQL OFFSET. Values outside what
// Postgres accepts used to reach the query as-is and come back as a 500 with
// the whole statement echoed into the logs — for a request that only asked to
// page past the end.
//
// Imported from the leaf module rather than `pet-search`: that one opens a
// database client at import time, which would make this suite need a
// DATABASE_URL to check arithmetic.
import { describe, expect, it } from "bun:test";

import {
  clampCursor,
  MAX_CURSOR,
  SEARCH_LIMITS,
} from "@/lib/pet-search-cursor";

describe("cursor clamping", () => {
  it("keeps an ordinary offset", () => {
    expect(clampCursor(0)).toBe(0);
    expect(clampCursor(24)).toBe(24);
    expect(clampCursor(MAX_CURSOR)).toBe(MAX_CURSOR);
  });

  it("floors a negative or fractional offset", () => {
    expect(clampCursor(-1)).toBe(0);
    expect(clampCursor(-99999)).toBe(0);
    expect(clampCursor(7.9)).toBe(7);
  });

  it("caps an offset that would overflow the query", () => {
    // The shape the route hands over after `parseInt`: already rounded, and
    // far past `bigint`. Postgres answers `22003 bigint out of range`.
    expect(clampCursor(Number.parseInt("99999999999999999999", 10))).toBe(
      MAX_CURSOR,
    );
    expect(clampCursor(Number.MAX_SAFE_INTEGER)).toBe(MAX_CURSOR);
  });

  it("treats a non-finite offset as the start", () => {
    expect(clampCursor(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampCursor(Number.NaN)).toBe(0);
    expect(clampCursor(undefined)).toBe(0);
  });

  it("stays exact when a page is taken from the cap", () => {
    // The reason the bound is 1e9 rather than `MAX_SAFE_INTEGER`: adding a
    // limit to it must not lose precision, or `nextCursor` would stop
    // matching the offset the next request sends back.
    const next = MAX_CURSOR + SEARCH_LIMITS.MAX_LIMIT;
    expect(Number.isSafeInteger(next)).toBe(true);
    expect(next - SEARCH_LIMITS.MAX_LIMIT).toBe(MAX_CURSOR);
  });

  it("is a value Postgres accepts as an offset", () => {
    expect(Number.isSafeInteger(MAX_CURSOR)).toBe(true);
    expect(MAX_CURSOR).toBeLessThan(2 ** 63 - 1);
  });
});
