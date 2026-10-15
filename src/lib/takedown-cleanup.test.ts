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
mock.module("@/lib/db/client", () => ({
  db: {},
  schema,
  // Named here because mock.module is process-wide: a suite that
  // links `executeAtomicReturning` fails with a SyntaxError otherwise.
  executeAtomicReturning: async () => [],
  rowsOf: () => [],
}));

const { takedownRowStillMatches } = await import("@/lib/takedown");

const client = new PGlite();
const db = drizzle(client);

const SLUG = "shared-slug";

beforeAll(async () => {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "submitted_pets" (
      "id" text PRIMARY KEY,
      "slug" text NOT NULL,
      "owner_id" text
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
  // The two tables takedownPet's newer cleanups target. Reviews hang off the
  // pet by id and candidates by (pet_id, request_id); neither is a collection
  // table, so the slug-keyed cleanup above never touched them, and nothing
  // executed these statements before — a typo'd column would have passed CI.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "submission_reviews" (
      "id" text PRIMARY KEY,
      "submitted_pet_id" text NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_request_candidates" (
      "pet_id" text NOT NULL,
      "request_id" text NOT NULL,
      "status" text NOT NULL DEFAULT 'pending'
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

  it("owner-scoped gate refuses rows whose owner_id no longer matches", async () => {
    // The owner self-service path restates ownership inside the statements
    // (ownerScoped: true) so a claim racing the takedown — owner_id rewritten
    // after the route's 403 check read its snapshot — cannot delete a pet the
    // caller no longer owns. Null ownerId keeps the unscoped gate.
    await seedPet("pet_owned");
    await db.execute(
      sql`UPDATE "submitted_pets" SET "owner_id" = 'user_new' WHERE "id" = 'pet_owned'`,
    );

    const gate = takedownRowStillMatches("pet_owned", SLUG, "user_old");
    const result = await db.execute(sql`
      SELECT EXISTS (SELECT 1 FROM "submitted_pets" WHERE "id" = 'pet_owned' AND ${gate}) AS ok
    `);
    const rows = (result as { rows?: Array<{ ok?: unknown }> }).rows ?? [];
    expect(rows[0]?.ok).toBe(false);

    const matching = takedownRowStillMatches("pet_owned", SLUG, "user_new");
    const ok = await db.execute(sql`
      SELECT EXISTS (SELECT 1 FROM "submitted_pets" WHERE "id" = 'pet_owned' AND ${matching}) AS ok
    `);
    const okRows = (ok as { rows?: Array<{ ok?: unknown }> }).rows ?? [];
    expect(okRows[0]?.ok).toBe(true);
  });
});

describe("takedown cleanup of the id-keyed tables", () => {
  // `submission_reviews` and `pet_request_candidates` are keyed by the pet's
  // id, not its slug, so they cannot ride the slug-keyed statements above and
  // were never executed against a real database. These run the same statement
  // shapes takedownPet submits, against the real column names.
  async function reviewCount(petId: string): Promise<number> {
    const result = await db.execute(
      sql`SELECT count(*)::int AS n FROM "submission_reviews" WHERE "submitted_pet_id" = ${petId}`,
    );
    const rows = (result as { rows?: Array<{ n?: unknown }> }).rows ?? [];
    return Number(rows[0]?.n ?? 0);
  }

  async function candidateCount(petId: string): Promise<number> {
    const result = await db.execute(
      sql`SELECT count(*)::int AS n FROM "pet_request_candidates" WHERE "pet_id" = ${petId}`,
    );
    const rows = (result as { rows?: Array<{ n?: unknown }> }).rows ?? [];
    return Number(rows[0]?.n ?? 0);
  }

  it("deletes the pet's reviews and candidates while the row matches", async () => {
    await seedPet("pet_with_reviews");
    await db.execute(
      sql`INSERT INTO "submission_reviews" ("id", "submitted_pet_id") VALUES ('rev_1', 'pet_with_reviews'), ('rev_2', 'pet_with_reviews')`,
    );
    await db.execute(
      sql`INSERT INTO "pet_request_candidates" ("pet_id", "request_id") VALUES ('pet_with_reviews', 'req_1')`,
    );

    await db.execute(sql`
      DELETE FROM "submission_reviews"
      WHERE "submitted_pet_id" = 'pet_with_reviews'
        AND ${takedownRowStillMatches("pet_with_reviews", SLUG)}
    `);
    await db.execute(sql`
      DELETE FROM "pet_request_candidates"
      WHERE "pet_id" = 'pet_with_reviews'
        AND ${takedownRowStillMatches("pet_with_reviews", SLUG)}
    `);

    expect(await reviewCount("pet_with_reviews")).toBe(0);
    expect(await candidateCount("pet_with_reviews")).toBe(0);
  });

  it("leaves a stale takedown's rows alone", async () => {
    // The pet row is gone (an earlier takedown), so the gate must hold and a
    // newer pet's reviews/candidates must survive.
    await seedPet("pet_stale");
    await db.execute(
      sql`INSERT INTO "submission_reviews" ("id", "submitted_pet_id") VALUES ('rev_keep', 'pet_stale')`,
    );
    await db.execute(
      sql`DELETE FROM "submitted_pets" WHERE "id" = 'pet_stale'`,
    );

    await db.execute(sql`
      DELETE FROM "submission_reviews"
      WHERE "submitted_pet_id" = 'pet_stale'
        AND ${takedownRowStillMatches("pet_stale", SLUG)}
    `);

    expect(await reviewCount("pet_stale")).toBe(1);
  });
});
