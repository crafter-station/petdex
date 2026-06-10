import Link from "next/link";
import { notFound } from "next/navigation";

import { auth } from "@clerk/nextjs/server";
import { getTranslations } from "next-intl/server";

import { getOwnedAdCampaignForEditing } from "@/lib/ads/queries";
import { buildLocaleAlternates, withLocale } from "@/lib/locale-routing";

import { AdCampaignEditor } from "@/components/ads/ad-campaign-editor";
import { FullAuthProviders } from "@/components/auth-providers";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import type { Locale } from "@/i18n/config";
import { hasLocale } from "@/i18n/config";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; campaignId: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({
    locale,
    namespace: "advertise.dashboard.edit.metadata",
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

export default async function EditAdCampaignPage({
  params,
}: {
  params: Promise<{ locale: string; campaignId: string }>;
}) {
  const { locale, campaignId } = await params;
  const { userId, redirectToSignIn } = await auth();
  const localeValue = locale as Locale;
  if (!userId) {
    return redirectToSignIn({
      returnBackUrl: withLocale(
        `/advertise/dashboard/${campaignId}/edit`,
        localeValue,
      ),
    });
  }

  const campaign = await getOwnedAdCampaignForEditing(campaignId, userId);
  if (!campaign) notFound();

  const t = await getTranslations("advertise.dashboard.edit");
  const dashboardHref = withLocale("/advertise/dashboard", localeValue);
  const editable = campaign.status !== "deleted" && !campaign.deletedAt;

  return (
    <FullAuthProviders>
      <main className="min-h-dvh bg-background text-foreground">
        <SiteHeader />
        <section className="petdex-cloud relative -mt-[84px] pt-[84px]">
          <div className="relative mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-5 pt-10 pb-16 md:px-8 md:pt-14 md:pb-20">
            <header className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
                  {campaign.companyName}
                </p>
                <h1 className="mt-3 max-w-4xl text-balance text-4xl font-semibold tracking-tight md:text-6xl">
                  {t("title")}
                </h1>
                <p className="mt-4 max-w-2xl text-base leading-7 text-muted-2">
                  {t("body")}
                </p>
              </div>
              <Link
                href={dashboardHref}
                className="inline-flex h-11 shrink-0 items-center justify-center rounded-full border border-border-base bg-surface/72 px-5 text-sm font-medium text-foreground backdrop-blur transition hover:border-border-strong"
              >
                {t("backToDashboard")}
              </Link>
            </header>

            {editable ? (
              <AdCampaignEditor
                campaign={campaign}
                dashboardHref={dashboardHref}
              />
            ) : (
              <section className="rounded-[2rem] border border-border-base bg-surface/82 p-8 shadow-xl shadow-blue-950/5 backdrop-blur">
                <h2 className="text-2xl font-semibold tracking-tight">
                  {t("notEditable.title")}
                </h2>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-2">
                  {campaign.removalReason ?? t("notEditable.body")}
                </p>
                <Link
                  href={dashboardHref}
                  className="mt-6 inline-flex h-11 items-center justify-center rounded-full bg-inverse px-5 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
                >
                  {t("backToDashboard")}
                </Link>
              </section>
            )}
          </div>
        </section>
        <SiteFooter />
      </main>
    </FullAuthProviders>
  );
}
