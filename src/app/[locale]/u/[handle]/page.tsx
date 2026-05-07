import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { auth, clerkClient } from "@clerk/nextjs/server";
import { desc, eq } from "drizzle-orm";
import { Heart, TerminalSquare, Trophy } from "lucide-react";

import { isAdmin } from "@/lib/admin";
import { getCatchProgress, getLikedPetsForUser } from "@/lib/catch-status";
import { canManageCreatorCollections } from "@/lib/collection-access";
import { getOwnerCollection } from "@/lib/collections";
import { db, schema } from "@/lib/db/client";
import { getMetricsBySlugs } from "@/lib/db/metrics";
import { userIdForHandle } from "@/lib/handles";
import { getOwnerRank } from "@/lib/leaderboard";
import { buildLocaleAlternates } from "@/lib/locale-routing";
import { petStates } from "@/lib/pet-states";
import { type PetWithMetrics, rowToPet } from "@/lib/pets";
import { MAX_PINNED_PETS } from "@/lib/profiles";

import { JsonLd } from "@/components/json-ld";
import type { Submission } from "@/components/my-pets-view";
import { PetCard } from "@/components/pet-gallery";
import { PetSprite } from "@/components/pet-sprite";
import { PinnedReorderGrid } from "@/components/pinned-reorder-grid";
import { ProfileAnalytics } from "@/components/profile-analytics";
import { ProfileExternalLink } from "@/components/profile-external-link";
import { ProfileInlineEditor } from "@/components/profile-inline-editor";
import { ProfilePinButton } from "@/components/profile-pin-button";
import { ProfileShareButton } from "@/components/profile-share-button";
import { ProfileTabs } from "@/components/profile-tabs";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const dynamic = "force-dynamic";

const SITE_URL = "https://petdex.crafter.run";

type PageProps = { params: Promise<{ handle: string; locale: string }> };

export async function generateMetadata({ params }: PageProps) {
  const { handle } = await params;
  const userId = await userIdForHandle(handle);
  if (!userId) return { title: "Profile not found", robots: { index: false } };
  let displayName = `@${handle}`;
  const profile = await db.query.userProfiles.findFirst({
    where: eq(schema.userProfiles.userId, userId),
  });
  try {
    const client = await clerkClient();
    const u = await client.users.getUser(userId);
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
    const fallbackName = name || (u.username ? `@${u.username}` : `@${handle}`);
    displayName = profile?.displayName ?? fallbackName;
  } catch {
    if (profile?.displayName) displayName = profile.displayName;
    /* fall back */
  }
  const publicHandle = profile?.handle ?? handle.toLowerCase();
  // Pin OG image to locale-stripped path; next-intl redirects
  // /en/u/<handle>/opengraph-image with 307 which scrapers drop.
  const ogImage = `${SITE_URL}/u/${publicHandle}/opengraph-image`;
  return {
    title: `${displayName} on Petdex`,
    description: `Pets created by ${displayName} for Codex.`,
    alternates: buildLocaleAlternates(`/u/${publicHandle}`),
    openGraph: {
      title: `${displayName} on Petdex`,
      description: `Animated Codex pets created by ${displayName}.`,
      url: `${SITE_URL}/u/${publicHandle}`,
      images: [{ url: ogImage, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title: `${displayName} on Petdex`,
      description: `Animated Codex pets created by ${displayName}.`,
      images: [ogImage],
    },
  };
}

export default async function UserProfilePage({ params }: PageProps) {
  const { handle } = await params;
  const requestedHandle = handle.toLowerCase();
  const ownerId = await userIdForHandle(handle);
  if (!ownerId) notFound();

  // Pull Clerk profile.
  let displayName: string | null = null;
  let username: string | null = null;
  let avatarUrl: string | null = null;
  const externalUrls: { url: string; label: string }[] = [];
  let memberSince: number | null = null;
  try {
    const client = await clerkClient();
    const u = await client.users.getUser(ownerId);
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
    displayName = name || u.username || null;
    username = u.username ?? null;
    avatarUrl = u.imageUrl ?? null;
    memberSince = u.createdAt ?? null;
    for (const acc of u.externalAccounts ?? []) {
      const account = acc as { username?: string; provider: string };
      if (!account.username) continue;
      if (account.provider === "oauth_github") {
        externalUrls.push({
          url: `https://github.com/${account.username}`,
          label: `github.com/${account.username}`,
        });
      } else if (
        account.provider === "oauth_x" ||
        account.provider === "oauth_twitter"
      ) {
        externalUrls.push({
          url: `https://x.com/${account.username}`,
          label: `x.com/${account.username}`,
        });
      }
    }
  } catch {
    /* will render with handle only */
  }

  // Profile customization (bio, featured slug).
  const profile = await db.query.userProfiles.findFirst({
    where: eq(schema.userProfiles.userId, ownerId),
  });
  if (profile?.handle && profile.handle !== requestedHandle) {
    redirect(`/u/${profile.handle}`);
  }
  const publicHandle =
    profile?.handle ?? username?.toLowerCase() ?? requestedHandle;
  displayName = profile?.displayName ?? displayName;
  const bio = profile?.bio ?? null;
  const featuredSlugs =
    (profile?.featuredPetSlugs as string[] | undefined) ?? [];

  // Viewer detection runs ahead of the pets query so the owner sees
  // their pending + rejected rows alongside the approved gallery.
  const { userId: viewerId } = await auth();
  const isOwner = viewerId === ownerId;

  // Pets owned by this user. Visitors only see approved rows; the owner
  // sees everything so the profile doubles as their dashboard.
  const allOwnerRows = await db
    .select()
    .from(schema.submittedPets)
    .where(eq(schema.submittedPets.ownerId, ownerId))
    .orderBy(desc(schema.submittedPets.approvedAt));

  const approvedRows = allOwnerRows.filter((r) => r.status === "approved");

  const slugs = approvedRows.map((r) => r.slug);
  const metrics = slugs.length
    ? await getMetricsBySlugs(slugs)
    : new Map<
        string,
        { likeCount: number; installCount: number; zipDownloadCount: number }
      >();

  const pets: PetWithMetrics[] = approvedRows.map((row) => ({
    ...rowToPet(row),
    metrics: metrics.get(row.slug) ?? {
      installCount: 0,
      zipDownloadCount: 0,
      likeCount: 0,
    },
  }));

  // Owner-only: shape pending + rejected rows as Submission for the
  // tabs panel. Sorted by createdAt desc so the most recent submit
  // shows first.
  const ownerSubmissions: Submission[] = isOwner
    ? allOwnerRows
        .filter((r) => r.status === "pending" || r.status === "rejected")
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((row) => ({
          id: row.id,
          slug: row.slug,
          displayName: row.displayName,
          description: row.description,
          spritesheetUrl: row.spritesheetUrl,
          zipUrl: row.zipUrl,
          kind: row.kind,
          vibes: (row.vibes as string[]) ?? [],
          tags: (row.tags as string[]) ?? [],
          featured: row.featured,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          approvedAt: row.approvedAt?.toISOString() ?? null,
          rejectedAt: row.rejectedAt?.toISOString() ?? null,
          rejectionReason: row.rejectionReason,
          pending: row.pendingSubmittedAt
            ? {
                displayName: row.pendingDisplayName,
                description: row.pendingDescription,
                tags: (row.pendingTags as string[] | null) ?? null,
                submittedAt: row.pendingSubmittedAt.toISOString(),
              }
            : null,
          pendingRejectionReason: row.pendingRejectionReason,
          metrics: { installCount: 0, zipDownloadCount: 0, likeCount: 0 },
        }))
    : [];
  const collection = await getOwnerCollection(ownerId);
  const likedPets = await getLikedPetsForUser(ownerId);

  // Resolve pinned slugs to full pet objects, preserving owner-chosen
  // order. Drop any that are no longer approved (would otherwise break
  // the layout with empty cards).
  const featuredSet = new Set(featuredSlugs);
  const featuredPets = featuredSlugs
    .map((slug) => pets.find((p) => p.slug === slug))
    .filter((p): p is PetWithMetrics => Boolean(p));
  const restPets = pets.filter((p) => !featuredSet.has(p.slug));

  // Aggregate stats.
  const totalLikes = pets.reduce((acc, p) => acc + p.metrics.likeCount, 0);
  const totalInstalls = pets.reduce(
    (acc, p) => acc + p.metrics.installCount,
    0,
  );

  // Admins get a "Creator of Petdex" badge instead of a numeric rank,
  // since they're filtered out of the leaderboard. For everyone else
  // we look up their rank by approved-pet count and only render the
  // badge when they're inside the top 50.
  const isOwnerAdmin = isAdmin(ownerId);
  const rank = isOwnerAdmin ? null : await getOwnerRank(ownerId, "pets");

  const catchProgress = isOwner ? await getCatchProgress(viewerId) : null;
  const canManageOwnCollection = isOwner
    ? await canManageCreatorCollections(viewerId)
    : false;

  const fallbackInitial = (displayName ?? publicHandle)
    .slice(0, 1)
    .toUpperCase();

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    mainEntity: {
      "@type": "Person",
      name: displayName ?? `@${publicHandle}`,
      url: `${SITE_URL}/u/${publicHandle}`,
      ...(avatarUrl ? { image: avatarUrl } : {}),
      ...(externalUrls.length > 0
        ? { sameAs: externalUrls.map((e) => e.url) }
        : {}),
    },
  };

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <JsonLd data={jsonLd} />
      <ProfileAnalytics
        handle={publicHandle}
        petCount={pets.length}
        pinnedCount={featuredPets.length}
        viewerIsOwner={isOwner}
      />

      <SiteHeader />
      <section className="petdex-cloud relative -mt-[84px] overflow-clip pt-[84px]">
        <div className="relative mx-auto flex w-full max-w-[1440px] flex-col px-5 pb-10 md:px-8">
          <header className="mt-10 grid gap-8 md:mt-14 lg:grid-cols-[auto_1fr_auto] lg:items-start">
            {/* Avatar */}
            <div className="flex justify-center lg:block">
              {avatarUrl ? (
                // biome-ignore lint/performance/noImgElement: Clerk-hosted avatar
                <img
                  src={avatarUrl}
                  alt={displayName ?? `@${publicHandle}`}
                  className="size-28 rounded-3xl object-cover ring-1 ring-black/10 md:size-32"
                />
              ) : (
                <div className="grid size-28 place-items-center rounded-3xl bg-surface font-mono text-3xl font-semibold text-muted-2 ring-1 ring-black/10 md:size-32">
                  {fallbackInitial}
                </div>
              )}
            </div>

            {/* Identity */}
            <div className="text-center lg:text-left">
              <div className="flex flex-wrap items-center justify-center gap-2 lg:justify-start">
                <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
                  Petdex creator
                </p>
                {catchProgress ? (
                  <p className="font-mono text-xs tracking-[0.22em] text-muted-3 uppercase">
                    YOUR ALBUM: {catchProgress.caught}/{catchProgress.total} (
                    {catchProgress.pct}%)
                  </p>
                ) : null}
                {isOwnerAdmin ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-full bg-brand px-2 py-0.5 font-mono text-[10px] tracking-[0.15em] text-white uppercase"
                    title="One of the people who built Petdex"
                  >
                    <Trophy className="size-3" />
                    Creator of Petdex
                  </span>
                ) : rank ? (
                  <Link
                    href="/leaderboard"
                    className="inline-flex items-center gap-1 rounded-full bg-chip-warning-bg px-2 py-0.5 font-mono text-[10px] tracking-[0.15em] text-chip-warning-fg uppercase transition hover:opacity-80"
                    title={`Ranked #${rank.rank} of ${rank.total} by approved pets — see the full leaderboard`}
                  >
                    <Trophy className="size-3" />#{rank.rank} most pets
                  </Link>
                ) : null}
              </div>
              <h1 className="mt-3 text-balance text-[40px] leading-[1] font-semibold tracking-tight md:text-[56px]">
                {displayName ?? `@${publicHandle}`}
              </h1>
              {displayName ? (
                <p className="mt-2 font-mono text-sm tracking-[0.08em] text-muted-3">
                  @{publicHandle}
                </p>
              ) : null}
              {bio ? (
                <p className="mt-4 max-w-xl text-balance text-base leading-7 text-muted-1 md:text-lg">
                  {bio}
                </p>
              ) : null}

              {/* Stats row */}
              <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 font-mono text-[11px] tracking-[0.18em] text-muted-3 uppercase lg:justify-start">
                <span>
                  {pets.length} {pets.length === 1 ? "pet" : "pets"}
                </span>
                {totalLikes > 0 ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Heart className="size-3" />
                    {totalLikes}
                  </span>
                ) : null}
                {totalInstalls > 0 ? (
                  <span className="inline-flex items-center gap-1.5">
                    <TerminalSquare className="size-3" />
                    {totalInstalls} installs
                  </span>
                ) : null}
                {memberSince ? (
                  <span>
                    joined{" "}
                    {new Date(memberSince).toLocaleDateString(undefined, {
                      month: "short",
                      year: "numeric",
                    })}
                  </span>
                ) : null}
              </div>

              {/* External links */}
              {externalUrls.length > 0 ? (
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2 lg:justify-start">
                  {externalUrls.map((e) => (
                    <ProfileExternalLink
                      key={e.url}
                      handle={publicHandle}
                      url={e.url}
                      label={e.label}
                    />
                  ))}
                </div>
              ) : null}
            </div>

            {/* Owner + visitor actions. Share is on for everyone so a
                fan can spread a profile they liked, the same growth
                motion as the creator promoting their own page. */}
            <div className="flex flex-wrap items-center justify-center gap-2 lg:justify-end">
              <ProfileShareButton
                handle={publicHandle}
                displayName={displayName}
              />
              {isOwner ? (
                <ProfileInlineEditor
                  handle={publicHandle}
                  initialDisplayName={displayName}
                  initialBio={bio}
                  initialFeaturedSlugs={featuredSlugs}
                  approvedPets={pets.map((p) => ({
                    slug: p.slug,
                    displayName: p.displayName,
                  }))}
                />
              ) : null}
            </div>
          </header>
        </div>
      </section>

      <section className="mx-auto flex w-full max-w-[1440px] flex-col gap-8 px-5 py-12 md:px-8 md:py-16">
        {featuredPets.length > 0 ? (
          isOwner && featuredPets.length >= 2 ? (
            <PinnedReorderGrid
              pets={featuredPets}
              petStateCount={petStates.length}
            />
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="font-mono text-[11px] tracking-[0.22em] text-brand uppercase">
                  ★ Pinned
                </p>
                <p className="font-mono text-[10px] tracking-[0.18em] text-muted-4 uppercase">
                  {featuredPets.length} of {MAX_PINNED_PETS}
                </p>
              </div>
              {featuredPets.length === 1 ? (
                <div className="relative">
                  {isOwner ? (
                    <div className="absolute top-4 right-4">
                      <ProfilePinButton
                        slug={featuredPets[0].slug}
                        isPinned
                        pinnedCount={featuredPets.length}
                        maxPins={MAX_PINNED_PETS}
                      />
                    </div>
                  ) : null}
                  <FeaturedPin pet={featuredPets[0]} />
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 lg:grid-cols-6">
                  {featuredPets.map((pet, index) => (
                    <div key={pet.slug} className="relative h-full">
                      <PetCard
                        pet={pet}
                        index={index}
                        stateCount={petStates.length}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        ) : null}

        <ProfileTabs
          isOwner={isOwner}
          publicHandle={publicHandle}
          approvedPets={restPets}
          ownerSubmissions={ownerSubmissions}
          likedPets={likedPets}
          collection={
            collection
              ? {
                  slug: collection.slug,
                  title: collection.title,
                  description: collection.description,
                  externalUrl: collection.externalUrl,
                  coverPetSlug: collection.coverPetSlug,
                  petSlugs: collection.pets.map((pet) => pet.slug),
                }
              : null
          }
          canManageCollections={canManageOwnCollection}
          collectionApprovedPets={pets.map((p) => ({
            slug: p.slug,
            displayName: p.displayName,
            spritesheetUrl: p.spritesheetPath,
          }))}
          pinning={
            isOwner
              ? { pinnedSlugs: featuredSlugs, maxPins: MAX_PINNED_PETS }
              : null
          }
        />
      </section>

      <SiteFooter />
    </main>
  );
}

function FeaturedPin({ pet }: { pet: PetWithMetrics }) {
  return (
    <Link
      href={`/pets/${pet.slug}`}
      aria-label={`Open ${pet.displayName}`}
      className="featured-pin-card group relative flex flex-col overflow-hidden rounded-3xl border border-brand-light/45 bg-surface/80 backdrop-blur transition hover:bg-white md:flex-row md:items-stretch dark:hover:bg-stone-800"
    >
      <div className="pet-sprite-stage featured-pin-stage flex shrink-0 items-center justify-center px-8 py-10 md:w-[420px] md:py-14">
        <PetSprite
          src={pet.spritesheetPath}
          cycleStates
          scale={1.1}
          label={`${pet.displayName} animated`}
        />
      </div>
      <div className="flex flex-1 flex-col justify-center gap-3 border-t border-black/[0.06] p-6 md:border-t-0 md:border-l dark:border-white/[0.06]">
        <span className="font-mono text-[11px] tracking-[0.22em] text-brand uppercase">
          ★ Pinned
        </span>
        <h2 className="text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
          {pet.displayName}
        </h2>
        <p className="max-w-2xl text-base leading-7 text-muted-2">
          {pet.description}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
          {pet.metrics.likeCount > 0 ? (
            <span className="inline-flex items-center gap-1.5">
              <Heart className="size-3" />
              {pet.metrics.likeCount}
            </span>
          ) : null}
          {pet.metrics.installCount > 0 ? (
            <span className="inline-flex items-center gap-1.5">
              <TerminalSquare className="size-3" />
              {pet.metrics.installCount} installs
            </span>
          ) : null}
          <span>{pet.kind}</span>
        </div>
      </div>
    </Link>
  );
}
