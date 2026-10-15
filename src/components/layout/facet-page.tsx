// Shared layout for /vibe/<vibe> and /kind/<kind> programmatic SEO pages.
// Reuses the same gallery card grid as the home page but with a single
// hardcoded filter and a hero block tuned for keyword targeting.

import Link from "next/link";

import { getLocale, getTranslations } from "next-intl/server";

import { formatLocalizedNumber } from "@/lib/format-number";
import type { SearchPet } from "@/lib/pet-search";
import { PET_KINDS, PET_VIBES } from "@/lib/types";
import { cn } from "@/lib/utils";

import { StaticCommandLine } from "@/components/download/static-command-line";
import { StaticFacetPetCard } from "@/components/pets/static-facet-pet-card";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

type FacetPageProps = {
  eyebrow: string;
  title: string;
  intro: string;
  countLabel: string;
  pets: SearchPet[];
  exampleSlug?: string;
  relatedLabel: string;
  related: { href: string; label: string; count: number }[];
};

export async function FacetPage({
  eyebrow,
  title,
  intro,
  countLabel,
  pets,
  exampleSlug,
  relatedLabel,
  related,
}: FacetPageProps) {
  const locale = await getLocale();
  // The cards are rendered here rather than in the page, and they carry the
  // install count, the featured badge, and the discovered/author lines. Those
  // were English literals on /es and /zh until they moved into the
  // `facetPages` messages and were threaded down as labels.
  const t = await getTranslations("facetPages");
  // The card's kind badge and `#vibe` chips render from `taxonomy`, which is
  // also shipped to the client (the gallery's filter chips read it), so the
  // labels live there rather than in `facetPages`.
  const tTaxonomy = await getTranslations("taxonomy");
  const cardLabels = {
    installs: (count: number, formatted: string) =>
      t("cardInstalls", { count, formatted }),
    discovered: t("cardDiscovered"),
    discoveredTitle: t("cardDiscoveredTitle"),
    byAuthor: (name: string) => t("cardByAuthor", { name }),
    featured: t("cardFeatured"),
    dexNumber: (number: string) => t("cardDexNumber", { number }),
    openPet: (name: string) => t("cardOpenPet", { name }),
    spriteStill: (name: string) => t("cardSpriteStill", { name }),
    batchLabel: (month: string) => t("cardBatchLabel", { month }),
    kinds: Object.fromEntries(
      PET_KINDS.map((kind) => [kind, tTaxonomy(`kinds.${kind}`)]),
    ),
    vibes: Object.fromEntries(
      PET_VIBES.map((vibe) => [vibe, tTaxonomy(`vibes.${vibe}`)]),
    ),
  };
  const cmd = `npx petdex install ${exampleSlug ?? pets[0]?.slug ?? "boba"}`;

  return (
    <main id="main" className="min-h-dvh bg-background text-foreground">
      <section className="petdex-hero relative overflow-hidden">
        <div className="relative mx-auto flex w-full max-w-7xl flex-col px-5 pt-5 pb-10 md:px-8">
          <SiteHeader />
          <div className="mt-12 flex flex-col items-center text-center md:mt-16">
            <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
              {eyebrow}
            </p>
            <h1 className="mt-3 text-balance text-[40px] leading-[1] font-semibold tracking-tight md:text-[64px]">
              {title}
            </h1>
            <p className="mt-5 max-w-2xl text-balance text-base leading-7 text-muted-1 md:text-lg">
              {intro}
            </p>
            <StaticCommandLine command={cmd} className="mt-5 w-full max-w-sm" />
            <p className="mt-3 font-mono text-[11px] tracking-[0.18em] text-muted-3 uppercase">
              {countLabel}
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto flex w-full max-w-[1440px] flex-col gap-8 px-5 py-12 md:px-8 md:py-16">
        <div
          className={cn(
            "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5",
            locale === "zh" ? "md:gap-3" : "md:gap-5",
          )}
        >
          {pets.map((pet, index) => (
            <StaticFacetPetCard
              key={pet.slug}
              pet={pet}
              index={index}
              locale={locale}
              labels={cardLabels}
            />
          ))}
        </div>

        {related.length > 0 ? (
          <aside className="mt-8 rounded-2xl border border-black/[0.08] bg-surface/55 px-5 py-6 backdrop-blur md:px-7 dark:border-white/[0.08]">
            <p className="font-mono text-[11px] tracking-[0.22em] text-muted-3 uppercase">
              {relatedLabel}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {related.map((r) => (
                <Link
                  key={r.href}
                  href={r.href}
                  className="inline-flex h-9 items-center gap-2 rounded-full border border-border-base bg-surface px-3 font-mono text-[11px] tracking-[0.08em] capitalize text-muted-2 transition hover:border-border-strong"
                >
                  <span>{r.label}</span>
                  <span className="text-[10px] text-muted-4">
                    {formatLocalizedNumber(r.count, locale)}
                  </span>
                </Link>
              ))}
            </div>
          </aside>
        ) : null}
      </section>

      <SiteFooter />
    </main>
  );
}
