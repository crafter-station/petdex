import Link from "next/link";

import { ArrowRight, Search, Sparkles } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { getApprovedPetCount, getFeaturedPetsWithMetrics } from "@/lib/pets";

import { CommandLine } from "@/components/command-line";
import { PetSprite } from "@/components/pet-sprite";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "notFound.metadata" });

  return {
    title: t("title"),
    description: t("description"),
    robots: { index: false, follow: false },
  };
}

export default async function NotFound() {
  const t = await getTranslations("notFound");
  const [featured, total] = await Promise.all([
    getFeaturedPetsWithMetrics(4),
    getApprovedPetCount(),
  ]);

  // Pick a random featured pet for the "lost" sprite. Falls back gracefully
  // if the curated set is empty (early days / fresh DB).
  const lost = featured[Math.floor(Math.random() * featured.length)] ?? null;

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <SiteHeader />
      <section className="petdex-cloud relative -mt-[84px] overflow-clip pt-[84px]">
        <div className="relative mx-auto flex w-full max-w-[1440px] flex-col px-5 pb-10 md:px-8">

          <div className="mt-10 flex flex-col items-center text-center md:mt-14">
            <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
              {t("eyebrow")}
            </p>
            <h1 className="mt-3 text-balance text-[42px] leading-[1] font-semibold tracking-tight md:text-[64px]">
              {t("title")}
            </h1>
            <p className="mt-5 max-w-xl text-balance text-base leading-7 text-muted-1 md:text-lg">
              {t("body")}
            </p>

            {lost ? (
              <div className="relative mt-10 flex flex-col items-center gap-3">
                <div
                  className="relative flex items-center justify-center rounded-3xl border border-brand-light/25 bg-white/82 px-10 py-8 shadow-[0_0_0_1px_rgba(100,120,246,0.10),0_24px_60px_-30px_rgba(82,102,234,0.45)] backdrop-blur"
                  style={{
                    background:
                      "radial-gradient(circle at 50% 38%, rgba(255,255,255,0.95) 0%, rgba(238,241,255,0.55) 60%, transparent 90%)",
                  }}
                >
                  <PetSprite
                    src={lost.spritesheetPath}
                    cycleStates
                    cycleIntervalMs={1400}
                    scale={0.8}
                    label={t("lostPetAnimated", { name: lost.displayName })}
                  />
                </div>
                <p className="font-mono text-[10px] tracking-[0.22em] text-muted-3 uppercase">
                  {t("caughtWandering", { name: lost.displayName })}
                </p>
              </div>
            ) : null}
          </div>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/#gallery"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-inverse px-6 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
            >
              <Search className="size-4" />
              {total > 0
                ? t("browsePets", { count: total })
                : t("browseGallery")}
            </Link>
            <Link
              href="/about"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-border-base bg-surface/70 px-6 text-sm font-medium text-foreground backdrop-blur transition hover:bg-white dark:hover:bg-stone-800"
            >
              <Sparkles className="size-4" />
              {t("about")}
            </Link>
            <Link
              href="/submit"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-border-base bg-surface/70 px-6 text-sm font-medium text-foreground backdrop-blur transition hover:bg-white dark:hover:bg-stone-800"
            >
              {t("submit")}
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      </section>

      {featured.length > 0 ? (
        <section className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-12 md:px-8 md:py-16">
          <header className="flex flex-col gap-1">
            <p className="font-mono text-[10px] tracking-[0.22em] text-muted-3 uppercase">
              {t("featuredEyebrow")}
            </p>
            <h2 className="text-2xl font-medium tracking-tight text-foreground md:text-3xl">
              {t("featuredTitle")}
            </h2>
          </header>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {featured.map((pet) => (
              <Link
                key={pet.slug}
                href={`/pets/${pet.slug}`}
                className="group flex flex-col items-center rounded-3xl border border-border-base bg-surface/76 px-5 py-6 shadow-sm shadow-blue-950/5 backdrop-blur transition hover:-translate-y-0.5 hover:bg-white hover:shadow-xl hover:shadow-blue-950/10 dark:hover:bg-stone-800"
              >
                <div
                  className="flex items-center justify-center px-2 py-3"
                  style={{
                    background:
                      "radial-gradient(circle at 50% 38%, rgba(255,255,255,0.95) 0%, rgba(238,241,255,0.55) 55%, transparent 80%)",
                  }}
                >
                  <PetSprite
                    src={pet.spritesheetPath}
                    cycleStates
                    scale={0.6}
                    label={t("featuredPetAnimated", { name: pet.displayName })}
                  />
                </div>
                <span className="mt-3 text-base font-semibold tracking-tight text-foreground">
                  {pet.displayName}
                </span>
                <span className="font-mono text-[10px] tracking-[0.18em] text-muted-4 uppercase">
                  {pet.kind}
                </span>
              </Link>
            ))}
          </div>

          <div className="mt-2 rounded-2xl border border-black/[0.08] bg-surface/55 px-5 py-4 backdrop-blur dark:border-white/[0.08]">
            <p className="font-mono text-[10px] tracking-[0.22em] text-muted-3 uppercase">
              {t("terminalEyebrow")}
            </p>
            <CommandLine
              command={`npx petdex install ${lost?.slug ?? "boba"}`}
              source="not-found"
              className="mt-3"
            />
          </div>
        </section>
      ) : null}

      <SiteFooter />
    </main>
  );
}
