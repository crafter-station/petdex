import { NextResponse } from "next/server";

import { auth, clerkClient } from "@clerk/nextjs/server";
import { asc, eq } from "drizzle-orm";
import { Resend } from "resend";

import { isAdmin } from "@/lib/admin";
import { db, schema } from "@/lib/db/client";
import { renderFeedbackAdminReplyEmail } from "@/lib/email-templates/feedback-admin-reply";
import { renderFeedbackFollowUpEmail } from "@/lib/email-templates/feedback-follow-up";
import { createNotification } from "@/lib/notifications";
import { requireSameOrigin } from "@/lib/same-origin";
import { getPreferredLocaleForUser } from "@/lib/user-locale";

type Params = { id: string };

type PostBody = {
  body: string;
};

function newId(): string {
  return `rep_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const { userId } = await auth();
  const { id } = await ctx.params;

  const row = await db.query.feedback.findFirst({
    where: eq(schema.feedback.id, id),
  });
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Only the original author or an admin can read a thread.
  const ok = isAdmin(userId) || (userId && row.userId === userId);
  if (!ok) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const replies = await db
    .select()
    .from(schema.feedbackReplies)
    .where(eq(schema.feedbackReplies.feedbackId, id))
    .orderBy(asc(schema.feedbackReplies.createdAt));

  // Side-effect: mark thread as read for the caller.
  const now = new Date();
  if (isAdmin(userId)) {
    await db
      .update(schema.feedback)
      .set({ adminLastReadAt: now })
      .where(eq(schema.feedback.id, id));
  } else if (userId && row.userId === userId) {
    await db
      .update(schema.feedback)
      .set({ userLastReadAt: now })
      .where(eq(schema.feedback.id, id));
  }

  return NextResponse.json({
    feedback: {
      id: row.id,
      kind: row.kind,
      status: row.status,
      message: row.message,
      createdAt: row.createdAt,
    },
    replies,
  });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const text = (body.body ?? "").trim();
  if (!text || text.length > 2000) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const row = await db.query.feedback.findFirst({
    where: eq(schema.feedback.id, id),
  });
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const adminCaller = isAdmin(userId);
  const isAuthor = row.userId === userId;
  if (!adminCaller && !isAuthor) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const now = new Date();
  const replyId = newId();

  const [reply] = await db
    .insert(schema.feedbackReplies)
    .values({
      id: replyId,
      feedbackId: id,
      authorKind: adminCaller ? "admin" : "user",
      authorUserId: userId,
      body: text,
      createdAt: now,
    })
    .returning();

  // Update read markers for the writer.
  if (adminCaller) {
    await db
      .update(schema.feedback)
      .set({ adminLastReadAt: now })
      .where(eq(schema.feedback.id, id));
  } else {
    await db
      .update(schema.feedback)
      .set({ userLastReadAt: now })
      .where(eq(schema.feedback.id, id));
  }

  // In-app notification: when admin replies, push a bell entry to the
  // original author. We don't notify admins of user follow-ups via the
  // bell — they already have an admin-side counter on /admin/feedback.
  if (adminCaller && row.userId) {
    void createNotification({
      userId: row.userId,
      kind: "feedback_replied",
      payload: {
        feedbackId: id,
        excerpt: text.slice(0, 120),
      },
      href: `/my-feedback/${id}`,
    }).catch(() => {});
  }

  // Email the other party.
  if (process.env.RESEND_API_KEY) {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const from =
        process.env.RESEND_FROM ?? "Petdex <petdex@updates.railly.dev>";

      if (adminCaller) {
        // Admin replied → notify the original author.
        if (row.notifyEmail) {
          let toEmail = row.email ?? null;
          if (!toEmail && row.userId) {
            try {
              const client = await clerkClient();
              const u = await client.users.getUser(row.userId);
              const primary = u.emailAddresses.find(
                (e) => e.id === u.primaryEmailAddressId,
              );
              toEmail = primary?.emailAddress ?? null;
            } catch {
              /* ignore */
            }
          }
          if (toEmail) {
            const excerpt = row.message.slice(0, 80);
            const locale = await getPreferredLocaleForUser(row.userId);
            const email = renderFeedbackAdminReplyEmail(locale, {
              feedbackId: id,
              originalMessage: row.message,
              replyBody: text,
              excerpt: `${excerpt}${row.message.length > 80 ? "…" : ""}`,
            });
            await resend.emails.send({
              from,
              to: toEmail,
              subject: email.subject,
              html: email.html,
              text: email.text,
            });
          }
        }
      } else {
        // User followed up → notify admin (Hunter).
        const adminEmail =
          process.env.PETDEX_ADMIN_NOTIFY_EMAIL ?? "railly@clerk.dev";
        const excerpt = row.message.slice(0, 80);
        const email = renderFeedbackFollowUpEmail("en", {
          kindLabel: row.kind,
          statusLabel: row.status,
          originalMessage: row.message,
          replyBody: text,
          threadUrl: `https://petdex.crafter.run/admin/feedback?status=all&focus=${id}`,
          excerpt: `${excerpt}${row.message.length > 80 ? "…" : ""}`,
        });
        await resend.emails.send({
          from,
          to: adminEmail,
          subject: email.subject,
          html: email.html,
          text: email.text,
        });
      }
    } catch {
      /* email is best-effort; silent fail */
    }
  }

  return NextResponse.json({ ok: true, reply });
}
