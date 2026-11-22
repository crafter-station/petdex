import Link from "next/link";
import { notFound } from "next/navigation";

import { ArrowUpRight, Shuffle } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { BRAND_JSON_LD, BRAND_SITE_URL } from "@/lib/brand-kit";
import { getCollectionsContainingPet } from "@/lib/collections";
import { formatDexNumber, getDexEntryMap } from "@/lib/dex";
import { buildLocaleAlternates } from "@/lib/locale-routing";
import { resolveStoredOwnerCreditForSlug } from "@/lib/owner-credit";
import { getPet, getStaticPetSlugs } from "@/lib/pets";
import { getPetStickerAvailability } from "@/lib/sticker-export";
import { cn } from "@/lib/utils";
import { getVariantsFor } from "@/lib/variants";

import { ClaimCTA } from "@/components/auth/claim-cta";
import { InstallCommandCompact } from "@/components/download/install-command-compact";
import { OpenInCodexButton } from "@/components/download/open-in-codex-button";
import { OpenInPetdexButton } from "@/components/download/open-in-petdex-button";
import { JsonLd } from "@/components/layout/json-ld";
import { ReducedMotionHint } from "@/components/onboarding/reduced-motion-hint";
import { LikeButton } from "@/components/pets/like-button";
import { PetActionMenu } from "@/components/pets/pet-action-menu";
import { PetCountersBar } from "@/components/pets/pet-counters-bar";
import { PetKeyboardNav } from "@/components/pets/pet-keyboard-nav";
import { PetSoundButton } from "@/components/pets/pet-sound-button";
import { PetTakedownReportButton } from "@/components/pets/pet-takedown-report-button";
import { PetVitrineStage } from "@/components/pets/pet-vitrine-stage";
import { SaveAsSticker } from "@/components/pets/save-as-sticker";
import { StaticPetSprite } from "@/components/pets/static-pet-sprite";
import { OwnerPetControls } from "@/components/profile/owner-pet-controls";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { buttonVariants } from "@/components/ui/button";

import { defaultLocale, hasLocale } from "@/i18n/config";

const SITE_URL = BRAND_SITE_URL;

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
  const kindUrl = `${SITE_URL}/kind/${pet.kind}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      ...BRAND_JSON_LD["@graph"],
      {
        "@type": ["CreativeWork", "ImageObject"],
        "@id": `${url}#pet`,
        name: pet.displayName,
        description: pet.description,
        url,
        image: pet.spritesheetPath,
        contentUrl: pet.spritesheetPath,
        keywords: [...pet.tags, ...pet.vibes].join(", "),
        genre: pet.kind,
        datePublished: pet.importedAt,
        isPartOf: { "@id": `${SITE_URL}/#website` },
        publisher: { "@id": "https://crafter.run/#organization" },
        ...(ownerCredit
          ? {
              creator: {
                "@type": "Person",
                name: ownerCredit.name,
                ...(ownerCredit.externals[0]
                  ? { url: ownerCredit.externals[0].url }
                  : {}),
                ...(ownerCredit.imageUrl
                  ? { image: ownerCredit.imageUrl }
                  : {}),
              },
            }
          : {}),
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${url}#breadcrumb`,
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
            name: pet.kind,
            item: kindUrl,
          },
          {
            "@type": "ListItem",
            position: 3,
            name: pet.displayName,
            item: url,
          },
        ],
      },
    ],
  };

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

      <section className="petdex-hero relative -mt-14 overflow-visible pt-14">
        <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 pt-5 pb-12 md:gap-10 md:px-8 md:pt-8 md:pb-16">
          <nav
            aria-label={tPet("navigation.ariaLabel")}
            className="flex flex-wrap items-center justify-between gap-3"
          >
            <DexNavPill pet={prevPet} direction="prev" />
            <Link
              href={shuffleHref}
              prefetch={false}
              title={tPet("navigation.shuffleTitle")}
              className={buttonVariants({
                variant: "pearl",
                size: "lg",
                className: "text-[13px]",
              })}
            >
              <Shuffle />
              Shuffle
              <kbd className="ml-0.5 rounded-md border border-border-base bg-surface px-1.5 py-0.5 font-mono text-[10px] tracking-[0.05em] text-muted-3">
                Space
              </kbd>
            </Link>
            <DexNavPill pet={nextPet} direction="next" />
          </nav>

          <div className="grid items-start gap-6 lg:grid-cols-12">
            <div className="flex min-w-0 flex-col gap-3 lg:col-span-7">
              <PetVitrineStage
                src={pet.spritesheetPath}
                petName={pet.displayName}
                dexNumber={
                  currentDexNumber != null
                    ? formatDexNumber(currentDexNumber)
                    : null
                }
                kind={pet.kind}
                utilitySlot={
                  pet.soundUrl ? (
                    <PetSoundButton
                      soundUrl={pet.soundUrl}
                      displayName={pet.displayName}
                      labelPrefix="Play signature sound for"
                    />
                  ) : null
                }
              />
              {/* Lets users who disabled animations in OS settings know
                  the static sprite is intentional, not a bug. Reported
                  via feedback on /zh/pets/nyami. */}
              <ReducedMotionHint />
            </div>

            <aside className="flex min-w-0 flex-col gap-4 lg:col-span-5">
              <div className="toy-shell flex flex-col gap-5 rounded-3xl p-6">
                <header className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="toy-tag rounded-lg bg-toy-volt px-2.5 py-1 text-[#101944] shadow-[0_2px_0_#C9A91F]">
                      {pet.featured ? "Featured" : "Petdex entry"}
                    </p>
                    <Link
                      href={`/kind/${pet.kind}`}
                      prefetch={false}
                      className="toy-tag text-muted-3 transition hover:text-toy-cobalt dark:hover:text-[#8CA3FF]"
                    >
                      {pet.kind}
                    </Link>
                    <p className="toy-tag rounded-lg border border-toy-ink/15 px-2 py-0.5 text-muted-2">
                      v{pet.spriteVersionNumber}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <h1 className="min-w-0 font-heading text-3xl leading-[0.98] font-extrabold tracking-tight text-balance break-words text-foreground sm:text-4xl">
                      {pet.displayName}
                    </h1>
                    <OwnerPetControls
                      slug={pet.slug}
                      currentDisplayName={pet.displayName}
                      currentDescription={pet.description}
                    />
                  </div>

                  <p className="text-sm leading-relaxed text-pretty text-muted-1">
                    {pet.description}
                  </p>

                  <p className="text-xs text-muted-2">
                    {ownerCredit ? (
                      <>
                        Made by{" "}
                        <Link
                          href={`/u/${ownerCredit.handle}`}
                          prefetch={false}
                          className="font-semibold text-foreground underline decoration-toy-volt decoration-2 underline-offset-4 transition hover:decoration-toy-cobalt"
                        >
                          {ownerCredit.name}
                        </Link>
                        {ownerCredit.username ? (
                          <span className="ml-1.5 font-mono text-xs text-muted-3">
                            @{ownerCredit.username}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      "Curated by Petdex"
                    )}
                  </p>
                </header>

                <div className="flex flex-col gap-2.5">
                  <OpenInPetdexButton slug={pet.slug} />
                  <OpenInCodexButton
                    displayName={pet.displayName}
                    description={pet.description}
                    spritesheetUrl={pet.spritesheetPath}
                  />
                  <InstallCommandCompact
                    slug={pet.slug}
                    displayName={pet.displayName}
                  />
                </div>

                <div className="flex flex-col gap-3 border-t border-toy-ink/10 pt-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <LikeButton slug={pet.slug} />
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
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <PetCountersBar slug={pet.slug} />
                    <PetTakedownReportButton
                      pet={{ slug: pet.slug, displayName: pet.displayName }}
                    />
                  </div>
                </div>
              </div>

              {pet.vibes.length > 0 || pet.tags.length > 0 ? (
                <div className="toy-shell flex flex-col gap-3 rounded-3xl p-5">
                  <div className="flex flex-wrap gap-1.5">
                    {pet.vibes.map((vibe) => (
                      <Link
                        key={vibe}
                        href={`/vibe/${vibe}`}
                        prefetch={false}
                        className="rounded-xl bg-toy-volt/90 px-2.5 py-1 text-xs font-semibold text-[#101944] transition hover:brightness-95"
                      >
                        {vibe}
                      </Link>
                    ))}
                    {pet.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-xl border border-toy-ink/12 bg-background/60 px-2.5 py-1 text-xs font-medium text-muted-1"
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                  {ownerCredit && ownerCreditResult?.ownerIsProxy ? (
                    <div className="border-t border-toy-ink/10 pt-3">
                      <ClaimCTA
                        petName={pet.displayName}
                        authorLabel={ownerCredit.name}
                        githubUrl={
                          ownerCredit.externals.find(
                            (e) => e.provider === "github",
                          )?.url ?? null
                        }
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </aside>
          </div>
        </div>
      </section>

      {variants.length > 0 || memberOfCollections.length > 0 ? (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-12 px-5 pb-20 md:px-8 md:pb-24">
          {variants.length > 0 ? (
            <section className="space-y-5">
              <div className="space-y-1.5">
                <Eyebrow>Colorways</Eyebrow>
                <h2 className="font-heading text-2xl font-bold tracking-tight text-foreground">
                  {tPet("variants.title")}
                </h2>
              </div>
              <ul className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pt-1 pb-3">
                {variants.map((variant) => (
                  <li key={variant.slug} className="shrink-0 snap-start">
                    <Link
                      href={`/pets/${variant.slug}`}
                      prefetch={false}
                      className="toy-shell group flex w-36 flex-col items-center gap-2 rounded-2xl px-3 pt-4 pb-3 outline-none transition-[transform,border-color,box-shadow] hover:-translate-y-0.5 hover:border-toy-cobalt focus-visible:ring-2 focus-visible:ring-toy-cobalt/40"
                    >
                      <StaticPetSprite
                        src={variant.spritesheetUrl}
                        scale={0.5}
                        label={variant.displayName}
                      />
                      <span className="w-full truncate text-center text-[13px] font-semibold text-foreground">
                        {variant.displayName}
                      </span>
                      <span className="toy-tag text-muted-3">
                        No. {formatDexNumber(variant.dexNumber)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {memberOfCollections.length > 0 ? (
            <section className="toy-shell rounded-3xl p-6">
              <div className="mb-4 space-y-1">
                <Eyebrow>On display in</Eyebrow>
                <h2 className="font-heading text-2xl font-bold tracking-tight text-foreground">
                  Collections
                </h2>
              </div>
              <ul className="divide-y divide-toy-ink/10">
                {memberOfCollections.map((col, index) => (
                  <li key={col.slug}>
                    <Link
                      href={`/collections/${col.slug}`}
                      prefetch={false}
                      className="group flex items-center gap-4 py-3.5 text-foreground outline-none transition-colors hover:text-toy-cobalt focus-visible:text-toy-cobalt dark:hover:text-[#8CA3FF] dark:focus-visible:text-[#8CA3FF]"
                    >
                      <span className="font-hardware text-[10px] text-muted-3">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-heading text-lg font-semibold tracking-tight">
                        {col.title}
                      </span>
                      <ArrowUpRight className="size-4 opacity-40 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}

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
      className={buttonVariants({
        variant: "pearl",
        size: "lg",
        className: cn(
          "max-w-[46%] text-[13px]",
          direction === "next" && "ml-auto",
        ),
      })}
    >
      {direction === "prev" ? <span aria-hidden="true">←</span> : null}
      <span className="font-hardware text-[10px] tracking-[0.12em] text-muted-3">
        {formatDexNumber(pet.dexNumber)}
      </span>
      <span className="truncate">{pet.displayName}</span>
      {direction === "next" ? <span aria-hidden="true">→</span> : null}
    </Link>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-hardware text-[10px] tracking-[0.14em] text-toy-cobalt uppercase dark:text-[#8CA3FF]">
      {children}
    </p>
  );
}
