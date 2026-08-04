ALTER TABLE "submitted_pets" ADD COLUMN "sprite_version_number" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "submitted_pets" ADD COLUMN "pending_sprite_version_number" integer;
--> statement-breakpoint
ALTER TABLE "submitted_pets" ADD CONSTRAINT "submitted_pets_sprite_version_number_check" CHECK ("sprite_version_number" IN (1, 2));
--> statement-breakpoint
ALTER TABLE "submitted_pets" ADD CONSTRAINT "submitted_pets_pending_sprite_version_number_check" CHECK ("pending_sprite_version_number" IS NULL OR "pending_sprite_version_number" IN (1, 2));
--> statement-breakpoint
CREATE INDEX "submitted_pets_status_sprite_version_idx" ON "submitted_pets" USING btree ("status", "sprite_version_number");
