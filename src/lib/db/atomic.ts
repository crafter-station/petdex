import type { SQLWrapper } from "drizzle-orm";

/**
 * The slice of a drizzle pg client `runAtomicReturning` needs.
 *
 * Structural rather than `typeof db` so the driver branches can be exercised
 * without a configured database: the module that owns the real client is the
 * one module a test cannot import.
 */
export type AtomicClient = {
  execute: (query: SQLWrapper) => unknown;
  transaction: <T>(
    fn: (tx: { execute: (query: SQLWrapper) => unknown }) => Promise<T>,
  ) => Promise<T>;
};

/**
 * The batch entry point, read structurally rather than declared on
 * `AtomicClient`.
 *
 * The real drivers type it as a variadic tuple of `BatchItem<"pg">` returning
 * a tuple typed per entry, and `AtomicClient` cannot both describe that and
 * stay assignable from the client — the parameter would be contravariant and
 * no narrower type fits. Only `execute`'s output is ever passed here and the
 * result is discarded, so the call is made through this shape instead.
 */
type BatchCapable = {
  batch: (queries: unknown[]) => Promise<readonly unknown[]>;
};

/**
 * Runs every statement in one transaction and returns each statement's rows.
 *
 * Production reaches Neon over HTTP, and that driver throws "No transactions
 * support in neon-http driver" for the callback form — so code that reaches
 * straight for `db.transaction` answers 500 to every write on the deployed
 * app while passing against PGlite locally. Neon's batch endpoint executes the
 * same statements inside one database transaction, so it is the supported
 * equivalent. `db.batch` is absent on the postgres-js and PGlite clients, so
 * those keep the callback transaction they can actually run.
 *
 * The statements have to stay separate rather than being folded into a single
 * CTE. Every CTE in one statement shares the snapshot taken when that
 * statement began, so a statement that waits on a lock and then reads still
 * sees the pre-lock snapshot — measured on Postgres: two sessions serialized
 * by the same advisory lock both failed to observe each other's committed row
 * and both inserted. As separate statements inside one transaction each read
 * gets a fresh snapshot under READ COMMITTED, which is what closes the race.
 *
 * `execute` results are returned in statement order, in whatever shape the
 * driver produced. Neon HTTP and PGlite wrap their rows in a `{ rows }` result
 * object. postgres-js returns a **bare row array**, and it does so on both
 * paths: `client.ts` normalises the shape only on the top-level instance, and
 * the `tx` inside `db.transaction` is a separate object whose `execute` is
 * unpatched — measured on the docker Postgres (`dev:docker`), every result
 * came back as a bare array. So callers must go through `rowsOf` rather than
 * reading `.rows`, which would be `undefined` on that driver.
 */
export async function runAtomicReturning(
  client: AtomicClient,
  queries: readonly [SQLWrapper, ...SQLWrapper[]],
): Promise<readonly unknown[]> {
  const batch = (client as Partial<BatchCapable>).batch;
  if (typeof batch === "function") {
    return batch.call(
      client,
      queries.map((query) => client.execute(query.getSQL())),
    );
  }
  return client.transaction(async (tx) => {
    const results: unknown[] = [];
    for (const query of queries) results.push(await tx.execute(query.getSQL()));
    return results;
  });
}

/**
 * The rows of one statement's result, whatever shape it arrived in.
 *
 * Neon HTTP and PGlite wrap their rows as `{ rows }`. postgres-js hands back a
 * bare row array, and it does so even on the callback-transaction path that
 * `runAtomicReturning` uses for that driver: `client.ts` normalises the shape
 * only on the top-level client, and the `tx` inside `db.transaction` is a
 * separate object whose `execute` is unpatched — measured on the docker
 * Postgres, every result came back as a bare array. So both branches below are
 * live code, not a defensive fallback: the array branch is what the local
 * postgres-js driver actually produces. Callers must go through this rather
 * than reading `.rows`, which would be `undefined` on that driver.
 */
export function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result !== null && typeof result === "object") {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows;
  }
  return [];
}
