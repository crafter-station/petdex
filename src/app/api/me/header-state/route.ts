import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, sql as dsql, eq, inArray, isNull } from "drizzle-orm";

import { isAdmin } from "@/lib/admin";
import { getCaughtSlugSet } from "@/lib/catch-status";
import { db, schema } from "@/lib/db/client";

export const runtime = "nodejs";

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

  const [unreadNotifRows, caughtSet, myFeedback] = await Promise.all([
    db
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, userId),
          isNull(schema.notifications.readAt),
        ),
      ),
    getCaughtSlugSet(userId),
    db
      .select({
        id: schema.feedback.id,
        userLastReadAt: schema.feedback.userLastReadAt,
      })
      .from(schema.feedback)
      .where(eq(schema.feedback.userId, userId)),
  ]);

  let feedbackCount = 0;
  if (myFeedback.length > 0) {
    const ids = myFeedback.map((r) => r.id);
    const adminReplies = await db
      .select({
        feedbackId: schema.feedbackReplies.feedbackId,
        latestAdminReply: dsql<Date>`MAX(${schema.feedbackReplies.createdAt})`,
      })
      .from(schema.feedbackReplies)
      .where(
        and(
          eq(schema.feedbackReplies.authorKind, "admin"),
          inArray(schema.feedbackReplies.feedbackId, ids),
        ),
      )
      .groupBy(schema.feedbackReplies.feedbackId);

    const lastReadById = new Map(
      myFeedback.map((r) => [r.id, r.userLastReadAt]),
    );
    feedbackCount = adminReplies.filter((r) => {
      const lastRead = lastReadById.get(r.feedbackId);
      return !lastRead || new Date(r.latestAdminReply) > new Date(lastRead);
    }).length;
  }

  let adminCount = 0;
  if (isAdmin(userId)) {
    const rows = await db
      .select({
        feedbackId: schema.feedbackReplies.feedbackId,
        latestUserReply: dsql<Date>`MAX(${schema.feedbackReplies.createdAt})`,
        adminLastReadAt: schema.feedback.adminLastReadAt,
      })
      .from(schema.feedbackReplies)
      .innerJoin(
        schema.feedback,
        eq(schema.feedback.id, schema.feedbackReplies.feedbackId),
      )
      .where(eq(schema.feedbackReplies.authorKind, "user"))
      .groupBy(
        schema.feedbackReplies.feedbackId,
        schema.feedback.adminLastReadAt,
      );
    adminCount = rows.filter(
      (r) =>
        !r.adminLastReadAt ||
        new Date(r.latestUserReply) > new Date(r.adminLastReadAt),
    ).length;
  }

  return NextResponse.json(
    {
      signedIn: true,
      notifications: { unreadCount: unreadNotifRows.length },
      feedback: { count: feedbackCount, adminCount },
      caught: Array.from(caughtSet),
    },
    { headers },
  );
}
