import { afterAll, describe, expect, it, mock } from "bun:test";

// `isSlugUniqueViolation` gates the slug-collision retry in `persistSubmission`.
// drizzle wraps the driver error in `DrizzleQueryError` and does not copy the
// pg `code` onto the wrapper — it lives on `.cause` — so reading `error.code`
// never matched and the retry was dead, leaving the 23505 as an uncaught 500.
// These cases pin the unwrap: the wrapped shape is what actually arrives.
//
// The module imports `server-only` and builds a db connection at import time,
// so both are stubbed; the schema is the real one (mock.module is
// process-wide, and a partial stub is a SyntaxError in a later suite).

mock.module("server-only", () => ({}));
mock.module("@/lib/db/client", () => ({
  db: {},
  schema: {},
  executeAtomicReturning: async () => [],
  rowsOf: () => [],
}));

const { isSlugUniqueViolation } = await import("@/lib/submissions");

afterAll(() => {
  mock.restore();
});

/** What drizzle 0.45 actually throws: the pg error is on `.cause`. */
function drizzleWrapped(code: string): Error {
  const cause = Object.assign(new Error("duplicate key value"), { code });
  return Object.assign(new Error("Failed query"), {
    name: "DrizzleQueryError",
    cause,
  });
}

describe("isSlugUniqueViolation", () => {
  it("recognizes the drizzle-wrapped 23505", () => {
    expect(isSlugUniqueViolation(drizzleWrapped("23505"))).toBe(true);
  });

  it("still recognizes a bare driver error (defensive)", () => {
    expect(
      isSlugUniqueViolation(Object.assign(new Error("dup"), { code: "23505" })),
    ).toBe(true);
  });

  it("rejects a wrapped error with a different code", () => {
    expect(isSlugUniqueViolation(drizzleWrapped("23503"))).toBe(false);
  });

  it("rejects non-objects and missing causes", () => {
    expect(isSlugUniqueViolation(null)).toBe(false);
    expect(isSlugUniqueViolation(undefined)).toBe(false);
    expect(isSlugUniqueViolation("23505")).toBe(false);
    expect(isSlugUniqueViolation(new Error("plain"))).toBe(false);
  });
});
