// pgvector bootstrap for push-built databases.
//
// The repo's only automated schema path is `drizzle-kit push`, which diffs
// `src/lib/db/schema.ts`. That model deliberately keeps `embedding` and
// `embedding_model` out (Drizzle has no first-class pgvector type), and the
// migration files that DO declare them (0004, 0005) are never applied — so a
// database built by push has no vector columns, no `vector` extension, and
// none of the five hash/embedding indexes. Semantic search, similarity, and
// exact-hash dedup then silently degrade: `findSemanticMatches` returns
// nothing, `findExactHashMatches` errors into a null, and review falls back to
// the weaker checks with no error surfaced.
//
// Run this after `drizzle-kit push` wherever the database is not Neon (Neon
// already has pgvector enabled and the columns are created by hand there).
// Idempotent and best-effort: when the server has no `vector` extension
// available it reports and exits 0, because a stack without pgvector still
// serves the gallery — it just loses the semantic slice.

import postgres from "postgres";

import { requiredEnv } from "./env";

const sql = postgres(requiredEnv("DATABASE_URL"), { max: 1 });

const VECTOR_STATEMENTS = [
  `CREATE EXTENSION IF NOT EXISTS vector`,
  `ALTER TABLE "submitted_pets" ADD COLUMN IF NOT EXISTS "embedding" vector(3072)`,
  `ALTER TABLE "submitted_pets" ADD COLUMN IF NOT EXISTS "embedding_model" text`,
  `ALTER TABLE "pet_requests" ADD COLUMN IF NOT EXISTS "embedding" vector(3072)`,
  `ALTER TABLE "pet_requests" ADD COLUMN IF NOT EXISTS "embedding_model" text`,
];

// These need no extension; run them whether or not pgvector is available.
const PLAIN_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS "submitted_pets_sprite_sha_idx" ON "submitted_pets" USING btree ("sprite_sha256")`,
  `CREATE INDEX IF NOT EXISTS "submitted_pets_pet_json_sha_idx" ON "submitted_pets" USING btree ("pet_json_sha256")`,
  `CREATE INDEX IF NOT EXISTS "submitted_pets_zip_sha_idx" ON "submitted_pets" USING btree ("zip_sha256")`,
  `CREATE INDEX IF NOT EXISTS "submitted_pets_embedding_model_idx" ON "submitted_pets" USING btree ("embedding_model")`,
  `CREATE INDEX IF NOT EXISTS "pet_requests_embedding_model_idx" ON "pet_requests" USING btree ("embedding_model")`,
];

// Only "this server has no pgvector" may be swallowed. Matching on the
// message text is too loose: `permission denied to create extension "vector"`
// and `must be owner of extension vector` both contain "vector", so a
// non-superuser run (RDS, a self-managed box) was reported as "this Postgres
// has no pgvector", skipped, and exited 0 — leaving semantic search and
// exact-hash dedup silently off while the operator saw success.
//
// Postgres reports the two cases with different SQLSTATEs, and the driver
// surfaces it as `error.code`:
//   0A000 feature_not_supported — `extension "vector" is not available`,
//          i.e. pgvector is genuinely absent from the server.
//   42501 insufficient_privilege — the extension may exist; the role just
//          may not create it. That is an operator problem, not a missing
//          feature, so it must throw.
const SQLSTATE_FEATURE_NOT_SUPPORTED = "0A000";
// 42703 — the embedding_model indexes name a column that a pgvector-less
// server never created.
const SQLSTATE_UNDEFINED_COLUMN = "42703";

function isVectorUnavailable(error: unknown): boolean {
  return (
    (error as { code?: unknown } | null)?.code ===
    SQLSTATE_FEATURE_NOT_SUPPORTED
  );
}

async function main(): Promise<void> {
  let hasVector = true;
  for (const statement of VECTOR_STATEMENTS) {
    try {
      await sql.unsafe(statement);
    } catch (error) {
      if (isVectorUnavailable(error)) {
        // A server without pgvector (a stock `postgres:16-alpine`) fails the
        // extension create and every statement after it. That is expected:
        // say so once, skip the rest, and still create the plain indexes.
        console.log(
          "pgvector bootstrap skipped: this Postgres has no `vector` extension. " +
            "Semantic search and exact-hash dedup will be unavailable.",
        );
        hasVector = false;
        break;
      }
      throw error;
    }
  }

  for (const statement of PLAIN_STATEMENTS) {
    // The two embedding_model indexes reference a column the vector
    // statements create, so on a server without pgvector they cannot be
    // built. Tolerate exactly that failure (undefined_column) rather than
    // gating on `hasVector`: the other three indexes are independent of the
    // extension and must still be attempted, and a failure for any other
    // reason stays loud.
    try {
      await sql.unsafe(statement);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (!hasVector && code === SQLSTATE_UNDEFINED_COLUMN) continue;
      throw error;
    }
  }

  if (hasVector) console.log("pgvector bootstrap applied");
}

try {
  await main();
} finally {
  await sql.end();
}
