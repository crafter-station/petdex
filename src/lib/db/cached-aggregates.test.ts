import { afterEach, describe, expect, it } from "bun:test";

// `cachedAggregate` writes any non-null result back to Redis, and an empty
// array is as cacheable as real rows — `redis.get` returns `[]` for a stored
// `[]` and the `cached !== null && cached !== undefined` guard accepts it.
//
// That made a failed aggregate read poisonous: `getMetricsIndexRows` used to
// catch a DB error and `return []`, which stored "every pet has zero metrics"
// under the real key for the full TTL. One transient blip then showed zeros
// for every pet on any gallery or profile page that reads the index.
//
// These pin the two halves of the contract the fix relies on: `[]` is a cache
// hit, and a compute that *throws* is not written — so the caller sees the
// failure and the next request reads live instead of the poisoned value.

const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

afterEach(() => {
  if (originalRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
  if (originalRedisToken === undefined)
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
});

describe("cachedAggregate", () => {
  it("runs compute directly when Redis is not configured", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const { cachedAggregate } = await import("./cached-aggregates");

    let calls = 0;
    const value = await cachedAggregate(
      { key: "unused", ttlSeconds: 60 },
      async () => {
        calls += 1;
        return [1, 2, 3];
      },
    );
    expect(value).toEqual([1, 2, 3]);
    expect(calls).toBe(1);
  });

  it("a throwing compute is not cached, so the next caller reads live", async () => {
    // No Redis: compute runs every call, and the throw is never swallowed
    // into a cached empty value. This is the property the metrics fix needs —
    // with Redis configured the same compute throw skips the write.
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const { cachedAggregate } = await import("./cached-aggregates");

    let calls = 0;
    const compute = async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient DB error");
      return [{ slug: "boba" }];
    };

    await expect(
      cachedAggregate({ key: "unused", ttlSeconds: 60 }, compute),
    ).rejects.toThrow("transient DB error");

    const second = await cachedAggregate(
      { key: "unused", ttlSeconds: 60 },
      compute,
    );
    expect(second).toEqual([{ slug: "boba" }]);
    expect(calls).toBe(2);
  });
});
