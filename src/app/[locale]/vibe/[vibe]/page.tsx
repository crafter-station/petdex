import { notFound } from "next/navigation";

import { getTranslations } from "next-intl/server";

import { buildLocaleAlternates, withLocale } from "@/lib/locale-routing";
import { withNextDataCache } from "@/lib/next-data-cache";
import { searchPets } from "@/lib/pet-search";
import { PET_VIBES, type PetVibe } from "@/lib/types";

import { FacetPage } from "@/components/facet-page";
import { JsonLd } from "@/components/json-ld";

import { hasLocale } from "@/i18n/config";

const SITE_URL = "https://petdex.dev";
const FACET_PAGE_LIMIT = 60;

type Props = { params: Promise<{ locale: string; vibe: string }> };

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
  return {
    title: t(`vibes.${vibe}.title`),
    description: t(`vibes.${vibe}.metaDescription`),
    alternates: buildLocaleAlternates(
      `/vibe/${vibe}`,
      hasLocale(locale) ? locale : undefined,
    ),
    openGraph: {
      title: t(`vibes.${vibe}.title`),
      description: t(`vibes.${vibe}.metaDescription`),
      url: `${SITE_URL}/vibe/${vibe}`,
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

  const related = PET_VIBES.map(
    (v) => [v, results.facets.vibes[v] ?? 0] as const,
  )
    .filter(([v]) => v !== vibe)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([v, count]) => ({
      href: withLocale(`/vibe/${v}`, localeValue),
      label: t(`vibes.${v}.label`),
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
        eyebrow={t("vibeEyebrow", { vibe: t(`vibes.${vibe}.label`) })}
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
