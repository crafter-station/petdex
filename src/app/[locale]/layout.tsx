import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { notFound } from "next/navigation";

import { NextIntlClientProvider } from "next-intl";
import {
  getMessages,
  getTranslations,
  setRequestLocale,
} from "next-intl/server";

import { AuthFeedbackWidget } from "@/components/auth/auth-feedback-widget";
import { ConditionalAuthProviders } from "@/components/layout/conditional-auth-providers";
import { AppProviders } from "@/components/layout/theme-providers";
import { TopPromoStrip } from "@/components/zh/top-promo-strip";
import { ZhLayoutSpacer } from "@/components/zh/zh-layout-spacer";

import { pickClientMessages } from "@/i18n/client-messages";
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

const SITE_URL = "https://petdex.dev";

// og:locale uses underscore language_TERRITORY and zh needs the territory to
// read as Simplified Chinese; mirrors the hreflang codes in locale-routing.
const LOCALE_OG: Record<string, string> = {
  en: "en_US",
  es: "es_ES",
  zh: "zh_CN",
};

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
      t("keywords.chatgptPet"),
      t("keywords.chatgptDesktopPets"),
      t("keywords.codingAgentPet"),
      t("keywords.claudeCodePet"),
      t("keywords.geminiCliPet"),
      t("keywords.openCodePet"),
      t("keywords.aiCodingMascot"),
      t("keywords.petdex"),
    ],
    openGraph: {
      title: t("ogTitle"),
      description: t("description"),
      // OG-only scrapers (WeChat, Slack) never read hreflang, so the locale
      // has to ride the OG tags themselves.
      locale: LOCALE_OG[locale] ?? "en_US",
      alternateLocale: ["en_US", "es_ES", "zh_CN"].filter(
        (l) => l !== (LOCALE_OG[locale] ?? "en_US"),
      ),
      // No `url` here: this layout is the metadata *base* for every route
      // under it, and a hardcoded `SITE_URL` overrode each page's own og:url
      // (a /zh page shared as the site root). Next omits og:url when unset,
      // so scrapers fall back to the real page URL; pages that can set their
      // locale-prefixed URL do so individually.
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
  const clientMessages = pickClientMessages(messages);
  const t = await getTranslations({ locale, namespace: "common" });

  const isZh = locale === "zh";

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {/* First focusable element on the page: the header is tall and every
            route repeats it, so keyboard users otherwise Tab through the whole
            nav to reach the content. Every page's <main> carries id="main". */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-[200] focus:rounded-full focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:ring-2 focus:ring-brand focus:outline-none"
        >
          {t("skipToContent")}
        </a>
        <NextIntlClientProvider messages={clientMessages}>
          <AppProviders>
            <ConditionalAuthProviders>
              {isZh && <TopPromoStrip />}
              {isZh ? <ZhLayoutSpacer>{children}</ZhLayoutSpacer> : children}
              <AuthFeedbackWidget />
            </ConditionalAuthProviders>
          </AppProviders>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
