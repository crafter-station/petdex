import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "@/lib/db/schema";

// The suite runs its own PGlite connection; the client stub below hands the
// real drizzle instance to the route so db.select executes against it.
const client = new PGlite();
const testDb = drizzle(client);

// The route reads auth() and rate limits at import time through @/lib/db/client,
// which hard-fails without DATABASE_URL — stub both the way every suite that
// links that module does (mock.module is process-wide, first registration wins,
// so the schema export stays real and the helpers stay named).
mock.module("server-only", () => ({}));
mock.module("@/lib/db/client", () => ({
  db: testDb as never,
  schema,
  executeAtomicReturning: async () => [],
  rowsOf: () => [],
}));
mock.module("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user_test" }),
}));
mock.module("@/lib/ratelimit", () => ({
  profileEditRatelimit: { limit: async () => ({ success: true }) },
}));
mock.module("@/lib/same-origin", () => ({ requireSameOrigin: () => null }));

const { PATCH } = await import("@/app/api/profile/gallery-order/route");

function request(order: string[]): Promise<Response> {
  return PATCH(
    new Request("https://petdex.dev/api/profile/gallery-order", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order }),
    }),
    undefined as never,
  );
}

async function positions(): Promise<Array<{ slug: string; pos: number }>> {
  const rows = await testDb.execute(
    sql`SELECT slug, gallery_position AS pos FROM submitted_pets ORDER BY gallery_position ASC`,
  );
  return (
    (rows as { rows?: Array<{ slug: string; pos: number }> }).rows ?? []
  ).map((r) => ({ slug: r.slug, pos: Number(r.pos) }));
}

beforeAll(async () => {
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "submitted_pets" (
      "slug" text PRIMARY KEY,
      "owner_id" text NOT NULL,
      "status" text NOT NULL DEFAULT 'approved',
      "gallery_position" integer NOT NULL DEFAULT 0
    )
  `);
  for (const slug of ["a", "b", "c", "d"]) {
    await testDb.execute(
      sql`INSERT INTO "submitted_pets" ("slug", "owner_id") VALUES (${slug}, 'user_test') ON CONFLICT DO NOTHING`,
    );
  }
});

afterAll(async () => {
  await client.close();
});

describe("PATCH /api/profile/gallery-order", () => {
  it("pushes unlisted pets behind the ordered block, keeping their prior relative order", async () => {
    // Seed an arbitrary prior order so "existing relative order" has data to
    // preserve: d was first, b second, c third, a never ranked.
    await testDb.execute(sql`
      UPDATE "submitted_pets" SET "gallery_position" =
        CASE slug WHEN 'd' THEN 1 WHEN 'b' THEN 2 WHEN 'c' THEN 3 ELSE 0 END
    `);

    const res = await request(["a"]);
    expect(res.status).toBe(200);

    const rows = await positions();
    expect(rows.map((r) => r.slug)).toEqual(["a", "d", "b", "c"]);
  });

  it("orders the listed block by request order, not alphabetically", async () => {
    await testDb.execute(
      sql`UPDATE "submitted_pets" SET "gallery_position" = 0`,
    );

    const res = await request(["c", "a"]);
    expect(res.status).toBe(200);

    const rows = await positions();
    expect(rows.map((r) => r.slug)).toEqual(["c", "a", "b", "d"]);
  });

  it("rejects an order containing nobody else's pets with a 400", async () => {
    const res = await request(["not-mine"]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "no_owned_pets_in_order",
    );
  });
});
