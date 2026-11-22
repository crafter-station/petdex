import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@clerk/nextjs/server";
import { desc, sql as dsql, eq, inArray } from "drizzle-orm";
import { Bug, Heart, Lightbulb, MessageSquare } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { db, schema } from "@/lib/db/client";

import { FullAuthProviders } from "@/components/auth/auth-providers";
import { MyFeedbackFilters } from "@/components/feedback/my-feedback-filters";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({
    locale,
    namespace: "myFeedback.metadata",
  });

  return {
    title: t("title"),
    description: t("description"),
    alternates: { canonical: "/my-feedback" },
    robots: { index: false, follow: false },
  };
}

const KIND_META: Record<
  string,
  { label: string; tone: string; icon: React.ReactNode }
> = {
  suggestion: {
    label: "Suggest",
    tone: "bg-chip-warning-bg text-chip-warning-fg ring-chip-warning-fg/20",
    icon: <Lightbulb className="size-3.5" />,
  },
  bug: {
    label: "Bug",
    tone: "bg-chip-danger-bg text-chip-danger-fg ring-chip-danger-fg/20",
    icon: <Bug className="size-3.5" />,
  },
  praise: {
    label: "Praise",
    tone: "bg-chip-success-bg text-chip-success-fg ring-chip-success-fg/20",
    icon: <Heart className="size-3.5" />,
  },
  other: {
    label: "Other",
    tone: "bg-surface-muted text-stone-900 ring-stone-200 dark:text-stone-200 dark:ring-stone-700",
    icon: <MessageSquare className="size-3.5" />,
  },
};

type Filter = "unread" | "replied" | "waiting" | "all";

type SP = { filter?: string };

export default async function MyFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const t = await getTranslations("myFeedback");
  const { userId } = await auth();
  if (!userId) {
    redirect("/");
  }

  const sp = await searchParams;

  const rows = await db
    .select()
    .from(schema.feedback)
    .where(eq(schema.feedback.userId, userId))
    .orderBy(desc(schema.feedback.createdAt));

  // Per-thread aggregates: total reply count, latest admin reply
  // (timestamp + body excerpt for the row preview), and the timestamp of
  // the last message overall (used to detect the "waiting on Hunter" state).
  const ids = rows.map((r) => r.id);
  type Agg = {
    feedbackId: string;
    latestAt: Date | null;
    latestAdminAt: Date | null;
    latestAdminBody: string | null;
    replyCount: number;
  };
  const aggMap = new Map<string, Agg>();
  if (ids.length > 0) {
    const aggRows = await db
      .select({
        feedbackId: schema.feedbackReplies.feedbackId,
        latestAt: dsql<Date>`MAX(${schema.feedbackReplies.createdAt})`,
        latestAdminAt: dsql<Date | null>`MAX(${schema.feedbackReplies.createdAt}) FILTER (WHERE ${schema.feedbackReplies.authorKind} = 'admin')`,
        // Pick the body of the most recent admin reply via a window
        // function we order by createdAt desc inside the FILTER. Postgres
        // doesn't have FILTER on string_agg easily, so we use a simpler
        // pattern: array_agg ordered, then take [0].
        latestAdminBody: dsql<string | null>`(
          ARRAY_AGG(${schema.feedbackReplies.body} ORDER BY ${schema.feedbackReplies.createdAt} DESC)
          FILTER (WHERE ${schema.feedbackReplies.authorKind} = 'admin')
        )[1]`,
        replyCount: dsql<number>`COUNT(*)::int`,
      })
      .from(schema.feedbackReplies)
      .where(inArray(schema.feedbackReplies.feedbackId, ids))
      .groupBy(schema.feedbackReplies.feedbackId);
    for (const r of aggRows) aggMap.set(r.feedbackId, r);
  }

  // Decorate each row with derived state once so render + filtering +
  // sorting all read from the same shape.
  type Decorated = {
    row: (typeof rows)[number];
    agg: Agg | null;
    unread: boolean;
    replied: boolean;
    waiting: boolean;
  };
  const decorated: Decorated[] = rows.map((row) => {
    const agg = aggMap.get(row.id) ?? null;
    const lastAdminAt = agg?.latestAdminAt ?? null;
    const lastUserRead = row.userLastReadAt;
    const unread =
      lastAdminAt !== null &&
      (!lastUserRead || new Date(lastAdminAt) > new Date(lastUserRead));
    const replied = Boolean(lastAdminAt);
    // "Waiting on Hunter" means: thread exists but no admin reply yet,
    // OR the last message in the thread is the user's (latestAt > latestAdminAt
    // when both are set, or no admin reply at all).
    const latest = agg?.latestAt ?? null;
    const waiting =
      !replied ||
      (latest && lastAdminAt && new Date(latest) > new Date(lastAdminAt));
    return { row, agg, unread, replied, waiting: Boolean(waiting) };
  });

  const counts: Record<Filter, number> = {
    unread: decorated.filter((d) => d.unread).length,
    replied: decorated.filter((d) => d.replied).length,
    waiting: decorated.filter((d) => d.waiting).length,
    all: decorated.length,
  };

  // Smart default: unread > replied > all. Keeps the most useful tab
  // active when the user lands without an explicit filter.
  const defaultFilter: Filter =
    counts.unread > 0 ? "unread" : counts.replied > 0 ? "replied" : "all";
  const requested = (sp.filter as Filter | undefined) ?? defaultFilter;
  const validFilters: Filter[] = ["unread", "replied", "waiting", "all"];
  const filter: Filter = validFilters.includes(requested)
    ? requested
    : defaultFilter;

  const visible = decorated.filter((d) => {
    if (filter === "all") return true;
    if (filter === "unread") return d.unread;
    if (filter === "replied") return d.replied;
    return d.waiting;
  });

  // Sort within the filter: unread first, then most-recently-active,
  // then newest-created. Matters most on "all" but harmless elsewhere.
  visible.sort((a, b) => {
    if (a.unread !== b.unread) return a.unread ? -1 : 1;
    const aT = a.agg?.latestAt ?? a.row.createdAt;
    const bT = b.agg?.latestAt ?? b.row.createdAt;
    return new Date(bT).getTime() - new Date(aT).getTime();
  });

  return (
    <FullAuthProviders>
      <main className="min-h-dvh bg-background text-foreground">
        <SiteHeader />
        <section className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 pt-8 pb-20 md:px-8">
          <header className="space-y-3">
            <p className="toy-tag inline-block rounded-full bg-toy-volt px-2.5 py-1 text-[#101944] shadow-[0_2px_0_#C9A91F]">
              {t("eyebrow")}
            </p>
            <h1 className="font-heading text-4xl font-semibold tracking-tight md:text-5xl">
              {t("title")}
            </h1>
            <p className="text-sm text-muted-2">{t("subtitle")}</p>
            {decorated.length > 0 ? (
              <MyFeedbackFilters
                counts={counts}
                defaultFilter={defaultFilter}
              />
            ) : null}
          </header>

          {decorated.length === 0 ? (
            <div className="toy-shell rounded-3xl p-10 text-center text-sm text-muted-2">
              {t("empty")}
            </div>
          ) : visible.length === 0 ? (
            <div className="toy-shell rounded-3xl p-10 text-center text-sm text-muted-2">
              {t("emptyFiltered")}
            </div>
          ) : (
            <ul className="space-y-3">
              {visible.map(({ row: r, agg, unread, replied, waiting }) => {
                const meta = KIND_META[r.kind] ?? KIND_META.other;
                const lastAdminAt = agg?.latestAdminAt ?? null;
                const lastAdminBody = agg?.latestAdminBody ?? null;
                const replyCount = agg?.replyCount ?? 0;

                return (
                  <li key={r.id}>
                    <Link
                      href={`/my-feedback/${r.id}`}
                      className={`toy-shell block rounded-2xl p-4 transition-transform duration-200 [transition-timing-function:var(--ease-bounce)] hover:-translate-y-0.5 sm:p-5 ${
                        unread ? "ring-2 ring-toy-cobalt/35" : ""
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`toy-tag inline-flex items-center gap-1 rounded-full px-2 py-0.5 ring-1 ${meta.tone}`}
                            >
                              {meta.icon}
                              {meta.label}
                            </span>
                            {unread ? (
                              <span className="toy-tag inline-flex items-center gap-1 rounded-full bg-toy-cobalt px-2 py-0.5 text-white">
                                {t("badges.newReply")}
                              </span>
                            ) : replied ? (
                              <span className="toy-tag inline-flex items-center gap-1 rounded-full bg-chip-success-bg px-2 py-0.5 text-chip-success-fg ring-1 ring-chip-success-fg/20">
                                {t("badges.replied")}
                              </span>
                            ) : waiting ? (
                              <span className="toy-tag inline-flex items-center gap-1 rounded-full bg-chip-warning-bg px-2 py-0.5 text-chip-warning-fg ring-1 ring-chip-warning-fg/20">
                                {t("badges.waiting")}
                              </span>
                            ) : null}
                            <span className="toy-tag ml-auto text-muted-4">
                              {new Date(r.createdAt).toLocaleDateString()}
                            </span>
                          </div>

                          <p className="mt-2 line-clamp-2 text-sm leading-6 text-foreground">
                            {r.message}
                          </p>

                          {lastAdminBody ? (
                            <div className="mt-3 flex items-start gap-2 rounded-xl border border-emerald-200/60 bg-emerald-50/40 p-2.5 dark:border-emerald-800/40 dark:bg-emerald-950/30">
                              <div className="grid size-6 shrink-0 place-items-center rounded-full bg-emerald-600 font-hardware text-[10px] font-semibold text-white">
                                H
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="toy-tag flex items-center gap-1.5 text-emerald-900/70 dark:text-emerald-300/80">
                                  {t("replyAuthor")}
                                  {lastAdminAt ? (
                                    <span>
                                      ·{" "}
                                      {new Date(lastAdminAt).toLocaleDateString(
                                        undefined,
                                        { month: "short", day: "numeric" },
                                      )}
                                    </span>
                                  ) : null}
                                </div>
                                <p className="mt-0.5 line-clamp-2 text-sm leading-6 text-emerald-900 dark:text-emerald-300">
                                  {lastAdminBody}
                                </p>
                              </div>
                            </div>
                          ) : null}

                          <p className="mt-2 text-xs text-muted-3">
                            {replyCount > 0
                              ? t("replyCount", { count: replyCount })
                              : t("noReplies")}
                          </p>
                        </div>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <SiteFooter />
      </main>
    </FullAuthProviders>
  );
}
