import { NextResponse } from "next/server";

import { auth, clerkClient } from "@clerk/nextjs/server";
import { asc, eq } from "drizzle-orm";
import { Resend } from "resend";

import { isAdmin } from "@/lib/admin";
import { db, executeAtomicReturning, schema } from "@/lib/db/client";
import { emailEnv, sendEmail } from "@/lib/email-send";
import { renderFeedbackAdminReplyEmail } from "@/lib/email-templates/feedback-admin-reply";
import { renderFeedbackFollowUpEmail } from "@/lib/email-templates/feedback-follow-up";
import { createNotification } from "@/lib/notifications";
import { feedbackReplyRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";
import { getPreferredLocaleForUser } from "@/lib/user-locale";

export const runtime = "nodejs";

// A private feedback thread on a URL that carries no user identity — the id is
// the thread's, not the caller's — so an intermediary must not reuse it. Same
// reason `/api/notifications` and `/api/pet-requests` say `private, no-store`.
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

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

  return NextResponse.json(
    {
      feedback: {
        id: row.id,
        kind: row.kind,
        status: row.status,
        message: row.message,
        createdAt: row.createdAt,
      },
      replies,
    },
    { headers: PRIVATE_HEADERS },
  );
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

  // Starting a thread is capped at 5/hour, but nothing capped continuing one —
  // and a user reply emails the admin inbox, so an account could mail the
  // admin without bound. Admins are exempt: answering many threads is the job.
  if (!isAdmin(userId)) {
    const lim = await feedbackReplyRatelimit.limit(userId);
    if (!lim.success) {
      return NextResponse.json(
        {
          error: "rate_limited",
          message: "Too many replies. Try again later.",
        },
        { status: 429, headers: PRIVATE_HEADERS },
      );
    }
  }

  const { id } = await ctx.params;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  // `req.json()` resolves `null` for a literal `null` body, and reading
  // `.body` off it throws — the sibling `/api/feedback` route coerces its
  // fields for the same reason. Refuse non-objects as a 400.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // Must be a string: String() would coerce an object to "[object Object]"
  // or an array to its comma join, and either would land in the reply store
  // and the notification email as garbage that looks accepted.
  if (typeof body.body !== "string") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const text = body.body.trim();
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

  // One transaction, two separate statements (executeAtomicReturning): the
  // read marker used to be a second await, so a failure between the insert
  // and the update left the reply persisted while the marker never moved and
  // the thread stayed unread forever.
  await executeAtomicReturning([
    db
      .insert(schema.feedbackReplies)
      .values({
        id: replyId,
        feedbackId: id,
        authorKind: adminCaller ? "admin" : "user",
        authorUserId: userId,
        body: text,
        createdAt: now,
      })
      .getSQL(),
    // Update read markers for the writer.
    (adminCaller
      ? db.update(schema.feedback).set({ adminLastReadAt: now })
      : db.update(schema.feedback).set({ userLastReadAt: now })
    )
      .where(eq(schema.feedback.id, id))
      .getSQL(),
  ]);
  const reply = {
    id: replyId,
    feedbackId: id,
    authorKind: adminCaller ? ("admin" as const) : ("user" as const),
    authorUserId: userId,
    body: text,
    createdAt: now,
  };

  // In-app notification: when admin replies, push a bell entry to the
  // original author. We don't notify admins of user follow-ups via the
  // bell — they already have an admin-side counter on admin.petdex.dev.
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
      const from = emailEnv(
        "RESEND_FROM",
        "Petdex <petdex@updates.railly.dev>",
      );

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
            await sendEmail(
              resend,
              {
                from,
                to: toEmail,
                subject: email.subject,
                html: email.html,
                text: email.text,
              },
              "feedback admin reply",
            );
          }
        }
      } else {
        // User followed up → notify admin (Hunter).
        const adminEmail = emailEnv(
          "PETDEX_ADMIN_NOTIFY_EMAIL",
          "railly@clerk.dev",
        );
        const excerpt = row.message.slice(0, 80);
        const email = renderFeedbackFollowUpEmail("en", {
          kindLabel: row.kind,
          statusLabel: row.status,
          originalMessage: row.message,
          replyBody: text,
          threadUrl: `https://admin.petdex.dev/feedback?status=all&focus=${id}`,
          excerpt: `${excerpt}${row.message.length > 80 ? "…" : ""}`,
        });
        await sendEmail(
          resend,
          {
            from,
            to: adminEmail,
            subject: email.subject,
            html: email.html,
            text: email.text,
          },
          "feedback follow-up to admin",
        );
      }
    } catch (error) {
      console.error(
        "[feedback] notification email failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return NextResponse.json({ ok: true, reply });
}
