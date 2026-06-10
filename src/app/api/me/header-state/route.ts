import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { sql as dsql } from "drizzle-orm";

import { hasClerkSessionCookie } from "@/lib/clerk-session-cookie";
import { db } from "@/lib/db/client";
import {
  HEADER_STATE_BROWSER_CACHE_SECONDS,
  INITIAL_HEADER_STATE,
} from "@/lib/header-state";

export const runtime = "nodejs";

type HeaderStateRow = {
  notification_count: number | string;
  feedback_count: number | string;
  profile_handle: string | null;
  caught_slugs: unknown;
};

// GET /api/me/header-state -> single aggregate the SiteHeader needs on
// every page-view. Combines notifications unread, feedback unread,
// caught slugs, and the canonical profile handle so signed-in headers
// do not fan out into separate reads.
//
// Returns lightweight counts + the caught slug set. The full
// notifications list (`items[]`) still lives at /api/notifications and
// is only fetched when the bell dropdown opens.
export async function GET(req: Request): Promise<Response> {
  if (!hasClerkSessionCookie(req.headers.get("cookie"))) {
    return NextResponse.json(INITIAL_HEADER_STATE, {
      headers: {
        "Cache-Control":
          "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
        Vary: "Cookie",
      },
    });
  }

  const { userId } = await auth();

  if (!userId) {
    // Anonymous viewers always get the same empty payload, so let the
    // edge cache absorb most of the load. 5min CDN cache + 1h SWR keeps
    // the header snappy for visitors without hitting the function.
    return NextResponse.json(INITIAL_HEADER_STATE, {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
        Vary: "Cookie",
      },
    });
  }

  const headers = {
    "Cache-Control": `private, max-age=${HEADER_STATE_BROWSER_CACHE_SECONDS}, must-revalidate`,
    Vary: "Cookie",
  };
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
    )
    SELECT
      notification_state.notification_count,
      caught_state.caught_slugs,
      feedback_state.feedback_count,
      (
        SELECT handle
        FROM user_profiles
        WHERE user_id = ${userId}
        LIMIT 1
      ) AS profile_handle
    FROM notification_state, caught_state, feedback_state
  `)) as unknown as { rows: HeaderStateRow[] };
  const row = result.rows[0];

  return NextResponse.json(
    {
      signedIn: true,
      notifications: { unreadCount: toNumber(row?.notification_count) },
      feedback: {
        count: toNumber(row?.feedback_count),
      },
      profile: {
        handle: row?.profile_handle ?? null,
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
