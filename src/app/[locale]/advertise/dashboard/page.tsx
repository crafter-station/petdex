import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@clerk/nextjs/server";
import { getTranslations } from "next-intl/server";

import { getUserAdCampaigns } from "@/lib/ads/queries";
import { buildLocaleAlternates } from "@/lib/locale-routing";

import { AdDashboard } from "@/components/ads/ad-dashboard";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

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
    alternates: buildLocaleAlternates("/advertise/dashboard"),
    robots: { index: false, follow: false },
  };
}

export default async function AdvertiseDashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const { userId } = await auth();
  if (!userId)
    redirect(locale === "en" ? "/advertise" : `/${locale}/advertise`);

  const t = await getTranslations("advertise.dashboard");
  const campaigns = await getUserAdCampaigns(userId);

  return (
    <main className="petdex-cloud relative min-h-dvh overflow-hidden bg-background text-foreground">
      <section className="relative mx-auto flex w-full max-w-[1440px] flex-col gap-8 px-5 pt-5 pb-12 md:px-8 md:pb-16">
        <SiteHeader />
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
            href="/advertise"
            className="inline-flex h-11 shrink-0 items-center justify-center rounded-full bg-inverse px-5 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
          >
            {t("newCampaign")}
          </Link>
        </header>
        <AdDashboard campaigns={campaigns} />
      </section>
      <SiteFooter />
    </main>
  );
}
