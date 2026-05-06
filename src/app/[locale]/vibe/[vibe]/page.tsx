import { notFound } from "next/navigation";

import { VIBE_COPY } from "@/lib/facet-copy";
import { buildLocaleAlternates } from "@/lib/locale-routing";
import { getApprovedPetsWithMetrics, type PetWithMetrics } from "@/lib/pets";
import { PET_VIBES, type PetVibe } from "@/lib/types";

import { FacetPage } from "@/components/facet-page";
import { JsonLd } from "@/components/json-ld";

function curatedSort(pets: PetWithMetrics[]): PetWithMetrics[] {
  return [...pets].sort((a, b) => {
    const fa = a.featured ? 0 : 1;
    const fb = b.featured ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return a.displayName.localeCompare(b.displayName);
  });
}

const SITE_URL = "https://petdex.crafter.run";

type Props = { params: Promise<{ locale: string; vibe: string }> };

export function generateStaticParams() {
  return PET_VIBES.map((vibe) => ({ vibe }));
}

function resolveVibe(slug: string): PetVibe | null {
  const lower = slug.toLowerCase() as PetVibe;
  return PET_VIBES.includes(lower) ? lower : null;
}

export async function generateMetadata({ params }: Props) {
  const { vibe: raw } = await params;
  const vibe = resolveVibe(raw);
  if (!vibe) return { title: "Vibe not found", robots: { index: false } };
  const copy = VIBE_COPY[vibe];
  return {
    title: copy.title,
    description: copy.metaDescription,
    alternates: buildLocaleAlternates(`/vibe/${vibe}`),
    openGraph: {
      title: copy.title,
      description: copy.metaDescription,
      url: `${SITE_URL}/vibe/${vibe}`,
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: copy.title,
      description: copy.metaDescription,
    },
  };
}

export default async function VibePage({ params }: Props) {
  const { vibe: raw } = await params;
  const vibe = resolveVibe(raw);
  if (!vibe) notFound();

  const all = await getApprovedPetsWithMetrics();
  const filtered = curatedSort(all.filter((p) => p.vibes.includes(vibe)));

  if (filtered.length === 0) notFound();

  const copy = VIBE_COPY[vibe];

  // Related vibes: top 6 other vibes by count, excluding current.
  const facetCounts = new Map<PetVibe, number>();
  for (const p of all)
    for (const v of p.vibes) {
      facetCounts.set(v, (facetCounts.get(v) ?? 0) + 1);
    }
  const related = [...facetCounts.entries()]
    .filter(([v]) => v !== vibe)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([v, count]) => ({
      href: `/vibe/${v}`,
      label: v,
      count,
    }));

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: copy.title,
    description: copy.metaDescription,
    url: `${SITE_URL}/vibe/${vibe}`,
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
        eyebrow={`Vibe — ${vibe}`}
        title={copy.title}
        intro={copy.intro}
        count={filtered.length}
        pets={filtered}
        exampleSlug={filtered[0]?.slug}
        relatedLabel="Related vibes"
        related={related}
      />
    </>
  );
}
