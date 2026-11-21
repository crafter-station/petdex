import Link from "next/link";

import { ArrowRight, Download, ExternalLink } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { BRAND_COLORS, BRAND_JSON_LD, BRAND_SITE_URL } from "@/lib/brand-kit";
import { buildLocaleAlternates, withLocale } from "@/lib/locale-routing";

import { BrandSubnav } from "@/components/brand/brand-subnav";
import { CopyTokenButton } from "@/components/brand/copy-token-button";
import { PetdexTactileMark } from "@/components/brand/petdex-tactile-mark";
import { JsonLd } from "@/components/layout/json-ld";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import { hasLocale } from "@/i18n/config";

export const revalidate = 3600;

const DISPLAY = {
  fontFamily: "var(--font-display), var(--font-cjk), sans-serif",
};
const BODY = {
  fontFamily: "var(--font-geist-sans), var(--font-cjk), sans-serif",
};
const PIXEL = { fontFamily: "var(--font-pixel), monospace" };
const CJK = { fontFamily: "var(--font-cjk), sans-serif" };

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
      url: `${BRAND_SITE_URL}/brand`,
      type: "website",
    },
  };
}

export default async function BrandPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const localeValue = hasLocale(locale) ? locale : "en";
  const t = await getTranslations("brand");

  return (
    <main className="min-h-dvh bg-background text-foreground" style={BODY}>
      <JsonLd data={BRAND_JSON_LD} />
      <SiteHeader />

      <section className="petdex-hero relative -mt-14 overflow-clip pt-14">
        <div className="mx-auto grid w-full max-w-[1440px] gap-10 px-5 pt-14 pb-16 md:grid-cols-[1fr_0.9fr] md:px-8 md:pt-24 md:pb-24">
          <div className="flex flex-col justify-center">
            <div className="mb-6">
              <BrandSubnav
                locale={localeValue}
                active="overview"
                labels={{
                  overview: t("nav.overview"),
                  logoSystem: t("nav.logoSystem"),
                  brandAssets: t("nav.brandAssets"),
                }}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="toy-tag rounded-full bg-toy-volt px-2.5 py-1 text-[#101944] shadow-[0_2px_0_#C9A91F]">
                {t("eyebrow")}
              </span>
              <span className="toy-tag rounded-full bg-toy-sakura px-2.5 py-1 text-white shadow-[0_2px_0_#C24C72]">
                {t("tags.new")}
              </span>
            </div>
            <h1
              className="mt-4 max-w-3xl text-balance text-[44px] leading-[0.94] font-extrabold tracking-[-0.045em] md:text-[76px]"
              style={DISPLAY}
            >
              {t("hero.title")}
            </h1>
            <p className="mt-5 max-w-2xl text-balance text-base leading-7 text-muted-1 md:text-lg">
              {t("hero.body")}
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <a
                href="/brand/petdex-tactile-mark.svg"
                download
                className="toy-btn toy-btn-cobalt h-12 px-5 text-sm"
              >
                <Download className="size-4" />
                {t("hero.tactileCta")}
              </a>
              <a
                href="/brand/petdex-mark.png"
                download
                className="toy-btn toy-btn-pearl h-12 px-5 text-sm"
              >
                {t("hero.primaryCtaPng")}
              </a>
              <a
                href="https://github.com/crafter-station/petdex/tree/main/public/brand"
                target="_blank"
                rel="noreferrer"
                className="toy-btn toy-btn-pearl h-12 px-5 text-sm"
              >
                {t("hero.secondaryCta")}
                <ExternalLink className="size-4" />
              </a>
            </div>
          </div>

          <div className="toy-shell relative p-5 md:p-7">
            <div className="flex items-center justify-between">
              <span className="toy-tag text-toy-ink/60" style={PIXEL}>
                PETDEX-01
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-toy-mint shadow-[0_0_8px_var(--toy-mint)]" />
                <span className="toy-tag text-toy-ink/60">POWER</span>
              </span>
            </div>
            <div className="toy-screen relative mt-4 grid min-h-[300px] place-items-center p-8">
              <PetdexTactileMark className="size-44 transition-transform duration-300 [transition-timing-function:var(--ease-bounce)] hover:-translate-y-1 hover:rotate-[-3deg] md:size-56" />
              <div className="absolute top-4 left-4 flex gap-1.5">
                {["#0042", t("tags.level")].map((tag) => (
                  <span
                    key={tag}
                    className="toy-tag rounded-md bg-white/10 px-2 py-1 text-white/80"
                  >
                    {tag}
                  </span>
                ))}
              </div>
              <span className="toy-tag absolute right-4 bottom-4 rounded-md bg-toy-volt px-2 py-1 text-[#101944]">
                {t("tags.collect")}
              </span>
            </div>
            <div className="mt-5 flex items-center justify-between">
              <div className="relative size-16" aria-hidden="true">
                <span className="absolute top-5 left-0 h-6 w-16 rounded-md bg-toy-navy shadow-[0_3px_0_#05081c]" />
                <span className="absolute top-0 left-5 h-16 w-6 rounded-md bg-toy-navy shadow-[0_3px_0_#05081c]" />
              </div>
              <div className="flex gap-3" aria-hidden="true">
                <span className="size-10 rounded-full bg-toy-sakura shadow-[inset_0_2px_0_rgba(255,255,255,0.45),0_5px_0_#C24C72]" />
                <span className="-translate-y-3 size-10 rounded-full bg-toy-cobalt shadow-[inset_0_2px_0_rgba(255,255,255,0.45),0_5px_0_#162472]" />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1440px] px-5 py-12 md:px-8 md:py-16">
        <div className="grid gap-4 md:grid-cols-2">
          <Link
            href={withLocale("/brand/logo-system", localeValue)}
            className="toy-shell group flex flex-col justify-between p-6 transition-transform duration-200 [transition-timing-function:var(--ease-bounce)] hover:-translate-y-1 md:p-8"
          >
            <div>
              <p className="toy-tag text-toy-cobalt">/brand/logo-system</p>
              <h2
                className="mt-3 text-2xl font-bold tracking-[-0.03em] text-foreground md:text-3xl"
                style={DISPLAY}
              >
                {t("hub.logoSystem.title")}
              </h2>
              <p className="mt-3 text-sm leading-6 text-muted-2">
                {t("hub.logoSystem.body")}
              </p>
            </div>
            <span className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-brand">
              {t("hub.logoSystem.cta")}
              <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
            </span>
          </Link>

          <Link
            href={withLocale("/brand/brand-assets", localeValue)}
            className="toy-shell group flex flex-col justify-between p-6 transition-transform duration-200 [transition-timing-function:var(--ease-bounce)] hover:-translate-y-1 md:p-8"
          >
            <div>
              <p className="toy-tag text-toy-cobalt">/brand/brand-assets</p>
              <h2
                className="mt-3 text-2xl font-bold tracking-[-0.03em] text-foreground md:text-3xl"
                style={DISPLAY}
              >
                {t("hub.brandAssets.title")}
              </h2>
              <p className="mt-3 text-sm leading-6 text-muted-2">
                {t("hub.brandAssets.body")}
              </p>
            </div>
            <span className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-brand">
              {t("hub.brandAssets.cta")}
              <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
            </span>
          </Link>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1440px] px-5 py-12 md:px-8 md:py-16">
        <div className="toy-shell grid gap-6 p-6 md:grid-cols-[0.8fr_1.2fr] md:p-8">
          <div>
            <p className="toy-tag text-toy-cobalt">{t("system.eyebrow")}</p>
            <h2
              className="mt-3 text-3xl font-extrabold tracking-[-0.04em] md:text-4xl"
              style={DISPLAY}
            >
              {t("system.title")}
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted-2">
              {t("system.body")}
            </p>
          </div>

          <div className="grid gap-5">
            <div className="grid gap-3 sm:grid-cols-2">
              {BRAND_COLORS.map((color) => (
                <div
                  key={color.key}
                  className="flex flex-col gap-3 rounded-2xl bg-background p-3.5 shadow-[inset_0_-3px_0_var(--shell-pearl-edge)]"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`size-11 shrink-0 rounded-xl shadow-[inset_0_2px_0_rgba(255,255,255,0.45),inset_0_-3px_0_rgba(0,0,0,0.15)] ring-1 ring-black/10 ${color.className}`}
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {t(`system.colors.${color.key}`)}
                      </p>
                      <p className="truncate font-mono text-xs text-muted-3">
                        {color.hex}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <CopyTokenButton
                      value={color.hex}
                      label="HEX"
                      copiedLabel={t("actions.copied")}
                    />
                    <CopyTokenButton
                      value={color.oklch}
                      label="OKLCH"
                      copiedLabel={t("actions.copied")}
                    />
                    <CopyTokenButton
                      value={color.cssVar}
                      label="CSS"
                      copiedLabel={t("actions.copied")}
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="rounded-2xl bg-background p-5 shadow-[inset_0_-3px_0_var(--shell-pearl-edge)]">
              <p className="toy-tag text-toy-ink/60">
                {t("system.type.title")}
              </p>
              <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <dt className="toy-tag text-muted-3">
                    {t("system.type.display")}
                  </dt>
                  <dd
                    className="mt-1 text-4xl font-extrabold tracking-[-0.04em]"
                    style={DISPLAY}
                  >
                    Bricolage
                  </dd>
                </div>
                <div>
                  <dt className="toy-tag text-muted-3">
                    {t("system.type.body")}
                  </dt>
                  <dd className="mt-1 text-2xl font-medium" style={BODY}>
                    Geist Sans
                  </dd>
                </div>
                <div>
                  <dt className="toy-tag text-muted-3">
                    {t("system.type.pixel")}
                  </dt>
                  <dd className="mt-1 text-xl" style={PIXEL}>
                    SELECT START
                  </dd>
                </div>
                <div>
                  <dt className="toy-tag text-muted-3">
                    {t("system.type.cjk")}
                  </dt>
                  <dd className="mt-1 text-2xl font-bold" style={CJK}>
                    宠物图鉴 Noto Sans SC
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1440px] px-5 pt-4 pb-16 md:px-8 md:pb-24">
        <div className="toy-shell flex flex-col items-start justify-between gap-4 px-6 py-6 sm:flex-row sm:items-center md:px-8">
          <div>
            <p className="toy-tag text-toy-cobalt">
              {t("attribution.eyebrow")}
            </p>
            <p className="mt-2 text-sm leading-6 text-muted-2">
              {t("attribution.body")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              href="https://crafter.run"
              target="_blank"
              rel="noreferrer"
              className="toy-btn toy-btn-pearl h-10 px-4 text-sm"
            >
              Crafter Station
              <ExternalLink className="size-3.5" />
            </a>
            <a
              href="https://github.com/Railly"
              target="_blank"
              rel="noreferrer"
              className="toy-btn toy-btn-pearl h-10 px-4 text-sm"
            >
              Railly Hugo
              <ExternalLink className="size-3.5" />
            </a>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
