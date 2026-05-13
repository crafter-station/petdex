import { cache } from "react";

import { eq, inArray, sql } from "drizzle-orm";

import {
  AGGREGATE_KEYS,
  cachedAggregate,
  invalidateAggregates,
  invalidateMetricCaches,
  petMetricsCacheKey,
} from "./cached-aggregates";
import { db, schema } from "./client";

const PET_METRICS_TTL_SECONDS = 60;
const METRICS_INDEX_TTL_SECONDS = 60;
const METRICS_INDEX_MIN_BATCH_SIZE = 50;

type MetricsIndexRow = {
  petSlug: string;
  installCount: number;
  zipDownloadCount: number;
  likeCount: number;
};

export async function incrementInstallCount(slug: string): Promise<void> {
  await db
    .insert(schema.petMetrics)
    .values({
      petSlug: slug,
      installCount: 1,
      lastInstalledAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.petMetrics.petSlug,
      set: {
        installCount: sql`${schema.petMetrics.installCount} + 1`,
        lastInstalledAt: new Date(),
        updatedAt: new Date(),
      },
    });
  // maxInstallCount in the cached summary may have moved.
  await Promise.all([
    invalidateAggregates(
      AGGREGATE_KEYS.metricsSummary,
      AGGREGATE_KEYS.metricsIndex,
    ),
    invalidateMetricCaches(slug),
  ]);
}

export async function incrementZipDownloadCount(slug: string): Promise<void> {
  await db
    .insert(schema.petMetrics)
    .values({
      petSlug: slug,
      zipDownloadCount: 1,
    })
    .onConflictDoUpdate({
      target: schema.petMetrics.petSlug,
      set: {
        zipDownloadCount: sql`${schema.petMetrics.zipDownloadCount} + 1`,
        updatedAt: new Date(),
      },
    });
  await Promise.all([
    invalidateAggregates(AGGREGATE_KEYS.metricsIndex),
    invalidateMetricCaches(slug),
  ]);
}

export async function setLikeCount(slug: string, count: number): Promise<void> {
  await db
    .insert(schema.petMetrics)
    .values({ petSlug: slug, likeCount: count })
    .onConflictDoUpdate({
      target: schema.petMetrics.petSlug,
      set: { likeCount: count, updatedAt: new Date() },
    });
  // maxLikeCount in the cached summary may have moved.
  await Promise.all([
    invalidateAggregates(
      AGGREGATE_KEYS.metricsSummary,
      AGGREGATE_KEYS.metricsIndex,
    ),
    invalidateMetricCaches(slug),
  ]);
}

export type Metrics = {
  installCount: number;
  zipDownloadCount: number;
  likeCount: number;
};

export type MetricsSummary = {
  maxInstallCount: number;
  maxLikeCount: number;
};

/**
 * @deprecated Reads the entire pet_metrics table — drove ~20 GB/month of
 * Neon egress when called per-request. Prefer `getMetricsBySlugs(slugs)`,
 * which only loads the rows you actually need.
 */
export async function getAllMetrics(): Promise<Map<string, Metrics>> {
  const rows = await getMetricsIndexRows();
  const map = new Map<string, Metrics>();
  for (const row of rows) {
    map.set(row.petSlug, {
      installCount: row.installCount,
      zipDownloadCount: row.zipDownloadCount,
      likeCount: row.likeCount,
    });
  }
  return map;
}

export async function getMetricsBySlugs(
  slugs: string[],
): Promise<Map<string, Metrics>> {
  if (slugs.length === 0) return new Map();
  if (slugs.length >= METRICS_INDEX_MIN_BATCH_SIZE) {
    const index = await getAllMetrics();
    const map = new Map<string, Metrics>();
    for (const slug of slugs) {
      const metrics = index.get(slug);
      if (metrics) map.set(slug, metrics);
    }
    return map;
  }
  const rows = await db
    .select()
    .from(schema.petMetrics)
    .where(inArray(schema.petMetrics.petSlug, slugs));
  const map = new Map<string, Metrics>();
  for (const row of rows) {
    map.set(row.petSlug, {
      installCount: row.installCount,
      zipDownloadCount: row.zipDownloadCount,
      likeCount: row.likeCount,
    });
  }
  return map;
}

const getMetricsIndexRows = cache(async (): Promise<MetricsIndexRow[]> => {
  return cachedAggregate(
    {
      key: AGGREGATE_KEYS.metricsIndex,
      ttlSeconds: METRICS_INDEX_TTL_SECONDS,
    },
    async () => {
      const rows = await db.select().from(schema.petMetrics);
      return rows.map((row) => ({
        petSlug: row.petSlug,
        installCount: row.installCount,
        zipDownloadCount: row.zipDownloadCount,
        likeCount: row.likeCount,
      }));
    },
  );
});

export async function getMetricsForSlug(slug: string): Promise<Metrics> {
  return cachedAggregate(
    { key: petMetricsCacheKey(slug), ttlSeconds: PET_METRICS_TTL_SECONDS },
    async () => {
      const row = await db.query.petMetrics.findFirst({
        where: (t, { eq }) => eq(t.petSlug, slug),
      });
      return {
        installCount: row?.installCount ?? 0,
        zipDownloadCount: row?.zipDownloadCount ?? 0,
        likeCount: row?.likeCount ?? 0,
      };
    },
  );
}

export async function getMetricsSummary(): Promise<MetricsSummary> {
  return cachedAggregate(
    { key: AGGREGATE_KEYS.metricsSummary, ttlSeconds: 60 },
    async () => {
      const [row] = await db
        .select({
          maxInstallCount: sql<number>`coalesce(max(${schema.petMetrics.installCount}), 0)::int`,
          maxLikeCount: sql<number>`coalesce(max(${schema.petMetrics.likeCount}), 0)::int`,
        })
        .from(schema.petMetrics)
        .innerJoin(
          schema.submittedPets,
          eq(schema.petMetrics.petSlug, schema.submittedPets.slug),
        )
        .where(eq(schema.submittedPets.status, "approved"));

      return {
        maxInstallCount: row?.maxInstallCount ?? 0,
        maxLikeCount: row?.maxLikeCount ?? 0,
      };
    },
  );
}
