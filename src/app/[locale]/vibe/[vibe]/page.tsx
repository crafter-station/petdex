import { notFound } from "next/navigation";

import { getTranslations } from "next-intl/server";

import { buildLocaleAlternates, withLocale } from "@/lib/locale-routing";
import { withNextDataCache } from "@/lib/next-data-cache";
import { searchPets } from "@/lib/pet-search";
import { PET_VIBES, type PetVibe } from "@/lib/types";

import { FacetPage } from "@/components/layout/facet-page";
import { JsonLd } from "@/components/layout/json-ld";

import { hasLocale } from "@/i18n/config";

const SITE_URL = "https://petdex.dev";
const FACET_PAGE_LIMIT = 60;

type Props = { params: Promise<{ locale: string; vibe: string }> };

// Fully public: no auth, no cookies, no per-visitor data. The declaration is
// also what gets every locale prerendered — without it Next builds the default
// locale and leaves the others to be rendered on demand, so /zh and /es were
// the only locales this page did not have a static copy for.
export const dynamic = "force-static";

export const revalidate = 86400;

export function generateStaticParams() {
  return PET_VIBES.map((vibe) => ({ vibe }));
}

function resolveVibe(slug: string): PetVibe | null {
  const lower = slug.toLowerCase() as PetVibe;
  return PET_VIBES.includes(lower) ? lower : null;
}

function loadVibeFacet(vibe: PetVibe) {
  return withNextDataCache(
    () => searchPets({ vibes: [vibe], limit: FACET_PAGE_LIMIT }),
    ["petdex-facet-page", "vibe", vibe, String(FACET_PAGE_LIMIT)],
    { tags: ["pet:list", "petdex:facets"], revalidate: 86400 },
  )();
}

export async function generateMetadata({ params }: Props) {
  const { vibe: raw, locale } = await params;
  const t = await getTranslations({
    locale: hasLocale(locale) ? locale : "en",
    namespace: "facetPages",
  });
  const vibe = resolveVibe(raw);
  if (!vibe) return { title: t("notFound.vibe"), robots: { index: false } };
  const alternates = buildLocaleAlternates(
    `/vibe/${vibe}`,
    hasLocale(locale) ? locale : undefined,
  );
  return {
    title: t(`vibes.${vibe}.title`),
    description: t(`vibes.${vibe}.metaDescription`),
    alternates,
    openGraph: {
      title: t(`vibes.${vibe}.title`),
      description: t(`vibes.${vibe}.metaDescription`),
      url: alternates.canonical,
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: t(`vibes.${vibe}.title`),
      description: t(`vibes.${vibe}.metaDescription`),
    },
  };
}

export default async function VibePage({ params }: Props) {
  const { vibe: raw, locale } = await params;
  const localeValue = hasLocale(locale) ? locale : "en";
  const t = await getTranslations({
    locale: hasLocale(locale) ? locale : "en",
    namespace: "facetPages",
  });
  const vibe = resolveVibe(raw);
  if (!vibe) notFound();

  const results = await loadVibeFacet(vibe);
  const filtered = results.pets;
  const total = results.total;

  if (total === 0) notFound();

  // The label moved from `facetPages.vibes.<v>.label` to the `taxonomy`
  // namespace — same string the gallery filter chips render, shipped once.
  const tTaxonomy = await getTranslations({
    locale: hasLocale(locale) ? locale : "en",
    namespace: "taxonomy",
  });
  const related = PET_VIBES.map((v) => {
    const count = results.facets.vibes[v] ?? 0;
    return [v, count] as const;
  })
    // Exclude the current vibe, then drop empty siblings: the page 404s at
    // total === 0, and linking an empty facet hands the visitor that same
    // 404. Ties break alphabetically so the chip order is deterministic
    // (Array#sort is not guaranteed stable across engines).
    .filter(([v, count]) => v !== vibe && count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([v, count]) => ({
      href: withLocale(`/vibe/${v}`, localeValue),
      label: tTaxonomy(`vibes.${v}`),
      count,
    }));

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: t(`vibes.${vibe}.title`),
    description: t(`vibes.${vibe}.metaDescription`),
    url: `${SITE_URL}/vibe/${vibe}`,
    isPartOf: { "@type": "WebSite", "@id": `${SITE_URL}/#website` },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: total,
      itemListElement: filtered.slice(0, 20).map((p, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: `${SITE_URL}/pets/${p.slug}`,
        name: p.displayName,
      })),
    },
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      <FacetPage
        eyebrow={t("vibeEyebrow", { vibe: tTaxonomy(`vibes.${vibe}`) })}
        title={t(`vibes.${vibe}.title`)}
        intro={t(`vibes.${vibe}.intro`)}
        countLabel={t("count", { count: total })}
        pets={filtered}
        exampleSlug={filtered[0]?.slug}
        relatedLabel={t("relatedVibes")}
        related={related}
      />
    </>
  );
}
