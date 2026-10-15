// Two defects in this route shared one shape: the body was an unchecked cast.
// `req.json()` resolves `null` for a literal `null` body without throwing, so
// `"all" in null` raised a TypeError and the route 500'd; and `ids` went
// straight into `inArray` with no ceiling, so each element became a bind
// parameter and a hand-rolled request could walk past Postgres' parameter
// limit. Both are driven here against PGlite so the statement that consumed
// the body is the real one, not a stand-in.
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "@/lib/db/schema";

const client = new PGlite();
const testDb = drizzle(client, { schema });

mock.module("server-only", () => ({}));
mock.module("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user_1" }),
}));
mock.module("@/lib/db/client", () => ({
  db: testDb,
  schema,
  // Named because mock.module is process-wide and first-registration-wins:
  // a suite that links these off this module fails with a SyntaxError, and
  // src/lib/db-client-mock-shape.test.ts asserts every factory provides them.
  executeAtomicReturning: async () => [],
  rowsOf: () => [],
}));
mock.module("@/lib/same-origin", () => ({ requireSameOrigin: () => null }));

const { POST } = await import("@/app/api/notifications/read/route");

beforeAll(async () => {
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "notifications" (
      "id" text PRIMARY KEY,
      "user_id" text NOT NULL,
      "kind" text NOT NULL,
      "payload" jsonb NOT NULL,
      "href" text NOT NULL,
      "read_at" timestamp with time zone,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
});

afterAll(async () => {
  await client.close();
});

function post(body: string): Promise<Response> {
  return POST(
    new Request("https://petdex.dev/api/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
}

async function seed(ids: string[]): Promise<void> {
  await testDb.execute(sql`DELETE FROM "notifications"`);
  for (const id of ids) {
    await testDb.execute(
      sql`INSERT INTO "notifications" ("id", "user_id", "kind", "payload", "href")
          VALUES (${id}, 'user_1', 'pet_approved', '{}'::jsonb, '/')`,
    );
  }
}

async function unreadCount(): Promise<number> {
  const rows = (await testDb.execute(
    sql`SELECT id FROM "notifications" WHERE "read_at" IS NULL`,
  )) as unknown as { rows?: unknown[] };
  return ((rows.rows ?? rows) as unknown[]).length;
}

describe("POST /api/notifications/read", () => {
  it("refuses a non-object body instead of raising on it", async () => {
    await seed(["n1"]);

    // `null` is the one that used to 500 — `"all" in null` is a TypeError.
    // The rest guard the same boundary from the other side.
    for (const body of ["null", "[]", '"all"', "42", "true"]) {
      const res = await post(body);
      expect(res.status, body).toBe(400);
      expect(((await res.json()) as { error: string }).error, body).toBe(
        "invalid_body",
      );
    }

    // Nothing above marked the seeded row read.
    expect(await unreadCount()).toBe(1);
  });

  it("marks every unread notification read for { all: true }", async () => {
    await seed(["n1", "n2"]);
    const res = await post(JSON.stringify({ all: true }));
    expect(res.status).toBe(200);
    expect(await unreadCount()).toBe(0);
  });

  it("marks only the named ids read", async () => {
    await seed(["n1", "n2", "n3"]);
    const res = await post(JSON.stringify({ ids: ["n1", "n3"] }));
    expect(res.status).toBe(200);

    const rows = (await testDb.execute(
      sql`SELECT "id" FROM "notifications" WHERE "read_at" IS NULL`,
    )) as unknown as { rows?: { id: string }[] };
    const unread = ((rows.rows ?? rows) as { id: string }[]).map((r) => r.id);
    expect(unread).toEqual(["n2"]);
  });

  it("refuses an id list past the parameter ceiling instead of truncating it", async () => {
    // Each id is one bind parameter for `inArray`. The route used to mark the
    // first 200 and answer `ok`, which reads as success while the tail was
    // never touched. It now refuses the whole request, so nothing is read.
    const ids = Array.from({ length: 1000 }, (_, i) => `n${i}`);
    await seed(ids);

    const res = await post(JSON.stringify({ ids }));
    expect(res.status).toBe(400);
    expect(await unreadCount()).toBe(1000);
  });

  it("rejects an ids array with nothing usable in it", async () => {
    await seed(["n1"]);
    for (const body of [{ ids: [] }, { ids: [1, 2, 3] }, { ids: null }]) {
      const res = await post(JSON.stringify(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await unreadCount()).toBe(1);
  });
});
