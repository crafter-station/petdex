// All pets — curated and community — live in Postgres after the curated
// backfill (scripts/backfill-curated-to-db.ts). The old `pets.generated.ts`
// JSON dump is only consulted by that backfill script; the rest of the app
// reads from the DB.

import { cache } from "react";

import { and, desc, eq, sql } from "drizzle-orm";

import {
  AGGREGATE_KEYS,
  cachedAggregate,
  petCacheKey,
} from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";
import {
  getMetricsBySlugs,
  getMetricsForSlug,
  type Metrics,
} from "@/lib/db/metrics";
import type { PetdexPet, PetKind, PetVibe } from "@/lib/types";

export type PetWithMetrics = PetdexPet & { metrics: Metrics };

const EMPTY_METRICS: Metrics = {
  installCount: 0,
  zipDownloadCount: 0,
  likeCount: 0,
};

const PET_CACHE_TTL_SECONDS = 300;
const APPROVED_CATALOG_TTL_SECONDS = 300;

type PetRow = Pick<
  typeof schema.submittedPets.$inferSelect,
  | "id"
  | "slug"
  | "displayName"
  | "description"
  | "spritesheetUrl"
  | "petJsonUrl"
  | "zipUrl"
  | "soundUrl"
  | "featured"
  | "kind"
  | "vibes"
  | "tags"
  | "dominantColor"
  | "colorFamily"
  | "creditName"
  | "creditUrl"
  | "creditImage"
  | "source"
  | "approvedAt"
  | "createdAt"
>;

const petColumns = {
  id: true,
  slug: true,
  displayName: true,
  description: true,
  spritesheetUrl: true,
  petJsonUrl: true,
  zipUrl: true,
  soundUrl: true,
  featured: true,
  kind: true,
  vibes: true,
  tags: true,
  dominantColor: true,
  colorFamily: true,
  creditName: true,
  creditUrl: true,
  creditImage: true,
  source: true,
  approvedAt: true,
  createdAt: true,
} as const;

export const getPet = cache(
  async (slug: string): Promise<PetdexPet | undefined> => {
    const pet = await cachedAggregate<PetdexPet | null>(
      { key: petCacheKey(slug), ttlSeconds: PET_CACHE_TTL_SECONDS },
      async () => {
        const row = await db.query.submittedPets.findFirst({
          columns: petColumns,
          where: and(
            eq(schema.submittedPets.slug, slug),
            eq(schema.submittedPets.status, "approved"),
          ),
        });
        return row ? rowToPet(row) : null;
      },
    );
    return pet ?? undefined;
  },
);

export async function getPetWithMetrics(
  slug: string,
): Promise<PetWithMetrics | undefined> {
  const pet = await getPet(slug);
  if (!pet) return undefined;
  const metrics = await getMetricsForSlug(slug);
  return { ...pet, metrics };
}

/** Returns curated/featured slugs for `generateStaticParams`. We only
 *  pre-render featured pets at build time; everything else is rendered
 *  on-demand and revalidated. */
export async function getStaticPetSlugs(): Promise<string[]> {
  const rows = await db
    .select({ slug: schema.submittedPets.slug })
    .from(schema.submittedPets)
    .where(
      and(
        eq(schema.submittedPets.status, "approved"),
        eq(schema.submittedPets.featured, true),
      ),
    );
  return rows.map((r) => r.slug);
}

export async function getFeaturedPetsWithMetrics(
  limit = 6,
): Promise<PetWithMetrics[]> {
  const rows = await db
    .select()
    .from(schema.submittedPets)
    .where(
      and(
        eq(schema.submittedPets.status, "approved"),
        eq(schema.submittedPets.featured, true),
      ),
    )
    .limit(limit);

  if (rows.length === 0) return [];
  const metrics = await getMetricsBySlugs(rows.map((row) => row.slug));
  return rows.map((row) => ({
    ...rowToPet(row),
    metrics: metrics.get(row.slug) ?? EMPTY_METRICS,
  }));
}

export async function getAllApprovedPets(): Promise<PetdexPet[]> {
  return cachedAggregate(
    {
      key: AGGREGATE_KEYS.approvedCatalog,
      ttlSeconds: APPROVED_CATALOG_TTL_SECONDS,
    },
    async () => {
      const rows = await db
        .select()
        .from(schema.submittedPets)
        .where(eq(schema.submittedPets.status, "approved"));
      return rows.map(rowToPet);
    },
  );
}

export type ApprovedPetSlim = {
  slug: string;
  displayName: string;
  kind: PetKind;
  spritesheetUrl: string;
  petJsonUrl: string;
  zipUrl: string | null;
  creditName: string | null;
};

// Slim projection for `/api/manifest` (and any CLI consumer that only
// reads the install metadata). The full-fat row is ~700 bytes serialized;
// this shape is ~200 bytes, which compounds across the CLI traffic that
// hits the slim manifest on every `petdex list` / `petdex install`.
export async function getApprovedPetsForManifest(): Promise<ApprovedPetSlim[]> {
  return cachedAggregate(
    { key: AGGREGATE_KEYS.slimManifest, ttlSeconds: 300 },
    async () => {
      const rows = await db
        .select({
          slug: schema.submittedPets.slug,
          displayName: schema.submittedPets.displayName,
          kind: schema.submittedPets.kind,
          spritesheetUrl: schema.submittedPets.spritesheetUrl,
          petJsonUrl: schema.submittedPets.petJsonUrl,
          zipUrl: schema.submittedPets.zipUrl,
          creditName: schema.submittedPets.creditName,
        })
        .from(schema.submittedPets)
        .where(eq(schema.submittedPets.status, "approved"));
      return rows.map((row) => ({
        slug: row.slug,
        displayName: row.displayName,
        kind: row.kind as PetKind,
        spritesheetUrl: row.spritesheetUrl,
        petJsonUrl: row.petJsonUrl,
        zipUrl: row.zipUrl,
        creditName: row.creditName,
      }));
    },
  );
}

export async function getLatestApprovedPets(limit = 5): Promise<PetdexPet[]> {
  // approved_at is nullable (older curated rows have NULL). NULLS LAST so
  // freshly approved pets surface first; coalesce-on-tie via created_at.
  const rows = await db
    .select()
    .from(schema.submittedPets)
    .where(eq(schema.submittedPets.status, "approved"))
    .orderBy(
      sql`${schema.submittedPets.approvedAt} DESC NULLS LAST`,
      desc(schema.submittedPets.createdAt),
    )
    .limit(limit);
  return rows.map(rowToPet);
}

export async function getApprovedPetsWithMetrics(): Promise<PetWithMetrics[]> {
  const pets = await getAllApprovedPets();
  if (pets.length === 0) return [];
  const metrics = await getMetricsBySlugs(pets.map((p) => p.slug));
  return pets.map((p) => ({
    ...p,
    metrics: metrics.get(p.slug) ?? EMPTY_METRICS,
  }));
}

export async function getApprovedPetCount(): Promise<number> {
  return cachedAggregate(
    { key: AGGREGATE_KEYS.approvedCount, ttlSeconds: 60 },
    async () => {
      const row = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.submittedPets)
        .where(eq(schema.submittedPets.status, "approved"));
      return row[0]?.n ?? 0;
    },
  );
}

export function rowToPet(row: PetRow): PetdexPet {
  const submittedBy = row.creditName
    ? {
        name: row.creditName,
        url: row.creditUrl ?? undefined,
        imageUrl: row.creditImage ?? undefined,
      }
    : undefined;

  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    description: row.description,
    spritesheetPath: row.spritesheetUrl,
    petJsonPath: row.petJsonUrl,
    zipUrl: row.zipUrl,
    soundUrl: row.soundUrl,
    approvalState: "approved",
    featured: row.featured,
    kind: row.kind as PetKind,
    vibes: (row.vibes as PetVibe[]) ?? [],
    tags: (row.tags as string[]) ?? [],
    dominantColor: row.dominantColor,
    colorFamily: row.colorFamily as PetdexPet["colorFamily"],
    submittedBy,
    source: row.source,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    importedAt: row.approvedAt?.toISOString() ?? row.createdAt.toISOString(),
    qa: {},
  };
}
