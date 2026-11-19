import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";

export const runtime = "nodejs";

// Per-user data on a URL that carries no user identity, so an intermediary
// must not reuse it. Other private routes in this repo say `private, no-store`
// for the same reason; this one said nothing, which is exactly the case the
// Cloudflare cache-everything rule in front of the deployment would fill in
// for itself.
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

// GET /api/notifications -> last 20 notifications for the current user
// + unread count. Bell polls this every 60s.
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { items: [], unreadCount: 0 },
      { headers: PRIVATE_HEADERS },
    );
  }

  const items = await db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.userId, userId))
    .orderBy(desc(schema.notifications.createdAt))
    .limit(20);

  // Count in the database rather than fetching every unread id: this is a
  // polled endpoint, and a user with hundreds of unread rows had all of them
  // loaded into memory (and sent back) just to take `.length`.
  const unreadRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.userId, userId),
        isNull(schema.notifications.readAt),
      ),
    );

  return NextResponse.json(
    {
      items: items.map((n) => ({
        id: n.id,
        kind: n.kind,
        payload: n.payload,
        href: n.href,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
      unreadCount: unreadRows[0]?.count ?? 0,
    },
    { headers: PRIVATE_HEADERS },
  );
}
