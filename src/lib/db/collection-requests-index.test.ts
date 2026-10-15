// The pair unique index used to carry `status` as a third column, which does
// not free the pair when a decision is made — it replaces the 'pending' row's
// slot with a 'rejected' one. A second rejection of the same (collection, pet)
// pair then collides with the first, and the decision UPDATE raises a
// duplicate-key error. The partial predicate is what actually frees it.
//
// The DDL below is the shape schema.ts declares; the last test reads schema.ts
// to keep the two from drifting apart.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

const client = new PGlite();
const db = drizzle(client);

beforeAll(async () => {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_collection_requests" (
      "id" text PRIMARY KEY,
      "collection_id" text NOT NULL,
      "pet_slug" text NOT NULL,
      "status" text NOT NULL DEFAULT 'pending'
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "pet_collection_requests_pending_pair"
      ON "pet_collection_requests" ("collection_id", "pet_slug")
      WHERE "status" = 'pending'
  `);
});

afterAll(async () => {
  await client.close();
});

async function reset(): Promise<void> {
  await db.execute(sql`DELETE FROM "pet_collection_requests"`);
}

async function insert(status: string): Promise<void> {
  await db.execute(
    sql`INSERT INTO "pet_collection_requests" ("id", "collection_id", "pet_slug", "status")
        VALUES (${crypto.randomUUID()}, 'c1', 'boba', ${status})`,
  );
}

async function decide(id: string, status: string): Promise<void> {
  await db.execute(
    sql`UPDATE "pet_collection_requests" SET "status" = ${status} WHERE "id" = ${id}`,
  );
}

async function pendingId(): Promise<string> {
  const rows = (await db.execute(
    sql`SELECT "id" FROM "pet_collection_requests" WHERE "status" = 'pending'`,
  )) as unknown as { rows?: { id: string }[] };
  return ((rows.rows ?? rows) as { id: string }[])[0]?.id as string;
}

describe("pet_collection_requests pair uniqueness", () => {
  it("allows a resubmission that is rejected a second time", async () => {
    await reset();

    await insert("pending");
    await decide(await pendingId(), "rejected");

    // Resubmission is allowed once a decision exists.
    await insert("pending");
    await decide(await pendingId(), "rejected");

    // Two rejections for the same pair now coexist — the old index raised
    // `duplicate key value violates unique constraint` on this second one.
    const rows = (await db.execute(
      sql`SELECT count(*)::int AS "n" FROM "pet_collection_requests"`,
    )) as unknown as { rows?: { n: number }[] };
    expect(((rows.rows ?? rows) as { n: number }[])[0]?.n).toBe(2);
  });

  it("still refuses two pending requests for the same pair", async () => {
    await reset();
    await insert("pending");
    // Specific, not a bare toThrow(): any failure on the suite's own
    // connection — a typo'd column, a missing table — would satisfy the
    // latter while the partial unique index went untested. Drizzle wraps the
    // driver error, so the SQLSTATE lives on `cause`; 23505 is
    // unique_violation.
    await expect(insert("pending")).rejects.toMatchObject({
      cause: { code: "23505" },
    });
  });

  it("lets a pending request coexist with a decided one", async () => {
    await reset();
    await insert("rejected");
    await insert("pending");
    expect(await pendingId()).toBeTruthy();
  });
});

describe("schema.ts declares the same shape", () => {
  it("declares the pair index as partial on pending", () => {
    const source = readFileSync(
      join(import.meta.dir, "schema.ts"),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(source).toContain(
      'uniqueIndex("pet_collection_requests_pending_pair") .on(table.collectionId, table.petSlug) .where(sql`',
    );
    // Built from parts so the linter does not read the placeholder as one
    // this file meant to interpolate.
    const placeholder = ["$", "{table.status} = 'pending'`)"].join("");
    expect(source).toContain(placeholder);
    // The old shape — status as an index column — must not come back.
    expect(source).not.toContain(
      ".on( table.collectionId, table.petSlug, table.status, )",
    );
  });
});
