import Link from "next/link";

import { getTranslations } from "next-intl/server";

import { AD_PACKAGES, formatUsd } from "@/lib/ads/packages";
import { buildLocaleAlternates } from "@/lib/locale-routing";

import { AdvertiseForm } from "@/components/ads/advertise-form";
import { JsonLd } from "@/components/json-ld";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

const SITE_URL = "https://petdex.crafter.run";
const PACKAGE_IDS = Object.keys(AD_PACKAGES) as Array<keyof typeof AD_PACKAGES>;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "advertise.metadata" });

  return {
    title: t("title"),
    description: t("description"),
    alternates: buildLocaleAlternates("/advertise"),
    openGraph: {
      title: t("title"),
      description: t("description"),
      url: `${SITE_URL}/advertise`,
      type: "website",
    },
  };
}

export default async function AdvertisePage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const t = await getTranslations("advertise");
  const { checkout } = await searchParams;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: t("metadata.title"),
    url: `${SITE_URL}/advertise`,
    description: t("metadata.description"),
    isPartOf: { "@type": "WebSite", "@id": `${SITE_URL}/#website` },
  };

  return (
    <main className="petdex-cloud relative min-h-dvh overflow-hidden bg-background text-foreground">
      <JsonLd data={jsonLd} />
      <section className="relative mx-auto flex w-full max-w-[1440px] flex-col px-5 pt-5 pb-12 md:px-8 md:pb-16">
        <SiteHeader />

        <div className="mt-12 grid gap-10 lg:grid-cols-[1fr_440px] lg:items-start">
          <div>
            <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
              {t("eyebrow")}
            </p>
            <h1 className="mt-4 max-w-4xl text-balance text-[42px] leading-[1] font-semibold tracking-tight md:text-[72px]">
              {t("hero.title")}
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-7 text-muted-1 md:text-lg">
              {t("hero.body")}
            </p>

            <div className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                t("heroCards.starting"),
                t("heroCards.impressions"),
                t("heroCards.native"),
                t("heroCards.audience"),
              ].map((item) => (
                <div
                  key={item}
                  className="rounded-2xl border border-border-base bg-surface/78 px-4 py-3 font-mono text-[11px] tracking-[0.16em] text-muted-2 uppercase shadow-sm shadow-blue-950/5 backdrop-blur"
                >
                  {item}
                </div>
              ))}
            </div>

            {checkout === "success" ? (
              <StatusCard tone="success" title={t("checkout.successTitle")}>
                <span>{t("checkout.successBody")}</span>
                <Link
                  href="/advertise/dashboard"
                  className="mt-3 inline-flex text-brand underline-offset-4 hover:underline"
                >
                  {t("checkout.dashboardCta")}
                </Link>
              </StatusCard>
            ) : checkout === "cancelled" ? (
              <StatusCard tone="warning" title={t("checkout.cancelTitle")}>
                {t("checkout.cancelBody")}
              </StatusCard>
            ) : null}

            <div className="mt-8 grid gap-3 sm:grid-cols-3">
              {PACKAGE_IDS.map((id) => {
                const pkg = AD_PACKAGES[id];
                return (
                  <div
                    key={id}
                    className="rounded-3xl border border-border-base bg-surface/80 p-5 shadow-sm shadow-blue-950/5 backdrop-blur"
                  >
                    <p className="text-3xl font-semibold tracking-tight">
                      {formatUsd(pkg.priceCents)}
                    </p>
                    <p className="mt-2 font-mono text-[11px] tracking-[0.18em] text-brand uppercase">
                      {pkg.label}
                    </p>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-sm leading-6 text-muted-2">
              {t("form.pricingTrust")}
            </p>
          </div>

          <AdvertiseForm />
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-[1440px] gap-5 px-5 pb-14 md:px-8 lg:grid-cols-3">
        <InfoCard title={t("sections.audience.title")}>
          {t("sections.audience.body")}
        </InfoCard>
        <InfoCard title={t("sections.placement.title")}>
          {t("sections.placement.body")}
        </InfoCard>
        <InfoCard title={t("sections.billing.title")}>
          {t("sections.billing.body")}
        </InfoCard>
      </section>

      <section className="mx-auto grid w-full max-w-[1440px] gap-5 px-5 pb-16 md:px-8 lg:grid-cols-2">
        <PolicyCard
          title={t("acceptableUse.title")}
          items={[
            t("acceptableUse.items.malware"),
            t("acceptableUse.items.adult"),
            t("acceptableUse.items.hate"),
            t("acceptableUse.items.illegal"),
            t("acceptableUse.items.impersonation"),
            t("acceptableUse.items.misleading"),
          ]}
        />
        <div className="rounded-3xl border border-border-base bg-surface/80 p-6 shadow-sm shadow-blue-950/5 backdrop-blur">
          <p className="font-mono text-[11px] tracking-[0.22em] text-brand uppercase">
            {t("legal.eyebrow")}
          </p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight">
            {t("legal.title")}
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted-2">
            {t("legal.body")}
          </p>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}

function InfoCard({ title, children }: { title: string; children: string }) {
  return (
    <article className="rounded-3xl border border-border-base bg-surface/80 p-6 shadow-sm shadow-blue-950/5 backdrop-blur">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-3 text-sm leading-6 text-muted-2">{children}</p>
    </article>
  );
}

function PolicyCard({ title, items }: { title: string; items: string[] }) {
  return (
    <article className="rounded-3xl border border-border-base bg-surface/80 p-6 shadow-sm shadow-blue-950/5 backdrop-blur">
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      <ul className="mt-4 space-y-3 text-sm leading-6 text-muted-2">
        {items.map((item) => (
          <li key={item} className="flex gap-2">
            <span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

function StatusCard({
  tone,
  title,
  children,
}: {
  tone: "success" | "warning";
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`mt-6 rounded-2xl p-4 text-sm leading-6 ${
        tone === "success"
          ? "bg-chip-success-bg text-chip-success-fg"
          : "bg-chip-warning-bg text-chip-warning-fg"
      }`}
    >
      <p className="font-semibold">{title}</p>
      <p className="mt-1">{children}</p>
    </div>
  );
}
