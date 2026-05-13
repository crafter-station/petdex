import Link from "next/link";

import { ArrowRight, Search, Sparkles } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { CommandLine } from "@/components/command-line";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

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

            <div className="mt-10 h-px w-32 bg-gradient-to-r from-transparent via-brand/40 to-transparent" />
          </div>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/#gallery"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-inverse px-6 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
            >
              <Search className="size-4" />
              {t("browseGallery")}
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

      <section className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-12 md:px-8 md:py-16">
        <div className="mt-2 rounded-2xl border border-black/[0.08] bg-surface/55 px-5 py-4 backdrop-blur dark:border-white/[0.08]">
          <p className="font-mono text-[10px] tracking-[0.22em] text-muted-3 uppercase">
            {t("terminalEyebrow")}
          </p>
          <CommandLine
            command="npx petdex install boba"
            source="not-found"
            className="mt-3"
          />
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
