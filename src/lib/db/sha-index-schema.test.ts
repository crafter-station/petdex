import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Same drift as `rate-limit-schema.test.ts`, one layer down: `drizzle-kit
// push` reconciles against `schema.ts`, so an index that exists only in
// `drizzle/*.sql` is one push away from being dropped. drizzle/0004 created
// these three sha indexes on columns schema.ts *does* declare — so unlike the
// `embedding_model` pair (whose column is deliberately raw-SQL and restored by
// `scripts/bootstrap-pgvector.ts`), there is no reason for them to be missing,
// and a push-built database carried none of them. The review path's
// `findExactHashMatches` filters on exactly these three columns.
const SRC = join(import.meta.dir, "..");
const REPO_ROOT = join(SRC, "..", "..");

const INDEXES = [
  { name: "submitted_pets_sprite_sha_idx", column: "sprite_sha256" },
  { name: "submitted_pets_pet_json_sha_idx", column: "pet_json_sha256" },
  { name: "submitted_pets_zip_sha_idx", column: "zip_sha256" },
];

describe("sha indexes are declared in schema.ts", () => {
  const schemaSource = readFileSync(join(import.meta.dir, "schema.ts"), "utf8");
  const migration = readFileSync(
    join(REPO_ROOT, "drizzle", "0004_submission_reviews.sql"),
    "utf8",
  );

  for (const { name, column } of INDEXES) {
    test(`${name} is declared, on ${column}`, () => {
      expect(
        schemaSource,
        `schema.ts must declare ${name}, or the next drizzle-kit push drops ` +
          `it and findExactHashMatches degrades to a sequential scan`,
      ).toContain(`index("${name}")`);
      expect(schemaSource).toContain(
        `table.${column.replace(/_(\w)/g, (_, c) => c.toUpperCase())}`,
      );
      // The migration is the shape push has to reproduce: plain btree, no
      // predicate. A predicate added on one side only would make push and the
      // migration disagree about the same index.
      expect(migration).toContain(`"${name}"`);
      expect(migration).toContain(`"${column}"`);
    });
  }
});
