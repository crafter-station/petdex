import Link from "next/link";

import { ArrowRight, Search, Sparkles } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { withLocale } from "@/lib/locale-routing";

import { StaticCommandLine } from "@/components/download/static-command-line";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import { hasLocale, type Locale } from "@/i18n/config";

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
  // Next constructs the not-found element with no props — a params
  // declaration made every 404 a 500 (the await destructure threw). The
  // locale comes from the request scope instead: getLocale reads the same
  // [locale] segment the i18n request config does.
  // Bare paths resolve to the default locale under `localePrefix: as-needed`,
  // so on /es or /zh these three CTAs would otherwise drop the visitor back
  // into English; route every link through withLocale.
  let locale: Locale = "en";
  try {
    const requested = await getLocale();
    if (hasLocale(requested)) locale = requested;
  } catch {
    /* no request scope (e.g. root-level 404) — stay on the default */
  }
  const t = await getTranslations("notFound");
  const localized = (path: string) => withLocale(path, locale);

  return (
    <>
      <SiteHeader />
      <main id="main" className="min-h-dvh bg-background text-foreground">
        <section className="petdex-hero relative -mt-14 overflow-clip pt-14">
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
                href={localized("/#gallery")}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-inverse px-6 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
              >
                <Search className="size-4" />
                {t("browseGallery")}
              </Link>
              <Link
                href={localized("/about")}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-border-base bg-surface/70 px-6 text-sm font-medium text-foreground backdrop-blur transition hover:bg-white dark:hover:bg-stone-800"
              >
                <Sparkles className="size-4" />
                {t("about")}
              </Link>
              <Link
                href={localized("/submit")}
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
            <StaticCommandLine
              command="npx petdex install boba"
              className="mt-3"
            />
          </div>
        </section>

        <SiteFooter />
      </main>
    </>
  );
}
