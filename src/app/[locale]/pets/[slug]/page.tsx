import Link from "next/link";
import { notFound } from "next/navigation";

import { Layers, Shuffle, Sparkles } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { getCollectionsContainingPet } from "@/lib/collections";
import { formatDexNumber, getDexEntryMap } from "@/lib/dex";
import { buildLocaleAlternates } from "@/lib/locale-routing";
import { resolveStoredOwnerCreditForSlug } from "@/lib/owner-credit";
import { getPet, getStaticPetSlugs } from "@/lib/pets";
import { getPetStickerAvailability } from "@/lib/sticker-export";
import { getVariantsFor } from "@/lib/variants";

import { ClaimCTA } from "@/components/auth/claim-cta";
import { InstallCommandCompact } from "@/components/download/install-command-compact";
import { InstallCommandLazy } from "@/components/download/install-command-lazy";
import { OpenInCodexButton } from "@/components/download/open-in-codex-button";
import { OpenInPetdexButton } from "@/components/download/open-in-petdex-button";
import { JsonLd } from "@/components/layout/json-ld";
import { ReducedMotionHint } from "@/components/onboarding/reduced-motion-hint";
import { LikeButton } from "@/components/pets/like-button";
import { PetActionMenu } from "@/components/pets/pet-action-menu";
import { PetCountersBar } from "@/components/pets/pet-counters-bar";
import { PetFloater } from "@/components/pets/pet-floater";
import { PetKeyboardNav } from "@/components/pets/pet-keyboard-nav";
import { PetRadarClient } from "@/components/pets/pet-radar-client";
import { PetSoundButton } from "@/components/pets/pet-sound-button";
import { PetSprite } from "@/components/pets/pet-sprite";
import { PetStateViewerLazy } from "@/components/pets/pet-state-viewer-lazy";
import { PetTakedownReportButton } from "@/components/pets/pet-takedown-report-button";
import { SaveAsSticker } from "@/components/pets/save-as-sticker";
import { StaticPetSprite } from "@/components/pets/static-pet-sprite";
import { SubmittedBy } from "@/components/pets/submitted-by";
import { OwnerPetControls } from "@/components/profile/owner-pet-controls";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import { defaultLocale, hasLocale } from "@/i18n/config";

const SITE_URL = "https://petdex.dev";

type PageProps = {
  params: Promise<{
    locale: string;
    slug: string;
  }>;
};

export const dynamicParams = true;
export const dynamic = "force-static";
// Long ISR window — the shell is byte-stable (metrics fetched
// client-side), so the page only needs to regenerate when its
// editorial fields change. Write paths call revalidateTag('pet:${slug}')
// to flush immediately on edit/withdraw/claim/feature.
export const revalidate = 86400;

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
  const { slug, locale } = await params;
  const pet = await getPet(slug);

  if (!pet) {
    return {
      title: "Pet not found",
      robots: { index: false, follow: false },
    };
  }

  const title = `${pet.displayName}: Animated Codex pet`;
  const description = `Install ${pet.displayName} for Codex: ${pet.description} One command, animated pixel art, ${pet.tags.slice(0, 3).join(" + ") || "open source"}.`;
  const url = `${SITE_URL}/pets/${pet.slug}`;

  return {
    title,
    description,
    alternates: buildLocaleAlternates(
      `/pets/${pet.slug}`,
      hasLocale(locale) ? locale : undefined,
    ),
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
      // Pin to the locale-stripped path. The auto-detected URL from
      // opengraph-image.tsx includes the [locale] segment, which
      // next-intl 307-redirects under localePrefix="as-needed". Most
      // OG scrapers don't follow redirects and fall back to the
      // generic site image.
      images: [
        {
          url: `${SITE_URL}/pets/${pet.slug}/opengraph-image`,
          width: 1200,
          height: 630,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${SITE_URL}/pets/${pet.slug}/opengraph-image`],
    },
  };
}

export default async function PetPage({ params }: PageProps) {
  const { slug, locale } = await params;
  const localeValue = hasLocale(locale) ? locale : defaultLocale;
  setRequestLocale(localeValue);
  const pet = await getPet(slug);
  const tPet = await getTranslations({ locale: localeValue, namespace: "pet" });

  if (!pet) {
    notFound();
  }

  const dexMap = await getDexEntryMap();
  const currentDexNumber = dexMap.get(slug)?.dexNumber ?? null;

  let prevSlug: string | null = null;
  let nextSlug: string | null = null;
  if (currentDexNumber != null) {
    for (const [entrySlug, entry] of dexMap.entries()) {
      if (entry.dexNumber === currentDexNumber - 1) prevSlug = entrySlug;
      if (entry.dexNumber === currentDexNumber + 1) nextSlug = entrySlug;
    }
  }

  const prevEntry = prevSlug ? dexMap.get(prevSlug) : undefined;
  const nextEntry = nextSlug ? dexMap.get(nextSlug) : undefined;
  const prevPet =
    prevSlug && prevEntry
      ? {
          slug: prevSlug,
          displayName: prevEntry.displayName,
          dexNumber: prevEntry.dexNumber,
        }
      : null;
  const nextPet =
    nextSlug && nextEntry
      ? {
          slug: nextSlug,
          displayName: nextEntry.displayName,
          dexNumber: nextEntry.dexNumber,
        }
      : null;

  const [
    ownerCreditResult,
    variants,
    memberOfCollections,
    stickerAvailability,
  ] = await Promise.all([
    resolveStoredOwnerCreditForSlug(slug),
    getVariantsFor(slug),
    getCollectionsContainingPet(slug),
    getPetStickerAvailability(slug),
  ]);
  const ownerCredit = ownerCreditResult?.credit ?? null;

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

      <SiteHeader />
      {/* Hero — single full-width section on the petdex-hero surface.
          Two-column lockup on lg+: animated sprite (the product) on the
          left, identity + CTAs on the right. Mobile collapses to a
          natural vertical stack: dex nav, sprite, info+CTAs. */}
      <section className="petdex-hero relative -mt-14 overflow-visible pt-14">
        <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-4 px-5 pt-5 pb-8 md:gap-6 md:px-8 md:pt-8 md:pb-14">
          {/* Dex nav strip — Pokédex chrome at the top. */}
          <nav
            aria-label={tPet("navigation.ariaLabel")}
            className="flex flex-wrap items-center justify-between gap-3"
          >
            <DexNavPill pet={prevPet} direction="prev" />
            <Link
              href={shuffleHref}
              prefetch={false}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border-base bg-surface/70 px-3.5 text-[13px] font-medium text-muted-2 backdrop-blur transition hover:bg-surface-muted hover:text-foreground"
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

          {/* Two-column hero. lg breakpoint splits sprite and info
              side-by-side; on mobile the floater stage shrinks to a
              short banner above the info so the title isn't pushed
              off-screen. The full state viewer (sprite + state tabs)
              renders below the hero. */}
          <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start lg:gap-10">
            {/* Left column: pet sprite stage.
                - Mobile: a static centered PetSprite (PetFloater
                  disables itself below 768px because the drag/portal
                  logic doesn't make sense on a phone).
                - md+: interactive PetFloater that wanders, idle-cycles
                  states, and reacts to drag inside this card.
                .petdex-floater-stage scopes the floater's bounds.
                Sticky on lg+ so it stays visible while the right
                column scrolls. */}
            <div className="lg:sticky lg:top-24">
              <div className="petdex-floater-stage pet-sprite-stage relative h-56 w-full overflow-hidden rounded-2xl border border-border-base bg-surface/40 backdrop-blur sm:h-72 lg:aspect-square lg:h-auto">
                {/* Static fallback for mobile + first paint. Anchored
                    upper-left so the pet reads like a peeking
                    character, not a centered specimen photo. Hidden
                    on md+ where the floater takes over. */}
                <span className="absolute top-2 left-3 md:hidden">
                  <PetSprite
                    src={pet.spritesheetPath}
                    state="idle"
                    scale={0.95}
                    label={`${pet.displayName} idle`}
                  />
                </span>
                {/* Interactive floater on md+ only. PetFloater
                    self-positions inside the stage. */}
                <span className="hidden md:block">
                  <PetFloater
                    src={pet.spritesheetPath}
                    petName={pet.displayName}
                    size={180}
                    initialFraction={{ x: 0.5, y: 0.5 }}
                  />
                </span>
              </div>
            </div>

            {/* Right column: identity + CTAs + meta. Order is intentional:
                eyebrow → name → description → primary CTA (Open in
                Petdex) → tertiary CTA (Open in Codex) → secondary CTA
                (install command) → quick actions (like/sound/menu +
                stats) → tags → collections. */}
            <header className="flex flex-col gap-5">
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
                <h1 className="text-balance text-[34px] leading-[0.95] font-semibold tracking-tight text-foreground sm:text-[40px] md:text-[56px]">
                  {pet.displayName}
                </h1>
                <OwnerPetControls
                  slug={pet.slug}
                  currentDisplayName={pet.displayName}
                  currentDescription={pet.description}
                />
              </div>

              <p className="text-balance text-base leading-7 text-muted-1 md:text-lg">
                {pet.description}
              </p>

              <OpenInPetdexButton slug={pet.slug} />

              <OpenInCodexButton
                displayName={pet.displayName}
                description={pet.description}
                spritesheetUrl={pet.spritesheetPath}
              />

              {/* Secondary CTA: single-line npx command + link to the
                  full install guide. The verbose tabs/instructions
                  live under the state viewer so they don't crowd the
                  hero — anyone who needs them is already scrolling. */}
              <InstallCommandCompact
                slug={pet.slug}
                displayName={pet.displayName}
              />

              {/* Quick actions row: like / sound / share / sticker share
                  one pill rung. Passive meta (counters) and the rare
                  action (report) live on a quieter second line so the
                  row reads as four choices, not seven. */}
              <div className="flex flex-col gap-2.5 pt-1">
                <div className="flex flex-wrap items-center gap-2.5">
                  <LikeButton slug={pet.slug} />
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
                  {stickerAvailability.available &&
                  stickerAvailability.collectionSlug ? (
                    <SaveAsSticker
                      slug={pet.slug}
                      displayName={pet.displayName}
                      collectionSlug={stickerAvailability.collectionSlug}
                    />
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <PetCountersBar slug={pet.slug} />
                  <PetTakedownReportButton
                    pet={{ slug: pet.slug, displayName: pet.displayName }}
                  />
                </div>
              </div>

              {/* Tags + collections collapsed into compact metadata. */}
              {pet.tags.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {pet.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border border-border-base bg-surface/70 px-2.5 py-1 text-[12px] font-medium text-muted-2 backdrop-blur"
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
                      prefetch={false}
                      className="rounded-full border border-border-base bg-surface/70 px-2.5 py-1 text-[12px] font-medium text-muted-2 backdrop-blur transition hover:bg-brand/15 hover:text-brand"
                    >
                      {col.title}
                    </Link>
                  ))}
                </div>
              ) : null}
            </header>
          </div>

          {/* Keyboard hint strip — full-width footer of the hero, only
              on pointer-fine media. */}
          <p className="mt-2 hidden flex-wrap items-center gap-3 font-mono text-[11px] tracking-[0.18em] text-muted-3 uppercase md:flex">
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
        </div>
      </section>

      <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-10 md:gap-8 md:px-8 md:py-12">
        {/* Lets users on Windows / macOS who disabled animations in OS
            settings know the static sprite is intentional, not a bug.
            Reported via feedback on /zh/pets/nyami where the user
            could not see the animation in Edge + Chrome. */}
        <ReducedMotionHint />

        {/* Full state viewer — sprite + state tabs lockup. Lives below
            the hero so its internal 2-column layout has the full content
            width to breathe. The hero idle preview keeps users grounded
            while they scroll into the state grid. */}
        <PetStateViewerLazy
          src={pet.spritesheetPath}
          petName={pet.displayName}
        />

        {/* Full install guide. CLI + Curl tabs, platform-specific
            terminal instructions, "Activate in Codex" steps. Lives
            under the state viewer so it doesn't crowd the hero where
            the primary CTA (Open in Petdex Desktop) plus a compact
            one-line npx command already cover the common path. */}
        <div id="install" className="scroll-mt-24">
          <InstallCommandLazy slug={pet.slug} displayName={pet.displayName} />
        </div>

        {/* Credit + stats stack on the left, variants on the right so
            the short cards share a column instead of each floating in
            its own full-width band. Single column when no variants. */}
        <div
          className={
            variants.length > 0
              ? "grid items-start gap-6 md:grid-cols-2"
              : "grid gap-6"
          }
        >
          <div className="flex flex-col gap-6">
            {ownerCredit ? (
              <div className="flex flex-col gap-3">
                <SubmittedBy credit={ownerCredit} />
                {ownerCreditResult?.ownerIsProxy ? (
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
            ) : (
              <InfoCard
                title="Submission"
                icon={<Sparkles className="size-4" />}
              >
                <p>Curated entry.</p>
                <p>Updated {new Date(pet.importedAt).toLocaleDateString()}</p>
              </InfoCard>
            )}

            <InfoCard
              title={tPet("stats.title")}
              icon={<Sparkles className="size-4" />}
            >
              <div className="flex items-center justify-center">
                <PetRadarClient
                  slug={pet.slug}
                  importedAt={pet.importedAt}
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
          </div>

          {variants.length > 0 ? (
            <section className="rounded-2xl border border-border-base bg-surface/60 p-4 backdrop-blur">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Sparkles className="size-4" />
                {tPet("variants.title")}
              </div>
              <p className="mt-1.5 text-[13px] text-muted-2">
                {tPet("variants.description")}
              </p>
              <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
                {variants.map((variant) => (
                  <Link
                    key={variant.slug}
                    href={`/pets/${variant.slug}`}
                    prefetch={false}
                    className="group flex items-center gap-3 rounded-2xl border border-border-base bg-background/70 p-3 transition hover:-translate-y-0.5 hover:border-brand/35 hover:bg-background"
                  >
                    <div className="shrink-0 rounded-2xl border border-border-base bg-surface p-2">
                      <StaticPetSprite
                        src={variant.spritesheetUrl}
                        scale={0.45}
                        label={variant.displayName}
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
      prefetch={false}
      className={`inline-flex h-9 items-center gap-2 rounded-full border border-border-base bg-surface/70 px-3.5 text-[13px] font-medium text-muted-2 backdrop-blur transition hover:bg-surface-muted hover:text-foreground ${direction === "next" ? "ml-auto" : ""}`}
    >
      {direction === "prev" ? <span aria-hidden="true">←</span> : null}
      <span className="font-mono text-[11px] tracking-[0.16em] text-muted-3">
        #{formatDexNumber(pet.dexNumber)}
      </span>
      <span>{pet.displayName}</span>
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
    <div className="rounded-2xl border border-border-base bg-surface/60 p-4 backdrop-blur">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        {icon}
        {title}
      </div>
      <div className="mt-3 space-y-2 break-words text-sm leading-6 text-muted-2">
        {children}
      </div>
    </div>
  );
}
