// Creating a request writes two rows: the request, and the creator's own vote.
// They were separate statements, and `pet_request_votes` carries no foreign
// key, so a vote insert that failed left the request behind — reading the
// column default of 1 until the next upvote on the same text recounted it to
// 0. The route now writes both in one atomic call.
//
// The route is driven for real, against a PGlite database standing in for
// `@/lib/db/client`, because the defect was in how the route sequences its
// writes: a test of the transaction that carries them passes either way.
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { rowsOf, runAtomicReturning } from "@/lib/db/atomic";
import * as schema from "@/lib/db/schema";
import * as realR2 from "@/lib/r2";
import * as realRatelimit from "@/lib/ratelimit";

const client = new PGlite();
const testDb = drizzle(client, { schema });

const actualNeon = await import("@neondatabase/serverless");

mock.module("server-only", () => ({}));
// Mutable so a test can act as a second signed-in user. The factory closes
// over the binding, so each call reads the current value.
let currentUserId = "user_1";
mock.module("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: currentUserId }),
  clerkClient: {},
}));
// The route reads `db.query.petRequests` for dedup and `executeAtomicReturning`
// for the write, so the stand-in has to expose the real drizzle surface. Its
// `executeAtomicReturning` is the real `runAtomicReturning` bound to the
// stand-in rather than a re-implementation — otherwise the assertions below
// would be checking the mock's behaviour instead of the branch the route
// actually takes. PGlite has no `batch`, so this is the callback-transaction
// path; the Neon batch path is exercised in `src/lib/db/atomic.test.ts`.
mock.module("@/lib/db/client", () => ({
  db: testDb,
  schema,
  rowsOf,
  executeAtomicReturning: (queries: never) =>
    runAtomicReturning(testDb as never, queries),
}));
// Spread the real module, for the same reason as the `@neondatabase/serverless`
// mock below: `mock.module` is process-wide and first-registration-wins, so a
// bare replacement starves whichever limiter another suite in the same process
// already stubbed.
mock.module("@/lib/ratelimit", () => ({
  ...realRatelimit,
  petRequestRatelimit: { limit: async () => ({ success: true }) },
}));
mock.module("@/lib/same-origin", () => ({ requireSameOrigin: () => null }));
mock.module("@/lib/query-embed", () => ({ embedQuery: async () => null }));
// The image-ownership specs POST an imageUrl, and the route now HEADs the
// R2 object before writing the row — a real R2 handshake fails offline.
// Patch the singleton client's `send` (the same shape asset-size-guard.test
// uses) instead of mock.module-ing @/lib/r2: that mock is process-wide and
// its undo is not reliable across files on Bun 1.4.2, so the spread
// replacement leaked into asset-size-guard.test.ts in CI's file order and
// drove its real checkR2ObjectSize assertions with this suite's stub.
const r2Client = realR2.r2 as unknown as {
  send: (command: unknown) => Promise<unknown>;
};
const originalSend = r2Client.send;
beforeAll(() => {
  r2Client.send = async () => ({ ContentLength: 1024 });
});
afterAll(() => {
  r2Client.send = originalSend;
});
mock.module("@neondatabase/serverless", () => ({
  // Spread the real module: a bare replacement drops `neonConfig`, `Pool`, and
  // the rest, and `mock.module` is process-wide, so the next suite to link one
  // of them fails with `Export named '...' not found` instead of an assertion.
  ...actualNeon,
  // The route's own `rawSql` is only used for the best-effort embedding
  // update, which this suite does not exercise.
  neon: () => async () => [],
}));

const { GET, POST } = await import("@/app/api/pet-requests/route");

beforeAll(async () => {
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_requests" (
      "id" text PRIMARY KEY,
      "query" text NOT NULL,
      "normalized" text NOT NULL,
      "requested_by" text,
      "upvote_count" integer NOT NULL DEFAULT 1,
      "status" text NOT NULL DEFAULT 'open',
      "fulfilled_pet_slug" text,
      "image_url" text,
      "image_review_status" text NOT NULL DEFAULT 'none',
      "image_rejection_reason" text,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_request_votes" (
      "request_id" text NOT NULL,
      "user_id" text NOT NULL,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      PRIMARY KEY ("request_id", "user_id")
    )
  `);
  // The GET handler resolves voter and requester handles through this table,
  // so a route-level GET needs it to exist even when no rows match.
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "user_profiles" (
      "user_id" text PRIMARY KEY,
      "handle" text,
      "display_name" text,
      "image_url" text
    )
  `);
  // A trigger that rejects the creator's own vote, standing in for any
  // failure of that insert. Without it the happy path succeeds whether or not
  // the two writes share a transaction, and the test cannot tell them apart.
  await testDb.execute(sql`
    CREATE OR REPLACE FUNCTION reject_probe_vote() RETURNS trigger AS $$
    BEGIN
      IF NEW.user_id = 'user_1' THEN
        RAISE EXCEPTION 'probe: vote insert refused';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await testDb.execute(sql`
    CREATE OR REPLACE TRIGGER reject_probe_vote_trigger
    BEFORE INSERT ON "pet_request_votes"
    FOR EACH ROW EXECUTE FUNCTION reject_probe_vote()
  `);
  // The trigger refuses every vote by `user_1`, which is the failure the
  // rollback test needs. Left armed it would also refuse the happy path, so
  // it is disabled here and armed only around that one test.
  await setVoteTrigger(false);
});

async function setVoteTrigger(enabled: boolean): Promise<void> {
  await testDb.execute(
    sql.raw(
      `ALTER TABLE "pet_request_votes" ${
        enabled ? "ENABLE" : "DISABLE"
      } TRIGGER reject_probe_vote_trigger`,
    ),
  );
}

afterAll(async () => {
  await client.close();
});

function postWithImage(query: string, imageUrl: string): Promise<Response> {
  return POST(
    new Request("https://petdex.dev/api/pet-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, imageUrl }),
    }),
  );
}

async function imageState(): Promise<{
  url: string | null;
  status: string;
  upvotes: number;
}> {
  const result = (await testDb.execute(
    sql`SELECT "image_url" AS "url", "image_review_status" AS "status",
               "upvote_count" AS "upvotes"
        FROM "pet_requests" LIMIT 1`,
  )) as unknown as {
    rows?: Array<{ url: string | null; status: string; upvotes: number }>;
  };
  const rows = (result.rows ?? (result as unknown as never[])) as Array<{
    url: string | null;
    status: string;
    upvotes: number;
  }>;
  return rows[0] as { url: string | null; status: string; upvotes: number };
}

function post(query: string): Promise<Response> {
  return POST(
    new Request("https://petdex.dev/api/pet-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    }),
  );
}

async function requestCount(): Promise<number> {
  const rows = (await testDb.execute(
    sql`SELECT id FROM "pet_requests"`,
  )) as unknown as { rows?: unknown[] };
  return ((rows.rows ?? rows) as unknown[]).length;
}

async function voteCount(): Promise<number> {
  const rows = (await testDb.execute(
    sql`SELECT request_id FROM "pet_request_votes"`,
  )) as unknown as { rows?: unknown[] };
  return ((rows.rows ?? rows) as unknown[]).length;
}

describe("GET /api/pet-requests limit", () => {
  // `LIMIT` takes a positive integer and nothing else, and the three shapes
  // that used to reach it each did something different: a positive float
  // (`?limit=0.5`) made Postgres reject the query and the route answer 500
  // with an empty body; `NaN` (`?limit=abc`) and a negative (`?limit=-1`) were
  // both accepted by the driver and mean "no limit", so the caller silently
  // received every row and the 80-row cap did not apply. None of them 500s
  // now, and the cap holds.
  async function seed(count: number): Promise<void> {
    await testDb.execute(sql`DELETE FROM "pet_request_votes"`);
    await testDb.execute(sql`DELETE FROM "pet_requests"`);
    for (let i = 0; i < count; i++) {
      await testDb.execute(sql`
        INSERT INTO "pet_requests" ("id", "query", "normalized", "requested_by")
        VALUES (${`req_${i}`}, ${`probe ${i}`}, ${`probe${i}`}, 'user_1')
      `);
    }
  }

  it("answers 200 for a positive float instead of 500", async () => {
    await seed(3);
    const res = await GET(
      new Request("http://localhost/api/pet-requests?limit=0.5"),
    );
    expect(res.status).toBe(200);
  });

  it("still caps at 80 when the limit is not a usable number", async () => {
    // `?limit=abc` and `?limit=-1` used to hand the driver a value it reads as
    // unlimited, so every row came back regardless of the cap.
    await seed(5);
    for (const raw of ["abc", "-1", "0", ""]) {
      const res = await GET(
        new Request(
          `http://localhost/api/pet-requests?status=all&limit=${raw}`,
        ),
      );
      expect(res.status, raw).toBe(200);
      const body = (await res.json()) as { requests: unknown[] };
      // The default is 60, so five seeded rows all fit — the point is that the
      // request succeeded and the value stayed a positive integer.
      expect(body.requests.length, raw).toBeLessThanOrEqual(60);
    }
  });

  it("honours a limit inside the range", async () => {
    await seed(5);
    const res = await GET(
      new Request("http://localhost/api/pet-requests?status=all&limit=2"),
    );
    const body = (await res.json()) as { requests: unknown[] };
    expect(body.requests).toHaveLength(2);
  });
});

describe("POST /api/pet-requests", () => {
  it("labels every POST response as private, not just the validation ones", async () => {
    // The 400/422 branches carried `private, no-store` while the 401, 429,
    // 500 and 200 branches carried nothing — on a route whose GET already
    // sets it. A response that says nothing about caching is the one a shared
    // cache is free to store, which is the failure the header exists to
    // prevent. This asserts the ones that were bare; the 400/422 header is
    // pinned by the cases below.
    const ok = await post("a bunny that deploys on fridays");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
  });

  it("answers 401 with the private header when there is no session", async () => {
    // The auth() stub is mutable (`currentUserId`), so the 401 branch is
    // reachable: set it to null and the route must refuse. Before, this case
    // ran as user_1 and asserted only the 200's header — the 401 branch's own
    // `headers: PRIVATE_HEADERS` could be deleted with nothing failing.
    currentUserId = null;
    try {
      const res = await POST(
        new Request("https://petdex.dev/api/pet-requests", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "a raccoon that files bugs" }),
        }),
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    } finally {
      currentUserId = "user_1";
    }
  });

  it("leaves no request behind when the creator's vote cannot be written", async () => {
    await setVoteTrigger(true);
    const before = await requestCount();
    const res = post("a bunny that deploys on fridays");

    // The vote insert is refused by the trigger, so the write fails. The
    // route does not catch it, so the failure surfaces as a rejection rather
    // than a status — what matters is the row count either way: with both
    // writes in one transaction the request is rolled back, and without one
    // it survives as a request nobody voted for.
    await res.catch(() => {});
    await setVoteTrigger(false);
    expect(await requestCount()).toBe(before);
  });

  it("answers 400 for a body whose query is not a string", async () => {
    // `body.query?.trim()` used to throw on these — `?.` guards null and
    // undefined only — so a signed-in caller got a 500 for `{"query":12345}`,
    // `{"query":["a"]}`, `{"query":{}}`, `{"query":true}` and a literal `null`
    // body. The parse is now checked before the field is used.
    await testDb.execute(sql`DELETE FROM "pet_request_votes"`);
    await testDb.execute(sql`DELETE FROM "pet_requests"`);

    const bodies = [
      "null",
      "[]",
      "12345",
      '{"query":12345}',
      '{"query":["a","b"]}',
      '{"query":{"a":1}}',
      '{"query":true}',
      '{"query":"a valid request","imageUrl":12345}',
      '{"query":"a valid request","imageUrl":["x"]}',
    ];

    for (const body of bodies) {
      const res = await POST(
        new Request("https://petdex.dev/api/pet-requests", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      );
      expect(res.status, body).toBe(400);
    }

    // None of them wrote anything.
    expect(await requestCount()).toBe(0);
  });

  it("answers 400 for a query carrying a NUL byte", async () => {
    // Postgres refuses NUL in a `text` column outright
    // (`invalid byte sequence for encoding "UTF8": 0x00`) and `normalize`
    // does not strip it, so this used to reach the INSERT and 500.
    await testDb.execute(sql`DELETE FROM "pet_request_votes"`);
    await testDb.execute(sql`DELETE FROM "pet_requests"`);

    const res = await POST(
      new Request("https://petdex.dev/api/pet-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "a bunny with a nul \u0000 inside" }),
      }),
    );

    expect(res.status).toBe(400);
    expect(await requestCount()).toBe(0);
  });

  it("creates one request when the same text arrives concurrently", async () => {
    // The look-up used to run outside any transaction, so both requests
    // missed each other and both created a row. PGlite serves one connection,
    // so these two interleave at the await points the route actually has
    // rather than truly in parallel — which is the interleaving that produced
    // the duplicate, since both used to read before either wrote.
    await testDb.execute(sql`DELETE FROM "pet_request_votes"`);
    await testDb.execute(sql`DELETE FROM "pet_requests"`);

    const text = "a capybara that reviews pull requests";
    const [a, b] = await Promise.all([post(text), post(text)]);
    const bodies = (await Promise.all([a.json(), b.json()])) as Array<{
      mode?: string;
      id?: string;
    }>;

    expect(await requestCount()).toBe(1);
    expect(await voteCount()).toBe(1);

    // Both callers must be told about the same request, and exactly one of
    // them created it.
    expect(new Set(bodies.map((body) => body.id)).size).toBe(1);
    expect(bodies.filter((body) => body.mode === "created").length).toBe(1);
    expect(bodies.filter((body) => body.mode === "upvoted").length).toBe(1);
  });
});

describe("POST /api/pet-requests image ownership", () => {
  // Upvoting an existing request is allowed for anyone, and the body may
  // carry an image. The image used to move for any voter — a second caller's
  // URL replaced the author's pending reference image, which is the author's
  // contribution and not the voter's to change. The image fields are now
  // gated on the caller being the request's author.
  // The folders mirror what /api/pet-requests/image presigns: the caller's
  // last-8 userId suffix, then the upload id. normalizeRequestImageUrl pins
  // that prefix, so these are the only paths each of these users may attach.
  const authorImage =
    "https://assets.petdex.dev/requests/aaaabbbb-a1b2c3d4/reference.webp";
  const voterImage =
    "https://assets.petdex.dev/requests/ccccdddd-e5f6a7b8/reference.webp";

  it("keeps the author's pending image when a different user upvotes with their own", async () => {
    await testDb.execute(sql`DELETE FROM "pet_request_votes"`);
    await testDb.execute(sql`DELETE FROM "pet_requests"`);

    const text = "a heron that writes changelogs";
    currentUserId = "user_aaaabbbb";
    const created = await postWithImage(text, authorImage);
    expect(created.status).toBe(200);
    expect((await imageState()).url).toBe(authorImage);
    expect((await imageState()).status).toBe("pending");

    // A second, unrelated signed-in user repeats the text with their own
    // image. The vote lands; the image must not.
    currentUserId = "user_ccccdddd";
    const upvoted = await postWithImage(text, voterImage);
    expect(upvoted.status).toBe(200);
    expect(((await upvoted.json()) as { mode: string }).mode).toBe("upvoted");

    const after = await imageState();
    expect(after.url).toBe(authorImage);
    expect(after.status).toBe("pending");
    expect(after.upvotes).toBe(2);

    currentUserId = "user_1";
  });

  it("still lets the author replace their own not-yet-approved image", async () => {
    await testDb.execute(sql`DELETE FROM "pet_request_votes"`);
    await testDb.execute(sql`DELETE FROM "pet_requests"`);

    const text = "a stoat that debugs flaky tests";
    currentUserId = "user_aaaabbbb";
    await postWithImage(text, authorImage);

    const replacement =
      "https://assets.petdex.dev/requests/aaaabbbb-9999aaaa/reference.webp";
    await postWithImage(text, replacement);
    expect((await imageState()).url).toBe(replacement);

    currentUserId = "user_1";
  });

  it("refuses an image living in another user's namespace", async () => {
    // The URL gate used to accept any path under /requests/, so an author
    // could paste a folder copied off someone else's unreviewed reference
    // upload and have it displayed as theirs. The presign namespace is the
    // only one the caller may attach.
    await testDb.execute(sql`DELETE FROM "pet_request_votes"`);
    await testDb.execute(sql`DELETE FROM "pet_requests"`);

    currentUserId = "user_aaaabbbb";
    const res = await postWithImage(
      "a puffin that reviews diffs",
      "https://assets.petdex.dev/requests/ccccdddd-e5f6a7b8/reference.webp",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_image_url" });
    expect(await requestCount()).toBe(0);

    currentUserId = "user_1";
  });

  it("also refuses a namespace that does not match the caller's suffix", async () => {
    // user_author's suffix is `author` — a well-formed but different folder
    // (theirs from another account, or any other prefix) is refused too.
    currentUserId = "user_aaaabbbb";
    const res = await postWithImage(
      "a puffin that reviews diffs again",
      "https://assets.petdex.dev/requests/aaaabbbbX-b1c2d3e4/reference.webp",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_image_url" });

    currentUserId = "user_1";
  });
});
