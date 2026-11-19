// The toggle branch used to insert without `onConflictDoNothing`, while the
// explicit-like branch beside it had it. `pet_likes` carries a
// (user_id, pet_slug) primary key, and the `existing` read runs outside any
// transaction, so two requests that both missed the row — a double-click, or
// a retry — both inserted and the second raised `duplicate key value violates
// unique constraint` instead of answering "liked".
//
// The route is driven for real against PGlite so the constraint that made the
// second insert fail is the one the test exercises, not a stand-in for it.
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { rowsOf, runAtomicReturning } from "@/lib/db/atomic";
import * as schema from "@/lib/db/schema";
import * as realRatelimit from "@/lib/ratelimit";

const client = new PGlite();
const testDb = drizzle(client, { schema });

mock.module("server-only", () => ({}));
mock.module("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user_1" }),
}));
mock.module("@/lib/db/client", () => ({
  db: testDb,
  schema,
  // The real runner over the suite's PGlite: the POST path now recounts the
  // like count inside executeAtomicReturning, and a stub returning [] would
  // drive every count assertion to 0 for the wrong reason.
  executeAtomicReturning: (queries: never) =>
    runAtomicReturning(testDb as never, queries),
  // The real `rowsOf`, not a stand-in: the toggle branch decides `liked` from
  // what this reads off the DELETE/INSERT statement, so a stub returning `[]`
  // would make the assertion below pass for the wrong reason.
  rowsOf,
}));
mock.module("@/lib/db/metrics", () => ({
  setLikeCount: async () => {},
}));
// `mock.module` is process-wide and first-registration-wins, so replacing the
// module wholesale would starve whichever factory another suite in the same
// process already stubbed — `bun run test a b` then fails with "Export named
// 'xRatelimit' not found". Spreading the real module keeps every other
// limiter intact and only overrides the one this route reads.
let publicCatalogAllowed = true;
mock.module("@/lib/ratelimit", () => ({
  ...realRatelimit,
  likeRatelimit: { limit: async () => ({ success: true }) },
  publicCatalogRatelimit: {
    limit: async () => ({ success: publicCatalogAllowed }),
  },
}));
mock.module("@/lib/same-origin", () => ({ requireSameOrigin: () => null }));

const { GET, POST } = await import("@/app/api/pets/[slug]/like/route");

beforeAll(async () => {
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "submitted_pets" (
      "slug" text PRIMARY KEY,
      "status" text NOT NULL DEFAULT 'approved'
    )
  `);
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_likes" (
      "user_id" text NOT NULL,
      "pet_slug" text NOT NULL,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      PRIMARY KEY ("user_id", "pet_slug")
    )
  `);
  await testDb.execute(
    sql`INSERT INTO "submitted_pets" ("slug") VALUES ('boba') ON CONFLICT DO NOTHING`,
  );
});

afterAll(async () => {
  await client.close();
});

function toggle(liked?: boolean): Promise<Response> {
  return POST(
    new Request("https://petdex.dev/api/pets/boba/like", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // No `liked` field is the toggle path — the one that used to insert
      // unguarded. Passing `liked: true` takes a different branch that always
      // had the conflict guard, so it would not exercise the fix.
      body: JSON.stringify(liked === undefined ? {} : { liked }),
    }),
    { params: Promise.resolve({ slug: "boba" }) },
  );
}

async function likeCount(): Promise<number> {
  const rows = (await testDb.execute(
    sql`SELECT user_id FROM "pet_likes" WHERE pet_slug = 'boba'`,
  )) as unknown as { rows?: unknown[] };
  return ((rows.rows ?? rows) as unknown[]).length;
}

describe("POST /api/pets/[slug]/like", () => {
  it("answers liked when the same like arrives twice concurrently", async () => {
    await testDb.execute(sql`DELETE FROM "pet_likes"`);

    // Both requests ask to like, which is what the UI sends (`{liked: true}`
    // from like-button-auth.tsx) — the toggle form is only the no-field
    // default. Without the conflict guard the second insert throws.
    const [a, b] = await Promise.all([toggle(true), toggle(true)]);
    const bodies = (await Promise.all([a.json(), b.json()])) as Array<{
      liked?: boolean;
      error?: string;
    }>;

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(bodies.every((body) => body.liked === true)).toBe(true);
    expect(await likeCount()).toBe(1);
  });

  it("reports the state the write produced for an explicit like", async () => {
    await testDb.execute(sql`DELETE FROM "pet_likes"`);

    const like = await toggle(true);
    expect(((await like.json()) as { liked: boolean }).liked).toBe(true);
    expect(await likeCount()).toBe(1);

    // Asking to like again is idempotent and still reports liked — the old
    // code echoed the request, so this passed then too; what changed is that
    // the answer now comes from the write.
    const again = await toggle(true);
    expect(((await again.json()) as { liked: boolean }).liked).toBe(true);
    expect(await likeCount()).toBe(1);
  });

  it("refuses a malformed body instead of toggling the like", async () => {
    await testDb.execute(sql`DELETE FROM "pet_likes"`);
    await toggle(true);

    for (const body of ["{", '{"liked":"yes"}', '{"liked":1}', "[]", "null"]) {
      const res = await POST(
        new Request("https://petdex.dev/api/pets/boba/like", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
        { params: Promise.resolve({ slug: "boba" }) },
      );
      expect(res.status, body).toBe(400);
    }

    // The like that was there is still there: none of the above flipped it.
    expect(await likeCount()).toBe(1);
  });

  it("toggles when the body names no target, and reports the delete's outcome", async () => {
    await testDb.execute(sql`DELETE FROM "pet_likes"`);

    // `toggle()` with no argument sends `{}` — the no-field branch, which is
    // the one that decides `liked` from the delete's outcome. Nothing else in
    // this file reached it: every other call passes an explicit `liked`, and
    // deleting the whole branch left this suite green.
    const on = await toggle();
    expect(((await on.json()) as { liked: boolean }).liked).toBe(true);
    expect(await likeCount()).toBe(1);

    const off = await toggle();
    expect(((await off.json()) as { liked: boolean }).liked).toBe(false);
    expect(await likeCount()).toBe(0);
  });

  // The toggle's answer has to be the delete's outcome, not the insert's, and
  // the two only disagree when a concurrent request's uncommitted INSERT makes
  // `removed` empty while a row is in fact present. PGlite cannot produce that
  // state — it runs queries one at a time, so two "concurrent" calls never
  // interleave — and the race was measured on real Postgres instead (every
  // round had a caller report the wrong final state under the old shape).
  // What is left to pin here is which CTE the answer is read from.
  it("reads the toggle answer from the delete, not from the insert", async () => {
    // Resolved from this file rather than the cwd: the suite has to read the
    // same source whether it is run from the repo root or from a
    // subdirectory, and a relative path silently found no file from `src/`.
    const source = readFileSync(
      join(import.meta.dir, "route.ts"),
      "utf8",
    ).replace(/\s+/g, " ");

    expect(source).toContain(
      'SELECT (SELECT count(*)::int FROM removed) = 0 AS "liked"',
    );
    // The insert's own RETURNING is what the answer must NOT come from.
    expect(source).not.toContain("FROM ins) > 0");
  });

  it("reports false for an explicit unlike and leaves no row", async () => {
    await testDb.execute(sql`DELETE FROM "pet_likes"`);
    await toggle(true);

    const unlike = await toggle(false);
    expect(((await unlike.json()) as { liked: boolean }).liked).toBe(false);
    expect(await likeCount()).toBe(0);

    // Unliking something already unliked is a no-op, not an error.
    const again = await toggle(false);
    expect(((await again.json()) as { liked: boolean }).liked).toBe(false);
    expect(await likeCount()).toBe(0);
  });
});

describe("GET /api/pets/[slug]/like", () => {
  it("returns the count for a valid slug", async () => {
    publicCatalogAllowed = true;
    const res = await GET(
      new Request("https://petdex.dev/api/pets/boba/like"),
      {
        params: Promise.resolve({ slug: "boba" }),
      },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { count: number }).count).toBe(0);
  });

  it("rejects an invalid slug with 400 before any DB work", async () => {
    publicCatalogAllowed = true;
    const res = await GET(
      new Request("https://petdex.dev/api/pets/..%2F/like"),
      { params: Promise.resolve({ slug: "../etc" }) },
    );
    expect(res.status).toBe(400);
  });

  it("answers 404 for a slug that is not approved", async () => {
    publicCatalogAllowed = true;
    await testDb.execute(
      sql`INSERT INTO "submitted_pets" ("slug", "status") VALUES ('gone', 'rejected') ON CONFLICT DO NOTHING`,
    );
    const res = await GET(
      new Request("https://petdex.dev/api/pets/gone/like"),
      {
        params: Promise.resolve({ slug: "gone" }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("answers 429 when the public catalog limiter refuses", async () => {
    publicCatalogAllowed = false;
    const res = await GET(
      new Request("https://petdex.dev/api/pets/boba/like"),
      {
        params: Promise.resolve({ slug: "boba" }),
      },
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    publicCatalogAllowed = true;
  });
});
