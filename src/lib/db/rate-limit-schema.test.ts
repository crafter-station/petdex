import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `drizzle-kit push` is this repo's only automated schema path — it reconciles
// the database against `src/lib/db/schema.ts`, not against the `drizzle/*.sql`
// history. A table that exists only as a migration file is therefore invisible
// to it, and `push --force` prompts to drop it as an unrecognized relation.
//
// That is what happened to `crafter_rate_limits`, which #759 shipped as
// `drizzle/0021_crafter_rate_limits.sql` (with a journal entry but no
// snapshot). The table was absent from the local stack, and since the
// Neon-backed limiters fail open, all 13 of them silently allowed every
// request while logging a NeonDbError per call.
//
// This guard reads both sides so the two cannot drift again: the table the
// rate limiters write to has to be declared in schema.ts.
const SRC = join(import.meta.dir, "..");
const REPO_ROOT = join(SRC, "..", "..");

describe("rate limit storage is in the schema", () => {
  const schemaSource = readFileSync(join(import.meta.dir, "schema.ts"), "utf8");

  /** The `crafterRateLimits` declaration, up to the next top-level export. */
  function rateLimitsBlock(): string {
    const start = schemaSource.indexOf('"crafter_rate_limits"');
    expect(
      start,
      "src/lib/db/schema.ts must declare crafter_rate_limits, or " +
        "`drizzle-kit push` cannot manage the table the rate limiters use " +
        "and a fresh database leaves them failing open.",
    ).toBeGreaterThan(-1);
    const end = schemaSource.indexOf("\nexport ", start);
    return schemaSource.slice(start, end === -1 ? undefined : end);
  }

  test("the Neon adapter's table is declared in schema.ts", () => {
    const block = rateLimitsBlock();
    // Columns mirror drizzle/0021_crafter_rate_limits.sql and the DDL inside
    // @crafter/limit's neonHttp adapter; the adapter writes raw SQL, so a
    // renamed column here would make push and the adapter disagree.
    expect(block).toContain('text("key").primaryKey()');
    expect(block).toContain('bigint("count"');
    expect(block).toContain('bigint("window_started_at"');
    expect(block).toContain('bigint("expires_at"');
  });

  test("the migration file and the schema agree on the table", () => {
    const migration = readFileSync(
      join(REPO_ROOT, "drizzle", "0021_crafter_rate_limits.sql"),
      "utf8",
    );
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS public.crafter_rate_limits",
    );
    // Same four columns on both sides, so push and the migration produce the
    // same table.
    const block = rateLimitsBlock();
    for (const column of ["key", "count", "window_started_at", "expires_at"]) {
      expect(block, `schema.ts is missing ${column}`).toContain(`"${column}"`);
      expect(migration, `0021 migration is missing ${column}`).toContain(
        column,
      );
    }
  });
});
