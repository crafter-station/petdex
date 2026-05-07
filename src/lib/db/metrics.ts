import { inArray, sql } from "drizzle-orm";

import { db, schema } from "./client";

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
}

export async function setLikeCount(
  slug: string,
  count: number,
): Promise<void> {
  await db
    .insert(schema.petMetrics)
    .values({ petSlug: slug, likeCount: count })
    .onConflictDoUpdate({
      target: schema.petMetrics.petSlug,
      set: { likeCount: count, updatedAt: new Date() },
    });
}

export type Metrics = {
  installCount: number;
  zipDownloadCount: number;
  likeCount: number;
};

export async function getAllMetrics(): Promise<Map<string, Metrics>> {
  const rows = await db.select().from(schema.petMetrics);
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

export async function getMetricsForSlug(slug: string): Promise<Metrics> {
  const row = await db.query.petMetrics.findFirst({
    where: (t, { eq }) => eq(t.petSlug, slug),
  });
  return {
    installCount: row?.installCount ?? 0,
    zipDownloadCount: row?.zipDownloadCount ?? 0,
    likeCount: row?.likeCount ?? 0,
  };
}
