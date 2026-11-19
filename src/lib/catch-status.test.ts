import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "@/lib/db/schema";

// The point of this suite is to run `getCatchProgress`'s real SQL, so it needs
// a real database behind the module's `db`. `@/lib/db/client` builds its client
// on import and hard-fails without DATABASE_URL, which the root `bun test` does
// not set — so stub it with a drizzle client over its own PGlite connection.
// `db-client-mock-shape.test.ts` requires every stub of this module to export
// the real `schema` plus the two helpers, because `mock.module` is process-wide
// and a later suite links them.
const client = new PGlite();
const db = drizzle(client);

mock.module("server-only", () => ({}));
mock.module("@/lib/db/client", () => ({
  db,
  schema,
  executeAtomicReturning: async () => [],
  rowsOf: () => [],
}));

const { getCatchProgress } = await import("@/lib/catch-status");

beforeAll(async () => {
  await db.execute(sql`
    CREATE TABLE "submitted_pets" (
      "slug" text PRIMARY KEY,
      "status" text NOT NULL,
      "source" text NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE TABLE "pet_likes" (
      "user_id" text NOT NULL,
      "pet_slug" text NOT NULL
    )
  `);
});

afterAll(async () => {
  await client.close();
});

// The numerator must count the same pets the denominator does. Measured before
// the fix: liking one submit pet and one discover pet rendered "2/1 (200%)",
// because `caught` counted every like while `total` excluded source='discover'.
describe("getCatchProgress counts only collectible pets", () => {
  it("ignores a like on a discover-source pet", async () => {
    await db.execute(sql`
      INSERT INTO "submitted_pets" ("slug", "status", "source") VALUES
        ('submit-pet', 'approved', 'submit'),
        ('discover-pet', 'approved', 'discover')
    `);
    await db.execute(sql`
      INSERT INTO "pet_likes" ("user_id", "pet_slug") VALUES
        ('u1', 'submit-pet'),
        ('u1', 'discover-pet')
    `);

    expect(await getCatchProgress("u1")).toEqual({
      caught: 1,
      total: 1,
      pct: 100,
    });
  });

  it("does not count a like on a pet that is no longer approved", async () => {
    await db.execute(sql`
      INSERT INTO "submitted_pets" ("slug", "status", "source")
      VALUES ('rejected-pet', 'rejected', 'submit')
    `);
    await db.execute(sql`
      INSERT INTO "pet_likes" ("user_id", "pet_slug") VALUES ('u2', 'rejected-pet')
    `);

    expect(await getCatchProgress("u2")).toEqual({
      caught: 0,
      total: 1,
      pct: 0,
    });
  });

  it("reports zero caught for a signed-out caller", async () => {
    expect(await getCatchProgress(null)).toEqual({
      caught: 0,
      total: 1,
      pct: 0,
    });
  });
});
