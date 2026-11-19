import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "@/lib/db/schema";

// The metrics route's visibility contract: a withdrawn or rejected pet
// answers 404 like its page does, so a slug dictionary cannot use live
// counters to confirm a takedown (the same signal the like GET closes).
// The suite runs its own PGlite and hands it to the route through the
// client stub, the way every suite linking @/lib/db/client does.
const client = new PGlite();
const testDb = drizzle(client);

mock.module("server-only", () => ({}));
mock.module("@/lib/db/client", () => ({
  db: testDb as never,
  schema,
  executeAtomicReturning: async () => [],
  rowsOf: () => [],
}));
// Every factory spreads the real module: a bare replacement is process-wide
// and starves whichever suite loads next (measured — like and withdraw both
// died on missing exports when this file ran first). The spreads resolve via
// dynamic import *after* the server-only stub registers — a static import
// hoists above the mocks and the real module tree throws on server-only.
const realRatelimit = await import("@/lib/ratelimit");
const realSameOrigin = await import("@/lib/same-origin");
const realMetrics = await import("@/lib/db/metrics");

mock.module("@/lib/ratelimit", () => ({
  ...realRatelimit,
  metricsReadRatelimit: { limit: async () => ({ success: true }) },
}));
mock.module("@/lib/same-origin", () => ({
  ...realSameOrigin,
  requireSameOrigin: () => null,
}));
mock.module("@/lib/db/metrics", () => ({
  ...realMetrics,
  getMetricsForSlug: async () => ({
    installCount: 3,
    zipDownloadCount: 1,
    likeCount: 2,
  }),
  getMetricsSummary: async () => ({ maxLikeCount: 3 }),
}));

const { GET } = await import("@/app/api/pets/[slug]/metrics/route");

function get(slug: string): Promise<Response> {
  return GET(new Request("https://petdex.dev/api/pets/x/metrics"), {
    params: Promise.resolve({ slug }),
  });
}

beforeAll(async () => {
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "submitted_pets" (
      "slug" text PRIMARY KEY,
      "status" text NOT NULL DEFAULT 'approved'
    )
  `);
  await testDb.execute(sql`
    INSERT INTO "submitted_pets" ("slug", "status")
    VALUES ('boba', 'approved'), ('gone', 'rejected')
    ON CONFLICT DO NOTHING
  `);
});

afterAll(async () => {
  await client.close();
});

describe("GET /api/pets/[slug]/metrics", () => {
  it("serves counters for an approved pet", async () => {
    const res = await get("boba");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { likeCount: number }).likeCount).toBe(2);
  });

  it("answers 404 for a rejected pet", async () => {
    const res = await get("gone");
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("answers 404 for a slug that never existed", async () => {
    const res = await get("never-existed");
    expect(res.status).toBe(404);
  });
});
