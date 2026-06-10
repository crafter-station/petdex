import Image from "next/image";

import { Download, ExternalLink } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { buildLocaleAlternates } from "@/lib/locale-routing";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import { hasLocale } from "@/i18n/config";

const SITE_URL = "https://petdex.dev";
const PREVIEW_BACKGROUND = {
  light: "bg-[#f7f8ff]",
  dark: "bg-[#12141f]",
} as const;

const ASSETS = [
  {
    key: "mark",
    mode: "light",
    preview: "/brand/petdex-mark.svg",
    downloads: [
      { format: "svg", href: "/brand/petdex-mark.svg" },
      { format: "png", href: "/brand/petdex-mark.png" },
    ],
  },
  {
    key: "wordmark",
    mode: "light",
    preview: "/brand/petdex-wordmark.svg",
    downloads: [
      { format: "svg", href: "/brand/petdex-wordmark.svg" },
      { format: "png", href: "/brand/petdex-wordmark.png" },
    ],
  },
  {
    key: "wordmarkDark",
    mode: "dark",
    preview: "/brand/petdex-wordmark-dark.svg",
    downloads: [
      { format: "svg", href: "/brand/petdex-wordmark-dark.svg" },
      { format: "png", href: "/brand/petdex-wordmark-dark.png" },
    ],
  },
  {
    key: "desktopIcon",
    mode: "light",
    preview: "/brand/petdex-desktop-icon.png",
    downloads: [{ format: "png", href: "/brand/petdex-desktop-icon.png" }],
  },
] as const;

const COLORS = [
  { key: "brand", value: "#5266EA", className: "bg-brand" },
  { key: "brandDeep", value: "#3847F5", className: "bg-brand-deep" },
  { key: "brandLight", value: "#6478F6", className: "bg-brand-light" },
  { key: "bgApp", value: "#F7F8FF", className: "bg-[#f7f8ff]" },
  { key: "brandTint", value: "#EEF1FF", className: "bg-brand-tint" },
  { key: "ink", value: "#1A1D2E", className: "bg-[#1a1d2e]" },
] as const;

export const revalidate = 3600;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "brand.metadata" });

  return {
    title: t("title"),
    description: t("description"),
    alternates: buildLocaleAlternates(
      "/brand",
      hasLocale(locale) ? locale : undefined,
    ),
    openGraph: {
      title: t("ogTitle"),
      description: t("description"),
      url: `${SITE_URL}/brand`,
      type: "website",
    },
  };
}

export default async function BrandPage() {
  const t = await getTranslations("brand");

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <SiteHeader />

      <section className="petdex-cloud relative -mt-[84px] overflow-clip pt-[84px]">
        <div className="mx-auto grid w-full max-w-[1440px] gap-10 px-5 pt-14 pb-16 md:grid-cols-[1fr_0.9fr] md:px-8 md:pt-24 md:pb-24">
          <div className="flex flex-col justify-center">
            <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
              {t("eyebrow")}
            </p>
            <h1 className="mt-3 max-w-3xl text-balance text-[44px] leading-[0.96] font-semibold tracking-tight md:text-[76px]">
              {t("hero.title")}
            </h1>
            <p className="mt-5 max-w-2xl text-balance text-base leading-7 text-muted-1 md:text-lg">
              {t("hero.body")}
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <div className="flex overflow-hidden rounded-full bg-brand text-on-inverse shadow-sm">
                <a
                  href="/brand/petdex-mark.svg"
                  download
                  className="inline-flex h-11 items-center gap-2 px-5 text-sm font-medium transition hover:bg-brand-deep"
                >
                  <Download className="size-4" />
                  {t("hero.primaryCtaSvg")}
                </a>
                <a
                  href="/brand/petdex-mark.png"
                  download
                  className="inline-flex h-11 items-center border-white/20 border-l px-5 text-sm font-medium transition hover:bg-brand-deep"
                >
                  {t("hero.primaryCtaPng")}
                </a>
              </div>
              <a
                href="https://github.com/crafter-station/petdex/tree/main/public/brand"
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-11 items-center gap-2 rounded-full border border-border-base bg-surface px-5 text-sm font-medium text-foreground transition hover:border-border-strong"
              >
                {t("hero.secondaryCta")}
                <ExternalLink className="size-4" />
              </a>
            </div>
          </div>

          <div className="relative overflow-hidden rounded-[2rem] border border-border-base bg-surface/80 p-6 shadow-sm backdrop-blur md:p-8">
            <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-brand-tint to-transparent dark:from-brand-tint-dark" />
            <div className="relative grid min-h-[320px] place-items-center rounded-[1.5rem] border border-border-base bg-background/75 p-8">
              <div className="relative size-48 drop-shadow-2xl md:size-64">
                <Image
                  src="/brand/petdex-desktop-icon.png"
                  alt={t("hero.iconAlt")}
                  fill
                  className="object-contain"
                  priority
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1440px] px-5 py-14 md:px-8 md:py-20">
        <div className="max-w-2xl">
          <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
            {t("assets.eyebrow")}
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
            {t("assets.title")}
          </h2>
          <p className="mt-3 text-base leading-7 text-muted-2">
            {t("assets.body")}
          </p>
        </div>

        <div className="mt-10 grid gap-4 md:grid-cols-2">
          {ASSETS.map((asset) => (
            <article
              key={asset.key}
              className="flex flex-col overflow-hidden rounded-3xl border border-border-base bg-surface shadow-sm"
            >
              <div
                className={`grid aspect-[16/10] place-items-center p-8 ${PREVIEW_BACKGROUND[asset.mode]}`}
              >
                <div className="relative h-28 w-full">
                  <Image
                    src={asset.preview}
                    alt={t(`assets.items.${asset.key}.alt`)}
                    fill
                    className="object-contain"
                  />
                </div>
              </div>
              <div className="flex flex-1 flex-col gap-4 p-5">
                <div>
                  <p className="mb-2 font-mono text-[10px] tracking-[0.18em] text-brand uppercase">
                    {t(`assets.modes.${asset.mode}`)}
                  </p>
                  <h3 className="text-base font-semibold text-foreground">
                    {t(`assets.items.${asset.key}.title`)}
                  </h3>
                  <p className="mt-1.5 text-sm leading-6 text-muted-2">
                    {t(`assets.items.${asset.key}.description`)}
                  </p>
                </div>
                <div className="mt-auto flex flex-wrap gap-2">
                  {asset.downloads.map((download) => (
                    <a
                      key={download.href}
                      href={download.href}
                      download
                      className="inline-flex h-9 items-center gap-2 rounded-full border border-border-base bg-background px-3 text-sm font-medium text-brand transition hover:border-brand/40 hover:bg-brand-tint dark:hover:bg-brand-tint-dark"
                    >
                      <Download className="size-4" />
                      {t(`assets.formats.${download.format}`)}
                    </a>
                  ))}
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-[1440px] gap-6 px-5 py-14 md:grid-cols-[0.85fr_1.15fr] md:px-8 md:py-20">
        <div>
          <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
            {t("usage.eyebrow")}
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
            {t("usage.title")}
          </h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {(["do", "dont"] as const).map((group) => (
            <div
              key={group}
              className="rounded-3xl border border-border-base bg-surface p-6"
            >
              <h3 className="text-base font-semibold text-foreground">
                {t(`usage.${group}.title`)}
              </h3>
              <ul className="mt-4 space-y-3 text-sm leading-6 text-muted-2">
                {(["item1", "item2", "item3"] as const).map((item) => (
                  <li key={item}>{t(`usage.${group}.${item}`)}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1440px] px-5 py-14 md:px-8 md:py-20">
        <div className="grid gap-6 rounded-[2rem] border border-border-base bg-surface p-6 md:grid-cols-[0.8fr_1.2fr] md:p-8">
          <div>
            <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
              {t("system.eyebrow")}
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
              {t("system.title")}
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted-2">
              {t("system.body")}
            </p>
          </div>

          <div className="grid gap-5">
            <div className="grid gap-3 sm:grid-cols-2">
              {COLORS.map((color) => (
                <div
                  key={color.key}
                  className="flex items-center gap-3 rounded-2xl border border-border-base bg-background p-3"
                >
                  <span
                    className={`size-11 rounded-xl ring-1 ring-black/10 ${color.className}`}
                  />
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {t(`system.colors.${color.key}`)}
                    </p>
                    <p className="font-mono text-xs text-muted-3">
                      {color.value}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            <div className="rounded-2xl border border-border-base bg-background p-5">
              <p className="text-sm font-medium text-foreground">
                {t("system.type.title")}
              </p>
              <p className="mt-3 text-4xl font-semibold tracking-tight text-foreground">
                Geist
              </p>
              <p className="mt-2 font-mono text-sm text-muted-3">Geist Mono</p>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
