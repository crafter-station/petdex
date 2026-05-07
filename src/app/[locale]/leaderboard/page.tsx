import { getTranslations } from "next-intl/server";

import {
  getLeaderboard,
  getLeaderboardPetThumbs,
  type LeaderboardMetric,
  type LeaderboardRow,
} from "@/lib/leaderboard";
import { buildLocaleAlternates } from "@/lib/locale-routing";
import { resolveOwnerCredits } from "@/lib/owner-credit";

import { LeaderboardView } from "@/components/leaderboard-view";
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
    namespace: "leaderboard.metadata",
  });

  return {
    title: t("title"),
    description: t("description"),
    alternates: buildLocaleAlternates("/leaderboard"),
  };
}

const METRIC_VALUES: LeaderboardMetric[] = [
  "pets",
  "likes",
  "installs",
  "rising",
  "collectors",
];

type SP = { tab?: string };

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const t = await getTranslations("leaderboard");
  const { tab } = await searchParams;
  const active: LeaderboardMetric = METRIC_VALUES.includes(
    tab as LeaderboardMetric,
  )
    ? (tab as LeaderboardMetric)
    : "pets";

  // Fetch every variant in parallel so the tabs feel instant when the
  // user clicks between them — Next will serve cached HTML for the tab
  // they pick first, but the visible table still renders SSR on the
  // initial pick. The volume is tiny (5 GROUP BY queries, top 50 each).
  const [petsRows, likesRows, installsRows, risingRows, collectorsRows] =
    await Promise.all([
      getLeaderboard("pets"),
      getLeaderboard("likes"),
      getLeaderboard("installs"),
      getLeaderboard("rising"),
      getLeaderboard("collectors"),
    ]);

  // Resolve Clerk credits ONCE for the union of owners that appear in
  // any tab — we want the same name/avatar regardless of which tab is
  // active so renames and rotates only happen at one fetch boundary.
  const allOwnerIds = new Set<string>([
    ...petsRows.map((r) => r.ownerId),
    ...likesRows.map((r) => r.ownerId),
    ...installsRows.map((r) => r.ownerId),
    ...risingRows.map((r) => r.ownerId),
    ...collectorsRows.map((r) => r.ownerId),
  ]);

  const [credits, petThumbs] = await Promise.all([
    resolveOwnerCredits(
      [...allOwnerIds].map((ownerId) => ({
        ownerId,
        creditName: null,
        creditUrl: null,
        creditImage: null,
      })),
    ),
    getLeaderboardPetThumbs([...allOwnerIds]),
  ]);

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <SiteHeader />
      <section className="petdex-cloud relative -mt-[84px] overflow-clip pt-[84px]">
        <div className="relative mx-auto flex w-full max-w-5xl flex-col px-5 pb-10 md:px-8">

          <div className="mt-12 flex flex-col items-center text-center md:mt-16">
            <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
              {t("eyebrow")}
            </p>
            <h1 className="mt-3 text-balance text-[36px] leading-[1] font-semibold tracking-tight md:text-[56px]">
              {t("title")}
            </h1>
            <p className="mt-4 max-w-xl text-balance text-base leading-7 text-muted-1 md:text-lg">
              {t("subtitle")}
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-10 md:px-8 md:py-14">
        <LeaderboardView
          active={active}
          credits={serializeCredits(credits)}
          petThumbs={petThumbs}
          rows={{
            pets: petsRows,
            likes: likesRows,
            installs: installsRows,
            rising: risingRows,
            collectors: collectorsRows,
          }}
        />
      </section>

      <SiteFooter />
    </main>
  );
}

// Plain-object map so it can cross the server -> client boundary as
// JSON. resolveOwnerCredits returns a Map<string, OwnerCredit>; the
// view only needs the visible bits. We surface the first GitHub external
// here so the leaderboard can prefer the artist's GitHub @ over the
// raw Clerk userId tail when no Clerk username is set.
function serializeCredits(
  credits: Awaited<ReturnType<typeof resolveOwnerCredits>>,
): Record<
  string,
  {
    name: string;
    handle: string;
    username: string | null;
    githubUsername: string | null;
    imageUrl: string | null;
  }
> {
  const out: Record<
    string,
    {
      name: string;
      handle: string;
      username: string | null;
      githubUsername: string | null;
      imageUrl: string | null;
    }
  > = {};
  for (const [id, c] of credits.entries()) {
    const gh = c.externals.find((e) => e.provider === "github");
    out[id] = {
      name: c.name,
      handle: c.handle,
      username: c.username,
      githubUsername: gh?.username ?? null,
      imageUrl: c.imageUrl,
    };
  }
  return out;
}

// Re-export so the view can type its props off the same source.
export type { LeaderboardRow };
