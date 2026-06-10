import Link from "next/link";
import { notFound } from "next/navigation";

import { ExternalLink, Heart, TerminalSquare } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { getCollection } from "@/lib/collections";
import { getDexNumberMap } from "@/lib/dex";
import { formatLocalizedNumber } from "@/lib/format-number";
import { buildLocaleAlternates } from "@/lib/locale-routing";
import { getStoredPublicProfileForUser } from "@/lib/owner-credit";

import { CollectionCaughtProgress } from "@/components/collection-caught-progress";
import { CollectionPetGrid } from "@/components/collection-pet-grid";
import { JsonLd } from "@/components/json-ld";
import { PetSprite } from "@/components/pet-sprite";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import { defaultLocale, hasLocale } from "@/i18n/config";

export const dynamic = "force-static";
export const revalidate = 86400;

const SITE_URL = "https://petdex.dev";

type PageProps = { params: Promise<{ slug: string; locale: string }> };

export async function generateMetadata({ params }: PageProps) {
  const { slug, locale } = await params;
  const collection = await getCollection(slug);
  if (!collection) {
    return { title: "Collection not found", robots: { index: false } };
  }

  // Pin the OG image URL to the locale-stripped path. The auto-detected
  // image route from app/[locale]/collections/[slug]/opengraph-image.tsx
  // would generate /en/collections/.../opengraph-image, which next-intl
  // rewrites with a 307 redirect under localePrefix="as-needed". Most
  // social scrapers (Discord, X) don't follow redirects on og:image
  // and silently fall back to the parent layout's image — so unfurls
  // showed the generic Petdex hero instead of the per-collection art.
  const ogImage = `${SITE_URL}/collections/${collection.slug}/opengraph-image`;
  return {
    title: `${collection.title} collection`,
    description: collection.description,
    alternates: buildLocaleAlternates(
      `/collections/${collection.slug}`,
      hasLocale(locale) ? locale : undefined,
    ),
    openGraph: {
      title: `${collection.title} on Petdex`,
      description: collection.description,
      url: `${SITE_URL}/collections/${collection.slug}`,
      images: [{ url: ogImage, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title: `${collection.title} on Petdex`,
      description: collection.description,
      images: [ogImage],
    },
  };
}

export default async function CollectionPage({ params }: PageProps) {
  const { slug, locale } = await params;
  const localeValue = hasLocale(locale) ? locale : defaultLocale;
  setRequestLocale(localeValue);
  const collection = await getCollection(slug);
  if (!collection) notFound();
  const t = await getTranslations({
    locale: localeValue,
    namespace: "collectionDetail",
  });

  const [dexEntries, ownerProfile] = await Promise.all([
    getDexNumberMap(),
    collection.ownerId
      ? getStoredPublicProfileForUser(collection.ownerId)
      : Promise.resolve(null),
  ]);
  const ownerHref = ownerProfile?.handle ? `/u/${ownerProfile.handle}` : null;
  const petSlugs = collection.pets.map((pet) => pet.slug);
  const leadPet =
    collection.pets.find((pet) => pet.slug === collection.coverPetSlug) ??
    collection.pets[0] ??
    null;
  const totalLikes = collection.pets.reduce(
    (acc, pet) => acc + pet.metrics.likeCount,
    0,
  );
  const totalInstalls = collection.pets.reduce(
    (acc, pet) => acc + pet.metrics.installCount,
    0,
  );
  const dexMap = Object.fromEntries(dexEntries.entries());
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: collection.title,
    description: collection.description,
    url: `${SITE_URL}/collections/${collection.slug}`,
    mainEntity: {
      "@type": "ItemList",
      itemListElement: collection.pets.map((pet, index) => ({
        "@type": "ListItem",
        position: index + 1,
        url: `${SITE_URL}/pets/${pet.slug}`,
        name: pet.displayName,
      })),
    },
  };

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <JsonLd data={jsonLd} />
      <SiteHeader />
      <section className="petdex-cloud relative -mt-[84px] overflow-clip pt-[84px]">
        <div className="relative mx-auto flex w-full max-w-[1440px] flex-col px-5 pb-12 md:px-8">
          <div className="mt-6">
            <Link
              href="/collections"
              className="inline-flex h-8 items-center rounded-full border border-border-base bg-surface/70 px-3 text-xs font-medium text-muted-2 transition hover:border-border-strong hover:text-foreground"
            >
              {t("backToCollections")}
            </Link>
          </div>
          <div className="mt-6 grid gap-8 md:mt-10 lg:grid-cols-[1fr_420px] lg:items-center">
            <div>
              <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
                Featured collection
              </p>
              <h1 className="mt-3 text-balance text-[44px] leading-[0.98] font-semibold tracking-tight md:text-[72px]">
                {collection.title}
              </h1>
              <p className="mt-5 max-w-2xl text-balance text-base leading-7 text-muted-1 md:text-lg">
                {collection.description}
              </p>

              <div className="mt-6 flex flex-wrap items-center gap-3">
                {ownerHref ? (
                  <Link
                    href={ownerHref}
                    prefetch={false}
                    className="inline-flex h-10 items-center rounded-full bg-inverse px-4 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
                  >
                    View creator
                  </Link>
                ) : null}
                {collection.externalUrl ? (
                  <Link
                    href={collection.externalUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-10 items-center gap-1.5 rounded-full border border-border-base bg-surface/70 px-4 text-sm font-medium text-muted-2 transition hover:border-border-strong"
                  >
                    <ExternalLink className="size-4" />
                    Visit IP site
                  </Link>
                ) : null}
              </div>

              <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[11px] tracking-[0.18em] text-muted-3 uppercase">
                <span>{collection.pets.length} pets</span>
                <CollectionCaughtProgress petSlugs={petSlugs} />
                {totalLikes > 0 ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Heart className="size-3" />
                    {formatLocalizedNumber(totalLikes, locale)}
                  </span>
                ) : null}
                {totalInstalls > 0 ? (
                  <span className="inline-flex items-center gap-1.5">
                    <TerminalSquare className="size-3" />
                    {formatLocalizedNumber(totalInstalls, locale)} installs
                  </span>
                ) : null}
              </div>
            </div>

            <div className="pet-sprite-stage relative grid aspect-square place-items-center overflow-hidden rounded-3xl border border-border-base bg-surface/70">
              {leadPet ? (
                <PetSprite
                  src={leadPet.spritesheetPath}
                  cycleStates
                  scale={1}
                  label={`${leadPet.displayName} animated`}
                />
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-5 py-12 md:px-8 md:py-16">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[11px] tracking-[0.22em] text-brand uppercase">
              Set contents
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight">
              Catch the full collection
            </h2>
          </div>
          <Link
            href="/collections"
            className="inline-flex h-10 items-center rounded-full border border-border-base bg-surface px-4 text-sm font-medium text-muted-2 transition hover:border-border-strong"
          >
            All collections
          </Link>
        </div>

        <CollectionPetGrid pets={collection.pets} dexMap={dexMap} />
      </section>

      <SiteFooter />
    </main>
  );
}
