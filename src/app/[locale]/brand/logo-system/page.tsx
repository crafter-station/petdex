import Image from "next/image";

import { getTranslations } from "next-intl/server";

import { BRAND_JSON_LD, BRAND_SITE_URL, LOGO_GEOMETRY } from "@/lib/brand-kit";
import { buildLocaleAlternates } from "@/lib/locale-routing";

import { BrandSubnav } from "@/components/brand/brand-subnav";
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
const CJK = { fontFamily: "var(--font-cjk), sans-serif" };

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({
    locale,
    namespace: "brand.logoSystem.metadata",
  });

  return {
    title: t("title"),
    description: t("description"),
    alternates: buildLocaleAlternates(
      "/brand/logo-system",
      hasLocale(locale) ? locale : undefined,
    ),
    openGraph: {
      title: t("ogTitle"),
      description: t("description"),
      url: `${BRAND_SITE_URL}/brand/logo-system`,
      type: "website",
    },
  };
}

export default async function BrandLogoSystemPage({
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
        <div className="mx-auto w-full max-w-[1440px] px-5 pt-14 pb-12 md:px-8 md:pt-20">
          <BrandSubnav
            locale={localeValue}
            active="logoSystem"
            labels={{
              overview: t("nav.overview"),
              logoSystem: t("nav.logoSystem"),
              brandAssets: t("nav.brandAssets"),
            }}
          />
          <p className="toy-tag mt-6 inline-block rounded-full bg-toy-volt px-2.5 py-1 text-[#101944] shadow-[0_2px_0_#C9A91F]">
            {t("logoSystem.eyebrow")}
          </p>
          <h1
            className="mt-4 max-w-3xl text-balance text-4xl leading-[0.98] font-extrabold tracking-[-0.045em] md:text-6xl"
            style={DISPLAY}
          >
            {t("logoSystem.title")}
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-muted-1 md:text-lg">
            {t("logoSystem.body")}
          </p>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1440px] px-5 py-12 md:px-8 md:py-16">
        <div className="toy-shell grid gap-6 p-6 lg:grid-cols-[1.1fr_0.9fr] md:p-8">
          <div className="toy-screen grid place-items-center p-8">
            <div
              role="img"
              aria-label={t("logoSystem.anatomy.diagramAlt")}
              className="relative size-64 md:size-80"
            >
              <div className="absolute -inset-6 rounded-[2.5rem] border border-dashed border-white/30" />
              <PetdexTactileMark className="absolute inset-0 size-full" />
              <svg
                aria-hidden="true"
                viewBox="0 0 128 128"
                className="pointer-events-none absolute inset-0 size-full"
              >
                <g stroke="#9BB2FF" strokeOpacity="0.4" strokeWidth="0.5">
                  {[32, 44, 56, 72, 84, 96].map((x) => (
                    <line key={`v${x}`} x1={x} y1="8" x2={x} y2="120" />
                  ))}
                  {[40, 52, 76, 88].map((y) => (
                    <line key={`h${y}`} x1="8" y1={y} x2="120" y2={y} />
                  ))}
                </g>
              </svg>
            </div>
          </div>

          <div className="flex flex-col justify-center gap-4">
            <p className="toy-tag text-toy-cobalt">
              {t("logoSystem.anatomy.eyebrow")}
            </p>
            <h2
              className="text-2xl font-extrabold tracking-[-0.04em] md:text-3xl"
              style={DISPLAY}
            >
              {t("logoSystem.anatomy.title")}
            </h2>
            <p className="text-sm leading-6 text-muted-2">
              {t("logoSystem.anatomy.body")}
            </p>
            <dl className="mt-2 grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-background p-4 shadow-[inset_0_-3px_0_var(--shell-pearl-edge)]">
                <dt className="toy-tag text-muted-3">
                  {t("logoSystem.anatomy.metrics.viewBox")}
                </dt>
                <dd className="mt-1 font-mono text-lg font-semibold">
                  {LOGO_GEOMETRY.viewBox} x {LOGO_GEOMETRY.viewBox}
                </dd>
              </div>
              <div className="rounded-2xl bg-background p-4 shadow-[inset_0_-3px_0_var(--shell-pearl-edge)]">
                <dt className="toy-tag text-muted-3">
                  {t("logoSystem.anatomy.metrics.pixelUnit")}
                </dt>
                <dd className="mt-1 font-mono text-lg font-semibold">
                  {LOGO_GEOMETRY.pixelUnit}px
                </dd>
              </div>
              <div className="rounded-2xl bg-background p-4 shadow-[inset_0_-3px_0_var(--shell-pearl-edge)]">
                <dt className="toy-tag text-muted-3">
                  {t("logoSystem.anatomy.metrics.cornerRadius")}
                </dt>
                <dd className="mt-1 font-mono text-lg font-semibold">
                  {LOGO_GEOMETRY.cornerRadius}px
                </dd>
              </div>
              <div className="rounded-2xl bg-background p-4 shadow-[inset_0_-3px_0_var(--shell-pearl-edge)]">
                <dt className="toy-tag text-muted-3">
                  {t("logoSystem.anatomy.metrics.clearspace")}
                </dt>
                <dd className="mt-1 font-mono text-lg font-semibold">
                  {LOGO_GEOMETRY.clearspaceRatio}x
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1440px] px-5 py-12 md:px-8 md:py-16">
        <div className="max-w-2xl">
          <p className="toy-tag text-toy-cobalt">
            {t("logoSystem.lockups.eyebrow")}
          </p>
          <h2
            className="mt-3 text-3xl font-extrabold tracking-[-0.04em] md:text-4xl"
            style={DISPLAY}
          >
            {t("logoSystem.lockups.title")}
          </h2>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-2">
          <div className="toy-shell p-8 text-toy-ink">
            <p className="toy-tag text-toy-cobalt">
              {t("logoSystem.lockups.primaryLight")}
            </p>
            <div className="mt-6 flex h-24 items-center justify-center">
              <Image
                src="/brand/petdex-wordmark.svg"
                alt="Petdex wordmark light"
                width={220}
                height={64}
                className="h-14 w-auto object-contain"
              />
            </div>
          </div>

          <div className="rounded-[2rem] bg-[#101944] p-8 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.1),inset_0_-6px_0_#070b22]">
            <p className="toy-tag text-[#9BB2FF]">
              {t("logoSystem.lockups.primaryDark")}
            </p>
            <div className="mt-6 flex h-24 items-center justify-center">
              <Image
                src="/brand/petdex-wordmark-dark.svg"
                alt="Petdex wordmark dark"
                width={220}
                height={64}
                className="h-14 w-auto object-contain"
              />
            </div>
          </div>

          <div className="toy-shell p-8 text-toy-ink">
            <p className="toy-tag text-toy-cobalt">
              {t("logoSystem.lockups.mono")}
            </p>
            <div className="mt-6 flex h-24 items-center justify-center gap-8">
              <Image
                src="/brand/petdex-mark-mono-light.svg"
                alt="Petdex monochrome mark"
                width={56}
                height={56}
              />
              <div className="rounded-2xl bg-[#12141f] p-3">
                <Image
                  src="/brand/petdex-mark-mono-dark.svg"
                  alt="Petdex inverted monochrome mark"
                  width={48}
                  height={48}
                />
              </div>
            </div>
          </div>

          <div className="toy-shell p-8">
            <p className="toy-tag text-toy-cobalt">
              {t("logoSystem.lockups.cobrand")}
            </p>
            <div className="mt-6 flex h-24 items-center justify-center gap-3">
              <PetdexTactileMark className="size-10" />
              <span
                className="text-xl font-bold tracking-[-0.03em] text-foreground"
                style={DISPLAY}
              >
                Petdex
              </span>
              <span className="text-muted-3">/</span>
              <span className="font-mono text-xs tracking-[0.16em] text-muted-2 uppercase">
                Crafter Station
              </span>
            </div>
          </div>

          <div className="toy-shell p-8 md:col-span-2">
            <p className="toy-tag text-toy-cobalt">
              {t("logoSystem.lockups.bilingual")}
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-4">
              <PetdexTactileMark className="size-16" />
              <span
                className="text-4xl font-extrabold tracking-[-0.04em] text-foreground md:text-5xl"
                style={DISPLAY}
              >
                Petdex
              </span>
              <span className="text-3xl text-toy-sakura" aria-hidden="true">
                ·
              </span>
              <span
                lang="zh-CN"
                className="text-3xl font-bold text-foreground md:text-4xl"
                style={CJK}
              >
                宠物图鉴
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1440px] px-5 py-12 md:px-8 md:py-16">
        <div className="toy-shell p-6 md:p-8">
          <p className="toy-tag text-toy-cobalt">
            {t("logoSystem.scale.eyebrow")}
          </p>
          <h2
            className="mt-3 text-2xl font-extrabold tracking-[-0.04em] md:text-3xl"
            style={DISPLAY}
          >
            {t("logoSystem.scale.title")}
          </h2>
          <div className="mt-8 flex flex-wrap items-end gap-8">
            {LOGO_GEOMETRY.minimumSizesPx.map((size) => (
              <div key={size} className="flex flex-col items-center gap-3">
                <div className="grid size-24 place-items-center rounded-2xl bg-background shadow-[inset_0_-3px_0_var(--shell-pearl-edge)]">
                  <PetdexTactileMark size={size} className="" />
                </div>
                <span className="toy-tag text-muted-3">{size}px</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-[1440px] gap-6 px-5 pt-6 pb-20 md:grid-cols-[0.85fr_1.15fr] md:px-8">
        <div>
          <p className="toy-tag text-toy-cobalt">{t("usage.eyebrow")}</p>
          <h2
            className="mt-3 text-3xl font-extrabold tracking-[-0.04em] md:text-4xl"
            style={DISPLAY}
          >
            {t("usage.title")}
          </h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {(["do", "dont"] as const).map((group) => (
            <div key={group} className="toy-shell p-6">
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

      <SiteFooter />
    </main>
  );
}
