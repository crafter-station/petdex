import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { notFound } from "next/navigation";

import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { NextIntlClientProvider } from "next-intl";
import {
  getMessages,
  getTranslations,
  setRequestLocale,
} from "next-intl/server";

import { AnnouncementQueue } from "@/components/announcement-queue";
import { BuildVersionWatcher } from "@/components/build-version-watcher";
import { FeedbackWidget } from "@/components/feedback-widget";
import { HeaderStateProvider } from "@/components/header-state-provider";
import { ProfileAnnouncementModal } from "@/components/profile-announcement-modal";
import { AppProviders } from "@/components/theme-providers";
import { TopPromoStrip } from "@/components/zh/top-promo-strip";
import { ZhLayoutSpacer } from "@/components/zh/zh-layout-spacer";

import { hasLocale, locales } from "@/i18n/config";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

type Props = {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
};

const SITE_URL = "https://petdex.crafter.run";

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(locale)) {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: "metadata.root" });

  // og:image points to /api/og which streams og.png by default and
  // og-wechat.png (1:1) when the crawler UA contains MicroMessenger.
  // Doing the UA check inside that route keeps this layout fully
  // statically renderable and preserves ISR for the whole [locale] tree.
  return {
    title: {
      default: t("titleDefault"),
      template: t("titleTemplate"),
    },
    description: t("description"),
    keywords: [
      t("keywords.codexPet"),
      t("keywords.codexCliPet"),
      t("keywords.openaiCodexPets"),
      t("keywords.pixelPet"),
      t("keywords.animatedPet"),
      t("keywords.developerMascot"),
      t("keywords.terminalPet"),
      t("keywords.codexCompanion"),
      t("keywords.petdex"),
    ],
    openGraph: {
      title: t("ogTitle"),
      description: t("description"),
      url: SITE_URL,
      siteName: "Petdex",
      type: "website",
      images: [
        { url: `${SITE_URL}/api/og`, width: 1200, height: 630, alt: "Petdex" },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: t("twitterTitle"),
      description: t("description"),
      images: ["/og-twitter.png"],
      creator: "@raillyhugo",
    },
  };
}

export default async function LocaleLayout({ children, params }: Props) {
  const { locale } = await params;

  if (!hasLocale(locale)) {
    notFound();
  }

  setRequestLocale(locale);
  const messages = await getMessages();

  const isZh = locale === "zh";

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <NextIntlClientProvider messages={messages}>
          <AppProviders>
            {isZh && <TopPromoStrip />}
            <HeaderStateProvider>
              {isZh ? <ZhLayoutSpacer>{children}</ZhLayoutSpacer> : children}
              <FeedbackWidget />
              <AnnouncementQueue />
              <ProfileAnnouncementModal />
              <BuildVersionWatcher />
              <Analytics />
              <SpeedInsights />
            </HeaderStateProvider>
          </AppProviders>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
