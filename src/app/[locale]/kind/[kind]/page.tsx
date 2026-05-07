import { notFound } from "next/navigation";

import { KIND_COPY } from "@/lib/facet-copy";
import { buildLocaleAlternates } from "@/lib/locale-routing";
import { getApprovedPetsWithMetrics, type PetWithMetrics } from "@/lib/pets";
import { PET_KINDS, type PetKind } from "@/lib/types";

import { FacetPage } from "@/components/facet-page";
import { JsonLd } from "@/components/json-ld";

const SITE_URL = "https://petdex.crafter.run";

type Props = { params: Promise<{ kind: string; locale: string }> };

export const revalidate = 600;

export function generateStaticParams() {
  return PET_KINDS.map((kind) => ({ kind }));
}

function resolveKind(slug: string): PetKind | null {
  const lower = slug.toLowerCase() as PetKind;
  return PET_KINDS.includes(lower) ? lower : null;
}

function curatedSort(pets: PetWithMetrics[]): PetWithMetrics[] {
  return [...pets].sort((a, b) => {
    const fa = a.featured ? 0 : 1;
    const fb = b.featured ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return a.displayName.localeCompare(b.displayName);
  });
}

export async function generateMetadata({ params }: Props) {
  const { kind: raw } = await params;
  const kind = resolveKind(raw);
  if (!kind) return { title: "Kind not found", robots: { index: false } };
  const copy = KIND_COPY[kind];
  return {
    title: copy.title,
    description: copy.metaDescription,
    alternates: buildLocaleAlternates(`/kind/${kind}`),
    openGraph: {
      title: copy.title,
      description: copy.metaDescription,
      url: `${SITE_URL}/kind/${kind}`,
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: copy.title,
      description: copy.metaDescription,
    },
  };
}

export default async function KindPage({ params }: Props) {
  const { kind: raw } = await params;
  const kind = resolveKind(raw);
  if (!kind) notFound();

  const all = await getApprovedPetsWithMetrics();
  const filtered = curatedSort(all.filter((p) => p.kind === kind));

  if (filtered.length === 0) notFound();

  const copy = KIND_COPY[kind];

  const otherKinds = PET_KINDS.filter((k) => k !== kind);
  const related = otherKinds.map((k) => ({
    href: `/kind/${k}`,
    label: k,
    count: all.filter((p) => p.kind === k).length,
  }));

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: copy.title,
    description: copy.metaDescription,
    url: `${SITE_URL}/kind/${kind}`,
    isPartOf: { "@type": "WebSite", "@id": `${SITE_URL}/#website` },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: filtered.length,
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
        eyebrow={`Kind — ${kind}`}
        title={copy.title}
        intro={copy.intro}
        count={filtered.length}
        pets={filtered}
        exampleSlug={filtered[0]?.slug}
        relatedLabel="Other kinds"
        related={related}
      />
    </>
  );
}
