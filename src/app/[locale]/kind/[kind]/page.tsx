import { notFound } from "next/navigation";

import { getTranslations } from "next-intl/server";

import { buildLocaleAlternates, withLocale } from "@/lib/locale-routing";
import { withNextDataCache } from "@/lib/next-data-cache";
import { searchPets } from "@/lib/pet-search";
import { PET_KINDS, type PetKind } from "@/lib/types";

import { FacetPage } from "@/components/facet-page";
import { JsonLd } from "@/components/json-ld";

import { hasLocale } from "@/i18n/config";

const SITE_URL = "https://petdex.dev";
const FACET_PAGE_LIMIT = 60;

type Props = { params: Promise<{ kind: string; locale: string }> };

export const revalidate = 86400;

export function generateStaticParams() {
  return PET_KINDS.map((kind) => ({ kind }));
}

function resolveKind(slug: string): PetKind | null {
  const lower = slug.toLowerCase() as PetKind;
  return PET_KINDS.includes(lower) ? lower : null;
}

function loadKindFacet(kind: PetKind) {
  return withNextDataCache(
    () => searchPets({ kinds: [kind], limit: FACET_PAGE_LIMIT }),
    ["petdex-facet-page", "kind", kind, String(FACET_PAGE_LIMIT)],
    { tags: ["pet:list", "petdex:facets"], revalidate: 86400 },
  )();
}

export async function generateMetadata({ params }: Props) {
  const { kind: raw, locale } = await params;
  const t = await getTranslations({
    locale: hasLocale(locale) ? locale : "en",
    namespace: "facetPages",
  });
  const kind = resolveKind(raw);
  if (!kind) return { title: t("notFound.kind"), robots: { index: false } };
  return {
    title: t(`kinds.${kind}.title`),
    description: t(`kinds.${kind}.metaDescription`),
    alternates: buildLocaleAlternates(
      `/kind/${kind}`,
      hasLocale(locale) ? locale : undefined,
    ),
    openGraph: {
      title: t(`kinds.${kind}.title`),
      description: t(`kinds.${kind}.metaDescription`),
      url: `${SITE_URL}/kind/${kind}`,
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: t(`kinds.${kind}.title`),
      description: t(`kinds.${kind}.metaDescription`),
    },
  };
}

export default async function KindPage({ params }: Props) {
  const { kind: raw, locale } = await params;
  const localeValue = hasLocale(locale) ? locale : "en";
  const t = await getTranslations({
    locale: hasLocale(locale) ? locale : "en",
    namespace: "facetPages",
  });
  const kind = resolveKind(raw);
  if (!kind) notFound();

  const results = await loadKindFacet(kind);
  const filtered = results.pets;
  const total = results.total;

  if (total === 0) notFound();

  const otherKinds = PET_KINDS.filter((k) => k !== kind);
  const related = otherKinds.map((k) => ({
    href: withLocale(`/kind/${k}`, localeValue),
    label: t(`kinds.${k}.label`),
    count: results.facets.kinds[k] ?? 0,
  }));

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: t(`kinds.${kind}.title`),
    description: t(`kinds.${kind}.metaDescription`),
    url: `${SITE_URL}/kind/${kind}`,
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
        eyebrow={t("kindEyebrow", { kind: t(`kinds.${kind}.label`) })}
        title={t(`kinds.${kind}.title`)}
        intro={t(`kinds.${kind}.intro`)}
        countLabel={t("count", { count: total })}
        pets={filtered}
        exampleSlug={filtered[0]?.slug}
        relatedLabel={t("relatedKinds")}
        related={related}
      />
    </>
  );
}
