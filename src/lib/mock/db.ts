// PGlite-backed in-memory Postgres for mock mode. Boots on first import,
// runs every drizzle migration in /drizzle/, then seeds a handful of
// approved pets so the gallery isn't empty. The instance lives for the
// lifetime of the dev server process — restart the server to get a fresh
// DB. We deliberately don't persist to disk: the goal is zero setup, not
// state across restarts.

import "server-only";

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "../db/schema";
import { MOCK_USER } from "./index";

type MockDbState = {
  db: ReturnType<typeof drizzle<typeof schema>> | null;
  initPromise: Promise<void> | null;
};

const globalMockDb = globalThis as typeof globalThis & {
  __petdexMockDb?: MockDbState;
};

if (!globalMockDb.__petdexMockDb) {
  globalMockDb.__petdexMockDb = {
    db: null,
    initPromise: null,
  };
}
const state: MockDbState = globalMockDb.__petdexMockDb;

async function bootstrap(client: PGlite): Promise<void> {
  // Drizzle migrations are SQL files. We run them in order, tolerating
  // PGlite limitations (no pgvector, no GIN on jsonb) by swallowing
  // those errors. We then run a fixup pass that adds any columns the
  // current schema.ts expects but that no .sql migration introduced
  // (drift between schema.ts and the migrations folder is real in
  // active projects).
  const migrationsDir = join(process.cwd(), "drizzle");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      try {
        await client.exec(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          !msg.includes("already exists") &&
          !msg.includes("extension") &&
          !msg.includes("vector") &&
          !msg.includes("gin") &&
          !msg.includes("does not exist")
        ) {
          console.warn(`[mock-db] skipped statement: ${msg.slice(0, 120)}`);
        }
      }
    }
  }

  // Fixup: schema.ts is ahead of /drizzle migrations. Apply any tables
  // and columns the runtime needs that the migrations don't create.
  // Whenever schema.ts grows a new field that pages read, add it here
  // until the migration file lands. This keeps the mock unblocked
  // without forcing maintainers to regenerate migrations on every PR.
  const fixups = [
    `CREATE TABLE IF NOT EXISTS "user_profiles" (
      "user_id" text PRIMARY KEY NOT NULL,
      "display_name" text,
      "handle" text,
      "bio" text,
      "preferred_locale" text NOT NULL DEFAULT 'en',
      "featured_pet_slugs" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS "pet_requests" (
      "id" text PRIMARY KEY NOT NULL,
      "query" text NOT NULL,
      "normalized" text NOT NULL,
      "requested_by" text,
      "upvote_count" integer NOT NULL DEFAULT 1,
      "status" text NOT NULL DEFAULT 'open',
      "fulfilled_pet_slug" text,
      "image_url" text,
      "image_review_status" text NOT NULL DEFAULT 'none',
      "image_rejection_reason" text,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS "feedback" (
      "id" text PRIMARY KEY NOT NULL,
      "kind" text NOT NULL DEFAULT 'suggestion',
      "status" text NOT NULL DEFAULT 'pending',
      "message" text NOT NULL,
      "email" text,
      "page_url" text,
      "user_agent" text,
      "user_id" text,
      "addressed_at" timestamp with time zone,
      "archived_at" timestamp with time zone,
      "admin_note" text,
      "notify_email" boolean NOT NULL DEFAULT true,
      "user_last_read_at" timestamp with time zone,
      "admin_last_read_at" timestamp with time zone,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS "feedback_replies" (
      "id" text PRIMARY KEY NOT NULL,
      "feedback_id" text NOT NULL,
      "author_kind" text NOT NULL,
      "author_user_id" text,
      "body" text NOT NULL,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS "notifications" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL,
      "kind" text NOT NULL,
      "payload" jsonb NOT NULL,
      "href" text NOT NULL,
      "read_at" timestamp with time zone,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )`,
    `ALTER TABLE "submitted_pets" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'submit'`,
    `ALTER TABLE "submitted_pets" ADD COLUMN IF NOT EXISTS "dominant_color" text`,
    `ALTER TABLE "submitted_pets" ADD COLUMN IF NOT EXISTS "color_family" text`,
    `ALTER TABLE "submitted_pets" ADD COLUMN IF NOT EXISTS "sound_url" text`,
    `ALTER TABLE "submitted_pets" ADD COLUMN IF NOT EXISTS "dhash" text`,
    `ALTER TABLE "submitted_pets" ADD COLUMN IF NOT EXISTS "credit_image" text`,
    `ALTER TABLE "submitted_pets" ADD COLUMN IF NOT EXISTS "pending_display_name" text`,
    `ALTER TABLE "submitted_pets" ADD COLUMN IF NOT EXISTS "pending_description" text`,
    `ALTER TABLE "submitted_pets" ADD COLUMN IF NOT EXISTS "pending_tags" jsonb`,
    `ALTER TABLE "submitted_pets" ADD COLUMN IF NOT EXISTS "pending_submitted_at" timestamp with time zone`,
    `ALTER TABLE "submitted_pets" ADD COLUMN IF NOT EXISTS "pending_rejection_reason" text`,
    // Denormalize metric columns onto submitted_pets so drizzle's
    // coalesce-without-table-prefix queries (pet-search.ts:135) don't
    // 42703 in PGlite. Real Postgres handles the same query via the
    // leftJoin, but PGlite's planner picks the local column name first.
    `ALTER TABLE "submitted_pets" ADD COLUMN IF NOT EXISTS "install_count" integer NOT NULL DEFAULT 0`,
    `ALTER TABLE "submitted_pets" ADD COLUMN IF NOT EXISTS "like_count" integer NOT NULL DEFAULT 0`,
    `ALTER TABLE "submitted_pets" ADD COLUMN IF NOT EXISTS "zip_download_count" integer NOT NULL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS "pet_metrics" (
      "pet_slug" text PRIMARY KEY NOT NULL,
      "install_count" integer NOT NULL DEFAULT 0,
      "zip_download_count" integer NOT NULL DEFAULT 0,
      "like_count" integer NOT NULL DEFAULT 0,
      "last_installed_at" timestamp with time zone,
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )`,
  ];
  for (const stmt of fixups) {
    try {
      await client.exec(stmt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[mock-db] fixup failed: ${msg.slice(0, 120)}`);
    }
  }
}

async function seed(client: PGlite): Promise<void> {
  // Seed from pets/ideas.json so the gallery shows the same names a real
  // contributor would see in production. Everything is marked `approved`
  // so /, /pets, /search, /u/<handle> all render content.
  let ideas: Array<{
    id: string;
    name: string;
    description: string;
    tags?: string[];
  }>;
  try {
    const raw = readFileSync(join(process.cwd(), "pets/ideas.json"), "utf8");
    ideas = JSON.parse(raw);
  } catch {
    ideas = [];
  }

  const sample = ideas.slice(0, 12);
  for (let i = 0; i < sample.length; i++) {
    const idea = sample[i];
    const slug = idea.id;
    const id = `pet_mock_${i.toString().padStart(3, "0")}`;
    // Use a 1x1 transparent webp data URI as a stand-in spritesheet so
    // <img> tags don't 404 in the gallery. Real R2 URLs would point to
    // multi-frame sprite sheets.
    const placeholder =
      "data:image/svg+xml;utf8," +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#1a1a1a"/><text x="50%" y="50%" fill="#888" text-anchor="middle" dominant-baseline="middle" font-family="monospace" font-size="20">${idea.name}</text></svg>`,
      );
    await client.query(
      `INSERT INTO submitted_pets (
        id, slug, display_name, description, spritesheet_url,
        pet_json_url, zip_url, kind, vibes, tags,
        status, source, owner_id, owner_email, credit_name,
        approved_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $5, $5, 'creature', '[]'::jsonb, $6::jsonb,
        'approved', 'submit', $7, $8, $9,
        now()
      )
      ON CONFLICT (slug) DO NOTHING`,
      [
        id,
        slug,
        idea.name,
        idea.description,
        placeholder,
        JSON.stringify(idea.tags ?? []),
        MOCK_USER.userId,
        MOCK_USER.email,
        MOCK_USER.username,
      ],
    );
  }

  // Seed the contributor's user_profile so /my-pets and /u/contributor work.
  await client.query(
    `INSERT INTO user_profiles (user_id, display_name, handle, bio, preferred_locale)
     VALUES ($1, $2, $3, $4, 'en')
     ON CONFLICT (user_id) DO NOTHING`,
    [
      MOCK_USER.userId,
      "Test Contributor",
      MOCK_USER.username,
      "Mock user for local QA",
    ],
  );
}

// Bootstrap+seed are run synchronously at module load via top-level
// await. PGlite's underlying postgres-on-wasm queues exec calls so the
// schema is fully ready before drizzle's first .select() runs.
export function getMockDb() {
  if (state.db) {
    return { db: state.db, ready: state.initPromise ?? Promise.resolve() };
  }

  const client = new PGlite();
  state.db = drizzle(client, { schema });
  state.initPromise = (async () => {
    await bootstrap(client);
    await seed(client);
    console.log(
      "[mock-db] PGlite ready (in-memory, seeded from pets/ideas.json)",
    );
  })();

  return { db: state.db, ready: state.initPromise };
}

// Awaitable used by /src/lib/db/client.ts to block on first import.
export const mockDbReady = (): Promise<void> => {
  if (state.initPromise) return state.initPromise;
  // Side-effect of getMockDb seeds _initPromise; ignore the returned db.
  getMockDb();
  return state.initPromise ?? Promise.resolve();
};
