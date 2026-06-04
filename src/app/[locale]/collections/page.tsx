import { getTranslations } from "next-intl/server";

import { getCollectionsForListing } from "@/lib/collections";
import { buildLocaleAlternates } from "@/lib/locale-routing";
import { resolveOwnerCredits } from "@/lib/owner-credit";

import { CollectionsBrowser } from "@/components/collections-browser";
import { JsonLd } from "@/components/json-ld";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import { hasLocale } from "@/i18n/config";

// /collections is fully public — no auth, no cookies, no per-visitor
// data. 24h ceiling + revalidateTag('collection:list') from admin
// write paths keeps the page fresh on actual changes without burning
// a function on every visit.
export const revalidate = 86400;

const SITE_URL = "https://petdex.crafter.run";
const MIN_PETS = 4;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({
    locale: hasLocale(locale) ? locale : "en",
    namespace: "collectionsPage",
  });
  return {
    title: t("metadata.title"),
    description: t("metadata.description"),
    alternates: buildLocaleAlternates(
      "/collections",
      hasLocale(locale) ? locale : undefined,
    ),
  };
}

export default async function CollectionsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({
    locale: hasLocale(locale) ? locale : "en",
    namespace: "collectionsPage",
  });
  const collections = await getCollectionsForListing(MIN_PETS, 6);

  const ownerIds = collections
    .map((c) => c.ownerId)
    .filter((id): id is string => Boolean(id));
  const credits = await resolveOwnerCredits(
    ownerIds.map((ownerId) => ({
      ownerId,
      creditName: null,
      creditUrl: null,
      creditImage: null,
    })),
  );
  const creditsObj = Object.fromEntries(credits);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Petdex collections",
    url: `${SITE_URL}/collections`,
    mainEntity: {
      "@type": "ItemList",
      itemListElement: collections.map((c, index) => ({
        "@type": "ListItem",
        position: index + 1,
        url: `${SITE_URL}/collections/${c.slug}`,
        name: c.title,
      })),
    },
  };

  const browserItems = collections.map((c) => ({
    slug: c.slug,
    title: c.title,
    description: c.description,
    ownerId: c.ownerId,
    externalUrl: c.externalUrl,
    coverPetSlug: c.coverPetSlug,
    petCount: c.petCount,
    pets: c.pets.map((pet) => ({
      slug: pet.slug,
      displayName: pet.displayName,
      spritesheetPath: pet.spritesheetPath,
    })),
  }));

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <JsonLd data={jsonLd} />
      <SiteHeader />
      <section className="petdex-cloud relative -mt-[84px] overflow-clip pt-[84px]">
        <div className="relative mx-auto flex w-full max-w-[1440px] flex-col px-5 pb-10 md:px-8">
          <div className="mt-12 max-w-2xl md:mt-16">
            <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
              {t("hero.eyebrow")}
            </p>
            <h1 className="mt-3 text-balance text-[40px] leading-[1] font-semibold tracking-tight md:text-[64px]">
              {t("hero.title")}
            </h1>
            <p className="mt-5 text-balance text-base leading-7 text-muted-1 md:text-lg">
              {t("hero.description", { count: collections.length })}
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1440px] px-5 py-10 md:px-8 md:py-14">
        <CollectionsBrowser collections={browserItems} credits={creditsObj} />
      </section>

      <SiteFooter />
    </main>
  );
}
