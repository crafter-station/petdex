// Shared layout for /vibe/<vibe> and /kind/<kind> programmatic SEO pages.
// Reuses the same gallery card grid as the home page but with a single
// hardcoded filter and a hero block tuned for keyword targeting.

import Link from "next/link";

import { getLocale } from "next-intl/server";

import type { PetWithMetrics } from "@/lib/pets";
import { cn } from "@/lib/utils";

import { CommandLine } from "@/components/command-line";
import { PetCard } from "@/components/pet-gallery";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

type FacetPageProps = {
  eyebrow: string;
  title: string;
  intro: string;
  countLabel: string;
  pets: PetWithMetrics[];
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
  const cmd = `npx petdex install ${exampleSlug ?? pets[0]?.slug ?? "boba"}`;

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <section className="petdex-cloud relative overflow-hidden">
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
            <CommandLine
              command={cmd}
              source="facet-hero"
              className="mt-5 w-full max-w-sm"
            />
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
            <PetCard key={pet.slug} pet={pet} index={index} />
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
                  <span className="text-[10px] text-muted-4">{r.count}</span>
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
