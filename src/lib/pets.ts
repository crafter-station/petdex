// All pets — curated and community — live in Postgres after the curated
// backfill (scripts/backfill-curated-to-db.ts). The old `pets.generated.ts`
// JSON dump is only consulted by that backfill script; the rest of the app
// reads from the DB.

import { cacheLife, cacheTag } from "next/cache";

import { and, eq, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import {
  getAllMetrics,
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

export async function getPet(slug: string): Promise<PetdexPet | undefined> {
  "use cache";
  cacheLife("hours");
  cacheTag("gallery");
  cacheTag(`pet:${slug}`);

  const row = await db.query.submittedPets.findFirst({
    where: and(
      eq(schema.submittedPets.slug, slug),
      eq(schema.submittedPets.status, "approved"),
    ),
  });
  return row ? rowToPet(row) : undefined;
}

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
  "use cache";
  cacheLife("hours");
  cacheTag("gallery");

  const rows = await db
    .select({ slug: schema.submittedPets.slug })
    .from(schema.submittedPets)
    .where(
      and(
        eq(schema.submittedPets.status, "approved"),
        eq(schema.submittedPets.featured, true),
      ),
    );
  const slugs = rows.map((r) => r.slug);
  return slugs.length > 0 ? slugs : ["boba"];
}

export async function getFeaturedPetsWithMetrics(
  limit = 6,
): Promise<PetWithMetrics[]> {
  "use cache";
  cacheLife("hours");
  cacheTag("gallery");

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
  const metrics = await getAllMetrics();
  return rows.map((row) => ({
    ...rowToPet(row),
    metrics: metrics.get(row.slug) ?? EMPTY_METRICS,
  }));
}

export async function getAllApprovedPets(): Promise<PetdexPet[]> {
  "use cache";
  cacheLife("hours");
  cacheTag("gallery");

  const rows = await db
    .select()
    .from(schema.submittedPets)
    .where(eq(schema.submittedPets.status, "approved"));
  return rows.map(rowToPet);
}

export async function getApprovedPetsWithMetrics(): Promise<PetWithMetrics[]> {
  "use cache";
  cacheLife("hours");
  cacheTag("gallery");

  const pets = await getAllApprovedPets();
  if (pets.length === 0) return [];
  const metrics = await getAllMetrics();
  return pets.map((p) => ({
    ...p,
    metrics: metrics.get(p.slug) ?? EMPTY_METRICS,
  }));
}

export async function getApprovedPetCount(): Promise<number> {
  "use cache";
  cacheLife("hours");
  cacheTag("gallery");

  const row = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.submittedPets)
    .where(eq(schema.submittedPets.status, "approved"));
  return row[0]?.n ?? 0;
}

export function rowToPet(
  row: typeof schema.submittedPets.$inferSelect,
): PetdexPet {
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
