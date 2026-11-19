import { describe, expect, it } from "bun:test";

import type { SQLWrapper } from "drizzle-orm";

import { rowsOf, runAtomicReturning } from "./atomic";

/** A statement whose only job is to be recognisable in the call log. */
function statement(name: string): SQLWrapper {
  return { getSQL: () => name } as unknown as SQLWrapper;
}

function recordingClient(hasBatch: boolean) {
  const calls: string[] = [];
  const client = {
    // `runAtomicReturning` hands these the output of `getSQL()`, so the fake records
    // the compiled statement the way a driver would receive it.
    execute: (compiled: unknown) => {
      calls.push(`execute:${String(compiled)}`);
      return { compiled };
    },
    transaction: async <T>(
      fn: (tx: { execute: (query: unknown) => unknown }) => Promise<T>,
    ) => {
      calls.push("transaction:begin");
      const result = await fn({
        execute: (compiled: unknown) => {
          calls.push(`tx.execute:${String(compiled)}`);
          return { compiled };
        },
      });
      calls.push("transaction:end");
      return result;
    },
  };
  return hasBatch
    ? {
        client: {
          ...client,
          batch: async (queries: unknown[]) => {
            calls.push(`batch:${queries.length}`);
            return [];
          },
        },
        calls,
      }
    : { client, calls };
}

describe("runAtomicReturning driver branches", () => {
  it("uses the batch endpoint when the driver has one", async () => {
    // Neon's HTTP driver is the deployed one, and it throws on the callback
    // form, so this branch is what keeps writes working in production.
    const { client, calls } = recordingClient(true);

    await runAtomicReturning(client, [
      statement("insert-request"),
      statement("vote"),
    ]);

    expect(calls).toEqual([
      "execute:insert-request",
      "execute:vote",
      "batch:2",
    ]);
  });

  it("falls back to a callback transaction without one", async () => {
    const { client, calls } = recordingClient(false);

    await runAtomicReturning(client, [
      statement("insert-request"),
      statement("vote"),
    ]);

    expect(calls).toEqual([
      "transaction:begin",
      "tx.execute:insert-request",
      "tx.execute:vote",
      "transaction:end",
    ]);
  });

  it("propagates a failing statement so the caller sees the write fail", async () => {
    const { client } = recordingClient(false);
    const failing = {
      ...client,
      transaction: async <T>(
        fn: (tx: { execute: (query: unknown) => unknown }) => Promise<T>,
      ) =>
        fn({
          execute: () => {
            throw new Error("vote insert rejected");
          },
        }),
    };

    expect(
      runAtomicReturning(failing, [
        statement("insert-request"),
        statement("vote"),
      ]),
    ).rejects.toThrow("vote insert rejected");
  });
});

describe("runAtomicReturning", () => {
  it("returns each statement's rows in order", async () => {
    // The statements have to stay separate: every CTE in one statement shares
    // the snapshot taken when it began, so a read that follows a lock wait
    // would still miss the row the lock was protecting. Returning per
    // statement is what lets the caller read the INSERT's own result.
    const seen: string[] = [];
    // No `batch`, so this takes the callback-transaction path — the one
    // PGlite and postgres-js take. The recording lives there because that is
    // where the statements actually run.
    const client = {
      execute: () => ({ rows: [] }),
      transaction: async <T>(
        fn: (tx: { execute: (query: unknown) => unknown }) => Promise<T>,
      ) =>
        fn({
          execute: (compiled: unknown) => {
            seen.push(String(compiled));
            return { rows: [{ n: seen.length }] };
          },
        }),
    };

    const results = await runAtomicReturning(client, [
      statement("lock"),
      statement("insert"),
    ]);

    expect(seen).toEqual(["lock", "insert"]);
    expect(results.length).toBe(2);
    expect(rowsOf(results[1])).toEqual([{ n: 2 }]);
  });

  it("reads rows from either driver's result shape", () => {
    // `{ rows }` is what all three drivers produce once `client.ts` has
    // normalised postgres-js; the bare array is the pre-normalisation shape a
    // client built by a test can still hand over.
    expect(rowsOf({ rows: [{ id: "a" }] })).toEqual([{ id: "a" }]);
    expect(rowsOf([{ id: "a" }])).toEqual([{ id: "a" }]);
    // Anything else is no rows rather than a throw, so a driver that reports
    // an empty result in some other shape cannot take the caller down.
    expect(rowsOf(undefined)).toEqual([]);
    expect(rowsOf(null)).toEqual([]);
    expect(rowsOf({ rowCount: 0 })).toEqual([]);
  });
});
