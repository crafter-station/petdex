import Link from "next/link";
import { notFound } from "next/navigation";

import { auth } from "@clerk/nextjs/server";
import { and, eq, inArray } from "drizzle-orm";
import { Layers, Shuffle, Sparkles } from "lucide-react";
import { getTranslations } from "next-intl/server";

import {
  getCollectionCandidatesForPet,
  getCollectionsContainingPet,
} from "@/lib/collections";
import { db, schema } from "@/lib/db/client";
import { formatDexNumber, getDexNumberMap } from "@/lib/dex";
import { buildLocaleAlternates } from "@/lib/locale-routing";
import { resolveOwnerCreditFor } from "@/lib/owner-credit";
import { computeStats } from "@/lib/pet-stats";
import {
  getApprovedPetsWithMetrics,
  getPet,
  getStaticPetSlugs,
} from "@/lib/pets";
import { getVariantsFor } from "@/lib/variants";

import { ClaimCTA } from "@/components/claim-cta";
import { InstallCommand } from "@/components/install-command";
import { JsonLd } from "@/components/json-ld";
import { LikeButton } from "@/components/like-button";
import { OwnerEditPanel } from "@/components/owner-edit-panel";
import { PetActionMenu } from "@/components/pet-action-menu";
import { PetFloater } from "@/components/pet-floater";
import { PetKeyboardNav } from "@/components/pet-keyboard-nav";
import { PetRadar } from "@/components/pet-radar";
import { PetSoundButton } from "@/components/pet-sound-button";
import { PetSprite } from "@/components/pet-sprite";
import { PetStateViewer } from "@/components/pet-state-viewer";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { SubmittedBy } from "@/components/submitted-by";
import { SuggestCollectionButton } from "@/components/suggest-collection-button";

const SITE_URL = "https://petdex.crafter.run";

type PageProps = {
  params: Promise<{
    locale: string;
    slug: string;
  }>;
};

type DexNavPet = {
  slug: string;
  displayName: string;
  dexNumber: number;
};

export async function generateStaticParams() {
  const slugs = await getStaticPetSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  const pet = await getPet(slug);

  if (!pet) {
    return {
      title: "Pet not found",
      robots: { index: false, follow: false },
    };
  }

  const title = `${pet.displayName} — Animated Codex pet`;
  const description = `Install ${pet.displayName} for Codex: ${pet.description} One command, animated pixel art, ${pet.tags.slice(0, 3).join(" + ") || "open source"}.`;
  const url = `${SITE_URL}/pets/${pet.slug}`;

  return {
    title,
    description,
    alternates: buildLocaleAlternates(`/pets/${pet.slug}`),
    keywords: [
      pet.displayName,
      `${pet.displayName} Codex pet`,
      `${pet.displayName} pixel pet`,
      "Codex pet",
      ...pet.tags.slice(0, 4),
      ...pet.vibes.slice(0, 2),
    ],
    openGraph: {
      title,
      description,
      url,
      type: "article",
      // images auto-injected from app/pets/[slug]/opengraph-image.tsx
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

export default async function PetPage({ params }: PageProps) {
  const { slug } = await params;
  const pet = await getPet(slug);
  const tPet = await getTranslations("pet");

  if (!pet) {
    notFound();
  }

  const dexMap = await getDexNumberMap();
  const currentDexNumber = dexMap.get(slug) ?? null;

  let prevSlug: string | null = null;
  let nextSlug: string | null = null;
  if (currentDexNumber != null) {
    for (const [entrySlug, dexNumber] of dexMap.entries()) {
      if (dexNumber === currentDexNumber - 1) prevSlug = entrySlug;
      if (dexNumber === currentDexNumber + 1) nextSlug = entrySlug;
    }
  }

  const neighborSlugs = [prevSlug, nextSlug].filter((value): value is string =>
    Boolean(value),
  );
  const neighborRows =
    neighborSlugs.length > 0
      ? await db
          .select({
            slug: schema.submittedPets.slug,
            displayName: schema.submittedPets.displayName,
          })
          .from(schema.submittedPets)
          .where(inArray(schema.submittedPets.slug, neighborSlugs))
      : [];
  const neighborNameMap = new Map(
    neighborRows.map((row) => [row.slug, row.displayName]),
  );
  const prevDexNumber = prevSlug ? dexMap.get(prevSlug) : undefined;
  const nextDexNumber = nextSlug ? dexMap.get(nextSlug) : undefined;
  const prevPet =
    prevSlug && prevDexNumber !== undefined
      ? {
          slug: prevSlug,
          displayName: neighborNameMap.get(prevSlug) ?? prevSlug,
          dexNumber: prevDexNumber,
        }
      : null;
  const nextPet =
    nextSlug && nextDexNumber !== undefined
      ? {
          slug: nextSlug,
          displayName: neighborNameMap.get(nextSlug) ?? nextSlug,
          dexNumber: nextDexNumber,
        }
      : null;

  const [{ userId }, allPets, ownerRow, variants, memberOfCollections] =
    await Promise.all([
      auth(),
      getApprovedPetsWithMetrics(),
      db.query.submittedPets.findFirst({
        where: eq(schema.submittedPets.slug, slug),
      }),
      getVariantsFor(slug),
      getCollectionsContainingPet(slug),
    ]);
  const petWithMetrics = allPets.find((candidate) => candidate.slug === slug);
  const metrics = petWithMetrics?.metrics ?? {
    installCount: 0,
    zipDownloadCount: 0,
    likeCount: 0,
  };
  const stats = computeStats(
    {
      importedAt: pet.importedAt,
      metrics,
    },
    allPets.map((candidate) => ({
      importedAt: candidate.importedAt,
      metrics: candidate.metrics,
    })),
  );
  const initialLiked = userId
    ? Boolean(
        await db.query.petLikes.findFirst({
          where: and(
            eq(schema.petLikes.userId, userId),
            eq(schema.petLikes.petSlug, slug),
          ),
        }),
      )
    : false;

  // Resolve the "submitted by" credit live from Clerk so name/url/avatar
  // reflect the user's *current* profile (not the snapshot taken at
  // submit time). Falls back to row.credit_* for orphan rows.
  const ownerCredit = ownerRow
    ? await resolveOwnerCreditFor({
        ownerId: ownerRow.ownerId,
        creditName: ownerRow.creditName,
        creditUrl: ownerRow.creditUrl,
        // Discovered rows can carry a stale credit_image from the seed
        // import that belongs to a *different* user (the importer's
        // primary login or whichever Clerk profile was active during
        // the bulk insert). Drop it for discovered rows so we never
        // show another person's avatar; we still show the right name +
        // GitHub url because those came from the seed enrichment.
        creditImage:
          ownerRow.source === "discover" ? null : ownerRow.creditImage,
        // For 'discover' rows the ownerId is the admin who imported
        // on the author's behalf, NOT the author. Use stored credit_*
        // exclusively so the author keeps the byline. After someone
        // claims the row source flips to 'claimed' and we go back to
        // resolving from the live Clerk profile.
        ownerIsProxy: ownerRow.source === "discover",
      })
    : null;

  let ownerEditState: {
    isOwner: boolean;
    petId: string;
    currentTags: string[];
    pending: {
      displayName: string | null;
      description: string | null;
      tags: string[] | null;
      submittedAt: string | null;
    } | null;
    lastRejection: string | null;
  } | null = null;
  if (userId && ownerRow && ownerRow.ownerId === userId) {
    const hasPending = Boolean(ownerRow.pendingSubmittedAt);
    ownerEditState = {
      isOwner: true,
      petId: ownerRow.id,
      currentTags: (ownerRow.tags as string[]) ?? [],
      pending: hasPending
        ? {
            displayName: ownerRow.pendingDisplayName,
            description: ownerRow.pendingDescription,
            tags: (ownerRow.pendingTags as string[] | null) ?? null,
            submittedAt: ownerRow.pendingSubmittedAt
              ? ownerRow.pendingSubmittedAt.toISOString()
              : null,
          }
        : null,
      lastRejection: ownerRow.pendingRejectionReason,
    };
  }

  // Owner-only: candidate featured collections + already-submitted
  // pending requests for the suggest button.
  const collectionSuggest =
    userId && ownerRow && ownerRow.ownerId === userId
      ? await getCollectionCandidatesForPet(slug, userId)
      : null;

  const url = `${SITE_URL}/pets/${pet.slug}`;
  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "CreativeWork",
      "@id": `${url}#pet`,
      name: pet.displayName,
      description: pet.description,
      url,
      image: pet.spritesheetPath,
      keywords: [...pet.tags, ...pet.vibes].join(", "),
      genre: pet.kind,
      datePublished: pet.importedAt,
      isPartOf: { "@type": "WebSite", "@id": `${SITE_URL}/#website` },
      ...(ownerCredit
        ? {
            creator: {
              "@type": "Person",
              name: ownerCredit.name,
              ...(ownerCredit.externals[0]
                ? { url: ownerCredit.externals[0].url }
                : {}),
              ...(ownerCredit.imageUrl ? { image: ownerCredit.imageUrl } : {}),
            },
          }
        : {}),
      ...(metrics.likeCount > 0
        ? {
            interactionStatistic: {
              "@type": "InteractionCounter",
              interactionType: "https://schema.org/LikeAction",
              userInteractionCount: metrics.likeCount,
            },
          }
        : {}),
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Petdex",
          item: SITE_URL,
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "Pets",
          item: `${SITE_URL}/#gallery`,
        },
        {
          "@type": "ListItem",
          position: 3,
          name: pet.displayName,
          item: url,
        },
      ],
    },
  ];

  const shuffleHref = `/api/pets/random?exclude=${encodeURIComponent(pet.slug)}`;

  return (
    <main className="min-h-dvh bg-background">
      <JsonLd data={jsonLd} />

      {/* Wire keyboard shortcuts: ←/→ for prev/next, Space for shuffle.
          Renders nothing — purely a side-effect listener. */}
      <PetKeyboardNav
        prevSlug={prevPet?.slug ?? null}
        nextSlug={nextPet?.slug ?? null}
        shuffleHref={shuffleHref}
      />

      {/* Hero banner — full-width petdex-cloud gradient like /u/[handle].
          Houses the dex nav pills, the title block, the action row, and
          (if the viewer owns the pet) the inline edit button. The
          animated sprite + install command + secondary panels live
          below in their own contained section. */}
      <section className="petdex-cloud relative z-10 overflow-visible">
        <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 pt-5 pb-10 md:px-8 md:pb-14">
          <SiteHeader />

          {/* Interactive floater pet — drag, click, watch. Renders an
              absolute-positioned sprite over the banner's empty right
              side. Mounted INSIDE the max-w-6xl content wrapper so it
              shares the same coordinate space and z-index as the rest
              of the banner. Only rendered on md+ where there's enough
              room; on mobile the banner is too cramped. */}
          <PetFloater src={pet.spritesheetPath} petName={pet.displayName} />

          {/* Dex nav pills + shuffle. Sit at the top edge of the banner
              so they read like a Pokédex chrome strip, not page content. */}
          <nav
            aria-label={tPet("navigation.ariaLabel")}
            className="flex flex-wrap items-center justify-between gap-3"
          >
            <DexNavPill pet={prevPet} direction="prev" />
            <Link
              href={shuffleHref}
              className="inline-flex h-10 items-center gap-2 rounded-full border border-border-base bg-surface/80 px-4 text-sm font-medium text-foreground backdrop-blur transition hover:border-border-strong"
              title={tPet("navigation.shuffleTitle")}
            >
              <Shuffle className="size-4" />
              Shuffle
              <kbd className="ml-1 rounded border border-border-base bg-surface px-1.5 py-0.5 font-mono text-[10px] tracking-[0.05em] text-muted-3">
                Space
              </kbd>
            </Link>
            <DexNavPill pet={nextPet} direction="next" />
          </nav>

          <header className="mt-6 flex flex-col gap-5">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
              <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
                {pet.featured ? "Featured" : "Petdex entry"}
              </p>
              {currentDexNumber != null ? (
                <p className="font-mono text-xs tracking-[0.22em] text-muted-3 uppercase">
                  No. {formatDexNumber(currentDexNumber)}
                </p>
              ) : null}
              <p className="font-mono text-xs tracking-[0.22em] text-muted-3 uppercase">
                {pet.kind}
              </p>
            </div>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <h1 className="text-balance text-[44px] leading-[1] font-semibold tracking-tight text-foreground md:text-[64px]">
                {pet.displayName}
              </h1>
              {ownerEditState ? (
                <OwnerEditPanel
                  petId={ownerEditState.petId}
                  slug={pet.slug}
                  currentDisplayName={pet.displayName}
                  currentDescription={pet.description}
                  currentTags={ownerEditState.currentTags}
                  initialPending={ownerEditState.pending}
                  initialRejection={ownerEditState.lastRejection}
                />
              ) : null}
            </div>
            <p className="max-w-3xl text-balance text-base leading-7 text-muted-1 md:text-lg">
              {pet.description}
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <LikeButton
                slug={pet.slug}
                initialCount={metrics.likeCount}
                initialLiked={initialLiked}
                signedIn={Boolean(userId)}
              />
              {pet.soundUrl ? (
                <PetSoundButton
                  soundUrl={pet.soundUrl}
                  displayName={pet.displayName}
                  labelPrefix="Play signature sound for"
                />
              ) : null}
              <PetActionMenu
                pet={{
                  slug: pet.slug,
                  displayName: pet.displayName,
                  zipUrl: pet.zipUrl,
                  description: pet.description,
                }}
                variant="detail"
              />
              <span className="font-mono text-[11px] tracking-[0.18em] text-muted-3 uppercase">
                {metrics.installCount} installs · {metrics.zipDownloadCount}{" "}
                downloads
              </span>
            </div>

            {pet.tags.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {pet.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-brand-tint px-2.5 py-1 text-xs font-medium text-brand dark:bg-brand-tint-dark"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}

            {memberOfCollections.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 font-mono text-[11px] tracking-[0.18em] text-muted-3 uppercase">
                  <Layers className="size-3.5" />
                  Part of
                </span>
                {memberOfCollections.map((col) => (
                  <Link
                    key={col.slug}
                    href={`/collections/${col.slug}`}
                    className="rounded-full border border-border-base bg-surface px-2.5 py-1 text-xs font-medium text-muted-2 transition hover:border-border-strong hover:text-foreground"
                  >
                    {col.title}
                  </Link>
                ))}
              </div>
            ) : null}

            {collectionSuggest && collectionSuggest.candidates.length > 0 ? (
              <SuggestCollectionButton
                petSlug={slug}
                petDisplayName={pet.displayName}
                candidateCollections={collectionSuggest.candidates}
                alreadyRequested={collectionSuggest.alreadyRequested}
              />
            ) : null}

            {/* Keyboard hint strip — minimal, mono-spaced, only on
                pointer-fine media so we don't spam mobile users with
                Esc/arrow chrome. */}
            <p className="hidden flex-wrap items-center gap-3 font-mono text-[11px] tracking-[0.18em] text-muted-3 uppercase md:flex">
              <span>{tPet("keyboardHint.tip")}</span>
              <span className="inline-flex items-center gap-1">
                <kbd className="rounded border border-border-base bg-surface px-1.5 py-0.5 text-[10px] text-muted-2">
                  ←
                </kbd>
                <kbd className="rounded border border-border-base bg-surface px-1.5 py-0.5 text-[10px] text-muted-2">
                  →
                </kbd>
                {tPet("keyboardHint.browse")}
              </span>
              <span className="inline-flex items-center gap-1">
                <kbd className="rounded border border-border-base bg-surface px-1.5 py-0.5 text-[10px] text-muted-2">
                  Space
                </kbd>
                {tPet("keyboardHint.shuffle")}
              </span>
            </p>
          </header>
        </div>
      </section>

      <section className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-5 py-12 md:px-8 md:py-16">
        {/* The animated sprite is the product. Lives right after the
            banner so it lands above the fold on most screens. */}
        <PetStateViewer src={pet.spritesheetPath} petName={pet.displayName} />

        {/* Two-column lockup: install command + owner credit aside.
            Stats radar + variants live below so the install never
            gets pushed out of the first viewport. */}
        <div className="grid gap-6 lg:grid-cols-[1fr_360px] lg:items-start">
          <InstallCommand slug={pet.slug} displayName={pet.displayName} />

          {ownerCredit ? (
            <div className="space-y-3">
              <SubmittedBy credit={ownerCredit} />
              {ownerRow?.source === "discover" && !userId ? (
                <ClaimCTA
                  petName={pet.displayName}
                  authorLabel={ownerCredit.name}
                  githubUrl={
                    ownerCredit.externals.find((e) => e.provider === "github")
                      ?.url ?? null
                  }
                />
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <InfoCard
            title={tPet("stats.title")}
            icon={<Sparkles className="size-4" />}
          >
            <div className="flex items-center justify-center py-2">
              <PetRadar
                {...stats}
                ariaLabel={tPet("stats.ariaLabel")}
                labels={{
                  vibrance: tPet("stats.vibrance"),
                  popularity: tPet("stats.popularity"),
                  loved: tPet("stats.loved"),
                  freshness: tPet("stats.freshness"),
                }}
              />
            </div>
          </InfoCard>

          {variants.length > 0 ? (
            <section className="rounded-2xl border border-border-base bg-surface/76 p-5 shadow-sm shadow-blue-950/5 backdrop-blur">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Sparkles className="size-4" />
                Variants of this character
              </div>
              <p className="mt-2 text-sm text-muted-2">
                Other approved pets with closely matching sprite shapes.
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {variants.map((variant) => (
                  <Link
                    key={variant.slug}
                    href={`/pets/${variant.slug}`}
                    className="group flex items-center gap-3 rounded-2xl border border-border-base bg-background/70 p-3 transition hover:-translate-y-0.5 hover:border-brand/35 hover:bg-background"
                  >
                    <div className="shrink-0 rounded-2xl border border-border-base bg-surface p-2">
                      <PetSprite
                        src={variant.spritesheetUrl}
                        scale={0.45}
                        label={`${variant.displayName} animated`}
                      />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground transition group-hover:text-brand">
                        {variant.displayName}
                      </p>
                      <p className="mt-1 font-mono text-[11px] tracking-[0.16em] text-muted-3 uppercase">
                        #{formatDexNumber(variant.dexNumber)}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        {!ownerCredit ? (
          <InfoCard title="Submission" icon={<Sparkles className="size-4" />}>
            <p>Curated entry.</p>
            <p>Updated {new Date(pet.importedAt).toLocaleDateString()}</p>
          </InfoCard>
        ) : null}
      </section>

      <SiteFooter />
    </main>
  );
}

function DexNavPill({
  pet,
  direction,
}: {
  pet: DexNavPet | null;
  direction: "prev" | "next";
}) {
  if (!pet) return null;

  return (
    <Link
      href={`/pets/${pet.slug}`}
      className={`inline-flex min-h-10 items-center gap-2 rounded-full border border-border-base bg-surface px-4 py-2 text-sm text-foreground transition hover:border-border-strong ${direction === "next" ? "ml-auto" : ""}`}
    >
      {direction === "prev" ? <span aria-hidden="true">←</span> : null}
      <span className="font-mono text-xs tracking-[0.16em]">
        #{formatDexNumber(pet.dexNumber)}
      </span>
      <span className="font-normal">{pet.displayName}</span>
      {direction === "next" ? <span aria-hidden="true">→</span> : null}
    </Link>
  );
}

function InfoCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border-base bg-surface/76 p-5 shadow-sm shadow-blue-950/5 backdrop-blur">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        {icon}
        {title}
      </div>
      <div className="mt-4 space-y-2 break-words text-sm leading-6 text-muted-2">
        {children}
      </div>
    </div>
  );
}
