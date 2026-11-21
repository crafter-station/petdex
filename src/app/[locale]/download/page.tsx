import Link from "next/link";

import { ArrowRight, MonitorSmartphone, Pointer, Zap } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { BRAND_JSON_LD } from "@/lib/brand-kit";
import { buildLocaleAlternates } from "@/lib/locale-routing";

import { DownloadHero } from "@/components/download/download-hero";
import { JsonLd } from "@/components/layout/json-ld";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import { hasLocale } from "@/i18n/config";

const SITE_URL = "https://petdex.dev";
const _DEFAULT_PREVIEW_PET_SLUG = "boba";
const _DEFAULT_PREVIEW_PET = {
  spritesheetPath: "https://assets.petdex.dev/curated/boba/spritesheet.webp",
};

// Auto-detected /download/opengraph-image is locale-prefixed
// (/en/download/opengraph-image) and next-intl rewrites that with a
// 307. Most social scrapers (Discord, X) do not follow OG redirects
// and silently fall back to the parent layout's image, so unfurls
// would show the generic Petdex card instead of the desktop hero.
// Pin the URL to the locale-stripped path the same way per-collection
// metadata does.
const OG_IMAGE = `${SITE_URL}/download/opengraph-image`;

// Public page now (admin gate lifted on 2026-05-10 alongside the
// petdex:// URL scheme + 9-state bubble UI launch). Index + follow
// so the desktop landing surfaces in search.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return {
    title: "Download Petdex Desktop",
    description:
      "Download Petdex Desktop for macOS, Windows, and Linux. Your animated pet, floating beside every coding agent. Built by Railly Hugo at Crafter Station.",
    alternates: buildLocaleAlternates(
      "/download",
      hasLocale(locale) ? locale : undefined,
    ),
    openGraph: {
      title: "Petdex Desktop",
      description:
        "Your animated pet, floating beside every coding agent on macOS, Windows, and Linux.",
      url: `${SITE_URL}/download`,
      images: [{ url: OG_IMAGE, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Petdex Desktop",
      description:
        "Your animated pet, floating beside every coding agent on macOS, Windows, and Linux.",
      images: [OG_IMAGE],
    },
  };
}

export const dynamic = "force-static";
export const revalidate = 3600;

export default async function DownloadPage() {
  const t = await getTranslations("download");
  const locale = await getLocale();

  const features = [
    {
      icon: Zap,
      title: t("features.crossAgent.title"),
      description: t("features.crossAgent.description"),
    },
    {
      icon: MonitorSmartphone,
      title: t("features.alwaysWithYou.title"),
      description: t("features.alwaysWithYou.description"),
    },
    {
      icon: Pointer,
      title: t("features.pickYourFighter.title"),
      description: t("features.pickYourFighter.description"),
    },
  ];

  const softwareJsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      ...BRAND_JSON_LD["@graph"],
      {
        "@type": "SoftwareApplication",
        "@id": `${SITE_URL}/download#app`,
        name: "Petdex Desktop",
        applicationCategory: "DeveloperApplication",
        operatingSystem: "macOS, Windows, Linux",
        url: `${SITE_URL}/download`,
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "USD",
        },
        author: { "@id": "https://railly.dev/#person" },
        publisher: { "@id": "https://crafter.run/#organization" },
      },
    ],
  };

  return (
    <main className="relative min-h-dvh bg-background text-foreground">
      <JsonLd data={softwareJsonLd} />
      <SiteHeader />

      <DownloadHero />

      <section
        id="what-it-does"
        className="mx-auto w-full max-w-[1440px] px-5 py-16 md:px-8"
      >
        <div className="text-center">
          <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
            {t("features.eyebrow")}
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
            {t("features.title")}
          </h2>
        </div>

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {features.map((feature) => {
            const Icon = feature.icon;
            return (
              <div
                key={feature.title}
                className="toy-shell flex flex-col gap-4 rounded-3xl p-6"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-tint text-brand ring-1 ring-brand/15 dark:bg-brand-tint-dark dark:ring-brand/25">
                  <Icon className="size-5" />
                </span>
                <div>
                  <h3 className="text-base font-semibold text-foreground">
                    {feature.title}
                  </h3>
                  <p className="mt-1.5 text-sm leading-6 text-muted-2">
                    {feature.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>
      <section className="mx-auto w-full max-w-[1440px] px-5 py-10 md:px-8">
        <div className="mx-auto max-w-2xl">
          <Link
            href={`/${locale}/docs`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-brand transition hover:text-brand-deep"
          >
            {t("docsLink")}
            <ArrowRight className="size-4" />
          </Link>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
