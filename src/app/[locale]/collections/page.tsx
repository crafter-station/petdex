import Link from "next/link";

import { ExternalLink } from "lucide-react";

import { getAllCollections } from "@/lib/collections";
import { buildLocaleAlternates } from "@/lib/locale-routing";
import { resolveOwnerCredits } from "@/lib/owner-credit";

import { CollectionCover } from "@/components/collection-cover";
import { JsonLd } from "@/components/json-ld";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

// /collections is fully public — no auth, no cookies, no per-visitor
// data. ISR with 5 minute revalidation lets featured-collection
// rotations show up quickly without waking a function on every visit.
export const revalidate = 300;

const SITE_URL = "https://petdex.crafter.run";

export async function generateMetadata() {
  return {
    title: "Featured collections",
    description: "Original Petdex character sets grouped by creator and IP.",
    alternates: buildLocaleAlternates("/collections"),
  };
}

export default async function CollectionsPage() {
  const collections = await getAllCollections();
  const ownerIds = collections
    .map((collection) => collection.ownerId)
    .filter((id): id is string => Boolean(id));
  const credits = await resolveOwnerCredits(
    ownerIds.map((ownerId) => ({
      ownerId,
      creditName: null,
      creditUrl: null,
      creditImage: null,
    })),
  );

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Petdex collections",
    url: `${SITE_URL}/collections`,
    mainEntity: {
      "@type": "ItemList",
      itemListElement: collections.map((collection, index) => ({
        "@type": "ListItem",
        position: index + 1,
        url: `${SITE_URL}/collections/${collection.slug}`,
        name: collection.title,
      })),
    },
  };

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <JsonLd data={jsonLd} />
      <section className="petdex-cloud relative overflow-clip">
        <div className="relative mx-auto flex w-full max-w-6xl flex-col px-5 pt-5 pb-12 md:px-8">
          <SiteHeader />
          <div className="mt-12 max-w-2xl md:mt-16">
            <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
              Featured collections
            </p>
            <h1 className="mt-3 text-balance text-[40px] leading-[1] font-semibold tracking-tight md:text-[64px]">
              Original IP sets for your Codex desk
            </h1>
            <p className="mt-5 text-balance text-base leading-7 text-muted-1 md:text-lg">
              Curated character families from Petdex creators. Catch a whole
              set, follow the artist, and install the ones that match your
              workspace.
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-[1440px] auto-rows-fr gap-5 px-5 py-12 md:grid-cols-2 md:px-8 md:py-16">
        {collections.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-border-base bg-surface/60 p-10 text-center text-sm text-muted-2 md:col-span-2">
            No collections are featured yet.
          </div>
        ) : (
          collections.map((collection) => {
            const owner = collection.ownerId
              ? credits.get(collection.ownerId)
              : null;
            return (
              <article
                key={collection.slug}
                className="flex h-full flex-col overflow-hidden rounded-3xl border border-border-base bg-surface/80"
              >
                <Link
                  href={`/collections/${collection.slug}`}
                  className="block"
                >
                  <CollectionCover
                    pets={collection.pets}
                    coverSlug={collection.coverPetSlug}
                    max={5}
                    scale={0.55}
                  />
                </Link>
                <div className="flex flex-1 flex-col p-6">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
                        {collection.pets.length} pets
                      </p>
                      <h2 className="mt-1 text-2xl font-semibold tracking-tight">
                        <Link href={`/collections/${collection.slug}`}>
                          {collection.title}
                        </Link>
                      </h2>
                    </div>
                    {collection.externalUrl ? (
                      <Link
                        href={collection.externalUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border-base bg-surface px-3 text-xs font-medium text-muted-2 transition hover:border-border-strong"
                      >
                        <ExternalLink className="size-3.5" />
                        IP site
                      </Link>
                    ) : null}
                  </div>
                  <p className="mt-3 text-sm leading-6 text-muted-2">
                    {collection.description}
                  </p>
                  {owner ? (
                    <Link
                      href={`/u/${owner.handle}`}
                      className="mt-auto inline-flex pt-4 text-sm font-medium text-brand hover:underline"
                    >
                      by {owner.name}
                    </Link>
                  ) : null}
                </div>
              </article>
            );
          })
        )}
      </section>

      <SiteFooter />
    </main>
  );
}
