import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, eq, inArray, sql as dsql } from "drizzle-orm";

import { isAdmin } from "@/lib/admin";
import { db, schema } from "@/lib/db/client";

export const runtime = "nodejs";

// GET /api/feedback/unread -> { count, role }
//
// 'role' here means "what the badge represents":
//   - 'user'  -> count of *the viewer's own* feedback threads with
//                an admin reply newer than userLastReadAt. Used for
//                the My feedback (N) label in the dropdown.
//   - 'admin' -> count of admin-side unread (any feedback with a user
//                follow-up newer than adminLastReadAt). Returned in
//                a separate field so the admin can wire it to a
//                dedicated admin badge if they want.
//
// Critical: even when the viewer is an admin we still compute the
// 'user' count first against rows where feedback.userId === viewerId.
// /my-feedback only lists those rows, so the dropdown number must
// match what the page renders. Mixing in admin-side unread numbers
// makes the badge lie when the viewer is also an admin.
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ count: 0, role: "user", adminCount: 0 });
  }

  // Author-side unread: replies on the viewer's own feedback.
  let count = 0;
  const myFeedback = await db
    .select({
      id: schema.feedback.id,
      userLastReadAt: schema.feedback.userLastReadAt,
    })
    .from(schema.feedback)
    .where(eq(schema.feedback.userId, userId));

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
    count = adminReplies.filter((r) => {
      const lastRead = lastReadById.get(r.feedbackId);
      return !lastRead || new Date(r.latestAdminReply) > new Date(lastRead);
    }).length;
  }

  // Admin-side unread (only computed for admins, optional).
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

  return NextResponse.json({ count, role: "user", adminCount });
}
