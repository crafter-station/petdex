import Link from "next/link";

import { auth } from "@clerk/nextjs/server";
import { getTranslations } from "next-intl/server";

import { getUserAdCampaigns } from "@/lib/ads/queries";
import { buildLocaleAlternates, withLocale } from "@/lib/locale-routing";

import { AdDashboard } from "@/components/ads/ad-dashboard";
import { FullAuthProviders } from "@/components/auth-providers";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import type { Locale } from "@/i18n/config";
import { hasLocale } from "@/i18n/config";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({
    locale,
    namespace: "advertise.dashboard.metadata",
  });

  return {
    title: t("title"),
    description: t("description"),
    alternates: buildLocaleAlternates(
      "/advertise/dashboard",
      hasLocale(locale) ? locale : undefined,
    ),
    robots: { index: false, follow: false },
  };
}

export default async function AdvertiseDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { locale } = await params;
  const { checkout } = await searchParams;
  const { userId, redirectToSignIn } = await auth();
  const localeValue = locale as Locale;
  if (!userId) {
    return redirectToSignIn({
      returnBackUrl: withLocale("/advertise/dashboard", localeValue),
    });
  }

  const t = await getTranslations("advertise.dashboard");
  const campaigns = await getUserAdCampaigns(userId);

  return (
    <FullAuthProviders>
      <main className="min-h-dvh bg-background text-foreground">
        <SiteHeader />
        <section className="petdex-cloud relative -mt-[84px] overflow-clip pt-[84px]">
          <div className="relative mx-auto flex w-full max-w-[1440px] flex-col gap-8 px-5 pb-12 md:px-8 md:pb-16">
            <header className="mt-8 flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
                  {t("eyebrow")}
                </p>
                <h1 className="mt-3 text-balance text-4xl font-semibold tracking-tight md:text-6xl">
                  {t("title")}
                </h1>
                <p className="mt-4 max-w-2xl text-base leading-7 text-muted-2">
                  {t("body")}
                </p>
              </div>
              <Link
                href={withLocale("/advertise/new", localeValue)}
                className="inline-flex h-11 shrink-0 items-center justify-center rounded-full bg-inverse px-5 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
              >
                {t("newCampaign")}
              </Link>
            </header>
            {checkout === "success" ? (
              <div className="rounded-2xl bg-chip-success-bg p-4 text-sm leading-6 text-chip-success-fg">
                <p className="font-semibold">{t("checkout.successTitle")}</p>
                <p className="mt-1">{t("checkout.successBody")}</p>
              </div>
            ) : null}
            <AdDashboard campaigns={campaigns} locale={localeValue} />
          </div>
        </section>
        <SiteFooter />
      </main>
    </FullAuthProviders>
  );
}
