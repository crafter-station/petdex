import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "@/lib/db/schema";

// The two statements that replace a collection's members carry a guard each,
// and both are load-bearing in the same direction: a request whose UPDATE
// matched nothing, or whose proposed list no longer passes authorization, must
// not touch the members. Neither guard is visible in a stub — the route suites
// replace runCollectionMutation wholesale, and collection-batch.test.ts reads
// the results without executing the SQL — so this suite owns a PGlite
// connection and runs the real statements.
//
// server-only throws outside a server component context, and @/lib/db/client
// builds its connection on import and hard-fails without DATABASE_URL, which
// the root `bun test` does not set. The real schema is exported because
// mock.module is process-wide and the first registration wins.
mock.module("server-only", () => ({}));
mock.module("@/lib/db/client", () => ({ db: {}, schema }));

const { deleteCollectionItemsQuery, insertCollectionItemsQuery } = await import(
  "@/lib/collection-access"
);

const client = new PGlite();
const db = drizzle(client);

const COLLECTION = "col_1";
const OWNER = "user_owner";

beforeAll(async () => {
  // Only the columns the two statements read or write. A narrower shape keeps
  // this suite's dependency explicit and cannot start passing because an
  // unrelated column changed.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_collections" (
      "id" text PRIMARY KEY,
      "owner_id" text NOT NULL,
      "featured" boolean NOT NULL DEFAULT false
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_collection_items" (
      "collection_id" text NOT NULL,
      "pet_slug" text NOT NULL,
      "position" integer NOT NULL DEFAULT 0
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "submitted_pets" (
      "slug" text PRIMARY KEY,
      "owner_id" text NOT NULL,
      "status" text NOT NULL
    )
  `);
});

afterAll(async () => {
  await client.close();
});

/** Members `slugs` in the collection, with each pet's approval `statuses`. */
async function seed(
  members: readonly string[],
  statuses: Record<string, string>,
) {
  await db.execute(sql`DELETE FROM "pet_collection_items"`);
  await db.execute(sql`DELETE FROM "pet_collections"`);
  await db.execute(sql`DELETE FROM "submitted_pets"`);
  await db.execute(
    sql`INSERT INTO "pet_collections" ("id", "owner_id", "featured") VALUES (${COLLECTION}, ${OWNER}, false)`,
  );
  for (const slug of members) {
    await db.execute(
      sql`INSERT INTO "pet_collection_items" ("collection_id", "pet_slug", "position") VALUES (${COLLECTION}, ${slug}, 1)`,
    );
  }
  for (const [slug, status] of Object.entries(statuses)) {
    await db.execute(
      sql`INSERT INTO "submitted_pets" ("slug", "owner_id", "status") VALUES (${slug}, ${OWNER}, ${status})`,
    );
  }
}

async function members(): Promise<string[]> {
  const result = await db.execute(
    sql`SELECT "pet_slug" FROM "pet_collection_items" WHERE "collection_id" = ${COLLECTION} ORDER BY "pet_slug"`,
  );
  const rows = (result as { rows?: Array<{ pet_slug?: unknown }> }).rows ?? [];
  return rows.map((row) => String(row.pet_slug));
}

/** Run the replace pair the routes build, inside one transaction. */
async function replace(
  proposed: readonly string[],
  options: { updateParent: boolean },
) {
  await db.transaction(async (tx) => {
    if (options.updateParent) {
      await tx.execute(
        sql`UPDATE "pet_collections" SET "owner_id" = ${OWNER} WHERE "id" = ${COLLECTION}`,
      );
    }
    const deleted = deleteCollectionItemsQuery(COLLECTION, OWNER, proposed, {
      requireSuccessfulParentUpdate: true,
    });
    if (deleted) await tx.execute(deleted as never);
    const inserted = insertCollectionItemsQuery(
      COLLECTION,
      [...proposed],
      OWNER,
      { requireSuccessfulParentUpdate: true },
    );
    if (inserted) await tx.execute(inserted as never);
  });
}

describe("a refused collection write leaves the members alone", () => {
  it("deletes nothing when the parent UPDATE matched no row", async () => {
    // The case the empty-list condition exists for, one level down: the
    // route's pre-lock read saw members, a concurrent writer changed the row,
    // and the UPDATE's WHERE then matched nothing. On Neon HTTP the batch
    // cannot abort part-way, so the DELETE runs unconditionally unless its own
    // guard stops it — and without the parent `xmin` condition it removed every
    // member of a collection the response said it had not modified.
    // The proposed list is a strict subset, which is what makes the assertion
    // able to fail: with the guard, neither statement runs and the stored
    // members stand; without it, the DELETE empties the collection and the
    // INSERT refills it from the proposed list. Passing the full member list
    // here would delete and re-insert the same rows, and the test would pass
    // either way — which is exactly how it read before this was corrected.
    await seed(["a", "b", "c"], {
      a: "approved",
      b: "approved",
      c: "approved",
    });

    await replace(["a"], { updateParent: false });

    expect(await members()).toEqual(["a", "b", "c"]);
  });

  it("deletes nothing when a proposed pet is no longer approved", async () => {
    // Authorization is decided from a read the route takes before the lock, so
    // a pet un-approved in between is the reachable race. The condition travels
    // in the statements themselves, which is what makes the write atomic
    // against it rather than dependent on that read.
    await seed(["a", "b", "c"], {
      a: "approved",
      b: "rejected",
      c: "approved",
    });

    // The proposed list has to *contain* the unapproved pet for this to be
    // able to fail. A list that merely omits it is authorized — the condition
    // judges the list being written, and the replace then legitimately drops
    // what the request left out — so only a proposed list that still includes
    // the unapproved slug distinguishes the guard from its absence. Stored
    // members exceed the proposed set so a write that got through is visible.
    await replace(["a", "b"], { updateParent: true });

    expect(await members()).toEqual(["a", "b", "c"]);
  });

  it("still replaces the members when both guards pass", async () => {
    // Guards against a fix that refuses everything: the ordinary edit must
    // still drop the members the request left out and keep the rest in order.
    await seed(["a", "b", "c"], {
      a: "approved",
      b: "approved",
      c: "approved",
    });

    await replace(["a", "c"], { updateParent: true });

    expect(await members()).toEqual(["a", "c"]);
  });
});
