import { describe, expect, it, mock } from "bun:test";

// The module under test carries `import "server-only"` and pulls the real DB
// client, which throws without `DATABASE_URL`. Stub both so the test exercises
// only the guard's short-circuit. The db stub must name every export the real
// module provides — `src/lib/db-client-mock-shape.test.ts` enforces it, since
// `mock.module` is process-wide and a partial shape breaks a later suite.
mock.module("server-only", () => ({}));

let dbCalls = 0;
mock.module("@/lib/db/client", () => ({
  db: {
    select: () => {
      dbCalls += 1;
      throw new Error("driver should not be reached for a NUL token");
    },
    update: () => {
      dbCalls += 1;
      throw new Error("driver should not be reached for a NUL token");
    },
  },
  schema: { emailPreferences: { unsubscribeToken: "col", userId: "uid" } },
  rowsOf: () => [],
  executeAtomicReturning: async () => [],
}));

const { findByToken, markResubscribed, markUnsubscribed } = await import(
  "./email-preferences"
);

// `?token=a%00b` reaches these helpers from a public, unauthenticated page.
// Postgres rejects a NUL byte in a `text` parameter outright — measured:
// `invalid byte sequence for encoding "UTF8": 0x00` — so before the guard the
// page answered 500 (verified against production, not just reasoned) instead
// of its "invalid link" branch. The guard must short-circuit ahead of the
// driver, and must not swallow ordinary tokens.
describe("email preference token guards", () => {
  const NUL = String.fromCharCode(0);

  it("treats a NUL-bearing token as no match without querying", async () => {
    expect(await findByToken(`a${NUL}b`)).toBeNull();
    expect(await markUnsubscribed(`a${NUL}b`)).toBe(false);
    expect(await markResubscribed(`a${NUL}b`)).toBe(false);
    expect(dbCalls).toBe(0);
  });
});
