// Idempotent migration: pet_request_candidates table.
//
// Run with: bun scripts/apply-pet-request-candidates.ts
//
// Loads .env.local automatically. Safe to re-run.

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
  "create table pet_request_candidates",
  () =>
    sql`
    CREATE TABLE pet_request_candidates (
      pet_id text NOT NULL,
      request_id text NOT NULL,
      similarity real,
      source text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      rejection_reason text,
      suggested_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz,
      resolved_by text,
      PRIMARY KEY (pet_id, request_id)
    )
  `,
);

await tryRun(
  "index pet_request_candidates_request_status_idx",
  () =>
    sql`
    CREATE INDEX pet_request_candidates_request_status_idx
    ON pet_request_candidates (request_id, status)
  `,
);

await tryRun(
  "index pet_request_candidates_status_suggested_idx",
  () =>
    sql`
    CREATE INDEX pet_request_candidates_status_suggested_idx
    ON pet_request_candidates (status, suggested_at DESC)
  `,
);

await tryRun(
  "index pet_request_candidates_pet_idx",
  () =>
    sql`
    CREATE INDEX pet_request_candidates_pet_idx
    ON pet_request_candidates (pet_id)
  `,
);

console.log("\ndone.");
