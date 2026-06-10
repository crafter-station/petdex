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

testMock.module("@/lib/shuffle-seed", () => ({
  createShuffleSeed: () => TEST_SEED,
  normalizeShuffleSeed: (value: string | null | undefined) =>
    value && /^[a-f0-9]{16}$/.test(value) ? value : null,
  readShuffleSeed: async () => null,
  setShuffleSeedCookie: (response: Response, seed: string) => {
    response.headers.append(
      "Set-Cookie",
      `petdex_shuffle_seed=${seed}; Path=/; Max-Age=2592000; SameSite=Lax`,
    );
  },
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
    expect(first.headers.get("Set-Cookie") ?? "").toContain(
      `petdex_shuffle_seed=${TEST_SEED}`,
    );
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
});
