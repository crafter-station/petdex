import Link from "next/link";

import { getTranslations } from "next-intl/server";

import { getActiveFeedAds } from "@/lib/ads/queries";
import {
  getFeaturedCollections,
  type PetCollectionWithPets,
} from "@/lib/collections";
import { getDexNumberMap } from "@/lib/dex";
import { buildLocaleAlternates } from "@/lib/locale-routing";
import { searchPets } from "@/lib/pet-search";
import {
  getApprovedPetCount,
  getFeaturedPetsWithMetrics,
  type PetWithMetrics,
} from "@/lib/pets";

import { CollectionCover } from "@/components/collection-cover";
import { CommandLine } from "@/components/command-line";
import { DiscordLink } from "@/components/discord-link";
import { JsonLd } from "@/components/json-ld";
import { PetGallery } from "@/components/pet-gallery";
import { PetSprite } from "@/components/pet-sprite";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { SubmitCTA } from "@/components/submit-cta";
import { SurprisePetCard } from "@/components/surprise-pet-card";

// ISR. The home page used to be force-dynamic because it pulled the
// visitor's shuffle seed cookie and caught-slug set. Both moved to
// the client: PetGallery re-fetches /api/pets/search after hydration
// (which picks up the cookie) and /api/me/caught-slugs feeds the
// "caught" highlight. The server now renders an alpha-ordered, anon
// shell that the edge can cache for 60s — enough to keep new pets
// surfacing without waking a function on every visit.
export const revalidate = 60;
export const metadata = {
  alternates: buildLocaleAlternates("/"),
};
const SITE_URL = "https://petdex.crafter.run";

export default async function Home() {
  const t = await getTranslations("home");

  const [
    heroPets,
    totalPets,
    initialSearch,
    dexEntries,
    allFeaturedCollections,
    feedAds,
  ] = await Promise.all([
    getFeaturedPetsWithMetrics(6),
    getApprovedPetCount(),
    // No shuffleSeed → searchPets falls back to alpha order, which is
    // the same for every visitor and therefore safe to cache. The
    // client re-fetches with the visitor's seed on hydration.
    searchPets({ sort: "curated" }),
    getDexNumberMap(),
    getFeaturedCollections(20),
    getActiveFeedAds(6),
  ]);

  // Hand-pick the 3 collections that show on the landing strip in a
  // specific narrative order: GRAYCRAFT (creator IP) → Meme Lords (cultural
  // hook) → Anime Heroes (mainstream pull). Anything else lives behind
  // the View all button.
  const LANDING_COLLECTION_ORDER = ["graycraft", "meme-lords", "anime-heroes"];
  const collectionsBySlug = new Map(
    allFeaturedCollections.map((c) => [c.slug, c]),
  );
  const collections = LANDING_COLLECTION_ORDER.map((slug) =>
    collectionsBySlug.get(slug),
  ).filter((c): c is NonNullable<typeof c> => Boolean(c));

  // Plain-object so the server -> client serializer doesn't choke on a
  // Map. Same source of truth either way.
  const dexMap = Object.fromEntries(dexEntries.entries());

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
    <main className="min-h-dvh bg-background text-foreground">
      <JsonLd data={jsonLd} />
      <SurprisePetCard />
      <SiteHeader />
      <section className="petdex-cloud relative -mt-[84px] overflow-clip pt-[84px]">
        <div className="relative mx-auto flex w-full max-w-[1440px] flex-col px-5 pb-10 md:px-8">
          <div className="mt-12 flex flex-col items-center text-center md:mt-16">
            <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
              {t("eyebrow")}
            </p>
            <h1 className="mt-3 text-[48px] leading-[0.98] font-semibold tracking-tight md:text-[80px]">
              {t("title")}
            </h1>
            <p className="mt-5 max-w-xl text-balance text-base leading-7 text-muted-1 md:text-lg">
              {t.rich("tagline", {
                totalPets,
                brand: () => <strong>Codex</strong>,
              })}
            </p>
            <CommandLine
              command="npx petdex install boba"
              source="hero"
              className="mt-5 w-full max-w-sm"
            />
          </div>

          <HeroPetParade pets={heroPets} />

          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <SubmitCTA className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-inverse px-6 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover">
              {t("submitCta")}
            </SubmitCTA>
            {process.env.NEXT_PUBLIC_DISCORD_INVITE_URL ? (
              <DiscordLink
                href={process.env.NEXT_PUBLIC_DISCORD_INVITE_URL}
                source="hero_secondary"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-border-base bg-surface/70 px-6 text-sm font-medium text-foreground backdrop-blur transition hover:bg-surface"
              >
                {t("joinDiscord")}
              </DiscordLink>
            ) : (
              <Link
                href="#gallery"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-border-base bg-surface/70 px-6 text-sm font-medium text-foreground backdrop-blur transition hover:bg-surface"
              >
                {t("browseGallery")}
              </Link>
            )}
          </div>
        </div>
      </section>

      <FeaturedCollections collections={collections} />

      <section
        id="gallery"
        className="mx-auto flex w-full max-w-[1440px] flex-col gap-8 px-5 py-12 md:px-8 md:py-16"
      >
        {totalPets > 0 ? (
          <PetGallery
            initial={initialSearch}
            totalPets={totalPets}
            dexMap={dexMap}
            ads={feedAds}
          />
        ) : null}
      </section>

      <SiteFooter />
    </main>
  );
}

function FeaturedCollections({
  collections,
}: {
  collections: PetCollectionWithPets[];
}) {
  if (collections.length === 0) return null;

  return (
    <section className="mx-auto flex w-full max-w-[1440px] flex-col gap-5 px-5 pt-12 md:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[11px] tracking-[0.22em] text-brand uppercase">
            Featured collections
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            Original IP sets worth collecting
          </h2>
        </div>
        <Link
          href="/collections"
          className="inline-flex h-10 items-center rounded-full border border-border-base bg-surface px-4 text-sm font-medium text-muted-2 transition hover:border-border-strong"
        >
          View all
        </Link>
      </div>
      <div className="grid auto-rows-fr gap-4 md:grid-cols-3">
        {collections.map((collection) => {
          return (
            <Link
              key={collection.slug}
              href={`/collections/${collection.slug}`}
              className="group flex h-full flex-col overflow-hidden rounded-3xl border border-border-base bg-surface/80 transition hover:border-border-strong hover:shadow-xl hover:shadow-blue-950/10"
            >
              <CollectionCover
                pets={collection.pets}
                coverSlug={collection.coverPetSlug}
                max={5}
                scale={0.5}
              />
              <div className="flex flex-1 flex-col p-5">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="truncate text-lg font-semibold tracking-tight text-foreground">
                    {collection.title}
                  </h3>
                  <span className="shrink-0 font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
                    {collection.pets.length} pets
                  </span>
                </div>
                <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-2">
                  {collection.description}
                </p>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

type HeroPetParadeProps = {
  pets: PetWithMetrics[];
};

async function HeroPetParade({ pets }: HeroPetParadeProps) {
  if (pets.length === 0) return null;

  const t = await getTranslations("home");

  return (
    <section
      className="mt-10 flex flex-wrap items-end justify-center gap-3 md:gap-5"
      aria-label={t("petParadeAria")}
    >
      {pets.map((pet, index) => {
        const tilt = index % 2 === 0 ? "rotate-[-3deg]" : "rotate-[3deg]";
        const lift = index % 3 === 1 ? "translate-y-1" : "-translate-y-1";

        return (
          <Link
            key={pet.slug}
            href={`/pets/${pet.slug}`}
            aria-label={t("openPet", { name: pet.displayName })}
            className={`group relative flex flex-col items-center rounded-2xl border border-border-base bg-surface/60 px-3 pt-3 pb-2 shadow-lg shadow-blue-900/10 backdrop-blur-md transition hover:-translate-y-1 hover:bg-surface ${tilt} ${lift}`}
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
