// Upstash-backed cache for shared hot reads. Reads gracefully degrade to
// a direct DB call when Redis isn't configured. Writes are best-effort.

import { Redis } from "@upstash/redis";

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? Redis.fromEnv()
    : null;

type CacheOptions = {
  key: string;
  ttlSeconds: number;
};

export async function cachedAggregate<T>(
  options: CacheOptions,
  compute: () => Promise<T>,
): Promise<T> {
  if (!redis) return compute();

  try {
    const cached = await redis.get<T>(options.key);
    if (cached !== null && cached !== undefined) return cached;
  } catch {
    /* fall through to DB */
  }

  const fresh = await compute();
  if (fresh !== null && fresh !== undefined) {
    redis.set(options.key, fresh, { ex: options.ttlSeconds }).catch(() => {
      /* best-effort */
    });
  }
  return fresh;
}

export const AGGREGATE_KEYS = {
  facets: "petdex:agg:facets:v1",
  approvedCount: "petdex:agg:approved-count:v1",
  metricsSummary: "petdex:agg:metrics-summary:v1",
  batches: "petdex:agg:batches:v1",
  variantIndex: "petdex:agg:variant-index:v1",
  approvedCatalog: "petdex:agg:approved-catalog:v1",
  slimManifest: "petdex:agg:slim-manifest:v1",
} as const;

export function petCacheKey(slug: string): string {
  return `petdex:pet:${slug}:v1`;
}

export function collectionBacklinksCacheKey(slug: string): string {
  return `petdex:collection-backlinks:${slug}:v1`;
}

export async function invalidatePetCaches(...slugs: string[]): Promise<void> {
  const keys = slugs.filter(Boolean).map((slug) => petCacheKey(slug));
  if (keys.length > 0) {
    keys.push(AGGREGATE_KEYS.approvedCatalog, AGGREGATE_KEYS.slimManifest);
  }
  await invalidateAggregates(...keys);
}

export async function invalidateCollectionBacklinks(
  ...slugs: string[]
): Promise<void> {
  await invalidateAggregates(
    ...slugs.filter(Boolean).map((slug) => collectionBacklinksCacheKey(slug)),
  );
}

// Next per-instance cache tags paired with each Upstash key. Both
// layers must be invalidated together: Upstash is cross-instance and
// authoritative, but the inner withNextDataCache layer can still serve
// a stale value on a hot lambda and repopulate Upstash with it.
const NEXT_TAGS_FOR_KEY: Record<string, string[]> = {
  [AGGREGATE_KEYS.facets]: ["petdex:facets"],
};

// Invalidate keys after writes that change the aggregate (approve,
// reject, install bump). Clears Upstash + any paired Next cache tag.
// Safe no-op when Redis isn't configured.
export async function invalidateAggregates(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;

  if (redis) {
    try {
      await redis.del(...keys);
    } catch {
      /* best-effort */
    }
  }

  // Clear paired Next cache tags so the inner LRU doesn't re-seed
  // Upstash with a stale value on the next request.
  const tags = new Set<string>();
  for (const key of keys) {
    for (const tag of NEXT_TAGS_FOR_KEY[key] ?? []) tags.add(tag);
  }
  if (tags.size === 0) return;

  try {
    const { revalidateTag } = await import("next/cache");
    // Next 16's `revalidateTag(tag, "max")` is stale-while-revalidate —
    // it marks the entry stale and serves the old value while refreshing
    // in the background. That's the wrong semantics here: after we've
    // already deleted the Upstash value, a background refresh from the
    // inner Next cache would re-seed Upstash with the stale data.
    // `{ expire: 0 }` forces immediate eviction so the next read is a
    // real miss that hits the DB.
    for (const tag of tags) revalidateTag(tag, { expire: 0 });
  } catch {
    /* next/cache unavailable in some runtime contexts (tests, scripts) */
  }
}
