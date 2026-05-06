import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";

// All queries here are admin-only — no per-user gating, no row-level
// filters beyond the obvious "approved" / "pending" splits. They run
// against the live Postgres so numbers are real-time. Nothing is
// cached at this layer; the page owns the revalidation policy.

export type SubmissionVelocityPoint = {
  bucket: string; // ISO timestamp at hour boundary
  pending: number;
  approved: number;
  rejected: number;
};

// Submissions per hour for the last N hours, broken down by terminal
// status. We bucket by the row's createdAt (when it landed in the
// queue), not approvedAt — drift between submit and approve would
// otherwise inflate "recent" buckets with old approvals.
export async function getSubmissionVelocity(
  hours = 24,
): Promise<SubmissionVelocityPoint[]> {
  const out = (await db.execute(sql`
    WITH series AS (
      SELECT generate_series(
        date_trunc('hour', now() - interval '${sql.raw(`${hours} hours`)}'),
        date_trunc('hour', now()),
        interval '1 hour'
      ) AS bucket
    )
    SELECT
      series.bucket,
      COALESCE(sum(CASE WHEN p.status = 'pending'  THEN 1 ELSE 0 END), 0) AS pending,
      COALESCE(sum(CASE WHEN p.status = 'approved' THEN 1 ELSE 0 END), 0) AS approved,
      COALESCE(sum(CASE WHEN p.status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected
    FROM series
    LEFT JOIN submitted_pets p
      ON date_trunc('hour', p.created_at) = series.bucket
    GROUP BY series.bucket
    ORDER BY series.bucket ASC
  `)) as unknown as {
    rows: Array<{
      bucket: string | Date;
      pending: number | string;
      approved: number | string;
      rejected: number | string;
    }>;
  };
  return (out.rows ?? []).map((row) => ({
    bucket:
      row.bucket instanceof Date
        ? row.bucket.toISOString()
        : String(row.bucket),
    pending: Number(row.pending),
    approved: Number(row.approved),
    rejected: Number(row.rejected),
  }));
}

export type QueueDepth = {
  pending: number;
  oldestPendingAgeMinutes: number | null;
  pendingEdits: number;
  oldestPendingEditAgeMinutes: number | null;
};

// Snapshot of the admin's open work: how many pets are waiting for a
// first review, and how stale the oldest one is. Same for in-flight
// edits to existing approved pets.
export async function getQueueDepth(): Promise<QueueDepth> {
  const out = (await db.execute(sql`
    SELECT
      (SELECT count(*) FROM submitted_pets WHERE status = 'pending' AND source <> 'discover') AS pending,
      (SELECT extract(epoch FROM (now() - min(created_at))) / 60
         FROM submitted_pets
         WHERE status = 'pending' AND source <> 'discover') AS oldest_pending_age_minutes,
      (SELECT count(*) FROM submitted_pets WHERE pending_submitted_at IS NOT NULL) AS pending_edits,
      (SELECT extract(epoch FROM (now() - min(pending_submitted_at))) / 60
         FROM submitted_pets
         WHERE pending_submitted_at IS NOT NULL) AS oldest_pending_edit_age_minutes
  `)) as unknown as {
    rows: Array<{
      pending: number | string;
      oldest_pending_age_minutes: number | string | null;
      pending_edits: number | string;
      oldest_pending_edit_age_minutes: number | string | null;
    }>;
  };
  const row = out.rows?.[0];
  return {
    pending: Number(row?.pending ?? 0),
    oldestPendingAgeMinutes:
      row?.oldest_pending_age_minutes != null
        ? Number(row.oldest_pending_age_minutes)
        : null,
    pendingEdits: Number(row?.pending_edits ?? 0),
    oldestPendingEditAgeMinutes:
      row?.oldest_pending_edit_age_minutes != null
        ? Number(row.oldest_pending_edit_age_minutes)
        : null,
  };
}

export type HiddenHit = {
  id: string;
  slug: string;
  displayName: string;
  installCount: number;
  zipDownloadCount: number;
  likeCount: number;
  approvedAt: string | null;
};

// Pets with a strong install-to-like ratio relative to the catalog
// median. The interesting cohort is pets that aren't featured / pinned
// but are quietly converting: they install at a higher rate per like
// than the average pet, which means people who notice them follow
// through. A signal for re-promote / pin to the landing strip.
export async function getHiddenHits(limit = 10): Promise<HiddenHit[]> {
  const out = (await db.execute(sql`
    SELECT
      p.id,
      p.slug,
      p.display_name,
      COALESCE(m.install_count, 0)      AS install_count,
      COALESCE(m.zip_download_count, 0) AS zip_download_count,
      COALESCE(m.like_count, 0)         AS like_count,
      p.approved_at
    FROM submitted_pets p
    LEFT JOIN pet_metrics m ON m.pet_slug = p.slug
    WHERE p.status = 'approved'
      AND p.featured = false
      AND COALESCE(m.install_count, 0) >= 3
    ORDER BY
      (COALESCE(m.install_count, 0)::float
        / GREATEST(COALESCE(m.like_count, 0), 1)) DESC,
      m.install_count DESC NULLS LAST
    LIMIT ${limit}
  `)) as unknown as {
    rows: Array<{
      id: string;
      slug: string;
      display_name: string;
      install_count: number | string;
      zip_download_count: number | string;
      like_count: number | string;
      approved_at: string | Date | null;
    }>;
  };
  return (out.rows ?? []).map((row) => ({
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    installCount: Number(row.install_count),
    zipDownloadCount: Number(row.zip_download_count),
    likeCount: Number(row.like_count),
    approvedAt:
      row.approved_at instanceof Date
        ? row.approved_at.toISOString()
        : (row.approved_at as string | null),
  }));
}

export type FeaturedPet = {
  id: string;
  slug: string;
  displayName: string;
  installCount: number;
  likeCount: number;
  approvedAt: string | null;
};

// Pets currently flagged featured = true. Surfaces in the insights
// dashboard so the admin can see what's promoted and rotate stale
// entries (low install count relative to peers means the slot would
// be better used by something else).
export async function getCurrentlyFeatured(limit = 24): Promise<FeaturedPet[]> {
  const out = (await db.execute(sql`
    SELECT
      p.id,
      p.slug,
      p.display_name,
      COALESCE(m.install_count, 0) AS install_count,
      COALESCE(m.like_count, 0)    AS like_count,
      p.approved_at
    FROM submitted_pets p
    LEFT JOIN pet_metrics m ON m.pet_slug = p.slug
    WHERE p.status = 'approved'
      AND p.featured = true
    ORDER BY m.install_count DESC NULLS LAST, p.approved_at DESC NULLS LAST
    LIMIT ${limit}
  `)) as unknown as {
    rows: Array<{
      id: string;
      slug: string;
      display_name: string;
      install_count: number | string;
      like_count: number | string;
      approved_at: string | Date | null;
    }>;
  };
  return (out.rows ?? []).map((row) => ({
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    installCount: Number(row.install_count),
    likeCount: Number(row.like_count),
    approvedAt:
      row.approved_at instanceof Date
        ? row.approved_at.toISOString()
        : (row.approved_at as string | null),
  }));
}

export type ActiveCreator = {
  ownerId: string;
  creditName: string | null;
  approvedCount: number;
  lastSubmittedAt: string;
};

// Creators who shipped at least one submission in the last 7 days.
// Sorts by recency first, then by approved count for tie-breaking.
// Drives the "are creators churning?" health signal.
export async function getActiveCreators(
  days = 7,
  limit = 20,
): Promise<ActiveCreator[]> {
  const out = (await db.execute(sql`
    SELECT
      p.owner_id,
      max(p.credit_name) AS credit_name,
      sum(CASE WHEN p.status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
      max(p.created_at) AS last_submitted_at
    FROM submitted_pets p
    WHERE p.created_at > now() - interval '${sql.raw(`${days} days`)}'
      AND p.source <> 'discover'
    GROUP BY p.owner_id
    ORDER BY last_submitted_at DESC
    LIMIT ${limit}
  `)) as unknown as {
    rows: Array<{
      owner_id: string;
      credit_name: string | null;
      approved_count: number | string;
      last_submitted_at: string | Date;
    }>;
  };
  return (out.rows ?? []).map((row) => ({
    ownerId: row.owner_id,
    creditName: row.credit_name,
    approvedCount: Number(row.approved_count),
    lastSubmittedAt:
      row.last_submitted_at instanceof Date
        ? row.last_submitted_at.toISOString()
        : String(row.last_submitted_at),
  }));
}

export type OverviewStats = {
  totalApproved: number;
  totalPending: number;
  totalRejected: number;
  approvedLast24h: number;
  approvedLast7d: number;
  totalCreators: number;
  totalLikes: number;
  totalInstalls: number;
};

// Headline numbers for the top of the page. One round-trip via a
// single sub-query block to keep the dashboard cheap on every reload.
export async function getOverviewStats(): Promise<OverviewStats> {
  const out = (await db.execute(sql`
    SELECT
      (SELECT count(*) FROM submitted_pets WHERE status = 'approved') AS total_approved,
      (SELECT count(*) FROM submitted_pets WHERE status = 'pending'  AND source <> 'discover') AS total_pending,
      (SELECT count(*) FROM submitted_pets WHERE status = 'rejected') AS total_rejected,
      (SELECT count(*) FROM submitted_pets WHERE status = 'approved' AND approved_at > now() - interval '24 hours') AS approved_last_24h,
      (SELECT count(*) FROM submitted_pets WHERE status = 'approved' AND approved_at > now() - interval '7 days')  AS approved_last_7d,
      (SELECT count(distinct owner_id) FROM submitted_pets WHERE status = 'approved' AND source <> 'discover') AS total_creators,
      (SELECT COALESCE(sum(like_count), 0)    FROM pet_metrics) AS total_likes,
      (SELECT COALESCE(sum(install_count), 0) FROM pet_metrics) AS total_installs
  `)) as unknown as {
    rows: Array<Record<string, number | string>>;
  };
  const row = out.rows?.[0] ?? {};
  return {
    totalApproved: Number(row.total_approved ?? 0),
    totalPending: Number(row.total_pending ?? 0),
    totalRejected: Number(row.total_rejected ?? 0),
    approvedLast24h: Number(row.approved_last_24h ?? 0),
    approvedLast7d: Number(row.approved_last_7d ?? 0),
    totalCreators: Number(row.total_creators ?? 0),
    totalLikes: Number(row.total_likes ?? 0),
    totalInstalls: Number(row.total_installs ?? 0),
  };
}
