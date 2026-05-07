import Link from "next/link";

import { clerkClient } from "@clerk/nextjs/server";
import { desc, inArray, sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";

import { db, schema } from "@/lib/db/client";
import { buildLocaleAlternates } from "@/lib/locale-routing";

import { type RequestRow, RequestsView } from "@/components/requests-view";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "requests.metadata" });

  return {
    title: t("title"),
    description: t("description"),
    alternates: buildLocaleAlternates("/requests"),
  };
}

export default async function RequestsPage() {
  const t = await getTranslations("requests");

  // Pull everything (open + fulfilled + dismissed) so the sort tabs in
  // RequestsView can switch instantly without a refetch. The list is
  // small enough that 80 rows is fine.
  const rows = await db
    .select()
    .from(schema.petRequests)
    .orderBy(
      sql`${schema.petRequests.upvoteCount} DESC, ${schema.petRequests.createdAt} DESC`,
    )
    .limit(80);

  const requestIds = rows.map((r) => r.id);

  type Vote = { requestId: string; userId: string };
  const votes: Vote[] = requestIds.length
    ? ((await db
        .select({
          requestId: schema.petRequestVotes.requestId,
          userId: schema.petRequestVotes.userId,
        })
        .from(schema.petRequestVotes)
        .where(inArray(schema.petRequestVotes.requestId, requestIds))
        .orderBy(desc(schema.petRequestVotes.createdAt))) as Vote[])
    : [];

  const userIdSet = new Set<string>();
  for (const r of rows) if (r.requestedBy) userIdSet.add(r.requestedBy);
  for (const v of votes) userIdSet.add(v.userId);

  type ClerkInfo = {
    handle: string;
    displayName: string | null;
    username: string | null;
    imageUrl: string | null;
  };
  const clerkInfo = new Map<string, ClerkInfo>();
  if (userIdSet.size > 0) {
    try {
      const client = await clerkClient();
      const all = [...userIdSet];
      for (let i = 0; i < all.length; i += 100) {
        const batch = await client.users.getUserList({
          userId: all.slice(i, i + 100),
          limit: 100,
        });
        for (const u of batch.data) {
          const displayName = [u.firstName, u.lastName]
            .filter(Boolean)
            .join(" ")
            .trim();
          clerkInfo.set(u.id, {
            handle: u.username
              ? u.username.toLowerCase()
              : u.id.slice(-8).toLowerCase(),
            displayName: displayName || null,
            username: u.username ?? null,
            imageUrl: u.imageUrl ?? null,
          });
        }
      }
    } catch {
      /* fine */
    }
  }

  // Fulfilled pet thumbnails.
  const fulfilledSlugs = rows
    .filter(
      (
        r,
      ): r is typeof r & {
        fulfilledPetSlug: string;
      } => r.status === "fulfilled" && typeof r.fulfilledPetSlug === "string",
    )
    .map((r) => r.fulfilledPetSlug);
  const fulfilledPets = fulfilledSlugs.length
    ? await db
        .select({
          slug: schema.submittedPets.slug,
          displayName: schema.submittedPets.displayName,
          spritesheetUrl: schema.submittedPets.spritesheetUrl,
        })
        .from(schema.submittedPets)
        .where(inArray(schema.submittedPets.slug, fulfilledSlugs))
    : [];
  const petBySlug = new Map(fulfilledPets.map((p) => [p.slug, p]));

  const initial: RequestRow[] = rows.map((r) => {
    const requester = r.requestedBy
      ? (clerkInfo.get(r.requestedBy) ?? null)
      : null;
    const voters = votes
      .filter((v) => v.requestId === r.id && v.userId !== r.requestedBy)
      .map((v) => clerkInfo.get(v.userId))
      .filter((v): v is ClerkInfo => Boolean(v))
      .slice(0, 6);
    const fulfilledPet = r.fulfilledPetSlug
      ? (petBySlug.get(r.fulfilledPetSlug) ?? null)
      : null;
    return {
      id: r.id,
      query: r.query,
      upvoteCount: r.upvoteCount,
      status: r.status,
      fulfilledPetSlug: r.fulfilledPetSlug,
      imageUrl: r.imageReviewStatus === "approved" ? r.imageUrl : null,
      imageReviewStatus: r.imageReviewStatus,
      hasPendingImage: r.imageReviewStatus === "pending",
      createdAt: r.createdAt.toISOString(),
      voted: false,
      requester,
      voters,
      fulfilledPet,
    };
  });

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <section className="mx-auto flex w-full max-w-[1440px] flex-col gap-8 px-5 py-5 md:px-8 md:py-5">
        <SiteHeader />
      </section>
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 pb-20 md:px-8">
        <header className="space-y-3">
          <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
            {t("eyebrow")}
          </p>
          <h1 className="text-balance text-4xl font-semibold tracking-tight text-foreground md:text-5xl">
            {t("title")}
          </h1>
          <p className="max-w-2xl text-base leading-7 text-muted-2">
            {t("body")}
          </p>
          <Link
            href="/#gallery"
            className="inline-flex h-9 items-center rounded-full border border-border-base bg-surface px-4 text-xs font-medium text-muted-2 transition hover:border-border-strong"
          >
            {t("backToGallery")}
          </Link>
        </header>

        <RequestsView initial={initial} />
      </section>
      <SiteFooter />
    </main>
  );
}
