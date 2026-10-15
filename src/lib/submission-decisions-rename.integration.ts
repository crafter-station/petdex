import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { rowsOf, runAtomicReturning } from "@/lib/db/atomic";
import * as schema from "@/lib/db/schema";

// The slug rename in `applySubmissionAction` once committed the main-row
// UPDATE as its own statement before migrating the slug-keyed references,
// and the migration list skipped `pet_requests.fulfilled_pet_slug`. Both
// halves are pinned here against real PGlite SQL: the batch must carry the
// pets UPDATE as its first statement, every reference table must move, and
// a fulfilled request must follow the rename.
const client = new PGlite();
const testDb = drizzle(client, { schema });

mock.module("server-only", () => ({}));
mock.module("@/lib/db/client", () => ({
  db: testDb as never,
  schema,
  executeAtomicReturning: (queries: never) =>
    runAtomicReturning(testDb as never, queries),
  rowsOf,
}));
const realRatelimit = await import("@/lib/ratelimit");
const realR2 = await import("@/lib/r2");
mock.module("@/lib/ratelimit", () => ({ ...realRatelimit }));
mock.module("@/lib/r2", () => ({ ...realR2 }));
const realCached = await import("@/lib/db/cached-aggregates");
mock.module("@/lib/db/cached-aggregates", () => ({ ...realCached }));
const realNotifications = await import("@/lib/notifications");
mock.module("@/lib/notifications", () => ({ ...realNotifications }));
const realUserLocale = await import("@/lib/user-locale");
mock.module("@/lib/user-locale", () => ({ ...realUserLocale }));
const realEmailTemplates = await import(
  "@/lib/email-templates/submission-approved"
);
mock.module("@/lib/email-templates/submission-approved", () => ({
  ...realEmailTemplates,
}));

const { applySubmissionAction } = await import("@/lib/submission-decisions");

beforeAll(async () => {
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "submitted_pets" (
      "id" text PRIMARY KEY,
      "slug" text NOT NULL UNIQUE,
      "status" text NOT NULL DEFAULT 'pending',
      "display_name" text NOT NULL DEFAULT '',
      "description" text NOT NULL DEFAULT '',
      "kind" text NOT NULL DEFAULT 'character',
      "spritesheet_url" text,
      "pet_json_url" text,
      "zip_url" text,
      "spritesheet_width" integer,
      "spritesheet_height" integer,
      "sprite_version_number" integer NOT NULL DEFAULT 1,
      "owner_id" text,
      "owner_email" text,
      "credit_name" text,
      "credit_url" text,
      "credit_image" text,
      "color_family" text,
      "tags" jsonb NOT NULL DEFAULT '[]',
      "vibes" jsonb NOT NULL DEFAULT '[]',
      "sounds" jsonb NOT NULL DEFAULT '[]',
      "license" text,
      "approved_at" timestamptz,
      "rejected_at" timestamptz,
      "rejection_reason" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "featured" boolean NOT NULL DEFAULT false,
      "gallery_position" integer,
      "preview_url" text,
      "thumb_url" text,
      "sticker_urls" jsonb,
      "embedding_model" text,
      "dominant_color" text,
      "sound_url" text,
      "dhash" text,
      "sprite_sha256" text,
      "pet_json_sha256" text,
      "zip_sha256" text,
      "source" text,
      "license_declared_at" timestamptz,
      "pending_display_name" text,
      "pending_description" text,
      "pending_tags" jsonb,
      "pending_submitted_at" timestamptz,
      "pending_rejection_reason" text,
      "pending_spritesheet_url" text,
      "pending_pet_json_url" text,
      "pending_zip_url" text,
      "pending_spritesheet_width" integer,
      "pending_spritesheet_height" integer,
      "pending_sprite_version_number" integer,
      "pending_dhash" text,
      "pending_review_id" text,
      "pending_auto_approved_at" timestamptz,
      "edit_count" integer,
      "last_edit_at" timestamptz
    )
  `);
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_collection_items" (
      "collection_id" text NOT NULL,
      "pet_slug" text NOT NULL,
      "position" integer NOT NULL DEFAULT 0,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("collection_id", "pet_slug")
    )
  `);
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_requests" (
      "id" text PRIMARY KEY,
      "user_id" text NOT NULL,
      "slug" text NOT NULL,
      "display_name" text NOT NULL,
      "kind" text NOT NULL DEFAULT 'character',
      "description" text NOT NULL DEFAULT '',
      "status" text NOT NULL DEFAULT 'open',
      "fulfilled_pet_slug" text,
      "upvote_count" integer NOT NULL DEFAULT 1,
      "image_url" text,
      "image_review_status" text NOT NULL DEFAULT 'none',
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_collections" (
      "id" text PRIMARY KEY,
      "slug" text NOT NULL,
      "cover_pet_slug" text,
      "created_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_likes" (
      "user_id" text NOT NULL,
      "pet_slug" text NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("user_id", "pet_slug")
    )
  `);
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_metrics" (
      "pet_slug" text PRIMARY KEY,
      "install_count" integer NOT NULL DEFAULT 0,
      "zip_download_count" integer NOT NULL DEFAULT 0,
      "like_count" integer NOT NULL DEFAULT 0
    )
  `);
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_collection_requests" (
      "id" text PRIMARY KEY,
      "collection_id" text NOT NULL,
      "pet_slug" text NOT NULL,
      "status" text NOT NULL DEFAULT 'pending',
      "created_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "user_profiles" (
      "user_id" text PRIMARY KEY,
      "featured_pet_slugs" jsonb NOT NULL DEFAULT '[]'
    )
  `);
  await testDb.execute(sql`
    INSERT INTO "submitted_pets" ("id", "slug", "status", "display_name")
    VALUES ('1', 'old-slug', 'approved', 'Old')
  `);
  await testDb.execute(sql`
    INSERT INTO "pet_collection_items" ("collection_id", "pet_slug")
    VALUES ('c1', 'old-slug')
  `);
  await testDb.execute(sql`
    INSERT INTO "pet_requests" ("id", "user_id", "slug", "display_name", "status", "fulfilled_pet_slug")
    VALUES ('r1', 'user_1', 'old-slug', 'Old', 'fulfilled', 'old-slug')
  `);
});

afterAll(async () => {
  await client.close();
});

describe("the slug rename moves the main row and every reference in one batch", () => {
  it("renames the pet, the collection item, and the fulfilled request together", async () => {
    const result = await applySubmissionAction("1", {
      action: "edit",
      slug: "new-slug",
    });
    expect(result.ok).toBe(true);
    // The batch's pets UPDATE must RETURN the row: approve-with-rename feeds
    // this value into runPostApprovalEffects (row.id, displayName, tags),
    // so an empty first-statement result here would silently break the
    // approve path downstream of every assertion below.
    const renamed = (
      result as { row?: { id: unknown; slug: unknown; displayName: unknown } }
    ).row;
    expect(renamed?.id).toBe("1");
    expect(renamed?.slug).toBe("new-slug");
    expect(renamed?.displayName).toBe("Old");

    const pet = await testDb.execute(
      sql`SELECT slug FROM "submitted_pets" WHERE id = '1'`,
    );
    expect((pet.rows[0] as { slug: string }).slug).toBe("new-slug");

    const item = await testDb.execute(
      sql`SELECT pet_slug FROM "pet_collection_items" WHERE collection_id = 'c1'`,
    );
    expect((item.rows[0] as { pet_slug: string }).pet_slug).toBe("new-slug");

    const request = await testDb.execute(
      sql`SELECT fulfilled_pet_slug FROM "pet_requests" WHERE id = 'r1'`,
    );
    expect(
      (request.rows[0] as { fulfilled_pet_slug: string }).fulfilled_pet_slug,
    ).toBe("new-slug");
    expect(
      await testDb
        .execute(
          sql`SELECT 1 FROM "pet_requests" WHERE fulfilled_pet_slug = 'old-slug'`,
        )
        .then((r) => r.rows.length),
    ).toBe(0);
  });

  it("maps camelCase update keys to snake_case columns on a status action", async () => {
    // approve/reject/pending carry approvedAt/rejectedAt/rejectionReason —
    // TS property names whose database columns are snake_case. The batch
    // builds its SET list with sql.identifier, so a quoted "approvedAt"
    // would not exist; the mapping must go through the schema.
    const result = await applySubmissionAction("1", { action: "pending" });
    expect(result.ok).toBe(true);
    const status = await testDb.execute(
      sql`SELECT status, approved_at, rejected_at, rejection_reason FROM "submitted_pets" WHERE id = '1'`,
    );
    const row = status.rows[0] as {
      status: string;
      approved_at: string | null;
      rejected_at: string | null;
      rejection_reason: string | null;
    };
    expect(row.status).toBe("pending");
    expect(row.approved_at).toBeNull();
  });

  it("keeps the pets UPDATE inside the same batch as the reference migration", async () => {
    // Source guard: the earlier revision issued the pets UPDATE through
    // db.update before the batch, so a mid-batch failure left a renamed row
    // with stale references. The batch's first statement must be the
    // submitted_pets UPDATE.
    const source = await Bun.file(
      new URL("./submission-decisions.ts", import.meta.url),
    ).text();
    const batchStart = source.indexOf("const renameStatements");
    const batchEnd = source.indexOf("executeAtomicReturning(renameStatements)");
    const batch = source.slice(batchStart, batchEnd);
    expect(batch).toContain('UPDATE "submitted_pets"');
    const batchPos = batch.indexOf('UPDATE "submitted_pets"');
    for (const table of [
      '"pet_collection_items"',
      '"pet_collections"',
      '"pet_likes"',
      '"pet_metrics"',
      '"pet_collection_requests"',
      '"pet_requests"',
    ]) {
      const pos = batch.indexOf(`UPDATE ${table}`);
      expect(pos).toBeGreaterThan(batchPos);
    }
  });
});
