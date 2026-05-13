import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { sql as dsql } from "drizzle-orm";

import { isAdmin } from "@/lib/admin";
import { db } from "@/lib/db/client";

export const runtime = "nodejs";

type HeaderStateRow = {
  notification_count: number | string;
  feedback_count: number | string;
  admin_count: number | string;
  caught_slugs: unknown;
};

// GET /api/me/header-state -> single aggregate the SiteHeader needs on
// every page-view. Combines what used to be three separate endpoints
// (notifications unread, feedback unread, caught slugs) so we ship
// one Edge Request per page-view instead of three.
//
// Returns lightweight counts + the caught slug set. The full
// notifications list (`items[]`) still lives at /api/notifications and
// is only fetched when the bell dropdown opens.
export async function GET(): Promise<Response> {
  const { userId } = await auth();

  if (!userId) {
    // Anonymous viewers always get the same empty payload, so let the
    // edge cache absorb most of the load. 5min CDN cache + 1h SWR keeps
    // the header snappy for visitors without hitting the function.
    return NextResponse.json(
      {
        signedIn: false,
        notifications: { unreadCount: 0 },
        feedback: { count: 0, adminCount: 0 },
        caught: [] as string[],
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
        },
      },
    );
  }

  const headers = { "Cache-Control": "private, no-store" };
  const admin = isAdmin(userId);
  const result = (await db.execute(dsql`
    WITH notification_state AS (
      SELECT count(*)::int AS notification_count
      FROM notifications
      WHERE user_id = ${userId}
        AND read_at IS NULL
    ),
    caught_state AS (
      SELECT coalesce(jsonb_agg(pet_slug ORDER BY pet_slug), '[]'::jsonb) AS caught_slugs
      FROM pet_likes
      WHERE user_id = ${userId}
    ),
    feedback_state AS (
      SELECT count(*)::int AS feedback_count
      FROM feedback f
      WHERE f.user_id = ${userId}
        AND EXISTS (
          SELECT 1
          FROM feedback_replies fr
          WHERE fr.feedback_id = f.id
            AND fr.author_kind = 'admin'
            AND (
              f.user_last_read_at IS NULL
              OR fr.created_at > f.user_last_read_at
            )
        )
    ),
    admin_feedback_state AS (
      SELECT
        CASE
          WHEN ${admin}::boolean THEN count(*)::int
          ELSE 0
        END AS admin_count
      FROM feedback f
      WHERE ${admin}::boolean
        AND EXISTS (
          SELECT 1
          FROM feedback_replies fr
          WHERE fr.feedback_id = f.id
            AND fr.author_kind = 'user'
            AND (
              f.admin_last_read_at IS NULL
              OR fr.created_at > f.admin_last_read_at
            )
        )
    )
    SELECT
      notification_state.notification_count,
      caught_state.caught_slugs,
      feedback_state.feedback_count,
      admin_feedback_state.admin_count
    FROM notification_state, caught_state, feedback_state, admin_feedback_state
  `)) as unknown as { rows: HeaderStateRow[] };
  const row = result.rows[0];

  return NextResponse.json(
    {
      signedIn: true,
      notifications: { unreadCount: toNumber(row?.notification_count) },
      feedback: {
        count: toNumber(row?.feedback_count),
        adminCount: toNumber(row?.admin_count),
      },
      caught: toStringArray(row?.caught_slugs),
    },
    { headers },
  );
}

function toNumber(value: number | string | undefined): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(isString);
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(isString) : [];
  } catch {
    return [];
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
