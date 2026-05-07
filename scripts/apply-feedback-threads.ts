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
  "feedback.notify_email column",
  () =>
    sql`ALTER TABLE feedback ADD COLUMN notify_email boolean NOT NULL DEFAULT true`,
);
await tryRun(
  "feedback.user_last_read_at column",
  () => sql`ALTER TABLE feedback ADD COLUMN user_last_read_at timestamptz`,
);
await tryRun(
  "feedback.admin_last_read_at column",
  () => sql`ALTER TABLE feedback ADD COLUMN admin_last_read_at timestamptz`,
);

await tryRun(
  "create enum feedback_author_kind",
  () => sql`CREATE TYPE feedback_author_kind AS ENUM ('admin', 'user')`,
);

await tryRun(
  "create table feedback_replies",
  () =>
    sql`
    CREATE TABLE feedback_replies (
      id text PRIMARY KEY,
      feedback_id text NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
      author_kind feedback_author_kind NOT NULL,
      author_user_id text,
      body text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `,
);

await tryRun(
  "idx feedback_replies_feedback_idx",
  () =>
    sql`CREATE INDEX feedback_replies_feedback_idx ON feedback_replies(feedback_id)`,
);
await tryRun(
  "idx feedback_replies_created_at_idx",
  () =>
    sql`CREATE INDEX feedback_replies_created_at_idx ON feedback_replies(created_at)`,
);

console.log("done");
