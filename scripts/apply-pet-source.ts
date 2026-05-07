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
  "create enum pet_source",
  () => sql`CREATE TYPE pet_source AS ENUM ('submit', 'discover', 'claimed')`,
);
await tryRun(
  "submitted_pets.source column",
  () =>
    sql`ALTER TABLE submitted_pets ADD COLUMN source pet_source NOT NULL DEFAULT 'submit'`,
);

// Backfill: rows added on behalf of external authors (owned by the
// admin id, credited elsewhere) get tagged so the UI can mark them
// as not-yet-claimed.
const ADMIN = "user_3DA3wOYrJh1UNufe2pgQpcF6GJ7";
const r = await sql`
  UPDATE submitted_pets
  SET source = 'discover'
  WHERE source = 'submit'
    AND owner_id = ${ADMIN}
    AND credit_url IS NOT NULL
    AND credit_url NOT ILIKE '%/railly%'
    AND created_at > NOW() - INTERVAL '6 hours'
  RETURNING id
`;
console.log(`backfilled ${r.length} rows -> source='discover'`);

console.log("done");
