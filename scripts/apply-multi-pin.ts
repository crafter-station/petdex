import { neon } from "@neondatabase/serverless";

import { requiredEnv } from "./env";

// This script's whole body writes: the add-column and backfill are
// irreversible-ish DDL + a table-wide UPDATE, and the legacy drop is the
// only step that is destructive in the git-history sense. The original
// header claimed "dry by default" but gated only the drop — running it to
// *look* at the plan silently added the column and rewrote every profile
// row. Everything now sits behind --apply, like the other maintenance
// scripts on this branch.
const apply = process.argv.includes("--apply");

const sql = neon(requiredEnv("DATABASE_URL"));

if (!apply) {
  console.log(
    "(dry run) no changes written — this script would add\n" +
      "  user_profiles.featured_pet_slugs, backfill it from\n" +
      "  featured_pet_slug, and (with --apply) drop the legacy column.\n" +
      "Pass --apply to execute.",
  );
  process.exit(0);
}

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

if (!apply) {
  console.log(
    "\n(pass --apply to drop the legacy featured_pet_slug column. " +
      "Dropping it is irreversible.)",
  );
} else {
  await tryRun(
    "drop legacy featured_pet_slug column",
    () => sql`ALTER TABLE user_profiles DROP COLUMN featured_pet_slug`,
  );
}

console.log("done");
