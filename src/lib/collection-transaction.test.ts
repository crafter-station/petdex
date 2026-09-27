import { describe, expect, it, mock } from "bun:test";

import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import * as schema from "@/lib/db/schema";

// The postgres-js driver has no db.batch, so every local-Postgres and
// docker-compose deployment takes runCollectionMutation's db.transaction
// branch. The batch branch is covered in collection-batch.test.ts; this file
// covers the branch developers actually run locally.
const dialect = new PgDialect();

let txStatements: string[] = [];

type SqlCarrier = { __sql: unknown };

function queryText(item: unknown): string {
  const target = (item as SqlCarrier).__sql ?? item;
  return dialect.sqlToQuery(target as never).sql;
}

mock.module("server-only", () => ({}));
mock.module("@/lib/db/client", () => {
  const tx = {
    execute: async (query: unknown) => {
      txStatements.push(queryText(query));
      return { rows: [] };
    },
  };
  const db = {
    // No batch: this is the postgres-js shape, which forces the transaction
    // branch.
    execute: async (query: unknown) => {
      const text = queryText(query);
      txStatements.push(text);
      return { rows: [] };
    },
    transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => {
      txStatements = [];
      return fn(tx);
    },
  };
  return { db, schema };
});

const { runCollectionMutation } = await import("@/lib/collection-access");

describe("runCollectionMutation transaction branch", () => {
  const cases: Array<{
    name: string;
    petMutation?: { ownerId: string; petSlugs: string[] };
    lockExistingPetSlugs?: boolean;
    expectSlugLock: boolean;
    expectPetRowLock: boolean;
  }> = [
    {
      name: "collection lock only",
      expectSlugLock: false,
      expectPetRowLock: false,
    },
    {
      name: "existing slug lock plus collection lock",
      lockExistingPetSlugs: true,
      expectSlugLock: true,
      expectPetRowLock: false,
    },
    {
      name: "slug lock, collection lock and approved pet row lock",
      petMutation: { ownerId: "u1", petSlugs: ["boba"] },
      expectSlugLock: true,
      expectPetRowLock: true,
    },
  ];

  for (const testCase of cases) {
    it(`takes the locks in order: ${testCase.name}`, async () => {
      await runCollectionMutation({
        collectionId: "col_1",
        ...(testCase.petMutation ? { petMutation: testCase.petMutation } : {}),
        ...(testCase.lockExistingPetSlugs
          ? { lockExistingPetSlugs: true }
          : {}),
        buildBatch: () => [],
        runTransaction: async (tx) => {
          // The caller's body runs inside the same transaction, after every lock
          // has been taken. It has to write through `tx` for the ordering claim
          // below to be testable at all: with an empty body, txStatements holds
          // only locks, so "the first statement is a lock" is true by
          // construction and would hold for any lock order.
          await tx.execute(
            sql`SELECT 'build-body' AS "run_transaction_marker"`,
          );
          return null;
        },
        parseBatch: () => null,
      });

      const advisoryLocks = txStatements.filter((s) =>
        s.includes("pg_advisory_xact_lock"),
      );
      const rowLocks = txStatements.filter((s) => s.includes("FOR SHARE"));
      const bodyIndex = txStatements.findIndex((s) =>
        s.includes("run_transaction_marker"),
      );

      // The collection lock is always taken.
      expect(advisoryLocks.length).toBeGreaterThanOrEqual(1);

      expect(
        advisoryLocks.some((s) => s.includes("pet_collection_items")),
      ).toBe(testCase.expectSlugLock);
      expect(rowLocks.length > 0).toBe(testCase.expectPetRowLock);

      // Every lock precedes the caller's body, and the body is reached.
      expect(bodyIndex).toBeGreaterThan(0);
      for (const lock of [...advisoryLocks, ...rowLocks]) {
        expect(txStatements.indexOf(lock)).toBeLessThan(bodyIndex);
      }
      // The declared order is: pet-slug lock, then collection lock, then the
      // approved-pet row lock. That exact order is what keeps a collection
      // mutation and a takedown — which takes the slug lock before the
      // collections that reference that slug — from acquiring the same two
      // locks in opposite directions. Pinning the sequence, not just "a lock
      // came first", is what makes a reordering fail here.
      // collectionMutationLock hashes the id it was handed and selects nothing;
      // the pet-slug lock selects the ids to lock and so has a FROM clause.
      const order = txStatements.map((s) =>
        s.includes("pg_advisory_xact_lock")
          ? s.includes("FROM")
            ? "slug-lock"
            : "collection-lock"
          : s.includes("FOR SHARE")
            ? "pet-row-lock"
            : "body",
      );
      expect(order).toEqual([
        ...(testCase.expectSlugLock ? ["slug-lock"] : []),
        "collection-lock",
        ...(testCase.expectPetRowLock ? ["pet-row-lock"] : []),
        "body",
      ]);
    });
  }

  it("runs the caller's transaction body and returns its result", async () => {
    const result = await runCollectionMutation({
      collectionId: "col_1",
      buildBatch: () => [],
      runTransaction: async () => "from-transaction",
      parseBatch: () => "from-batch",
    });

    expect(result).toBe("from-transaction");
  });
});
