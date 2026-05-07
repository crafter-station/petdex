import { neon } from "@neondatabase/serverless";

import { requiredEnv } from "./env";

const sql = neon(requiredEnv("DATABASE_URL"));

async function tryRun(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.log(`ok   ${label}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/already exists/i.test(msg)) {
      console.log(`skip ${label} (already exists)`);
    } else {
      throw err;
    }
  }
}

await tryRun(
  "add request_fulfilled to notification_kind",
  () =>
    sql`ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'request_fulfilled'`,
);

console.log("done");
