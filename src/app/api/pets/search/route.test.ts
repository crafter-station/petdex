import * as BunTest from "bun:test";

const { beforeEach, describe, expect, it } = BunTest;
const testMock = (
  BunTest as typeof BunTest & {
    mock: { module: (specifier: string, factory: () => object) => void };
  }
).mock;

const TEST_SEED = "0123456789abcdef";
const DETERMINISTIC_CACHE_CONTROL =
  "public, max-age=300, s-maxage=600, stale-while-revalidate=3600";
const calls: Array<{
  input: {
    cursor?: number;
    limit?: number;
    q?: string;
    shuffleSeed?: string;
    sort?: string;
    spriteVersions?: number[];
  };
  options: { includeTotal?: boolean; includeFacets?: boolean };
}> = [];

testMock.module("@/lib/pet-search", () => ({
  SEARCH_LIMITS: { DEFAULT_LIMIT: 24, MAX_LIMIT: 60 },
  searchPets: async (
    input: {
      cursor?: number;
      limit?: number;
      q?: string;
      shuffleSeed?: string;
      sort?: string;
      spriteVersions?: number[];
    },
    options: { includeTotal?: boolean; includeFacets?: boolean },
  ) => {
    calls.push({ input, options });
    return {
      pets: [],
      total: 0,
      nextCursor: input.cursor ? null : 24,
      searchMode: "all",
      facets: { kinds: {}, vibes: {}, colors: {}, batches: [] },
    };
  },
}));

// Only the seed *source* is stubbed (createShuffleSeed / readShuffleSeed).
// `setShuffleSeedCookie` is the real one, re-exported below: a hand-written
// stub that emits the cookie string the assertion looks for proves only that
// the mock ran, and leaves the real attributes (Path, SameSite, httpOnly,
// Max-Age) unpinned. The real setter writes through NextResponse.cookies.set,
// so the route's Set-Cookie header is genuine.
const realShuffleSeed = await import("@/lib/shuffle-seed");
testMock.module("@/lib/shuffle-seed", () => ({
  ...realShuffleSeed,
  createShuffleSeed: () => TEST_SEED,
  normalizeShuffleSeed: (value: string | null | undefined) =>
    value && /^[a-f0-9]{16}$/.test(value) ? value : null,
  readShuffleSeed: async () => null,
}));

async function search(url: string): Promise<Response> {
  const { GET } = await import("./route");
  return GET(new Request(url));
}

describe("GET /api/pets/search", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("defaults anonymous search to a cacheable deterministic response", async () => {
    const response = await search("https://petdex.local/api/pets/search");
    const body = (await response.json()) as { shuffleSeed?: string };
    const call = calls[0];

    expect(body.shuffleSeed).toBeUndefined();
    expect(response.headers.get("Cache-Control")).toBe(
      DETERMINISTIC_CACHE_CONTROL,
    );
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(call?.input.shuffleSeed).toBeUndefined();
    expect(call?.input.sort).toBe("alpha");
  });

  it("defaults text search to curated so vibe search still runs", async () => {
    const response = await search(
      "https://petdex.local/api/pets/search?q=cozy",
    );
    const body = (await response.json()) as { shuffleSeed?: string };
    const call = calls[0];

    expect(body.shuffleSeed).toBe(TEST_SEED);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Set-Cookie") ?? "").toContain(
      `petdex_shuffle_seed=${TEST_SEED}`,
    );
    expect(call?.input.q).toBe("cozy");
    expect(call?.input.sort).toBe("curated");
    expect(call?.input.shuffleSeed).toBe(TEST_SEED);
  });

  it("keeps explicit sorted text search private", async () => {
    const response = await search(
      "https://petdex.local/api/pets/search?q=cozy&sort=alpha",
    );
    const body = (await response.json()) as { shuffleSeed?: string };
    const call = calls[0];

    expect(body.shuffleSeed).toBeUndefined();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(call?.input.q).toBe("cozy");
    expect(call?.input.sort).toBe("alpha");
    expect(call?.input.shuffleSeed).toBeUndefined();
  });

  it("returns the minted curated seed so no-cookie pagination can reuse it", async () => {
    const first = await search(
      "https://petdex.local/api/pets/search?sort=curated",
    );
    const firstBody = (await first.json()) as { shuffleSeed?: string };
    const firstCall = calls[0];

    expect(firstBody.shuffleSeed).toBe(TEST_SEED);
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
    const cookie = first.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain(`petdex_shuffle_seed=${TEST_SEED}`);
    // The real setter's attributes, not a stub's — Path=/ and SameSite=lax
    // are what let the client reuse the seed on the next page.
    expect(cookie.toLowerCase()).toContain("path=/");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    expect(firstCall?.input.shuffleSeed).toBe(TEST_SEED);

    calls.length = 0;
    const second = await search(
      `https://petdex.local/api/pets/search?sort=curated&cursor=24&includeMeta=0&shuffleSeed=${TEST_SEED}`,
    );
    const secondBody = (await second.json()) as { shuffleSeed?: string };
    const secondCall = calls[0];

    expect(secondBody.shuffleSeed).toBe(TEST_SEED);
    expect(second.headers.get("Set-Cookie")).toBeNull();
    expect(secondCall?.input.cursor).toBe(24);
    expect(secondCall?.input.shuffleSeed).toBe(TEST_SEED);
    expect(secondCall?.options).toEqual({
      includeTotal: false,
      includeFacets: false,
    });
  });

  it("forwards a cursor past the safe range instead of dropping it", async () => {
    // `cursor` is handed to the query as a SQL OFFSET. Unclamped, a value like
    // this one arrives at Postgres as 1e20 and comes back `22003 bigint out of
    // range`, turning a request that only paged too far into a 500 — with the
    // whole statement in the logs. The cap is applied in `searchPets`, which
    // this suite stubs, so what is asserted here is the other half of the
    // contract: the route forwards the raw value rather than dropping or
    // rejecting it, and it is `searchPets` that bounds it. The bound itself is
    // covered by `pet-search-cursor.test.ts`, and that `searchPets` still
    // applies it by `pet-search-cursor-wiring.test.ts`.
    await search(
      "https://petdex.local/api/pets/search?sort=alpha&cursor=99999999999999999999&includeMeta=0",
    );

    // `parseInt` rounds it to the same double Postgres would have rejected.
    expect(calls[0]?.input.cursor).toBe(100000000000000000000);
  });

  it("accepts a smaller static-home cursor before loading the normal page size", async () => {
    const response = await search(
      "https://petdex.local/api/pets/search?sort=alpha&cursor=10&limit=24&includeMeta=0",
    );
    const call = calls[0];

    expect(response.headers.get("Cache-Control")).toBe(
      DETERMINISTIC_CACHE_CONTROL,
    );
    expect(call?.input.cursor).toBe(10);
    expect(call?.input.limit).toBe(24);
    expect(call?.input.sort).toBe("alpha");
    expect(call?.options).toEqual({
      includeTotal: false,
      includeFacets: false,
    });
  });

  it("passes only v1/v2 sprite version filters to search", async () => {
    const response = await search(
      "https://petdex.local/api/pets/search?spriteVersions=1,2,3,x&sort=alpha",
    );
    const call = calls[0];

    expect(response.headers.get("Cache-Control")).toBe(
      DETERMINISTIC_CACHE_CONTROL,
    );
    expect(call?.input.spriteVersions).toEqual([1, 2]);
  });
});
