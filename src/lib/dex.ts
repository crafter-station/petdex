// Pokédex-style canonical numbering. Each approved pet gets a stable
// number derived from its position in `approved_at ASC`, so the first
// pet ever approved is #001, the next #002, and so on. Discovered
// rows that haven't been claimed don't earn a slot — the dex reflects
// pets with a known author. Once a discovered row flips to `claimed`
// the source filter lets it in.
//
// Why ROW_NUMBER vs a frozen `dex_number` column:
//   - 312 approved rows today; query is fast.
//   - Avoids a write path on approve + a backfill migration.
//   - Re-numbers if a pet gets unapproved/deleted; for an album that
//     reflects "currently in the catalog" this is what we want. If
//     we ever need post-removal stable numbers (e.g. a deleted #042
//     never returns) we can freeze with a column later.

import { cache } from "react";

import { sql } from "drizzle-orm";

import { AGGREGATE_KEYS, cachedAggregate } from "@/lib/db/cached-aggregates";
import { db } from "@/lib/db/client";
import { withNextDataCache } from "@/lib/next-data-cache";

export type DexEntry = { slug: string; dexNumber: number };
const DEX_NUMBERS_TTL_SECONDS = 300;

const getDexEntries = withNextDataCache(
  async (): Promise<DexEntry[]> => {
    return cachedAggregate(
      {
        key: AGGREGATE_KEYS.dexNumbers,
        ttlSeconds: DEX_NUMBERS_TTL_SECONDS,
      },
      async () => {
        const result = (await db.execute(sql`
        SELECT slug,
               ROW_NUMBER() OVER (ORDER BY approved_at ASC, created_at ASC)::int AS dex_number
        FROM submitted_pets
        WHERE status = 'approved'
          AND source <> 'discover'
      `)) as unknown as {
          rows: Array<{ slug: string; dex_number: number }>;
        };

        return result.rows.map((row) => ({
          slug: row.slug,
          dexNumber: row.dex_number,
        }));
      },
    );
  },
  ["petdex-dex-numbers"],
  { tags: ["petdex:dex"], revalidate: 300 },
);

// Cached for the lifetime of a single render pass — every call inside
// one request returns the same Map without rebuilding it. The underlying
// ROW_NUMBER query is cached across requests by Next's data cache.
export const getDexNumberMap = cache(async (): Promise<Map<string, number>> => {
  const out = new Map<string, number>();
  for (const row of await getDexEntries()) {
    out.set(row.slug, row.dexNumber);
  }
  return out;
});

// Convenience for callers that only need one slug. Still goes through
// the cached map so calling it N times in one render is one query.
export async function getDexNumber(slug: string): Promise<number | null> {
  const map = await getDexNumberMap();
  return map.get(slug) ?? null;
}

// Total album size — the denominator in "23/312". Cached alongside the
// map; same render pass = same number.
export const getDexTotal = cache(async (): Promise<number> => {
  const map = await getDexNumberMap();
  return map.size;
});

// Format a dex number for UI: "001", "042", "9999". Pads to 3 digits
// while we have <1000 pets, then naturally widens. Keep this as the
// single source of truth so we don't get inconsistent paddings across
// surfaces.
export function formatDexNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  return n < 1000 ? n.toString().padStart(3, "0") : n.toString();
}

// Adjacent slugs in dex order, for prev/next navigation on the pet
// detail page. Returns nulls at the boundaries so the caller can hide
// the chevron rather than render a dead link.
export async function getDexNeighbors(
  slug: string,
): Promise<{ prev: string | null; next: string | null }> {
  const map = await getDexNumberMap();
  const target = map.get(slug);
  if (!target) return { prev: null, next: null };

  let prevSlug: string | null = null;
  let nextSlug: string | null = null;
  for (const [s, n] of map.entries()) {
    if (n === target - 1) prevSlug = s;
    if (n === target + 1) nextSlug = s;
  }
  return { prev: prevSlug, next: nextSlug };
}
