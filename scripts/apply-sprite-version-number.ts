// Adds the persisted sprite atlas contract version used by Gallery,
// manifests and downstream consumers. Idempotent.
//
// Run:
//   bun --env-file .env.local scripts/apply-sprite-version-number.ts

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
  "submitted_pets.sprite_version_number column",
  () => sql`
    ALTER TABLE submitted_pets
    ADD COLUMN sprite_version_number integer NOT NULL DEFAULT 1
  `,
);

await tryRun(
  "submitted_pets.pending_sprite_version_number column",
  () => sql`
    ALTER TABLE submitted_pets
    ADD COLUMN pending_sprite_version_number integer
  `,
);

await tryRun(
  "submitted_pets_sprite_version_number_check",
  () => sql`
    ALTER TABLE submitted_pets
    ADD CONSTRAINT submitted_pets_sprite_version_number_check
    CHECK (sprite_version_number IN (1, 2))
  `,
);

await tryRun(
  "submitted_pets_pending_sprite_version_number_check",
  () => sql`
    ALTER TABLE submitted_pets
    ADD CONSTRAINT submitted_pets_pending_sprite_version_number_check
    CHECK (
      pending_sprite_version_number IS NULL
      OR pending_sprite_version_number IN (1, 2)
    )
  `,
);

await tryRun(
  "submitted_pets_status_sprite_version_idx",
  () => sql`
    CREATE INDEX submitted_pets_status_sprite_version_idx
    ON submitted_pets (status, sprite_version_number)
  `,
);

console.log("done");
