CREATE TABLE "telemetry_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"install_id" text NOT NULL,
	"event" text NOT NULL,
	"cli_version" text,
	"binary_version" text,
	"os" text,
	"arch" text,
	"agents" jsonb,
	"state" text,
	"agent_source" text,
	"country" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "telemetry_install_id_idx" ON "telemetry_events" USING btree ("install_id");--> statement-breakpoint
CREATE INDEX "telemetry_event_idx" ON "telemetry_events" USING btree ("event");--> statement-breakpoint
CREATE INDEX "telemetry_created_at_idx" ON "telemetry_events" USING btree ("created_at");
