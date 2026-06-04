// Creator leaderboard queries.
//
// All metrics exclude `source = 'discover'` rows so admin-imported pets
// (where ownerId points at the importer, not the artist) don't poison
// the ranking. They re-enter once the original author claims them.
// Admins themselves are also filtered out — the leaderboard exists to
// surface community creators, not the team running the catalog.

import { sql } from "drizzle-orm";

import { getAdminUserIds } from "@/lib/admin";
import { db } from "@/lib/db/client";

export type LeaderboardMetric =
  | "pets"
  | "likes"
  | "installs"
  | "rising"
  | "collectors";

export type LeaderboardRow = {
  ownerId: string;
  // The metric value the row was ranked by — number of pets, likes, installs,
  // or recent approvals. Same name regardless of variant so the renderer
  // can be metric-agnostic.
  value: number;
  // Secondary stats kept in every variant for context, in case we want to
  // show "21 pets · 624 installs · 11 likes" on every row.
  approvedCount: number;
  totalLikes: number;
  totalInstalls: number;
  totalDownloads: number;
};

const TOP_LIMIT = 50;

// Defensive: this guarantees the leaderboard never lists somebody at #1
// with `0`. We don't want a "no signal yet" scoreboard on top of nothing.
const MIN_VALUE = 1;

export async function getLeaderboard(
  metric: LeaderboardMetric,
): Promise<LeaderboardRow[]> {
  const result = (await db.execute(
    metric === "rising"
      ? risingQuery()
      : metric === "collectors"
        ? collectorsQuery()
        : aggregateQuery(metric),
  )) as unknown as {
    rows: Array<{
      owner_id: string;
      value: string | number;
      approved_count: string | number;
      total_likes: string | number;
      total_installs: string | number;
      total_downloads: string | number;
    }>;
  };

  const adminIds = getAdminUserIds();
  return result.rows
    .map((row) => ({
      ownerId: row.owner_id,
      value: Number(row.value),
      approvedCount: Number(row.approved_count),
      totalLikes: Number(row.total_likes),
      totalInstalls: Number(row.total_installs),
      totalDownloads: Number(row.total_downloads),
    }))
    .filter((r) => r.value >= MIN_VALUE && !adminIds.has(r.ownerId));
}

function aggregateQuery(
  metric: Exclude<LeaderboardMetric, "rising" | "collectors">,
) {
  // value is the column we ORDER BY. tie-breakers always cascade through
  // approved_count -> total_likes so two creators with the same headline
  // metric still get a deterministic order.
  const valueExpr = (() => {
    switch (metric) {
      case "pets":
        return sql`COUNT(*) FILTER (WHERE sp.status='approved')`;
      case "likes":
        return sql`COALESCE(SUM(pm.like_count), 0)`;
      case "installs":
        return sql`COALESCE(SUM(pm.install_count), 0)`;
    }
  })();

  return sql`
    SELECT
      sp.owner_id                                                    AS owner_id,
      ${valueExpr}::bigint                                            AS value,
      COUNT(*) FILTER (WHERE sp.status='approved')::bigint            AS approved_count,
      COALESCE(SUM(pm.like_count), 0)::bigint                         AS total_likes,
      COALESCE(SUM(pm.install_count), 0)::bigint                      AS total_installs,
      COALESCE(SUM(pm.zip_download_count), 0)::bigint                 AS total_downloads
    FROM submitted_pets sp
    LEFT JOIN pet_metrics pm ON pm.pet_slug = sp.slug
    WHERE sp.source <> 'discover'
    GROUP BY sp.owner_id
    HAVING ${valueExpr} > 0
    ORDER BY value DESC, approved_count DESC, total_likes DESC
    LIMIT ${TOP_LIMIT}
  `;
}

function collectorsQuery() {
  return sql`
    SELECT
      pl.user_id                                      AS owner_id,
      COUNT(DISTINCT pl.pet_slug)::bigint            AS value,
      COUNT(DISTINCT pl.pet_slug)::bigint            AS approved_count,
      0::bigint                                      AS total_likes,
      0::bigint                                      AS total_installs,
      0::bigint                                      AS total_downloads
    FROM pet_likes pl
    INNER JOIN submitted_pets sp ON sp.slug = pl.pet_slug
    WHERE sp.status = 'approved'
    GROUP BY pl.user_id
    HAVING COUNT(DISTINCT pl.pet_slug) > 0
    ORDER BY value DESC, owner_id ASC
    LIMIT ${TOP_LIMIT}
  `;
}

function risingQuery() {
  // "Rising" = approved pets in the last 7 days. Metric is recent count;
  // we still surface lifetime stats so a brand-new creator with 1 pet
  // doesn't outrank a returning vet with 3 in the same week unless they
  // genuinely shipped more this week.
  return sql`
    SELECT
      sp.owner_id                                                                            AS owner_id,
      COUNT(*) FILTER (
        WHERE sp.status='approved' AND sp.approved_at > now() - interval '7 days'
      )::bigint                                                                              AS value,
      COUNT(*) FILTER (WHERE sp.status='approved')::bigint                                   AS approved_count,
      COALESCE(SUM(pm.like_count), 0)::bigint                                                AS total_likes,
      COALESCE(SUM(pm.install_count), 0)::bigint                                             AS total_installs,
      COALESCE(SUM(pm.zip_download_count), 0)::bigint                                        AS total_downloads
    FROM submitted_pets sp
    LEFT JOIN pet_metrics pm ON pm.pet_slug = sp.slug
    WHERE sp.source <> 'discover'
    GROUP BY sp.owner_id
    HAVING COUNT(*) FILTER (
      WHERE sp.status='approved' AND sp.approved_at > now() - interval '7 days'
    ) > 0
    ORDER BY value DESC, approved_count DESC, total_likes DESC
    LIMIT ${TOP_LIMIT}
  `;
}

// Pet thumbnails by owner for the leaderboard rows. Returns at most
// `defaultLimit` slugs per owner (`topLimit` for the first 3 ranks)
// preferring pinned pets when the owner has set them, then falling
// back to recently approved pets. Discover pets are excluded so a
// proxy ownerId never hijacks somebody else's row.
export async function getLeaderboardPetThumbs(
  ownerIds: string[],
  defaultLimit = 3,
  topLimit = 5,
): Promise<Record<string, Array<{ slug: string; displayName: string }>>> {
  const out: Record<string, Array<{ slug: string; displayName: string }>> = {};
  if (ownerIds.length === 0) return out;

  // We need the full set of approved pets per owner *and* whatever is
  // pinned in user_profiles.featured_pet_slugs. One query for both keeps
  // the round-trip count low even for top-50 lists.
  const result = (await db.execute(sql`
    WITH owner_set AS (
      SELECT * FROM unnest(
        ${sql.raw(`ARRAY[${ownerIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")}]::text[]`)}
      ) AS owner_id
    ),
    approved AS (
      SELECT
        sp.owner_id,
        sp.slug,
        sp.display_name,
        sp.approved_at,
        ROW_NUMBER() OVER (
          PARTITION BY sp.owner_id
          ORDER BY sp.approved_at DESC NULLS LAST
        ) AS rn
      FROM submitted_pets sp
      INNER JOIN owner_set os ON os.owner_id = sp.owner_id
      WHERE sp.status = 'approved' AND sp.source <> 'discover'
    )
    SELECT
      a.owner_id,
      a.slug,
      a.display_name,
      up.featured_pet_slugs
    FROM approved a
    LEFT JOIN user_profiles up ON up.user_id = a.owner_id
    WHERE a.rn <= ${topLimit + 5}
    ORDER BY a.owner_id, a.rn
  `)) as unknown as {
    rows: Array<{
      owner_id: string;
      slug: string;
      display_name: string;
      featured_pet_slugs: string[] | null;
    }>;
  };

  // Group rows + pinned slugs per owner so we can rank them: pinned
  // first (in the order the owner chose), then recent approvals.
  const byOwner = new Map<
    string,
    {
      pinnedOrder: string[];
      pets: Map<string, { slug: string; displayName: string }>;
    }
  >();
  for (const row of result.rows) {
    const existing = byOwner.get(row.owner_id) ?? {
      pinnedOrder: row.featured_pet_slugs ?? [],
      pets: new Map<string, { slug: string; displayName: string }>(),
    };
    existing.pets.set(row.slug, {
      slug: row.slug,
      displayName: row.display_name,
    });
    byOwner.set(row.owner_id, existing);
  }

  for (const [ownerId, { pinnedOrder, pets }] of byOwner.entries()) {
    const ranked: Array<{ slug: string; displayName: string }> = [];
    const seen = new Set<string>();
    for (const slug of pinnedOrder) {
      const pet = pets.get(slug);
      if (pet && !seen.has(slug)) {
        ranked.push(pet);
        seen.add(slug);
      }
    }
    for (const pet of pets.values()) {
      if (!seen.has(pet.slug)) {
        ranked.push(pet);
        seen.add(pet.slug);
      }
    }
    out[ownerId] = ranked.slice(0, topLimit);
  }

  // Note: caller decides per-row how many to show (3 default, topLimit
  // for #1-3). We always return up to topLimit so the cap is enforced
  // there, not here.
  void defaultLimit;
  return out;
}

// Single-owner rank lookup for the inline badge on /u/[handle].
// Returns null when the owner is outside the top, so callers can skip
// rendering rather than displaying "#999".
export async function getOwnerRank(
  ownerId: string,
  metric: LeaderboardMetric = "pets",
): Promise<{ rank: number; total: number; value: number } | null> {
  const rows = await getLeaderboard(metric);
  const idx = rows.findIndex((r) => r.ownerId === ownerId);
  if (idx === -1) return null;
  return { rank: idx + 1, total: rows.length, value: rows[idx].value };
}
