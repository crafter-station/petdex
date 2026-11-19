// Anonymous endpoint, so every field on the body is attacker-chosen. `?.`
// guards null/undefined only: `{"email": 5}` reached `.trim` on a number and
// threw, 500ing the route. The sibling `message`/`kind` fields already
// coerced with `String(...)`; this pins that email and pageUrl do too, and
// that the coerced values are what land in the row.
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "@/lib/db/schema";

const client = new PGlite();
const testDb = drizzle(client, { schema });

mock.module("server-only", () => ({}));
mock.module("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: null }),
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
mock.module("@/lib/neon-ratelimit", () => ({
  createNeonRatelimit: () => ({ limit: async () => ({ success: true }) }),
}));

const { POST } = await import("@/app/api/feedback/route");

type FeedbackRow = {
  email: string | null;
  page_url: string | null;
  message: string;
};

beforeAll(async () => {
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "feedback" (
      "id" text PRIMARY KEY,
      "kind" text NOT NULL DEFAULT 'suggestion',
      "status" text NOT NULL DEFAULT 'pending',
      "message" text NOT NULL,
      "email" text,
      "page_url" text,
      "user_agent" text,
      "user_id" text,
      "notify_email" boolean NOT NULL DEFAULT true,
      "addressed_at" timestamp with time zone,
      "archived_at" timestamp with time zone,
      "admin_note" text,
      "user_last_read_at" timestamp with time zone,
      "admin_last_read_at" timestamp with time zone,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
});

afterAll(async () => {
  await client.close();
});

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("https://petdex.dev/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

async function latest(): Promise<FeedbackRow> {
  const rows = (await testDb.execute(
    sql`SELECT "email", "page_url", "message" FROM "feedback" ORDER BY "created_at" DESC LIMIT 1`,
  )) as unknown as { rows?: FeedbackRow[] };
  return ((rows.rows ?? rows) as FeedbackRow[])[0] as FeedbackRow;
}

describe("POST /api/feedback", () => {
  it("coerces a non-string email and pageUrl instead of throwing", async () => {
    await testDb.execute(sql`DELETE FROM "feedback"`);

    // `email: 5` used to raise `.trim is not a function` and 500. Coerced it
    // becomes "5", which the format check then rejects — a 400, and no row.
    const badEmail = await post({
      message: "The picker loses my selection",
      email: 5,
    });
    expect(badEmail.status).toBe(400);
    expect(((await badEmail.json()) as { error: string }).error).toBe(
      "invalid_email",
    );

    // A non-string pageUrl has no format check to fall into, so it is
    // coerced and stored as text — the point is that the request answers.
    const res = await post({
      message: "The picker loses my selection",
      pageUrl: { href: "x" },
    });
    expect(res.status).toBe(200);
    expect((await latest()).page_url).toBe("[object Object]");
  });

  it("keeps a well-formed email and trims it", async () => {
    await testDb.execute(sql`DELETE FROM "feedback"`);
    const res = await post({
      message: "Love the new gallery",
      email: "  dev@example.com  ",
      pageUrl: "  /pets/boba  ",
    });
    expect(res.status).toBe(200);

    const row = await latest();
    expect(row.email).toBe("dev@example.com");
    expect(row.page_url).toBe("/pets/boba");
  });

  it("rejects a malformed email rather than storing it", async () => {
    await testDb.execute(sql`DELETE FROM "feedback"`);
    const res = await post({ message: "hello there", email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_email",
    );
  });
});
