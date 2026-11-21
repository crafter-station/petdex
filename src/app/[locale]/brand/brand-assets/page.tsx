import Image from "next/image";

import { Download, ExternalLink } from "lucide-react";
import { getTranslations } from "next-intl/server";

import {
  BRAND_ASSETS,
  BRAND_JSON_LD,
  BRAND_PREVIEW_BACKGROUND,
  BRAND_SITE_URL,
  PETDEX_BADGE_MARKDOWN_SNIPPET,
  PETDEX_MARK_SVG_SNIPPET,
  PETDEX_TACTILE_IMG_SNIPPET,
} from "@/lib/brand-kit";
import { buildLocaleAlternates } from "@/lib/locale-routing";

import { BrandSubnav } from "@/components/brand/brand-subnav";
import { PetdexTactileMark } from "@/components/brand/petdex-tactile-mark";
import { ToySnippetTabs } from "@/components/brand/toy-snippet-tabs";
import { ToySurfaceSwitcher } from "@/components/brand/toy-surface-switcher";
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

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({
    locale,
    namespace: "brand.brandAssets.metadata",
  });

  return {
    title: t("title"),
    description: t("description"),
    alternates: buildLocaleAlternates(
      "/brand/brand-assets",
      hasLocale(locale) ? locale : undefined,
    ),
    openGraph: {
      title: t("ogTitle"),
      description: t("description"),
      url: `${BRAND_SITE_URL}/brand/brand-assets`,
      type: "website",
    },
  };
}

export default async function BrandAssetsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const localeValue = hasLocale(locale) ? locale : "en";
  const t = await getTranslations("brand");

  const logoAssets = BRAND_ASSETS.filter((asset) => asset.category === "logos");
  const iconAssets = BRAND_ASSETS.filter((asset) => asset.category === "icons");

  return (
    <main className="min-h-dvh bg-background text-foreground" style={BODY}>
      <JsonLd data={BRAND_JSON_LD} />
      <SiteHeader />

      <section className="petdex-hero relative -mt-14 overflow-clip pt-14">
        <div className="mx-auto grid w-full max-w-[1440px] gap-10 px-5 pt-14 pb-12 md:grid-cols-[1fr_0.9fr] md:px-8 md:pt-20">
          <div>
            <BrandSubnav
              locale={localeValue}
              active="brandAssets"
              labels={{
                overview: t("nav.overview"),
                logoSystem: t("nav.logoSystem"),
                brandAssets: t("nav.brandAssets"),
              }}
            />
            <p className="toy-tag mt-6 inline-block rounded-full bg-toy-volt px-2.5 py-1 text-[#101944] shadow-[0_2px_0_#C9A91F]">
              {t("brandAssets.eyebrow")}
            </p>
            <h1
              className="mt-4 max-w-3xl text-balance text-4xl leading-[0.98] font-extrabold tracking-[-0.045em] md:text-6xl"
              style={DISPLAY}
            >
              {t("brandAssets.title")}
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-muted-1 md:text-lg">
              {t("brandAssets.body")}
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
          <ToySurfaceSwitcher
            ariaLabel={t("brandAssets.surface.label")}
            labels={{
              pearl: t("brandAssets.surface.pearl"),
              navy: t("brandAssets.surface.navy"),
              checker: t("brandAssets.surface.checker"),
            }}
          >
            <PetdexTactileMark className="size-40 md:size-48" />
          </ToySurfaceSwitcher>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1440px] px-5 py-12 md:px-8 md:py-16">
        <h2
          className="text-2xl font-extrabold tracking-[-0.04em] md:text-3xl"
          style={DISPLAY}
        >
          {t("brandAssets.groups.logos")}
        </h2>
        <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {logoAssets.map((asset) => (
            <article
              key={asset.key}
              className="toy-shell flex flex-col overflow-hidden p-3"
            >
              <div
                className={`grid aspect-[16/10] place-items-center rounded-[1.25rem] p-8 shadow-[inset_0_3px_10px_rgba(16,25,68,0.15)] ${BRAND_PREVIEW_BACKGROUND[asset.mode]}`}
              >
                <div className="relative h-24 w-full">
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
                  <p className="toy-tag mb-2 text-toy-cobalt">
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
                      className="toy-btn toy-btn-pearl h-9 px-3 text-sm"
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

      <section className="mx-auto w-full max-w-[1440px] px-5 py-8 md:px-8 md:py-12">
        <h2
          className="text-2xl font-extrabold tracking-[-0.04em] md:text-3xl"
          style={DISPLAY}
        >
          {t("brandAssets.groups.icons")}
        </h2>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {iconAssets.map((asset) => (
            <article
              key={asset.key}
              className="toy-shell flex flex-col overflow-hidden p-3"
            >
              <div
                className={`grid aspect-[16/10] place-items-center rounded-[1.25rem] p-8 shadow-[inset_0_3px_10px_rgba(16,25,68,0.15)] ${BRAND_PREVIEW_BACKGROUND[asset.mode]}`}
              >
                <div className="relative h-24 w-full">
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
                  <p className="toy-tag mb-2 text-toy-cobalt">
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
                      className="toy-btn toy-btn-pearl h-9 px-3 text-sm"
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

      <section className="mx-auto w-full max-w-[1440px] px-5 pt-8 pb-20 md:px-8">
        <h2
          className="mb-6 text-2xl font-extrabold tracking-[-0.04em] md:text-3xl"
          style={DISPLAY}
        >
          {t("brandAssets.snippets.tabsLabel")}
        </h2>
        <ToySnippetTabs
          copyLabel={t("actions.copy")}
          copiedLabel={t("actions.copied")}
          snippets={[
            {
              id: "img",
              label: t("brandAssets.snippets.imgTitle"),
              code: PETDEX_TACTILE_IMG_SNIPPET,
            },
            {
              id: "svg",
              label: t("brandAssets.snippets.svgTitle"),
              code: PETDEX_MARK_SVG_SNIPPET,
            },
            {
              id: "badge",
              label: t("brandAssets.snippets.badgeTitle"),
              code: PETDEX_BADGE_MARKDOWN_SNIPPET,
            },
          ]}
        />
      </section>

      <SiteFooter />
    </main>
  );
}
