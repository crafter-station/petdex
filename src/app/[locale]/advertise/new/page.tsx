import Link from "next/link";

import { auth } from "@clerk/nextjs/server";
import { getTranslations } from "next-intl/server";

import { buildLocaleAlternates, withLocale } from "@/lib/locale-routing";

import { AdvertiseForm } from "@/components/ads/advertise-form";
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
    namespace: "advertise.create.metadata",
  });

  return {
    title: t("title"),
    description: t("description"),
    alternates: buildLocaleAlternates(
      "/advertise/new",
      hasLocale(locale) ? locale : undefined,
    ),
    robots: { index: false, follow: false },
  };
}

export default async function NewAdvertisePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { locale } = await params;
  const { checkout } = await searchParams;
  const t = await getTranslations("advertise");
  const localeValue = locale as Locale;
  const { userId, redirectToSignIn } = await auth();
  if (!userId) {
    return redirectToSignIn({
      returnBackUrl: withLocale("/advertise/new", localeValue),
    });
  }

  return (
    <FullAuthProviders>
      <main className="min-h-dvh bg-background text-foreground">
        <SiteHeader />
        <section className="petdex-cloud relative -mt-[84px] pt-[84px]">
          <div className="relative mx-auto flex w-full max-w-[1440px] flex-col gap-8 px-5 pt-10 pb-16 md:px-8 md:pt-14 md:pb-20">
            <header className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
                  {t("create.eyebrow")}
                </p>
                <h1 className="mt-3 max-w-4xl text-balance text-4xl font-semibold tracking-tight md:text-6xl">
                  {t("create.title")}
                </h1>
                <p className="mt-4 max-w-2xl text-base leading-7 text-muted-2">
                  {t("create.body")}
                </p>
              </div>
              <Link
                href={withLocale("/advertise", localeValue)}
                className="inline-flex h-11 shrink-0 items-center justify-center rounded-full border border-border-base bg-surface/72 px-5 text-sm font-medium text-foreground backdrop-blur transition hover:border-border-strong"
              >
                {t("create.backToLanding")}
              </Link>
            </header>

            {checkout === "cancelled" ? (
              <div className="rounded-2xl bg-chip-warning-bg p-4 text-sm leading-6 text-chip-warning-fg">
                <p className="font-semibold">{t("checkout.cancelTitle")}</p>
                <p className="mt-1">{t("checkout.cancelBody")}</p>
              </div>
            ) : null}

            <div className="grid gap-5 lg:grid-cols-[1fr_280px] lg:items-start">
              <AdvertiseForm />
              <aside className="grid gap-3 lg:sticky lg:top-24">
                <HelperCard title={t("create.help.creative.title")}>
                  {t("create.help.creative.body")}
                </HelperCard>
                <HelperCard title={t("create.help.review.title")}>
                  {t("create.help.review.body")}
                </HelperCard>
                <HelperCard title={t("create.help.billing.title")}>
                  {t("create.help.billing.body")}
                </HelperCard>
              </aside>
            </div>
          </div>
        </section>
        <SiteFooter />
      </main>
    </FullAuthProviders>
  );
}

function HelperCard({ title, children }: { title: string; children: string }) {
  return (
    <article className="rounded-3xl border border-border-base bg-surface/82 p-5 shadow-sm shadow-blue-950/5 backdrop-blur">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-muted-2">{children}</p>
    </article>
  );
}
