// Shared layout for /vibe/<vibe> and /kind/<kind> programmatic SEO pages.
// Reuses the same gallery card grid as the home page but with a single
// hardcoded filter and a hero block tuned for keyword targeting.

import Link from "next/link";

import { getLocale } from "next-intl/server";

import type { SearchPet } from "@/lib/pet-search";
import { cn } from "@/lib/utils";

import { StaticCommandLine } from "@/components/download/static-command-line";
import { StaticFacetPetCard } from "@/components/pets/static-facet-pet-card";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { buttonVariants } from "@/components/ui/button";

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
  const cmd = `npx petdex install ${exampleSlug ?? pets[0]?.slug ?? "boba"}`;

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <section className="petdex-hero relative overflow-hidden">
        <div className="relative mx-auto flex w-full max-w-7xl flex-col px-5 pt-5 pb-10 md:px-8">
          <SiteHeader />
          <div className="mt-12 flex flex-col items-center text-center md:mt-16">
            <p className="toy-tag inline-block rounded-full bg-toy-volt px-2.5 py-1 text-[#101944] shadow-[0_2px_0_#C9A91F]">
              {eyebrow}
            </p>
            <h1 className="mt-4 font-heading text-balance text-[40px] leading-[0.98] font-extrabold tracking-tight md:text-[64px]">
              {title}
            </h1>
            <p className="mt-5 max-w-2xl text-balance text-base leading-7 text-muted-1 md:text-lg">
              {intro}
            </p>
            <StaticCommandLine command={cmd} className="mt-5 w-full max-w-sm" />
            <p className="toy-tag mt-4 text-toy-cobalt dark:text-[#9BB2FF]">
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
            />
          ))}
        </div>

        {related.length > 0 ? (
          <aside className="toy-shell mt-8 rounded-3xl border border-[#D4DCF4] px-5 py-6 md:px-7 dark:border-white/12">
            <p className="toy-tag text-toy-cobalt dark:text-[#9BB2FF]">
              {relatedLabel}
            </p>
            <div className="mt-4 flex flex-wrap gap-2.5">
              {related.map((r) => (
                <Link
                  key={r.href}
                  href={r.href}
                  className={cn(
                    buttonVariants({ variant: "pearl", size: "lg" }),
                    "gap-2 rounded-xl px-3.5 font-hardware text-[11px] tracking-[0.08em] capitalize",
                  )}
                >
                  <span>{r.label}</span>
                  <span className="text-[10px] text-muted-3">{r.count}</span>
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
