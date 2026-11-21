import type { Metadata } from "next";
import {
  Bricolage_Grotesque,
  Geist,
  Geist_Mono,
  Noto_Sans_SC,
  Silkscreen,
} from "next/font/google";
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

const display = Bricolage_Grotesque({
  variable: "--font-display",
  subsets: ["latin"],
});

const pixel = Silkscreen({
  variable: "--font-pixel",
  weight: ["400", "700"],
  subsets: ["latin"],
});

const cjk = Noto_Sans_SC({
  variable: "--font-cjk",
  weight: ["400", "500", "700"],
  subsets: ["latin"],
  preload: false,
});

type Props = {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
};

const SITE_URL = "https://petdex.dev";

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
    metadataBase: new URL(SITE_URL),
    authors: [{ name: "Railly Hugo", url: "https://railly.dev" }],
    creator: "Railly Hugo",
    publisher: "Crafter Station",
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
  const clientMessages = pickClientMessages(messages);

  const isZh = locale === "zh";

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${display.variable} ${pixel.variable} ${cjk.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
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
