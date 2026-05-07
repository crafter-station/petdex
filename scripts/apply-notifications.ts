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
  "create enum notification_kind",
  () =>
    sql`CREATE TYPE notification_kind AS ENUM (
    'pet_approved',
    'pet_rejected',
    'edit_approved',
    'edit_rejected',
    'feedback_replied'
  )`,
);

await tryRun(
  "create table notifications",
  () =>
    sql`
    CREATE TABLE notifications (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      kind notification_kind NOT NULL,
      payload jsonb NOT NULL,
      href text NOT NULL,
      read_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `,
);

await tryRun(
  "idx notifications_user_created_idx",
  () =>
    sql`CREATE INDEX notifications_user_created_idx ON notifications(user_id, created_at)`,
);
await tryRun(
  "idx notifications_user_unread_idx",
  () =>
    sql`CREATE INDEX notifications_user_unread_idx ON notifications(user_id, read_at)`,
);

console.log("done");
