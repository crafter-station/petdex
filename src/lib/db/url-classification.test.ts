import { describe, expect, it } from "bun:test";

import { isLocalDatabaseUrl } from "./url-classification";

// Two very different servers answer to `DATABASE_URL`: Neon over HTTP in
// production, and a plain local Postgres (compose / loopback) in development.
// `db/client.ts` picks a driver on this answer and the Neon rate limiter picks
// a storage adapter, so a wrong answer in either direction is a real defect —
// the limiter failing open against local Postgres is what this predicate was
// extracted to fix.
describe("local database detection", () => {
  it("recognizes the local shapes the compose stack and dev scripts use", () => {
    for (const url of [
      "postgresql://petdex:petdex@127.0.0.1:54320/petdex",
      "postgresql://petdex:petdex@localhost:5432/petdex",
      "postgresql://petdex:petdex@postgres:5432/petdex",
      "postgresql://petdex:petdex@[::1]:5432/petdex",
    ]) {
      expect(isLocalDatabaseUrl(url), url).toBe(true);
    }
  });

  it("treats a Neon host as remote", () => {
    expect(
      isLocalDatabaseUrl(
        "postgresql://user:pass@ep-cool-name-123456.us-east-2.aws.neon.tech/petdex",
      ),
    ).toBe(false);
  });

  it("does not crash on a missing or malformed URL", () => {
    expect(isLocalDatabaseUrl(undefined)).toBe(false);
    expect(isLocalDatabaseUrl("")).toBe(false);
    expect(isLocalDatabaseUrl("not a url")).toBe(false);
  });
});
