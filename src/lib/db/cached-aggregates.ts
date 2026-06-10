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
  metricsIndex: "petdex:agg:metrics-index:v1",
  featuredPets: "petdex:agg:featured-pets:v1",
  dexNumbers: "petdex:agg:dex-numbers:v2",
  randomPetPool: "petdex:agg:random-pet-pool:v1",
  latestApprovedPets: "petdex:agg:latest-approved-pets:v1",
} as const;

export function petCacheKey(slug: string): string {
  return `petdex:pet:${slug}:v1`;
}

export function collectionBacklinksCacheKey(slug: string): string {
  return `petdex:collection-backlinks:${slug}:v1`;
}

export function petMetricsCacheKey(slug: string): string {
  return `petdex:metrics:${slug}:v1`;
}

export function petOwnerCreditCacheKey(slug: string): string {
  return `petdex:pet-owner-credit:${slug}:v1`;
}

export function publicProfileCacheKey(userId: string): string {
  return `petdex:profile:${userId}:v1`;
}

export function handleForUserCacheKey(userId: string): string {
  return `petdex:handle-for-user:${userId}:v1`;
}

export function userIdForHandleCacheKey(handle: string): string {
  return `petdex:user-id-for-handle:${handle.trim().toLowerCase()}:v1`;
}

export async function invalidatePetCaches(...slugs: string[]): Promise<void> {
  const keys = slugs.filter(Boolean).map((slug) => petCacheKey(slug));
  if (keys.length > 0) {
    keys.push(
      ...slugs.filter(Boolean).map((slug) => petOwnerCreditCacheKey(slug)),
    );
    keys.push(
      AGGREGATE_KEYS.approvedCatalog,
      AGGREGATE_KEYS.slimManifest,
      AGGREGATE_KEYS.featuredPets,
      AGGREGATE_KEYS.dexNumbers,
      AGGREGATE_KEYS.randomPetPool,
      AGGREGATE_KEYS.latestApprovedPets,
    );
  }
  await invalidateAggregates(...keys);
  await revalidatePetTags(...slugs);
}

// Page-level ISR invalidation for the pet detail + listing pages. Paired
// with invalidatePetCaches so any caller that flushes Upstash also flushes
// the Next data cache tags (`pet:${slug}`, `pet:list`) used to wrap getPet,
// getApprovedPetsWithMetrics, getFeaturedPetsWithMetrics, getAllApprovedPets
// in src/lib/pets.ts. Without this the 24h revalidate ceiling held stale
// shells even after the Upstash layer was cleared.
export async function revalidatePetTags(...slugs: string[]): Promise<void> {
  const cleanSlugs = slugs.filter(Boolean);
  if (cleanSlugs.length === 0) return;
  try {
    const { revalidateTag } = await import("next/cache");
    for (const slug of cleanSlugs) revalidateTag(`pet:${slug}`, "max");
    revalidateTag("pet:list", "max");
  } catch {
    /* next/cache unavailable in some runtime contexts (tests, scripts) */
  }
}

// Page-level ISR invalidation for the collections list + detail pages.
// Pair with any pet_collections / pet_collection_items write path that
// changes user-visible content. Without this the same 24h ceiling
// problem applies to /collections and /collections/[slug].
export async function revalidateCollectionTags(
  ...slugs: string[]
): Promise<void> {
  try {
    const { revalidateTag } = await import("next/cache");
    for (const slug of slugs.filter(Boolean)) {
      revalidateTag(`collection:${slug}`, "max");
    }
    revalidateTag("collection:list", "max");
  } catch {
    /* next/cache unavailable in some runtime contexts (tests, scripts) */
  }
}

export async function invalidateMetricCaches(
  ...slugs: string[]
): Promise<void> {
  await invalidateAggregates(
    ...slugs.filter(Boolean).map((slug) => petMetricsCacheKey(slug)),
  );
}

export async function invalidatePublicProfileCaches(
  ...userIds: string[]
): Promise<void> {
  const cleanUserIds = userIds.filter(Boolean);
  await invalidateAggregates(
    ...cleanUserIds.flatMap((userId) => [
      publicProfileCacheKey(userId),
      handleForUserCacheKey(userId),
    ]),
  );
  await expireNextCacheTags(
    ...cleanUserIds.map((userId) => `petdex:profile:${userId}`),
  );
}

export async function invalidatePublicHandleCaches(
  ...handles: Array<string | null | undefined>
): Promise<void> {
  await invalidateAggregates(
    ...handles
      .filter((handle): handle is string => Boolean(handle))
      .map((handle) => userIdForHandleCacheKey(handle)),
  );
}

export async function invalidateCollectionBacklinks(
  ...slugs: string[]
): Promise<void> {
  const cleanSlugs = slugs.filter(Boolean);
  await invalidateAggregates(
    ...cleanSlugs.map((slug) => collectionBacklinksCacheKey(slug)),
  );
  await expireNextCacheTags(
    ...cleanSlugs.map((slug) => `collection:backlinks:${slug}`),
  );
}

// Next per-instance cache tags paired with each Upstash key. Both
// layers must be invalidated together: Upstash is cross-instance and
// authoritative, but the inner withNextDataCache layer can still serve
// a stale value on a hot lambda and repopulate Upstash with it.
const NEXT_TAGS_FOR_KEY: Record<string, string[]> = {
  [AGGREGATE_KEYS.facets]: ["petdex:facets"],
  [AGGREGATE_KEYS.dexNumbers]: ["petdex:dex"],
  [AGGREGATE_KEYS.variantIndex]: ["petdex:variant-index"],
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

  await expireNextCacheTags(...tags);
}

async function expireNextCacheTags(...tags: string[]): Promise<void> {
  const cleanTags = tags.filter(Boolean);
  if (cleanTags.length === 0) return;

  try {
    const { revalidateTag } = await import("next/cache");
    for (const tag of cleanTags) revalidateTag(tag, { expire: 0 });
  } catch {
    /* next/cache unavailable in some runtime contexts (tests, scripts) */
  }
}
