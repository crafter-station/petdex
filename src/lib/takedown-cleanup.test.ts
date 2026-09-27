import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "@/lib/db/schema";

// The gate is imported from the real module rather than rebuilt here: a copy
// would keep passing after the condition was dropped from the statements that
// use it. That import needs two stubs first — "server-only" throws outside a
// server component context, and @/lib/db/client builds its connection on import
// and hard-fails without DATABASE_URL, which the root `bun test` does not set.
// The real schema is exported because mock.module is process-wide and the first
// registration wins. This suite runs its own PGlite connection.
mock.module("server-only", () => ({}));
mock.module("@/lib/db/client", () => ({ db: {}, schema }));

const { takedownRowStillMatches } = await import("@/lib/takedown");

const client = new PGlite();
const db = drizzle(client);

const SLUG = "shared-slug";

beforeAll(async () => {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "submitted_pets" (
      "id" text PRIMARY KEY,
      "slug" text NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_collections" (
      "id" text PRIMARY KEY,
      "slug" text NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_collection_items" (
      "collection_id" text NOT NULL,
      "pet_slug" text NOT NULL
    )
  `);
});

afterAll(async () => {
  await client.close();
});

async function seedPet(id: string) {
  await db.execute(sql`DELETE FROM "submitted_pets" WHERE "id" = ${id}`);
  await db.execute(
    sql`INSERT INTO "submitted_pets" ("id", "slug") VALUES (${id}, ${SLUG})`,
  );
}

async function seedCollection(id: string) {
  await db.execute(
    sql`DELETE FROM "pet_collection_items" WHERE "collection_id" = ${id}`,
  );
  await db.execute(sql`DELETE FROM "pet_collections" WHERE "id" = ${id}`);
  await db.execute(
    sql`INSERT INTO "pet_collections" ("id", "slug") VALUES (${id}, ${id})`,
  );
}

/** One of the cleanup statements, reduced to the item delete it gates. */
async function cleanupItems(petId: string): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM "pet_collection_items"
    WHERE "pet_slug" = ${SLUG}
      AND ${takedownRowStillMatches(petId, SLUG)}
    RETURNING "pet_slug"
  `);
  const rows = (result as { rows?: unknown[] }).rows;
  return Array.isArray(rows) ? rows.length : 0;
}

async function memberCount(collectionId: string): Promise<number> {
  const result = await db.execute(
    sql`SELECT count(*)::int AS n FROM "pet_collection_items" WHERE "collection_id" = ${collectionId}`,
  );
  const rows = (result as { rows?: Array<{ n?: unknown }> }).rows ?? [];
  return Number(rows[0]?.n ?? 0);
}

// takedownPet has no integration coverage: its lock helper is asserted at the
// SQL-string level in collection-access.test.ts, but nothing executed the
// cleanup statements. What they hinge on is the
// `AND EXISTS (... WHERE id = $oldId AND slug = $slug)` gate every one of them
// carries — a repeated or stale takedown must not touch a newer pet that has
// reused the slug. That gate is what these tests prove, against real Postgres.
describe("takedown cleanup is gated on the pet row it was given", () => {
  it("cleans up while the row still matches", async () => {
    await seedPet("pet_current");
    await seedCollection("col_gate_on");
    await db.execute(
      sql`INSERT INTO "pet_collection_items" ("collection_id", "pet_slug") VALUES ('col_gate_on', ${SLUG})`,
    );

    expect(await cleanupItems("pet_current")).toBe(1);
    expect(await memberCount("col_gate_on")).toBe(0);
  });

  it("does nothing once the row is gone, so a newer pet keeps its references", async () => {
    // The stale-takedown case: the original row was deleted (by an earlier
    // takedown, or by an admin sweep), the slug was freed, and a newer pet has
    // since taken it and been added to a collection. Re-running the cleanup with
    // the old id must not delete the new pet's members.
    await seedPet("pet_old");
    await seedCollection("col_gate_off");
    await db.execute(sql`DELETE FROM "submitted_pets" WHERE "id" = 'pet_old'`);
    await db.execute(
      sql`INSERT INTO "pet_collection_items" ("collection_id", "pet_slug") VALUES ('col_gate_off', ${SLUG})`,
    );

    expect(await cleanupItems("pet_old")).toBe(0);
    expect(await memberCount("col_gate_off")).toBe(1);
  });

  it("does nothing when the id does not match the slug's current owner", async () => {
    // Same slug, different row: the gate keys on id AND slug together, so a
    // mismatched pair cannot delete another pet's references.
    await seedPet("pet_newer");
    await seedCollection("col_gate_mismatch");
    await db.execute(
      sql`INSERT INTO "pet_collection_items" ("collection_id", "pet_slug") VALUES ('col_gate_mismatch', ${SLUG})`,
    );

    expect(await cleanupItems("pet_some_other_id")).toBe(0);
    expect(await memberCount("col_gate_mismatch")).toBe(1);
  });
});
