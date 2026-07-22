import Link from "next/link";

import { Download } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";

import {
  getCollectionsBySlugs,
  type PetCollectionWithPets,
} from "@/lib/collections";
import { formatLocalizedNumber } from "@/lib/format-number";
import { buildLocaleAlternates } from "@/lib/locale-routing";
import { searchPets } from "@/lib/pet-search";
import { getFeaturedPetsWithMetrics, type PetWithMetrics } from "@/lib/pets";
import { getRandomPet } from "@/lib/random-pet-pool";
import { toSurprisePet } from "@/lib/surprise-pets";
import { cn } from "@/lib/utils";

import { CollectionActionMenu } from "@/components/collections/collection-action-menu";
import { CollectionCover } from "@/components/collections/collection-cover";
import { DownloadDesktopCTA } from "@/components/download/download-desktop-cta";
import { JsonLd } from "@/components/layout/json-ld";
import { PetSprite } from "@/components/pets/pet-sprite";
import { SurprisePetCard } from "@/components/pets/surprise-pet-card";
import { SiteFooter } from "@/components/site-footer";
import {
  Card,
  CardContent,
  CardDescription,
  CardTitle,
} from "@/components/ui/card";

import { hasLocale, locales } from "@/i18n/config";

// ISR. The home page renders an install-count ordered, anon shell.
// visitor's shuffle seed and caught-slug set are pulled client-side
// after interaction; /api/me/header-state feeds the "caught" highlight.
// With a 24h ceiling and tag-based
// invalidation on submit/feature/withdraw, the page stays fresh for
// editorial changes without burning a function on every visit.
export const dynamic = "force-static";
export const revalidate = 86400;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return {
    alternates: buildLocaleAlternates(
      "/",
      hasLocale(locale) ? locale : undefined,
    ),
  };
}
const SITE_URL = "https://petdex.dev";
const HOME_INITIAL_GALLERY_LIMIT = 10;

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export default async function Home({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const isZh = locale === "zh";
  const t = await getTranslations("home");

  // Hand-pick the 3 collections that show on the landing strip in a
  // specific narrative order: Pokemon (instant recognition) →
  // League of Legends (largest deck, gamer pull) →
  // JoJo's Bizarre Adventure (anime culture). Anything else lives
  // behind the View all button.
  const LANDING_COLLECTION_ORDER = [
    "franchise-pokemon",
    "franchise-league-of-legends",
    "franchise-jojos-bizarre-adventure",
  ];

  const [heroPets, initialSearch, collections, randomPet] = await Promise.all([
    getFeaturedPetsWithMetrics(5),
    searchPets({ sort: "installed", limit: HOME_INITIAL_GALLERY_LIMIT }),
    getCollectionsBySlugs(LANDING_COLLECTION_ORDER, 6),
    getRandomPet(),
  ]);
  const totalPets = initialSearch.total;
  const formattedTotalPets = formatLocalizedNumber(totalPets, locale);
  const surprisePet = randomPet ? toSurprisePet(randomPet) : null;

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      name: "Petdex",
      url: `${SITE_URL}/`,
      description: t("jsonLdDescription"),
      publisher: {
        "@type": "Organization",
        name: "Crafter Station",
        url: "https://crafter.run",
      },
      potentialAction: {
        "@type": "SearchAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: `${SITE_URL}/?q={search_term_string}#gallery`,
        },
        "query-input": "required name=search_term_string",
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: t("jsonLdFeaturedPets"),
      numberOfItems: heroPets.length,
      itemListElement: heroPets.map((pet, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: `${SITE_URL}/pets/${pet.slug}`,
        name: pet.displayName,
      })),
    },
  ];

  return (
    <main className="bg-background text-foreground">
      <JsonLd data={jsonLd} />
      <SurprisePetCard initialPet={surprisePet} />
      <section className="petdex-cloud relative overflow-clip">
        <div className="relative mx-auto flex w-full max-w-[1440px] flex-col px-5 pb-40 md:px-8">
          <div className="mt-12 flex flex-col items-center text-center md:mt-16">
            <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
              {t("eyebrow")}
            </p>
            <h1 className="mt-3 text-[48px] leading-[0.98] font-semibold tracking-tight md:text-[80px]">
              {t("title")}
            </h1>
            {locale === "zh" && (
              <p className="text-xs text-amber-300/70 mt-1 tracking-wider">
                宠物图鉴 · {formattedTotalPets}+ 个开源伙伴
              </p>
            )}
            <p className="mt-5 max-w-xl text-balance text-base leading-7 text-muted-1 md:text-lg">
              A public gallery of animated pets for Codex.
              <br />
              <span className="text-muted-3">
                9 states each. Drop in, animate, ship.
              </span>
            </p>
          </div>

          <HeroPetParade pets={heroPets} isZh={isZh} />

          <div className="mt-8 flex w-full flex-col items-stretch justify-center gap-2 sm:flex-row sm:items-center">
            <DownloadDesktopCTA
              href={`/${locale}/download`}
              source="hero_primary"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-inverse px-5 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
            >
              <Download className="size-4" />
              Download all pets
            </DownloadDesktopCTA>
            <Link
              href="#gallery"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-border-base bg-surface/70 px-6 text-sm font-medium text-foreground backdrop-blur transition hover:bg-surface"
            >
              Browse gallery
            </Link>
          </div>
        </div>
      </section>

      <FeaturedCollections collections={collections} isZh={isZh} />

      <SiteFooter />
    </main>
  );
}

async function FeaturedCollections({
  collections,
  isZh,
}: {
  collections: PetCollectionWithPets[];
  isZh: boolean;
}) {
  if (collections.length === 0) return null;
  const t = await getTranslations("home.featuredCollections");

  return (
    <section className="mx-auto flex w-full max-w-[1440px] flex-col gap-5 px-5 pt-12 md:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[11px] tracking-[0.22em] text-brand uppercase">
            {t("eyebrow")}
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            {t("title")}
          </h2>
        </div>
        <Link
          href="/collections"
          className="inline-flex h-10 items-center rounded-full border border-border-base bg-surface px-4 text-sm font-medium text-muted-2 transition hover:border-border-strong"
        >
          {t("viewAll")}
        </Link>
      </div>
      <div
        className={cn(
          "grid auto-rows-fr gap-4 md:grid-cols-3",
          isZh && "sm:gap-2.5",
        )}
      >
        {collections.map((collection) => {
          return (
            <Card
              key={collection.slug}
              className="group relative flex h-full flex-col gap-0 overflow-hidden rounded-3xl border border-border-base bg-surface/80 py-0 ring-0 transition hover:border-border-strong hover:shadow-xl hover:shadow-blue-950/10 has-[[aria-expanded=true]]:z-30"
            >
              <Link
                href={`/collections/${collection.slug}`}
                prefetch={false}
                className="block"
              >
                <CollectionCover
                  pets={collection.pets}
                  coverSlug={collection.coverPetSlug}
                  max={5}
                  scale={0.5}
                />
                <CardContent className="flex flex-1 flex-col p-5">
                  <div className="flex items-center justify-between gap-3">
                    <CardTitle className="truncate text-lg font-semibold tracking-tight text-foreground">
                      {collection.title}
                    </CardTitle>
                    <span className="shrink-0 font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
                      {t("petsCount", { count: collection.pets.length })}
                    </span>
                  </div>
                  <CardDescription className="mt-2 line-clamp-2 text-sm leading-6 text-muted-2">
                    {collection.description}
                  </CardDescription>
                </CardContent>
              </Link>
              <div className="absolute top-3 right-3 z-20">
                <CollectionActionMenu
                  collection={{
                    slug: collection.slug,
                    title: collection.title,
                    petCount: collection.pets.length,
                    pets: collection.pets.map((p) => ({ slug: p.slug })),
                  }}
                />
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

type HeroPetParadeProps = {
  pets: PetWithMetrics[];
  isZh: boolean;
};

async function HeroPetParade({ pets, isZh }: HeroPetParadeProps) {
  if (pets.length === 0) return null;

  const t = await getTranslations("home");

  return (
    <section
      className={cn(
        "mt-10 flex flex-wrap items-end justify-center gap-3",
        isZh ? "sm:gap-2 md:gap-2" : "md:gap-5",
      )}
      aria-label={t("petParadeAria")}
    >
      {pets.map((pet, index) => {
        const tilt = index % 2 === 0 ? "rotate-[-3deg]" : "rotate-[3deg]";
        const lift = index % 3 === 1 ? "translate-y-1" : "-translate-y-1";

        return (
          <Link
            key={pet.slug}
            href={`/pets/${pet.slug}`}
            prefetch={false}
            aria-label={t("openPet", { name: pet.displayName })}
            className={`group relative flex flex-col items-center rounded-2xl bg-surface/60 transition hover:-translate-y-1 ${tilt} ${lift}`}
          >
            <PetSprite
              src={pet.spritesheetPath}
              cycleStates
              cycleIntervalMs={1500}
              scale={0.55}
              label={t("petAnimated", { name: pet.displayName })}
            />
            <span className="mt-1 font-mono text-[10px] tracking-[0.18em] text-muted-2 uppercase">
              {pet.displayName}
            </span>
          </Link>
        );
      })}
    </section>
  );
}
