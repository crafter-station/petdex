CREATE TABLE "pending_asset_gc_claims" (
  "key" text PRIMARY KEY NOT NULL,
  "claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pending_asset_gc_claimed_at_idx"
ON "pending_asset_gc_claims" USING btree ("claimed_at");
