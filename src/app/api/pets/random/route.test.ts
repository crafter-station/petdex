// The shuffle pill is a plain `<a href="/api/pets/random">`, so a click
// without JS lands on this route's 302. Building that `Location` from
// `req.url` made it follow the request's own host, which is a header the
// caller chooses: a request claiming `Host: evil.example.com` was answered
// with a redirect to `evil.example.com`. These pin the origin to the app's
// canonical one instead.
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "@/lib/db/schema";

const client = new PGlite();
const testDb = drizzle(client, { schema });

mock.module("server-only", () => ({}));
mock.module("@/lib/db/client", () => ({
  db: testDb,
  schema,
  rowsOf: () => [],
  executeAtomicReturning: async () => [],
}));

// The pool is read through `cachedAggregate`, which short-circuits to Redis
// whenever `UPSTASH_REDIS_REST_URL` is set. Mocking only `@/lib/db/client`
// therefore left this suite reading the shared cache instead of the PGlite
// seed above — and, because `cachedAggregate` writes back what it computed,
// it also stored this suite's single fake pet under the real
// `petdex:agg:random-pet-pool:v2` key. Under `bun test` with no Redis env it
// passed by accident; with `.env.deploy.local` (or any real Upstash) it
// asserted against whatever was cached. Bypass the cache so the seed is the
// only source of pets.
mock.module("@/lib/db/cached-aggregates", () => ({
  cachedAggregate: <T>(_options: unknown, compute: () => Promise<T>) =>
    compute(),
  AGGREGATE_KEYS: { randomPetPool: "petdex:agg:random-pet-pool:v2" },
}));

const { GET } = await import("./route");

beforeAll(async () => {
  // Only the columns the pool query reads, named as the schema names them.
  await testDb.execute(
    `CREATE TABLE IF NOT EXISTS "submitted_pets" (
       "id" text PRIMARY KEY,
       "slug" text NOT NULL,
       "display_name" text NOT NULL,
       "description" text NOT NULL,
       "spritesheet_url" text NOT NULL,
       "status" text NOT NULL,
       "source" text NOT NULL DEFAULT 'submit'
     )`,
  );
  await testDb.execute(
    `INSERT INTO "submitted_pets" ("id","slug","display_name","description","spritesheet_url","status","source")
     VALUES ('p1','byte-bunny','Byte Bunny','A bunny','/pets/byte-bunny.png','approved','submit')`,
  );
});

afterAll(async () => {
  await client.close();
});

/** The origin the route redirected to, or null when it did not redirect. */
async function redirectOrigin(requestOrigin: string): Promise<string | null> {
  const res = await GET(new Request(`${requestOrigin}/api/pets/random`));
  if (res.status !== 302) return null;
  const location = res.headers.get("location");
  return location ? new URL(location).origin : null;
}

describe("GET /api/pets/random redirect origin", () => {
  it("uses the canonical origin for a host that is not the app's", async () => {
    expect(await redirectOrigin("https://evil.example.com")).toBe(
      "https://petdex.dev",
    );
  });

  it("keeps a loopback host so local development stays local", async () => {
    expect(await redirectOrigin("http://localhost:3100")).toBe(
      "http://localhost:3100",
    );
  });

  it("keeps the bracketed IPv6 loopback", async () => {
    // `new URL(...).hostname` brackets an IPv6 literal, so the entry has to be
    // `[::1]`; a bare `"::1"` in the set would never match and this host would
    // be redirected to production mid-development.
    expect(await redirectOrigin("http://[::1]:3100")).toBe("http://[::1]:3100");
  });

  it("prefers PETDEX_URL when it is configured", async () => {
    process.env.PETDEX_URL = "https://staging.petdex.dev";
    try {
      expect(await redirectOrigin("https://evil.example.com")).toBe(
        "https://staging.petdex.dev",
      );
    } finally {
      delete process.env.PETDEX_URL;
    }
  });

  it("falls back rather than throwing when PETDEX_URL is malformed", async () => {
    process.env.PETDEX_URL = "not a url";
    try {
      expect(await redirectOrigin("https://evil.example.com")).toBe(
        "https://petdex.dev",
      );
    } finally {
      delete process.env.PETDEX_URL;
    }
  });

  // `new URL("data:text/html,hi").origin` is the string `"null"`, not a URL.
  // Returning it and building `new URL("/pets/x", "null")` throws, so a
  // misconfigured scheme took the whole shuffle route down with a 500 instead
  // of degrading to the canonical origin.
  for (const scheme of [
    "data:text/html,hi",
    "file:///etc/passwd",
    "javascript:alert(1)",
  ]) {
    it(`falls back when PETDEX_URL has no origin (${scheme.split(":")[0]}:)`, async () => {
      process.env.PETDEX_URL = scheme;
      try {
        // The assertion that matters is that the route answers a 302 with a
        // usable Location, not that it throws while building one.
        expect(await redirectOrigin("https://evil.example.com")).toBe(
          "https://petdex.dev",
        );
      } finally {
        delete process.env.PETDEX_URL;
      }
    });
  }

  it("answers JSON with a relative href, which needs no origin", async () => {
    const res = await GET(
      new Request("https://evil.example.com/api/pets/random", {
        headers: { accept: "application/json" },
      }),
    );
    const body = (await res.json()) as { href: string };
    expect(body.href).toBe("/pets/byte-bunny");
  });

  it("labels the empty-pool JSON body with the same cache headers as a hit", async () => {
    // The 302 branches and the JSON hit branch all carried a `Cache-Control`
    // and `Vary: Accept`; the JSON empty-pool 404 carried neither, so it was
    // the one unlabelled response on a route whose whole content depends on
    // the `Accept` header. `?exclude=` the only seeded pet to empty the pool
    // without mutating the table.
    const res = await GET(
      new Request(
        "https://evil.example.com/api/pets/random?exclude=byte-bunny",
        { headers: { accept: "application/json" } },
      ),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=30, s-maxage=60, stale-while-revalidate=300",
    );
    expect(res.headers.get("vary")).toBe("Accept");
  });
});
