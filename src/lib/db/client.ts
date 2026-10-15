// Server-only Drizzle client. Importing this from a client component
// will throw a build-time error (via the `server-only` package) which
// is far easier to debug than a runtime "DATABASE_URL is not set" in
// the browser console.
import "server-only";

import { neon } from "@neondatabase/serverless";
import type { SQLWrapper } from "drizzle-orm";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { IS_MOCK } from "../mock";
import { getMockDb, mockDbReady } from "../mock/db";
import { runAtomicReturning } from "./atomic";
import * as schema from "./schema";
import { isLocalDatabaseUrl } from "./url-classification";

type DrizzleDb = ReturnType<typeof drizzleNeon<typeof schema>>;

function buildClient(): DrizzleDb {
  if (IS_MOCK) {
    return getMockDb().db as unknown as DrizzleDb;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }
  // Local Postgres (docker compose) cannot speak the Neon serverless
  // websocket protocol. Detect localhost URLs and switch to the
  // postgres-js driver so `bun run dev:docker` Just Works against the
  // container stack.
  if (isLocalDatabaseUrl(process.env.DATABASE_URL)) {
    const sql = postgres(process.env.DATABASE_URL, { max: 5 });
    const inner = drizzlePostgres(sql, { schema });
    // postgres-js returns the row array directly from .execute(); the
    // neon-http driver wraps it as `{ rows: [...] }`. The rest of the
    // codebase reads `result.rows`, so normalize the shape here so we
    // don't have to touch every callsite.
    const target = inner as unknown as {
      execute: (...args: unknown[]) => Promise<unknown>;
    };
    const originalExecute = target.execute.bind(target);
    target.execute = async (...args: unknown[]) => {
      const out = await originalExecute(...args);
      if (Array.isArray(out)) {
        return { rows: out, rowCount: out.length };
      }
      return out;
    };
    return inner as unknown as DrizzleDb;
  }
  const sql = neon(process.env.DATABASE_URL);
  return drizzleNeon(sql, { schema });
}

// Block on PGlite bootstrap+seed at module load time so any page
// running queries on first render finds the schema in place. In
// production this is a no-op.
if (IS_MOCK) {
  await mockDbReady();
}

export const db = buildClient();

export { rowsOf } from "./atomic";
export { schema };

/**
 * One transaction, statements kept separate, every statement's rows returned
 * in order. The separate statements matter: see `runAtomicReturning`.
 */
export async function executeAtomicReturning(
  queries: [SQLWrapper, ...SQLWrapper[]],
): Promise<readonly unknown[]> {
  return runAtomicReturning(db, queries);
}
