import { neon } from "@neondatabase/serverless";

import { requiredEnv } from "./env";

const sql = neon(requiredEnv("DATABASE_URL"));

async function tryRun(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.log(`ok   ${label}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      /already exists/i.test(msg) ||
      /duplicate column/i.test(msg) ||
      /duplicate object/i.test(msg)
    ) {
      console.log(`skip ${label} (already exists)`);
    } else {
      throw err;
    }
  }
}

await tryRun(
  "create table manifest_fetches",
  () =>
    sql`
    CREATE TABLE manifest_fetches (
      id text PRIMARY KEY,
      ip_hash text NOT NULL,
      user_agent text,
      country text,
      region text,
      referer text,
      variant text NOT NULL DEFAULT 'slim',
      fetched_at timestamptz NOT NULL DEFAULT now()
    )
  `,
);

await tryRun(
  "idx manifest_fetches_fetched_at_idx",
  () =>
    sql`CREATE INDEX manifest_fetches_fetched_at_idx ON manifest_fetches(fetched_at)`,
);
await tryRun(
  "idx manifest_fetches_ip_hash_idx",
  () =>
    sql`CREATE INDEX manifest_fetches_ip_hash_idx ON manifest_fetches(ip_hash)`,
);

console.log("done");
