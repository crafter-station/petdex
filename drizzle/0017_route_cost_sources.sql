CREATE TABLE "route_cost_source_buckets" (
  "id" serial PRIMARY KEY NOT NULL,
  "bucket_start" timestamp with time zone NOT NULL,
  "route" text NOT NULL,
  "route_kind" text NOT NULL,
  "method" text NOT NULL,
  "traffic_source" text DEFAULT 'unknown' NOT NULL,
  "referrer_source" text DEFAULT 'unknown' NOT NULL,
  "sample_count" integer DEFAULT 0 NOT NULL,
  "estimated_requests" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "route_cost_source_buckets_bucket_idx" ON "route_cost_source_buckets" USING btree ("bucket_start");
--> statement-breakpoint
CREATE INDEX "route_cost_source_buckets_route_idx" ON "route_cost_source_buckets" USING btree ("route","bucket_start");
--> statement-breakpoint
CREATE INDEX "route_cost_source_buckets_source_idx" ON "route_cost_source_buckets" USING btree ("route","traffic_source","referrer_source","bucket_start");
--> statement-breakpoint
CREATE UNIQUE INDEX "route_cost_source_buckets_unique" ON "route_cost_source_buckets" USING btree ("bucket_start","method","route_kind","route","traffic_source","referrer_source");
