import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "@/lib/db/schema";

const { petCollections } = schema;

// collection-access imports "server-only", which throws outside a server
// component context, so it is imported dynamically after the stub below runs.
// @/lib/db/client is stubbed for the same reason collection-access.test.ts
// stubs it: the module builds its client on import and hard-fails without
// DATABASE_URL, which the root `bun test` does not set. Nothing in this suite
// uses that client — it runs its own PGlite connection below — so an empty db
// is enough to let the import through.
//
// The real schema is exported, not an empty object: mock.module is process-wide
// and the first registration wins, so a suite that links a table off this
// module would otherwise get undefined depending on load order. Every other
// suite that stubs this module exports the real schema for that reason.
mock.module("server-only", () => ({}));
mock.module("@/lib/db/client", () => ({ db: {}, schema }));

const { collectionEmptyMemberListCondition } = await import(
  "@/lib/collection-access"
);

// This suite builds its own PGlite client rather than importing @/lib/db/client.
// Two reasons, and both have bitten this repo already:
//   - Bun's mock.module is process-wide for the whole run, and
//     collection-access.test.ts replaces @/lib/db/client with a stub whose `db`
//     is `{}`. Importing the real client here would hand back that stub.
//   - The shared client needs DATABASE_URL, which the root `bun test` does not
//     set, so the file would fail to load and take the suite red with it.
// Only the two tables the condition reads are created, which keeps the schema
// this test depends on explicit instead of inheriting the full migration set.
const client = new PGlite();
const db = drizzle(client);

beforeAll(async () => {
  // Only the columns the statement reads or writes. The real tables carry more,
  // but the condition touches collection_id alone and the update writes title,
  // so a narrower shape keeps this test's dependency explicit — and cannot
  // silently start passing because an unrelated column was added.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_collections" (
      "id" text PRIMARY KEY,
      "title" text NOT NULL DEFAULT ''
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

async function seedCollection(id: string, members: readonly string[]) {
  await db.execute(
    sql`DELETE FROM "pet_collection_items" WHERE "collection_id" = ${id}`,
  );
  await db.execute(sql`DELETE FROM "pet_collections" WHERE "id" = ${id}`);
  await db.execute(
    sql`INSERT INTO "pet_collections" ("id", "title") VALUES (${id}, 'Probe')`,
  );
  for (const slug of members) {
    await db.execute(
      sql`INSERT INTO "pet_collection_items" ("collection_id", "pet_slug") VALUES (${id}, ${slug})`,
    );
  }
}

/**
 * The write the routes build: one UPDATE whose WHERE carries the empty-list
 * condition. Returns how many rows matched, which is the whole question — 0
 * means the guard blocked the write.
 */
async function updateMatching(
  id: string,
  members: readonly string[] | undefined,
): Promise<number> {
  const rows = await db
    .update(petCollections)
    .set({ title: `Touched ${id}` })
    .where(
      and(
        eq(petCollections.id, id),
        collectionEmptyMemberListCondition(id, members),
      ),
    )
    .returning({ id: petCollections.id });
  return rows.length;
}

describe("collectionEmptyMemberListCondition against a real database", () => {
  it("lets an omitted member list through, even when members exist", async () => {
    // The regression this pins: the routes pass `petSlugs`, which is undefined
    // for a request that does not touch the members. Coercing it to [] before
    // calling this helper made every rename of a collection that holds members
    // match zero rows — a silent no-op, with a 200 for a write that never
    // happened. A rename is the common case; it must not be gated at all.
    await seedCollection("probe_rename", ["boba", "mochi"]);
    expect(await updateMatching("probe_rename", undefined)).toBe(1);
  });

  it("lets a non-empty list through", async () => {
    await seedCollection("probe_replace", ["boba", "mochi"]);
    expect(await updateMatching("probe_replace", ["boba"])).toBe(1);
    expect(await updateMatching("probe_replace", ["boba", "dora"])).toBe(1);
  });

  it("blocks an empty list while the collection holds members", async () => {
    await seedCollection("probe_blocked", ["boba"]);
    expect(await updateMatching("probe_blocked", [])).toBe(0);
  });

  it("allows an empty list once the collection holds none", async () => {
    // The rule bounds the change, not the stored row: nothing to destroy means
    // nothing to refuse, so a row left empty by an older build stays renameable
    // and may still be written with an empty list.
    await seedCollection("probe_empty", []);
    expect(await updateMatching("probe_empty", [])).toBe(1);
  });
});
