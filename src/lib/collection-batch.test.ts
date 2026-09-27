import { describe, expect, it, mock } from "bun:test";

import { sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { PgDialect } from "drizzle-orm/pg-core";

import * as schema from "@/lib/db/schema";

// The Neon HTTP path is the only one that calls db.batch, and it is the path
// the collection mutations were designed around: batch() has no interactive
// transaction, so the advisory locks and the xmin guard have to do the work a
// transaction would. These tests drive runCollectionMutation and
// createOwnerCollection through that path with a fake runner, so the result
// slicing that decides which statement's rows get parsed actually executes
// instead of only being string-compared.
const dialect = new PgDialect();

let submittedSql: string[] = [];
let submittedParams: unknown[][] = [];

/** Rows the fake runner returns for the statement that matches `marker`. */
let rowsForMarker: { marker: string; rows: unknown[] } | null = null;

// db.execute(sqlObject) is what the lock statements go through; the mocked
// driver returns a carrier object so the batch runner can still see the SQL.
type SqlCarrier = { __sql: unknown };

function queryText(item: unknown): string {
  const target = (item as SqlCarrier).__sql ?? item;
  return dialect.sqlToQuery(target as never).sql;
}

mock.module("server-only", () => ({}));
mock.module("@/lib/db/client", () => {
  const db = {
    execute: (query: unknown): SqlCarrier => ({ __sql: query }),
    batch: async (queries: readonly unknown[]) => {
      submittedSql = queries.map((query) => queryText(query));
      submittedParams = queries.map(
        (query) =>
          dialect.sqlToQuery((query as SqlCarrier).__sql ?? (query as never))
            .params,
      );
      // Tag every result with its submission index so a test can prove which
      // rows the production slicing actually handed to parseBatch. Without
      // this, a slice that returns the lock rows parses to the same length and
      // the assertion cannot tell the difference.
      return queries.map((query, index) => {
        const text = queryText(query);
        if (rowsForMarker && text.includes(rowsForMarker.marker)) {
          return { rows: rowsForMarker.rows, batchIndex: index };
        }
        return { rows: [], batchIndex: index };
      });
    },
    transaction: async () => {
      throw new Error("the batch path must not open a transaction");
    },
  };
  // mock.module is process-wide for the whole run: every suite that imports
  // @/lib/db/client resolves this factory's exports, and one that links a
  // missing name fails with a SyntaxError. Export the real schema so an
  // unrelated DB-backed suite still sees real tables.
  return { db, schema };
});

const {
  createOrReuseOwnerCollection,
  createOwnerCollection,
  runCollectionMutation,
} = await import("@/lib/collection-access");

// A real SQL object so the driver can render it, tagged so the fake runner
// can tell build results apart from lock statements.
function markerQuery(tag: string): BatchItem<"pg"> {
  return sql`SELECT '${sql.raw(tag)}' AS "build_marker"` as unknown as BatchItem<"pg">;
}

describe("runCollectionMutation batch result slicing", () => {
  const cases: Array<{
    name: string;
    petMutation?: { ownerId: string; petSlugs: string[] };
    lockExistingPetSlugs?: boolean;
    expectedLeadingStatements: number;
  }> = [
    {
      name: "collection lock only",
      expectedLeadingStatements: 1,
    },
    {
      name: "existing slug lock plus collection lock",
      lockExistingPetSlugs: true,
      expectedLeadingStatements: 2,
    },
    {
      name: "slug lock, collection lock and approved pet lock",
      petMutation: { ownerId: "u1", petSlugs: ["boba"] },
      expectedLeadingStatements: 3,
    },
    {
      name: "pet mutation plus existing slug lock",
      petMutation: { ownerId: "u1", petSlugs: ["boba"] },
      lockExistingPetSlugs: true,
      expectedLeadingStatements: 3,
    },
  ];

  for (const testCase of cases) {
    it(`parses only the build results: ${testCase.name}`, async () => {
      const built = [markerQuery("a"), markerQuery("b")];
      let parsed: unknown[] = [];

      await runCollectionMutation({
        collectionId: "col_1",
        ...(testCase.petMutation ? { petMutation: testCase.petMutation } : {}),
        ...(testCase.lockExistingPetSlugs
          ? { lockExistingPetSlugs: true }
          : {}),
        buildBatch: () => built,
        runTransaction: async () => {
          throw new Error("the batch path must not use the transaction branch");
        },
        parseBatch: (results) => {
          parsed = [...results];
          return null;
        },
      });

      expect(parsed).toHaveLength(built.length);
      expect(submittedSql).toHaveLength(
        testCase.expectedLeadingStatements + built.length,
      );
      // The parsed rows must be the trailing build statements, not the leading
      // locks. Their batchIndex is the position they were submitted at.
      expect(
        (parsed as Array<{ batchIndex: number }>).map((r) => r.batchIndex),
      ).toEqual([
        testCase.expectedLeadingStatements,
        testCase.expectedLeadingStatements + 1,
      ]);
      // Every statement before the build results is a lock acquisition:
      // advisory locks for the collection and pet slugs, and a FOR SHARE row
      // lock on the approved pet rows.
      for (const statement of submittedSql.slice(
        0,
        testCase.expectedLeadingStatements,
      )) {
        expect(
          statement.includes("pg_advisory_xact_lock") ||
            statement.includes("FOR SHARE"),
        ).toBe(true);
      }
    });
  }

  it("still locks current members when the mutation carries no pet slugs", async () => {
    await runCollectionMutation({
      collectionId: "col_1",
      petMutation: { ownerId: "u1", petSlugs: [] },
      buildBatch: () => [markerQuery("only")],
      runTransaction: async () => {
        throw new Error("the batch path must not use the transaction branch");
      },
      parseBatch: () => null,
    });

    // An empty pet list skips the approved-pet row lock, but the slug lock
    // still runs because it also covers the collection's current members and
    // cover pet, which a replacement is about to touch.
    expect(submittedSql).toHaveLength(3);
    expect(
      submittedSql.some((statement) => statement.includes("FOR SHARE")),
    ).toBe(false);
    const slugLock = submittedSql[0];
    expect(slugLock).toContain("pg_advisory_xact_lock");
    expect(slugLock).toContain("pet_collection_items");
  });
});

describe("createOwnerCollection batch state", () => {
  const baseInput = {
    id: "col_1",
    slug: "boba",
    title: "My pets",
    description: "",
    ownerId: "u1",
    externalUrl: null,
    coverPetSlug: "boba",
    petSlugs: ["boba"],
  };

  function setCreateState(state: Record<string, unknown>) {
    // The state select is the statement that projects `under_cap`.
    rowsForMarker = { marker: 'AS "under_cap"', rows: [state] };
  }

  it("reports created and keeps the requested slug when the insert landed", async () => {
    setCreateState({ created: true, under_cap: true, pets_valid: true });

    const result = await createOwnerCollection(baseInput);

    expect(result).toEqual({ status: "created", slug: "boba" });
  });

  it("reports the owner cap when the insert was skipped at the cap", async () => {
    setCreateState({ created: false, under_cap: false, pets_valid: true });

    const result = await createOwnerCollection(baseInput);

    expect(result).toEqual({ status: "cap" });
  });

  it("reports unapproved pets ahead of the cap", async () => {
    setCreateState({ created: false, under_cap: true, pets_valid: false });

    const result = await createOwnerCollection(baseInput);

    expect(result).toEqual({ status: "pets_not_owned_or_approved" });
  });

  it("retries with a suffixed slug when the first slug was taken", async () => {
    // The state select reports "not created, still under cap", which is the
    // slug-conflict signal the caller retries on.
    setCreateState({ created: false, under_cap: true, pets_valid: true });

    const result = await createOwnerCollection(baseInput);

    expect(result.status).toBe("slug_conflict");
    // Every retry reuses the base slug with a random suffix and its attempt
    // number, so the last attempt carries "boba-<random>-<n>" for n > 0.
    expect(
      submittedParams.some((params) =>
        params.some(
          (value) =>
            typeof value === "string" &&
            /^boba-[0-9a-f]{32}-[1-9]\d*$/.test(value),
        ),
      ),
    ).toBe(true);
  });

  it("guards the item insert on the parent row created by this transaction", async () => {
    setCreateState({ created: true, under_cap: true, pets_valid: true });

    await createOwnerCollection(baseInput);

    const itemInsert = submittedSql.find((sql) =>
      sql.includes('INSERT INTO "pet_collection_items"'),
    );
    expect(itemInsert).toBeDefined();
    expect(itemInsert).toContain("pg_current_xact_id()");
  });
});

describe("createOrReuseOwnerCollection batch state", () => {
  const baseInput = {
    id: "col_1",
    slug: "boba",
    title: "My pets",
    description: "",
    ownerId: "u1",
    externalUrl: null,
    coverPetSlug: "boba",
    petSlugs: ["boba"],
  };

  function setReuseState(state: Record<string, unknown>) {
    // The reuse state select projects the status literal.
    rowsForMarker = { marker: 'AS "status"', rows: [state] };
  }

  it("reports created when the first-use insert landed", async () => {
    setReuseState({ status: "created", id: "col_1", slug: "boba" });

    await expect(createOrReuseOwnerCollection(baseInput)).resolves.toEqual({
      status: "created",
      id: "col_1",
      slug: "boba",
    });
  });

  it("reports the existing collection instead of creating a second one", async () => {
    setReuseState({ status: "existing", id: "col_old", slug: "older" });

    await expect(createOrReuseOwnerCollection(baseInput)).resolves.toEqual({
      status: "existing",
      id: "col_old",
      slug: "older",
    });
  });

  it("reports unapproved pets from the state row", async () => {
    setReuseState({
      status: "pets_not_owned_or_approved",
      id: null,
      slug: null,
    });

    await expect(createOrReuseOwnerCollection(baseInput)).resolves.toEqual({
      status: "pets_not_owned_or_approved",
    });
  });

  it("rejects an unknown state row rather than guessing", async () => {
    setReuseState({ status: "something_new", id: null, slug: null });

    await expect(createOrReuseOwnerCollection(baseInput)).rejects.toThrow(
      "collection_create_state_invalid",
    );
  });

  it("guards the first-use item insert on the parent row", async () => {
    setReuseState({ status: "created", id: "col_1", slug: "boba" });

    await createOrReuseOwnerCollection(baseInput);

    const itemInsert = submittedSql.find((sql) =>
      sql.includes('INSERT INTO "pet_collection_items"'),
    );
    expect(itemInsert).toBeDefined();
    expect(itemInsert).toContain("pg_current_xact_id()");
  });
});
