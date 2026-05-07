import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

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

const SITE_URL = "https://petdex.crafter.run";

type PageProps = { params: Promise<{ handle: string; locale: string }> };

type PublicProfile = {
  ownerId: string;
  publicHandle: string;
  displayName: string | null;
  avatarUrl: string | null;
  externalUrls: { url: string; label: string }[];
  memberSince: number | null;
  bio: string | null;
  featuredSlugs: string[];
  approvedPets: PetWithMetrics[];
  collection: Awaited<ReturnType<typeof getOwnerCollection>>;
  totalLikes: number;
  totalInstalls: number;
  isOwnerAdmin: boolean;
  rank: { rank: number; total: number } | null;
};

async function loadPublicProfile(
  handle: string,
): Promise<PublicProfile | null> {
  const requestedHandle = handle.toLowerCase();
  const ownerId = await userIdForHandle(handle);
  if (!ownerId) return null;

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

  const approvedPets: PetWithMetrics[] = approvedRows.map((row) => ({
    ...rowToPet(row),
    metrics: metrics.get(row.slug) ?? {
      installCount: 0,
      zipDownloadCount: 0,
      likeCount: 0,
    },
  }));

  const collection = await getOwnerCollection(ownerId);
  const totalLikes = approvedPets.reduce(
    (acc, p) => acc + p.metrics.likeCount,
    0,
  );
  const totalInstalls = approvedPets.reduce(
    (acc, p) => acc + p.metrics.installCount,
    0,
  );
  const isOwnerAdmin = isAdmin(ownerId);
  const rank = isOwnerAdmin ? null : await getOwnerRank(ownerId, "pets");

  return {
    ownerId,
    publicHandle,
    displayName,
    avatarUrl,
    externalUrls,
    memberSince,
    bio,
    featuredSlugs,
    approvedPets,
    collection,
    totalLikes,
    totalInstalls,
    isOwnerAdmin,
    rank,
  };
}

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
  return {
    title: `${displayName} on Petdex`,
    description: `Pets created by ${displayName} for Codex.`,
    alternates: buildLocaleAlternates(`/u/${publicHandle}`),
    openGraph: {
      title: `${displayName} on Petdex`,
      description: `Animated Codex pets created by ${displayName}.`,
      url: `${SITE_URL}/u/${publicHandle}`,
    },
  };
}

export default async function UserProfilePage({ params }: PageProps) {
  const { handle } = await params;
  const data = await loadPublicProfile(handle);
  if (!data) notFound();

  const featuredSet = new Set(data.featuredSlugs);
  const featuredPets = data.featuredSlugs
    .map((slug) => data.approvedPets.find((p) => p.slug === slug))
    .filter((p): p is PetWithMetrics => Boolean(p));
  const restPets = data.approvedPets.filter((p) => !featuredSet.has(p.slug));

  const fallbackInitial = (data.displayName ?? data.publicHandle)
    .slice(0, 1)
    .toUpperCase();

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    mainEntity: {
      "@type": "Person",
      name: data.displayName ?? `@${data.publicHandle}`,
      url: `${SITE_URL}/u/${data.publicHandle}`,
      ...(data.avatarUrl ? { image: data.avatarUrl } : {}),
      ...(data.externalUrls.length > 0
        ? { sameAs: data.externalUrls.map((e) => e.url) }
        : {}),
    },
  };

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <JsonLd data={jsonLd} />

      <section className="petdex-cloud relative overflow-hidden">
        <div className="relative mx-auto flex w-full max-w-7xl flex-col px-5 pt-5 pb-10 md:px-8">
          <SiteHeader />

          <header className="mt-10 grid gap-8 md:mt-14 lg:grid-cols-[auto_1fr_auto] lg:items-start">
            <div className="flex justify-center lg:block">
              {data.avatarUrl ? (
                // biome-ignore lint/performance/noImgElement: Clerk-hosted avatar
                <img
                  src={data.avatarUrl}
                  alt={data.displayName ?? `@${data.publicHandle}`}
                  className="size-28 rounded-3xl object-cover ring-1 ring-black/10 md:size-32"
                />
              ) : (
                <div className="grid size-28 place-items-center rounded-3xl bg-surface font-mono text-3xl font-semibold text-muted-2 ring-1 ring-black/10 md:size-32">
                  {fallbackInitial}
                </div>
              )}
            </div>

            <div className="text-center lg:text-left">
              <div className="flex flex-wrap items-center justify-center gap-2 lg:justify-start">
                <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
                  Petdex creator
                </p>
                <Suspense fallback={null}>
                  <ViewerCatchProgress ownerId={data.ownerId} />
                </Suspense>
                {data.isOwnerAdmin ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-full bg-brand px-2 py-0.5 font-mono text-[10px] tracking-[0.15em] text-white uppercase"
                    title="One of the people who built Petdex"
                  >
                    <Trophy className="size-3" />
                    Creator of Petdex
                  </span>
                ) : data.rank ? (
                  <Link
                    href="/leaderboard"
                    className="inline-flex items-center gap-1 rounded-full bg-chip-warning-bg px-2 py-0.5 font-mono text-[10px] tracking-[0.15em] text-chip-warning-fg uppercase transition hover:opacity-80"
                    title={`Ranked #${data.rank.rank} of ${data.rank.total} by approved pets — see the full leaderboard`}
                  >
                    <Trophy className="size-3" />#{data.rank.rank} most pets
                  </Link>
                ) : null}
              </div>
              <h1 className="mt-3 text-balance text-[40px] leading-[1] font-semibold tracking-tight md:text-[56px]">
                {data.displayName ?? `@${data.publicHandle}`}
              </h1>
              {data.displayName ? (
                <p className="mt-2 font-mono text-sm tracking-[0.08em] text-muted-3">
                  @{data.publicHandle}
                </p>
              ) : null}
              {data.bio ? (
                <p className="mt-4 max-w-xl text-balance text-base leading-7 text-muted-1 md:text-lg">
                  {data.bio}
                </p>
              ) : null}

              <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 font-mono text-[11px] tracking-[0.18em] text-muted-3 uppercase lg:justify-start">
                <span>
                  {data.approvedPets.length}{" "}
                  {data.approvedPets.length === 1 ? "pet" : "pets"}
                </span>
                {data.totalLikes > 0 ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Heart className="size-3" />
                    {data.totalLikes}
                  </span>
                ) : null}
                {data.totalInstalls > 0 ? (
                  <span className="inline-flex items-center gap-1.5">
                    <TerminalSquare className="size-3" />
                    {data.totalInstalls} installs
                  </span>
                ) : null}
                {data.memberSince ? (
                  <span>
                    joined{" "}
                    {new Date(data.memberSince).toLocaleDateString(undefined, {
                      month: "short",
                      year: "numeric",
                    })}
                  </span>
                ) : null}
              </div>

              {data.externalUrls.length > 0 ? (
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2 lg:justify-start">
                  {data.externalUrls.map((e) => (
                    <ProfileExternalLink
                      key={e.url}
                      handle={data.publicHandle}
                      url={e.url}
                      label={e.label}
                    />
                  ))}
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2 lg:justify-end">
              <ProfileShareButton
                handle={data.publicHandle}
                displayName={data.displayName}
              />
              <Suspense fallback={null}>
                <OwnerEditButton
                  ownerId={data.ownerId}
                  publicHandle={data.publicHandle}
                  displayName={data.displayName}
                  bio={data.bio}
                  featuredSlugs={data.featuredSlugs}
                  approvedPets={data.approvedPets.map((p) => ({
                    slug: p.slug,
                    displayName: p.displayName,
                  }))}
                />
              </Suspense>
            </div>
          </header>
        </div>
      </section>

      <section className="mx-auto flex w-full max-w-[1440px] flex-col gap-8 px-5 py-12 md:px-8 md:py-16">
        <Suspense
          fallback={
            <PinnedSection
              featuredPets={featuredPets}
              isOwner={false}
              petStateCount={petStates.length}
            />
          }
        >
          <PinnedSectionWithViewer
            ownerId={data.ownerId}
            featuredPets={featuredPets}
          />
        </Suspense>

        <Suspense
          fallback={
            <PublicProfileTabs
              publicHandle={data.publicHandle}
              approvedPets={restPets}
              collection={data.collection}
              approvedAll={data.approvedPets}
            />
          }
        >
          <ProfileTabsWithViewer
            ownerId={data.ownerId}
            publicHandle={data.publicHandle}
            approvedPets={restPets}
            approvedAll={data.approvedPets}
            collection={data.collection}
          />
        </Suspense>
      </section>

      <Suspense fallback={null}>
        <ViewerAnalytics
          ownerId={data.ownerId}
          publicHandle={data.publicHandle}
          petCount={data.approvedPets.length}
          pinnedCount={featuredPets.length}
        />
      </Suspense>

      <SiteFooter />
    </main>
  );
}

async function ViewerAnalytics({
  ownerId,
  publicHandle,
  petCount,
  pinnedCount,
}: {
  ownerId: string;
  publicHandle: string;
  petCount: number;
  pinnedCount: number;
}) {
  const { userId: viewerId } = await auth();
  return (
    <ProfileAnalytics
      handle={publicHandle}
      petCount={petCount}
      pinnedCount={pinnedCount}
      viewerIsOwner={viewerId === ownerId}
    />
  );
}

async function ViewerCatchProgress({ ownerId }: { ownerId: string }) {
  const { userId: viewerId } = await auth();
  if (viewerId !== ownerId) return null;
  const catchProgress = await getCatchProgress(viewerId);
  if (!catchProgress) return null;
  return (
    <p className="font-mono text-xs tracking-[0.22em] text-muted-3 uppercase">
      YOUR ALBUM: {catchProgress.caught}/{catchProgress.total} (
      {catchProgress.pct}%)
    </p>
  );
}

async function OwnerEditButton({
  ownerId,
  publicHandle,
  displayName,
  bio,
  featuredSlugs,
  approvedPets,
}: {
  ownerId: string;
  publicHandle: string;
  displayName: string | null;
  bio: string | null;
  featuredSlugs: string[];
  approvedPets: { slug: string; displayName: string }[];
}) {
  const { userId: viewerId } = await auth();
  if (viewerId !== ownerId) return null;
  return (
    <ProfileInlineEditor
      handle={publicHandle}
      initialDisplayName={displayName}
      initialBio={bio}
      initialFeaturedSlugs={featuredSlugs}
      approvedPets={approvedPets}
    />
  );
}

function PinnedSection({
  featuredPets,
  isOwner,
  petStateCount,
}: {
  featuredPets: PetWithMetrics[];
  isOwner: boolean;
  petStateCount: number;
}) {
  if (featuredPets.length === 0) return null;
  if (isOwner && featuredPets.length >= 2) {
    return (
      <PinnedReorderGrid pets={featuredPets} petStateCount={petStateCount} />
    );
  }
  return (
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
              <PetCard pet={pet} index={index} stateCount={petStateCount} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

async function PinnedSectionWithViewer({
  ownerId,
  featuredPets,
}: {
  ownerId: string;
  featuredPets: PetWithMetrics[];
}) {
  const { userId: viewerId } = await auth();
  return (
    <PinnedSection
      featuredPets={featuredPets}
      isOwner={viewerId === ownerId}
      petStateCount={petStates.length}
    />
  );
}

function PublicProfileTabs({
  publicHandle,
  approvedPets,
  collection,
  approvedAll,
}: {
  publicHandle: string;
  approvedPets: PetWithMetrics[];
  collection: Awaited<ReturnType<typeof getOwnerCollection>>;
  approvedAll: PetWithMetrics[];
}) {
  return (
    <ProfileTabs
      isOwner={false}
      publicHandle={publicHandle}
      approvedPets={approvedPets}
      ownerSubmissions={[]}
      likedPets={[]}
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
      canManageCollections={false}
      collectionApprovedPets={approvedAll.map((p) => ({
        slug: p.slug,
        displayName: p.displayName,
        spritesheetUrl: p.spritesheetPath,
      }))}
    />
  );
}

async function ProfileTabsWithViewer({
  ownerId,
  publicHandle,
  approvedPets,
  approvedAll,
  collection,
}: {
  ownerId: string;
  publicHandle: string;
  approvedPets: PetWithMetrics[];
  approvedAll: PetWithMetrics[];
  collection: Awaited<ReturnType<typeof getOwnerCollection>>;
}) {
  const { userId: viewerId } = await auth();
  const isOwner = viewerId === ownerId;

  if (!isOwner) {
    return (
      <PublicProfileTabs
        publicHandle={publicHandle}
        approvedPets={approvedPets}
        collection={collection}
        approvedAll={approvedAll}
      />
    );
  }

  const allOwnerRows = await db
    .select()
    .from(schema.submittedPets)
    .where(eq(schema.submittedPets.ownerId, ownerId))
    .orderBy(desc(schema.submittedPets.approvedAt));

  const ownerSubmissions: Submission[] = allOwnerRows
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
    }));

  const likedPets = await getLikedPetsForUser(ownerId);
  const canManageOwnCollection = await canManageCreatorCollections(viewerId);

  return (
    <ProfileTabs
      isOwner
      publicHandle={publicHandle}
      approvedPets={approvedPets}
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
      collectionApprovedPets={approvedAll.map((p) => ({
        slug: p.slug,
        displayName: p.displayName,
        spritesheetUrl: p.spritesheetPath,
      }))}
    />
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
