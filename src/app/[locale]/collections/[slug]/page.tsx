import Link from "next/link";
import { notFound } from "next/navigation";

import { auth } from "@clerk/nextjs/server";
import { ExternalLink, Heart, TerminalSquare } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { getCaughtSlugSet } from "@/lib/catch-status";
import { getCollection } from "@/lib/collections";
import { getDexNumberMap } from "@/lib/dex";
import { buildLocaleAlternates } from "@/lib/locale-routing";
import { resolveOwnerCredits } from "@/lib/owner-credit";

import { JsonLd } from "@/components/json-ld";
import { PetCard } from "@/components/pet-gallery";
import { PetSprite } from "@/components/pet-sprite";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const dynamic = "force-dynamic";

const SITE_URL = "https://petdex.crafter.run";

type PageProps = { params: Promise<{ slug: string; locale: string }> };

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  const collection = await getCollection(slug);
  if (!collection) {
    return { title: "Collection not found", robots: { index: false } };
  }

  return {
    title: `${collection.title} collection`,
    description: collection.description,
    alternates: buildLocaleAlternates(`/collections/${collection.slug}`),
    openGraph: {
      title: `${collection.title} on Petdex`,
      description: collection.description,
      url: `${SITE_URL}/collections/${collection.slug}`,
    },
  };
}

export default async function CollectionPage({ params }: PageProps) {
  const { slug } = await params;
  const collection = await getCollection(slug);
  if (!collection) notFound();
  const t = await getTranslations("collectionDetail");

  const { userId } = await auth();
  const [caughtSlugs, dexEntries, credits] = await Promise.all([
    getCaughtSlugSet(userId),
    getDexNumberMap(),
    collection.ownerId
      ? resolveOwnerCredits([
          {
            ownerId: collection.ownerId,
            creditName: null,
            creditUrl: null,
            creditImage: null,
          },
        ])
      : Promise.resolve(new Map()),
  ]);
  const owner = collection.ownerId ? credits.get(collection.ownerId) : null;
  const leadPet =
    collection.pets.find((pet) => pet.slug === collection.coverPetSlug) ??
    collection.pets[0] ??
    null;
  const caughtCount = collection.pets.filter((pet) =>
    caughtSlugs.has(pet.slug),
  ).length;
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
      <section className="petdex-cloud relative overflow-hidden">
        <div className="relative mx-auto flex w-full max-w-7xl flex-col px-5 pt-5 pb-12 md:px-8">
          <SiteHeader />
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
                {owner ? (
                  <Link
                    href={`/u/${owner.handle}`}
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
                {userId ? (
                  <span>
                    caught {caughtCount}/{collection.pets.length}
                  </span>
                ) : null}
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

        {collection.pets.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-border-base bg-surface/60 p-10 text-center text-sm text-muted-2">
            This collection has no approved pets yet.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 md:gap-5">
            {collection.pets.map((pet, index) => (
              <PetCard
                key={pet.slug}
                pet={pet}
                index={index}
                dexNumber={dexMap[pet.slug] ?? null}
                caught={caughtSlugs.has(pet.slug)}
              />
            ))}
          </div>
        )}
      </section>

      <SiteFooter />
    </main>
  );
}
