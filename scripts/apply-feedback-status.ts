import { neon } from "@neondatabase/serverless";

import { requiredEnv } from "./env";

const sql = neon(requiredEnv("DATABASE_URL"));

async function tryRun(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.log(`ok  ${label}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/already exists/i.test(msg) || /duplicate column/i.test(msg)) {
      console.log(`skip ${label} (already exists)`);
    } else {
      throw err;
    }
  }
}

await tryRun(
  "create enum feedback_status",
  () =>
    sql`CREATE TYPE feedback_status AS ENUM ('pending', 'addressed', 'archived')`,
);
await tryRun(
  "add column status",
  () =>
    sql`ALTER TABLE feedback ADD COLUMN status feedback_status NOT NULL DEFAULT 'pending'`,
);
await tryRun(
  "add column addressed_at",
  () => sql`ALTER TABLE feedback ADD COLUMN addressed_at timestamptz`,
);
await tryRun(
  "add column archived_at",
  () => sql`ALTER TABLE feedback ADD COLUMN archived_at timestamptz`,
);
await tryRun(
  "add column admin_note",
  () => sql`ALTER TABLE feedback ADD COLUMN admin_note text`,
);
await tryRun(
  "create index feedback_status_idx",
  () => sql`CREATE INDEX feedback_status_idx ON feedback(status)`,
);

console.log("done");
