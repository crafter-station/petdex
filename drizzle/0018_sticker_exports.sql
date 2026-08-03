ALTER TABLE "submitted_pets" ADD COLUMN IF NOT EXISTS "sprite_sha256" text;
ALTER TABLE "submitted_pets" ADD COLUMN IF NOT EXISTS "pet_json_sha256" text;
ALTER TABLE "submitted_pets" ADD COLUMN IF NOT EXISTS "zip_sha256" text;

CREATE TABLE IF NOT EXISTS "pet_export_approvals" (
	"pet_id" text NOT NULL REFERENCES "submitted_pets"("id") ON DELETE CASCADE,
	"scope" text DEFAULT 'stickers' NOT NULL,
	"status" text NOT NULL,
	"source_sha256" text NOT NULL,
	"policy_version" text NOT NULL,
	"reviewed_by" text NOT NULL,
	"reason" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pet_export_approvals_pet_id_scope_pk" PRIMARY KEY("pet_id","scope")
);

CREATE TABLE IF NOT EXISTS "pet_sticker_publications" (
	"pet_id" text PRIMARY KEY NOT NULL REFERENCES "submitted_pets"("id") ON DELETE CASCADE,
	"source_sha256" text NOT NULL,
	"artifact_version" text NOT NULL,
	"states" jsonb NOT NULL,
	"formats" jsonb NOT NULL,
	"profiles" jsonb NOT NULL,
	"treatments" jsonb NOT NULL,
	"object_count" integer NOT NULL,
	"total_bytes" integer NOT NULL,
	"manifest_sha256" text NOT NULL,
	"status" text NOT NULL,
	"cleanup_status" text DEFAULT 'not_required' NOT NULL,
	"cleanup_error" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "pet_sticker_publications" ADD COLUMN IF NOT EXISTS "profiles" jsonb;
UPDATE "pet_sticker_publications" SET "profiles" = '["web","whatsapp"]'::jsonb WHERE "profiles" IS NULL;
ALTER TABLE "pet_sticker_publications" ALTER COLUMN "profiles" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "pet_export_approvals_scope_status_idx" ON "pet_export_approvals" ("scope","status");
CREATE INDEX IF NOT EXISTS "pet_export_approvals_source_idx" ON "pet_export_approvals" ("pet_id","source_sha256");
CREATE INDEX IF NOT EXISTS "pet_sticker_publications_status_idx" ON "pet_sticker_publications" ("status");
CREATE INDEX IF NOT EXISTS "pet_sticker_publications_source_idx" ON "pet_sticker_publications" ("pet_id","source_sha256");

INSERT INTO "pet_collections" (
	"id",
	"slug",
	"title",
	"description",
	"cover_pet_slug",
	"featured",
	"updated_at"
)
VALUES (
	'claude',
	'claude',
	'Claude',
	'Claude Code pets curated for reaction stickers.',
	'claude-crab',
	false,
	now()
)
ON CONFLICT ("slug") DO UPDATE SET
	"title" = excluded."title",
	"description" = excluded."description",
	"cover_pet_slug" = excluded."cover_pet_slug",
	"updated_at" = now();

INSERT INTO "pet_collection_items" ("collection_id", "pet_slug", "position")
SELECT 'claude', pet."slug", candidate."position"
FROM (VALUES
	('claude-crab', 0),
	('claude-spectacles-3', 1),
	('claude-spectacles-4', 2),
	('clawd-music', 3),
	('clawd-2', 4),
	('clawd-4', 5),
	('clawd-3', 6),
	('clawdex', 7)
) AS candidate("slug", "position")
INNER JOIN "submitted_pets" pet ON pet."slug" = candidate."slug" AND pet."status" = 'approved'
ON CONFLICT ("collection_id", "pet_slug") DO UPDATE SET
	"position" = excluded."position";
