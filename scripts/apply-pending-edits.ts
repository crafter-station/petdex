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
  "submitted_pets.pending_display_name",
  () => sql`ALTER TABLE submitted_pets ADD COLUMN pending_display_name text`,
);
await tryRun(
  "submitted_pets.pending_description",
  () => sql`ALTER TABLE submitted_pets ADD COLUMN pending_description text`,
);
await tryRun(
  "submitted_pets.pending_tags",
  () => sql`ALTER TABLE submitted_pets ADD COLUMN pending_tags jsonb`,
);
await tryRun(
  "submitted_pets.pending_submitted_at",
  () =>
    sql`ALTER TABLE submitted_pets ADD COLUMN pending_submitted_at timestamptz`,
);
await tryRun(
  "submitted_pets.pending_rejection_reason",
  () =>
    sql`ALTER TABLE submitted_pets ADD COLUMN pending_rejection_reason text`,
);
await tryRun(
  "idx submitted_pets_pending_edit_idx",
  () =>
    sql`CREATE INDEX submitted_pets_pending_edit_idx ON submitted_pets(pending_submitted_at)`,
);

console.log("done");
