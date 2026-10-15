-- Idempotent: this file historically repeated DDL that 0012 and 0013 already
-- apply (the `desktop_launch` enum value and the `gallery_position` column),
-- so a sequential replay aborted at the first duplicate. Guards keep the file
-- safe whether it runs after them or on a database that only ever got 0014.
ALTER TYPE "public"."email_campaign" ADD VALUE IF NOT EXISTS 'desktop_launch';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wechat_qr_uploads" (
	"id" serial PRIMARY KEY NOT NULL,
	"uploaded_by" text NOT NULL,
	"blob_url" text NOT NULL,
	"history_key" text NOT NULL,
	"validation_result" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "submitted_pets" ADD COLUMN IF NOT EXISTS "gallery_position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wechat_qr_uploads_status_idx" ON "wechat_qr_uploads" USING btree ("status","uploaded_at");
