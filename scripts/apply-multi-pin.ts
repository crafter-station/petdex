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
      /does not exist/i.test(msg)
    ) {
      console.log(`skip ${label} (${msg.split("\n")[0]})`);
    } else {
      throw err;
    }
  }
}

await tryRun(
  "add featured_pet_slugs column",
  () =>
    sql`ALTER TABLE user_profiles ADD COLUMN featured_pet_slugs jsonb NOT NULL DEFAULT '[]'::jsonb`,
);

// Backfill: any row with a non-null featured_pet_slug becomes a single-
// element array in the new column. Safe to run multiple times — uses
// jsonb_array_length to detect already-migrated rows.
await tryRun("backfill from featured_pet_slug", async () => {
  await sql`
    UPDATE user_profiles
    SET featured_pet_slugs = jsonb_build_array(featured_pet_slug)
    WHERE featured_pet_slug IS NOT NULL
      AND jsonb_array_length(featured_pet_slugs) = 0
  `;
});

await tryRun(
  "drop legacy featured_pet_slug column",
  () => sql`ALTER TABLE user_profiles DROP COLUMN featured_pet_slug`,
);

console.log("done");
