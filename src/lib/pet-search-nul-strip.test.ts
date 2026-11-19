// Postgres rejects a NUL byte in a query parameter outright, so before the
// strip existed `?q=%00` on /api/pets/search was a deterministic 500 with an
// empty body. pet-search owns the sanitization (the route passes q through
// untouched); these specs pin the strip at the real module, not the mock the
// route test installs.
// pet-search's import chain pulls server-only, the db client, and — at
// module top level — a neon() connection that throws without DATABASE_URL;
// the repo-wide pattern stubs the pieces before the import (see pets.test.ts).
// mock.module is process-wide, so the db stub carries the shape other
// suites expect — schema real, db empty, the two helpers named.
process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/test";

import { describe, expect, mock, test } from "bun:test";

import * as schema from "@/lib/db/schema";

mock.module("server-only", () => ({}));
mock.module("@/lib/db/client", () => ({
  db: {},
  schema,
  executeAtomicReturning: async () => [],
  rowsOf: () => [],
}));

const { stripNulBytes, VIBE_MAX_CURSOR } = await import("./pet-search");

describe("stripNulBytes", () => {
  test("removes NUL bytes anywhere in the query", () => {
    expect(stripNulBytes("co\u0000zy")).toBe("cozy");
    expect(stripNulBytes("\u0000cozy")).toBe("cozy");
    expect(stripNulBytes("cozy\u0000")).toBe("cozy");
    expect(stripNulBytes("\u0000\u0000")).toBe("");
  });

  test("leaves ordinary search terms unchanged", () => {
    expect(stripNulBytes("cozy cat")).toBe("cozy cat");
    expect(stripNulBytes("%00")).toBe("%00");
    expect(stripNulBytes("")).toBe("");
  });
});
// The vibe branch materializes LIMIT = cursor + limit + 1 rows (a cosine
// ranking has no seekable offset), so the cap is a resource guard: without
// it one request asks Postgres to produce a billion-row result. Pinning the
// export keeps a refactor from silently dropping the Math.min.
describe("VIBE_MAX_CURSOR", () => {
  test("stays a small, finite bound", () => {
    expect(Number.isFinite(VIBE_MAX_CURSOR)).toBe(true);
    expect(VIBE_MAX_CURSOR).toBeLessThan(10_000);
    expect(VIBE_MAX_CURSOR).toBeGreaterThan(0);
  });
});
