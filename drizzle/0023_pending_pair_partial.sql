-- The pair index used to carry `status` as a third column (see 0003). That
-- does not free the pair when a decision is made — it replaces the 'pending'
-- row's slot with a 'rejected' one, so a second rejection of the same
-- (collection, pet) pair collides and the decision UPDATE raises a
-- duplicate-key error. The partial predicate is what actually frees it.
-- `drizzle-kit push` (what dev and deploy run) already reads the corrected
-- shape from schema.ts; this migration exists so a database built from
-- drizzle/*.sql gets the same one.
DROP INDEX IF EXISTS "pet_collection_requests_pending_pair";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pet_collection_requests_pending_pair"
  ON "pet_collection_requests" USING btree ("collection_id", "pet_slug")
  WHERE "status" = 'pending';
