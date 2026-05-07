import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { auth, clerkClient } from "@clerk/nextjs/server";
import { asc, eq } from "drizzle-orm";

import { isAdmin } from "@/lib/admin";
import { db, schema } from "@/lib/db/client";

import { FeedbackThread } from "@/components/feedback-thread";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Feedback thread — Admin",
  robots: { index: false, follow: false },
};

type Params = { id: string; locale: string };

export default async function AdminFeedbackThreadPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { userId } = await auth();
  if (!isAdmin(userId)) redirect("/");

  const { id } = await params;
  const row = await db.query.feedback.findFirst({
    where: eq(schema.feedback.id, id),
  });
  if (!row) notFound();

  const replies = await db
    .select()
    .from(schema.feedbackReplies)
    .where(eq(schema.feedbackReplies.feedbackId, id))
    .orderBy(asc(schema.feedbackReplies.createdAt));

  // Mark as read by admin.
  await db
    .update(schema.feedback)
    .set({ adminLastReadAt: new Date() })
    .where(eq(schema.feedback.id, id));

  // Best-effort: pull the original author's display info for context.
  let author: {
    displayName: string | null;
    username: string | null;
    primaryEmail: string | null;
  } | null = null;
  if (row.userId) {
    try {
      const client = await clerkClient();
      const u = await client.users.getUser(row.userId);
      const primary = u.emailAddresses.find(
        (e) => e.id === u.primaryEmailAddressId,
      );
      const displayName = [u.firstName, u.lastName]
        .filter(Boolean)
        .join(" ")
        .trim();
      author = {
        displayName: displayName || null,
        username: u.username ?? null,
        primaryEmail: primary?.emailAddress ?? null,
      };
    } catch {
      /* fine */
    }
  }

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-5 pb-12 md:px-8 md:pb-16">
      <Link
        href="/admin/feedback"
        className="font-mono text-[11px] tracking-[0.18em] text-muted-3 uppercase hover:text-stone-900 dark:hover:text-stone-100"
      >
        ← Inbox
      </Link>

      {author ? (
        <div className="rounded-2xl border border-border-base bg-surface/60 p-3 text-xs text-muted-2">
          <span className="font-medium text-stone-900 dark:text-stone-100">
            {author.displayName ?? author.username ?? "Anonymous"}
          </span>
          {author.username ? (
            <span className="ml-2 font-mono text-[10px] text-muted-4">
              @{author.username}
            </span>
          ) : null}
          {author.primaryEmail ? (
            <span className="ml-2 font-mono text-[10px] text-muted-4">
              {author.primaryEmail}
            </span>
          ) : null}
        </div>
      ) : null}

      <FeedbackThread
        feedback={{
          id: row.id,
          kind: row.kind,
          status: row.status,
          message: row.message,
          createdAt: row.createdAt.toISOString(),
          notifyEmail: row.notifyEmail,
        }}
        initialReplies={replies.map((r) => ({
          id: r.id,
          authorKind: r.authorKind,
          body: r.body,
          createdAt: r.createdAt.toISOString(),
        }))}
        viewerKind="admin"
      />
    </section>
  );
}
