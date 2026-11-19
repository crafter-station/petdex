import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { auth } from "@clerk/nextjs/server";
import { asc, eq } from "drizzle-orm";
import { getTranslations } from "next-intl/server";

import { db, schema } from "@/lib/db/client";
import { withLocale } from "@/lib/locale-routing";

import { FullAuthProviders } from "@/components/auth/auth-providers";
import { FeedbackThread } from "@/components/feedback/feedback-thread";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import { hasLocale } from "@/i18n/config";

export const dynamic = "force-dynamic";

type Params = { id: string; locale: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}) {
  const { locale } = await params;
  const t = await getTranslations({
    locale,
    namespace: "myFeedbackThread.metadata",
  });

  return {
    title: t("title"),
    robots: { index: false, follow: false },
  };
}

export default async function MyFeedbackThreadPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const t = await getTranslations("myFeedbackThread");
  const { id, locale } = await params;
  const { userId } = await auth();
  if (!userId) redirect(withLocale("/", hasLocale(locale) ? locale : "en"));

  const row = await db.query.feedback.findFirst({
    where: eq(schema.feedback.id, id),
  });
  if (!row || row.userId !== userId) notFound();

  const replies = await db
    .select()
    .from(schema.feedbackReplies)
    .where(eq(schema.feedbackReplies.feedbackId, id))
    .orderBy(asc(schema.feedbackReplies.createdAt));

  // Mark the thread as read for this user.
  await db
    .update(schema.feedback)
    .set({ userLastReadAt: new Date() })
    .where(eq(schema.feedback.id, id));

  return (
    <FullAuthProviders>
      <SiteHeader />
      <main id="main" className="min-h-dvh pb-20">
        <section className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-5 pt-10 pb-12 md:px-8 md:pt-14">
          <Link
            href="/my-feedback"
            className="font-mono text-[11px] tracking-[0.18em] text-muted-3 uppercase hover:text-stone-900 dark:hover:text-stone-100"
          >
            {t("back")}
          </Link>
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
            viewerKind="user"
          />
        </section>
      </main>
      <SiteFooter />
    </FullAuthProviders>
  );
}
