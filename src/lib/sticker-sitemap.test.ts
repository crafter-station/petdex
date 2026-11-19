// `/stickers/<slug>` calls `notFound()` unless the collection holds at least
// one pet the current sticker policy publishes, so the sitemap has to apply
// that same filter. Listing slugs instead advertises 404s — the exact failure
// the vibe and kind entries were written to avoid, and the one the sticker
// route had because nothing listed it at all.
//
// Driven against a real PGlite database rather than a source scan, because the
// defect is in which rows survive the join and the per-pet predicates. A scan
// cannot tell a passing filter from a plausible one: dropping the
// `isCurrentStickerPublication` check leaves the join and the assertions
// looking intact.
//
// `server-only` and `@/lib/db/client` are stubbed for the same reasons
// `collection-empty-list.test.ts` documents — the former throws outside a
// server context, the latter builds a client on import and hard-fails without
// DATABASE_URL. Only the five tables the accessor touches are created, so the
// schema this suite depends on stays explicit.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "@/lib/db/schema";

const testDb = drizzle(new PGlite());

const FULL_STATES = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
];

// Matches STICKER_ARTIFACT_VERSION and STICKER_EXPORT_POLICY_VERSION in
// src/lib/sticker-export-policy.ts. Copied rather than imported so a policy
// bump fails here loudly instead of silently re-qualifying the fixtures.
const ARTIFACT_VERSION = "petdex-stickers-v2";
const POLICY_VERSION = "sticker-export-v1";

mock.module("server-only", () => ({}));
mock.module("@/lib/db/client", () => ({
  db: testDb,
  schema,
  executeAtomicReturning: async () => [],
  rowsOf: () => [],
}));

// `withNextDataCache` falls back to the raw function when Next's cache is
// unavailable, which is the path a plain `bun test` run takes.
const { getStickerSitemapEntries } = await import("@/lib/sticker-export");

async function createSchema(): Promise<void> {
  // Drizzle names every column of every joined table in the SELECT, so a
  // narrower table shape fails at parse time rather than at the assertion.
  // The definitions mirror `src/lib/db/schema.ts`; the ones the accessor reads
  // (`status`, `sprite_sha256`, `scope`, `source_sha256`, `policy_version`,
  // `artifact_version`, `owner_id`, `updated_at`) keep real types, the rest are
  // placeholders that exist only to satisfy the projection.
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "submitted_pets" (
      "id" text PRIMARY KEY,
      "slug" text NOT NULL,
      "display_name" text NOT NULL DEFAULT '',
      "description" text NOT NULL DEFAULT '',
      "spritesheet_url" text,
      "pet_json_url" text,
      "zip_url" text,
      "sprite_version_number" integer,
      "kind" text,
      "vibes" jsonb,
      "tags" jsonb,
      "dominant_color" text,
      "color_family" text,
      "sound_url" text,
      "featured" boolean NOT NULL DEFAULT false,
      "dhash" text,
      "sprite_sha256" text,
      "pet_json_sha256" text,
      "zip_sha256" text,
      "status" text NOT NULL,
      "source" text,
      "owner_id" text,
      "owner_email" text,
      "credit_name" text,
      "credit_url" text,
      "credit_image" text,
      "license" text,
      "license_declared_at" timestamp with time zone,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "approved_at" timestamp with time zone,
      "rejected_at" timestamp with time zone,
      "rejection_reason" text,
      "pending_display_name" text,
      "pending_description" text,
      "pending_tags" jsonb,
      "pending_submitted_at" timestamp with time zone,
      "pending_rejection_reason" text,
      "pending_spritesheet_url" text,
      "pending_pet_json_url" text,
      "pending_zip_url" text,
      "pending_spritesheet_width" integer,
      "pending_spritesheet_height" integer,
      "pending_sprite_version_number" integer,
      "pending_dhash" text,
      "pending_review_id" text,
      "pending_auto_approved_at" timestamp with time zone,
      "edit_count" integer NOT NULL DEFAULT 0,
      "last_edit_at" timestamp with time zone,
      "gallery_position" integer
    )
  `);
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_collections" (
      "id" text PRIMARY KEY,
      "slug" text NOT NULL,
      "title" text NOT NULL DEFAULT '',
      "description" text NOT NULL DEFAULT '',
      "owner_id" text,
      "external_url" text,
      "cover_pet_slug" text,
      "featured" boolean NOT NULL DEFAULT false,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone
    )
  `);
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_collection_items" (
      "collection_id" text NOT NULL,
      "pet_slug" text NOT NULL,
      "position" integer NOT NULL DEFAULT 0,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_export_approvals" (
      "pet_id" text NOT NULL,
      "scope" text NOT NULL DEFAULT 'stickers',
      "status" text NOT NULL,
      "source_sha256" text NOT NULL,
      "policy_version" text NOT NULL,
      "reviewed_by" text NOT NULL DEFAULT 'test',
      "reason" text NOT NULL DEFAULT '',
      "reviewed_at" timestamp with time zone NOT NULL DEFAULT now(),
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone,
      PRIMARY KEY ("pet_id", "scope")
    )
  `);
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_sticker_publications" (
      "pet_id" text PRIMARY KEY,
      "source_sha256" text NOT NULL,
      "artifact_version" text NOT NULL,
      "states" jsonb NOT NULL,
      "formats" jsonb NOT NULL,
      "profiles" jsonb NOT NULL,
      "treatments" jsonb NOT NULL,
      "object_count" integer NOT NULL DEFAULT 0,
      "total_bytes" integer NOT NULL DEFAULT 0,
      "manifest_sha256" text NOT NULL DEFAULT 'x',
      "status" text NOT NULL,
      "cleanup_status" text,
      "cleanup_error" text,
      "published_at" timestamp with time zone,
      "revoked_at" timestamp with time zone,
      "updated_at" timestamp with time zone
    )
  `);
}

async function seedPet(
  id: string,
  slug: string,
  opts: {
    status?: string;
    spriteSha256?: string | null;
    approval?: "allowed" | "revoked" | "none";
    publication?: "complete" | "revoked" | "none";
    states?: string[];
  } = {},
): Promise<void> {
  const {
    status = "approved",
    spriteSha256 = "sha-1",
    approval = "allowed",
    publication = "complete",
    states = FULL_STATES,
  } = opts;
  await testDb.execute(
    sql`INSERT INTO "submitted_pets" ("id", "slug", "status", "sprite_sha256")
        VALUES (${id}, ${slug}, ${status}, ${spriteSha256})`,
  );
  if (approval !== "none") {
    await testDb.execute(
      sql`INSERT INTO "pet_export_approvals"
            ("pet_id", "scope", "status", "source_sha256", "policy_version")
          VALUES (${id}, 'stickers', ${approval}, ${spriteSha256}, ${POLICY_VERSION})`,
    );
  }
  if (publication !== "none") {
    await testDb.execute(
      sql`INSERT INTO "pet_sticker_publications"
            ("pet_id", "source_sha256", "artifact_version", "states", "formats", "profiles", "treatments", "status")
          VALUES (${id}, ${spriteSha256}, ${ARTIFACT_VERSION},
                  ${JSON.stringify(states)}::jsonb,
                  '["webp","png"]'::jsonb,
                  '["web","whatsapp"]'::jsonb,
                  '["clean","outline"]'::jsonb,
                  ${publication})`,
    );
  }
}

async function seedCollection(
  id: string,
  slug: string,
  petSlugs: string[],
  opts: { ownerId?: string | null; updatedAt?: string | null } = {},
): Promise<void> {
  const { ownerId = null, updatedAt = "2026-01-01T00:00:00.000Z" } = opts;
  await testDb.execute(
    sql`INSERT INTO "pet_collections" ("id", "slug", "owner_id", "updated_at")
        VALUES (${id}, ${slug}, ${ownerId}, ${updatedAt})`,
  );
  for (const [i, petSlug] of petSlugs.entries()) {
    await testDb.execute(
      sql`INSERT INTO "pet_collection_items" ("collection_id", "pet_slug", "position")
          VALUES (${id}, ${petSlug}, ${i})`,
    );
  }
}

async function slugs(): Promise<string[]> {
  const entries = await getStickerSitemapEntries();
  return entries.map((entry) => entry.slug).sort();
}

beforeAll(createSchema);
afterAll(async () => {
  // PGlite holds the client in a closure created above; closing it through the
  // same handle keeps the test process from keeping a live database around.
  await testDb.$client.close();
});

describe("getStickerSitemapEntries", () => {
  beforeEach(async () => {
    process.env.STICKER_EXPLORER_ENABLED = "1";
    delete process.env.STICKER_EXPLORER_DEMO;
    delete process.env.STICKER_EXPORT_DISABLED;
    await testDb.execute(
      sql`TRUNCATE "pet_sticker_publications", "pet_export_approvals",
            "pet_collection_items", "pet_collections", "submitted_pets"`,
    );
  });

  it("returns nothing when the explorer is off", async () => {
    // The page 404s every slug in this state, so listing any is a 404 entry.
    process.env.STICKER_EXPLORER_ENABLED = "0";
    await seedPet("p1", "alpha");
    await seedCollection("c1", "claude", ["alpha"]);
    expect(await slugs()).toEqual([]);
  });

  it("returns nothing when the kill switch is set", async () => {
    // `STICKER_EXPORT_DISABLED` is read inside `isStickerExplorerEnabled`, so
    // it wins even with the explorer explicitly on.
    process.env.STICKER_EXPORT_DISABLED = "1";
    await seedPet("p1", "alpha");
    await seedCollection("c1", "claude", ["alpha"]);
    expect(await slugs()).toEqual([]);
  });

  it("lists a collection whose pet is approved and published", async () => {
    await seedPet("p1", "alpha");
    await seedCollection("c1", "claude", ["alpha"]);
    expect(await slugs()).toEqual(["claude"]);
  });

  it("skips a collection whose only pet is unapproved", async () => {
    await seedPet("p1", "alpha", { approval: "revoked" });
    await seedCollection("c1", "claude", ["alpha"]);
    expect(await slugs()).toEqual([]);
  });

  it("skips a collection whose only pet is unpublished", async () => {
    await seedPet("p1", "alpha", { publication: "none" });
    await seedCollection("c1", "claude", ["alpha"]);
    expect(await slugs()).toEqual([]);
  });

  it("skips a pet that is not approved", async () => {
    // The page's filter is over pets, so a pending pet is not indexable even
    // with an approval row present.
    await seedPet("p1", "alpha", { status: "pending" });
    await seedCollection("c1", "claude", ["alpha"]);
    expect(await slugs()).toEqual([]);
  });

  it("skips a pet whose sprite changed after publication", async () => {
    // `sourceSha256` on both rows has to equal the pet's current sprite; a
    // re-upload invalidates the artifacts the publication row describes.
    await seedPet("p1", "alpha");
    await seedCollection("c1", "claude", ["alpha"]);
    await testDb.execute(
      sql`UPDATE "submitted_pets" SET "sprite_sha256" = 'sha-2' WHERE "id" = 'p1'`,
    );
    expect(await slugs()).toEqual([]);
  });

  it("skips a publication with an incomplete state set", async () => {
    // `isCurrentStickerPublication` requires every public state, so a partial
    // publication is not a page the crawler can reach.
    await seedPet("p1", "alpha", { states: ["idle", "waving"] });
    await seedCollection("c1", "claude", ["alpha"]);
    expect(await slugs()).toEqual([]);
  });

  it("skips a publication from a previous artifact version", async () => {
    await seedPet("p1", "alpha");
    await testDb.execute(
      sql`UPDATE "pet_sticker_publications" SET "artifact_version" = 'petdex-stickers-v1'
          WHERE "pet_id" = 'p1'`,
    );
    await seedCollection("c1", "claude", ["alpha"]);
    expect(await slugs()).toEqual([]);
  });

  it("keeps a collection when one of several pets qualifies", async () => {
    await seedPet("p1", "alpha");
    await seedPet("p2", "beta", { approval: "revoked" });
    await seedCollection("c1", "claude", ["alpha", "beta"]);
    expect(await slugs()).toEqual(["claude"]);
  });

  it("lists each qualifying collection once", async () => {
    // The join emits one row per pet; the collection has to collapse to a
    // single sitemap entry rather than one per member.
    await seedPet("p1", "alpha");
    await seedPet("p2", "beta");
    await seedCollection("c1", "claude", ["alpha", "beta"]);
    expect(await slugs()).toEqual(["claude"]);
  });

  it("ignores owner-scoped collections", async () => {
    // `getStickerCollection` filters on `owner_id IS NULL`, so a creator's
    // private collection is not a sticker page.
    await seedPet("p1", "alpha");
    await seedCollection("c1", "claude", ["alpha"]);
    await seedCollection("c2", "mine", ["alpha"], { ownerId: "user_1" });
    expect(await slugs()).toEqual(["claude"]);
  });

  it("carries the collection's updatedAt for <lastmod>", async () => {
    await seedPet("p1", "alpha");
    await seedCollection("c1", "claude", ["alpha"], {
      updatedAt: "2026-05-01T12:00:00.000Z",
    });
    const [entry] = await getStickerSitemapEntries();
    expect(entry.updatedAt).toBeInstanceOf(Date);
    expect(entry.updatedAt?.toISOString()).toBe("2026-05-01T12:00:00.000Z");
  });

  it("tolerates a null updatedAt", async () => {
    await seedPet("p1", "alpha");
    await seedCollection("c1", "claude", ["alpha"], { updatedAt: null });
    const [entry] = await getStickerSitemapEntries();
    expect(entry.updatedAt).toBeNull();
  });

  it("returns qualifying collections in slug order", async () => {
    await seedPet("p1", "alpha");
    await seedCollection("c1", "zebra", ["alpha"]);
    await seedCollection("c2", "aardvark", ["alpha"]);
    expect(await slugs()).toEqual(["aardvark", "zebra"]);
  });
});
