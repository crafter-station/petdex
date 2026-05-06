import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, desc, eq, isNull } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";

// GET /api/notifications -> last 20 notifications for the current user
// + unread count. Bell polls this every 60s.
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ items: [], unreadCount: 0 });
  }

  const items = await db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.userId, userId))
    .orderBy(desc(schema.notifications.createdAt))
    .limit(20);

  const unreadRows = await db
    .select({ id: schema.notifications.id })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.userId, userId),
        isNull(schema.notifications.readAt),
      ),
    );

  return NextResponse.json({
    items: items.map((n) => ({
      id: n.id,
      kind: n.kind,
      payload: n.payload,
      href: n.href,
      readAt: n.readAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
    })),
    unreadCount: unreadRows.length,
  });
}
