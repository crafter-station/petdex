import { getTranslations } from "next-intl/server";

import { BRAND_JSON_LD } from "@/lib/brand-kit";
import { sortCollectionListingItems } from "@/lib/collection-listing-order";
import {
  getCollectionListingMetadata,
  getCollectionListingPreviewsBySlugs,
} from "@/lib/collections";
import { buildLocaleAlternates } from "@/lib/locale-routing";
import { resolveOwnerCredits } from "@/lib/owner-credit";

import { StaticCollectionCard } from "@/components/collections/static-collection-card";
import { JsonLd } from "@/components/layout/json-ld";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import { hasLocale } from "@/i18n/config";

// /collections is fully public - no auth, no cookies, no per-visitor
// data. 24h ceiling + revalidateTag('collection:list') from admin
// write paths keeps the page fresh on actual changes without burning
// a function on every visit.
export const revalidate = 86400;

const SITE_URL = "https://petdex.dev";
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
  const browserT = await getTranslations({
    locale: hasLocale(locale) ? locale : "en",
    namespace: "collectionsBrowser",
  });
  const collections = await getCollectionListingMetadata(MIN_PETS);
  const defaultVisibleOrder = sortCollectionListingItems(collections, "size");
  // Every card is server-rendered; there is no client loader for later previews.
  const previewCollections = await getCollectionListingPreviewsBySlugs(
    defaultVisibleOrder.map((c) => c.slug),
    MIN_PETS,
    6,
  );
  const previewPetsBySlug = new Map(
    previewCollections.map((c) => [c.slug, c.pets]),
  );

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
    "@graph": [
      ...BRAND_JSON_LD["@graph"],
      {
        "@type": "CollectionPage",
        "@id": `${SITE_URL}/collections#webpage`,
        name: "Petdex collections",
        url: `${SITE_URL}/collections`,
        isPartOf: { "@id": `${SITE_URL}/#website` },
        author: { "@id": "https://www.railly.dev/#person" },
        publisher: { "@id": "https://crafter.run/#organization" },
        mainEntity: {
          "@type": "ItemList",
          itemListElement: collections.map((c, index) => ({
            "@type": "ListItem",
            position: index + 1,
            url: `${SITE_URL}/collections/${c.slug}`,
            name: c.title,
          })),
        },
      },
    ],
  };

  const browserItems = defaultVisibleOrder.map((c) => ({
    slug: c.slug,
    title: c.title,
    description: c.description,
    ownerId: c.ownerId,
    externalUrl: c.externalUrl,
    coverPetSlug: c.coverPetSlug,
    petCount: c.petCount,
    pets: (previewPetsBySlug.get(c.slug) ?? []).map((pet) => ({
      slug: pet.slug,
      displayName: pet.displayName,
      spritesheetPath: pet.spritesheetPath,
    })),
  }));

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <JsonLd data={jsonLd} />
      <SiteHeader />
      <section className="petdex-hero relative -mt-14 overflow-clip pt-14">
        <div className="relative mx-auto flex w-full max-w-[1440px] flex-col px-5 pb-10 md:px-8">
          <div className="mt-12 max-w-2xl md:mt-16">
            <p className="toy-tag inline-block rounded-full bg-toy-volt px-2.5 py-1 text-[#101944] shadow-[0_2px_0_#C9A91F]">
              {t("hero.eyebrow")}
            </p>
            <h1 className="mt-4 text-balance text-[40px] leading-[1] font-semibold tracking-tight md:text-[64px]">
              {t("hero.title")}
            </h1>
            <p className="mt-5 text-balance text-base leading-7 text-muted-1 md:text-lg">
              {t("hero.description", { count: collections.length })}
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1440px] px-5 py-10 md:px-8 md:py-14">
        <div className="mb-5 flex items-center justify-end">
          <span className="toy-tag text-toy-cobalt dark:text-[#9BB2FF]">
            {browserT("showingCount", {
              visible: browserItems.length,
              total: browserItems.length,
            })}
          </span>
        </div>
        <div className="grid auto-rows-fr gap-5 md:grid-cols-2 lg:grid-cols-3">
          {browserItems.map((collection) => {
            const owner = collection.ownerId
              ? (creditsObj[collection.ownerId] ?? null)
              : null;
            return (
              <div
                key={collection.slug}
                className="toy-shell h-full rounded-[1.75rem] p-2.5 transition-transform duration-200 [transition-timing-function:var(--ease-bounce)] hover:-translate-y-1"
              >
                <StaticCollectionCard
                  collection={collection}
                  owner={owner}
                  labels={{
                    kind: {
                      franchise: browserT("kindLabel.franchise"),
                      category: browserT("kindLabel.category"),
                      categorySub: browserT("kindLabel.categorySub"),
                      other: browserT("kindLabel.other"),
                    },
                    petCount: browserT("card.petCount", {
                      count: collection.petCount,
                    }),
                    siteLink: browserT("card.siteLink"),
                    byOwner: owner
                      ? browserT("card.byOwner", { name: owner.name })
                      : null,
                  }}
                />
              </div>
            );
          })}
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
