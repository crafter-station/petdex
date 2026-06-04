import { neon } from "@neondatabase/serverless";

import { requiredEnv } from "./env";

const sql = neon(requiredEnv("DATABASE_URL"));

async function tryRun(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.log(`ok   ${label}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      /already exists/i.test(msg) ||
      /duplicate column/i.test(msg) ||
      /duplicate object/i.test(msg)
    ) {
      console.log(`skip ${label} (already exists)`);
    } else {
      throw err;
    }
  }
}

await tryRun(
  "route_cost_buckets table",
  () => sql`
    CREATE TABLE route_cost_buckets (
      id serial PRIMARY KEY,
      bucket_start timestamp with time zone NOT NULL,
      route text NOT NULL,
      route_kind text NOT NULL,
      method text NOT NULL,
      sample_count integer NOT NULL DEFAULT 0,
      estimated_requests integer NOT NULL DEFAULT 0,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    )
  `,
);

await tryRun(
  "route_cost_buckets_bucket_idx",
  () => sql`
    CREATE INDEX route_cost_buckets_bucket_idx
    ON route_cost_buckets (bucket_start)
  `,
);

await tryRun(
  "route_cost_buckets_route_idx",
  () => sql`
    CREATE INDEX route_cost_buckets_route_idx
    ON route_cost_buckets (route, bucket_start)
  `,
);

await tryRun(
  "route_cost_buckets_unique",
  () => sql`
    CREATE UNIQUE INDEX route_cost_buckets_unique
    ON route_cost_buckets (bucket_start, method, route_kind, route)
  `,
);

await tryRun(
  "route_cost_source_buckets table",
  () => sql`
    CREATE TABLE route_cost_source_buckets (
      id serial PRIMARY KEY,
      bucket_start timestamp with time zone NOT NULL,
      route text NOT NULL,
      route_kind text NOT NULL,
      method text NOT NULL,
      traffic_source text NOT NULL DEFAULT 'unknown',
      referrer_source text NOT NULL DEFAULT 'unknown',
      sample_count integer NOT NULL DEFAULT 0,
      estimated_requests integer NOT NULL DEFAULT 0,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    )
  `,
);

await tryRun(
  "route_cost_source_buckets_bucket_idx",
  () => sql`
    CREATE INDEX route_cost_source_buckets_bucket_idx
    ON route_cost_source_buckets (bucket_start)
  `,
);

await tryRun(
  "route_cost_source_buckets_route_idx",
  () => sql`
    CREATE INDEX route_cost_source_buckets_route_idx
    ON route_cost_source_buckets (route, bucket_start)
  `,
);

await tryRun(
  "route_cost_source_buckets_source_idx",
  () => sql`
    CREATE INDEX route_cost_source_buckets_source_idx
    ON route_cost_source_buckets (
      route,
      traffic_source,
      referrer_source,
      bucket_start
    )
  `,
);

await tryRun(
  "route_cost_source_buckets_unique",
  () => sql`
    CREATE UNIQUE INDEX route_cost_source_buckets_unique
    ON route_cost_source_buckets (
      bucket_start,
      method,
      route_kind,
      route,
      traffic_source,
      referrer_source
    )
  `,
);

console.log("done");
