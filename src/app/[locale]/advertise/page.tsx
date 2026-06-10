import Link from "next/link";

import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  MousePointer2,
  ShieldCheck,
} from "lucide-react";
import { getTranslations } from "next-intl/server";

import { AD_PACKAGES, formatUsd } from "@/lib/ads/packages";
import { buildLocaleAlternates, withLocale } from "@/lib/locale-routing";

import { JsonLd } from "@/components/json-ld";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import type { Locale } from "@/i18n/config";
import { hasLocale } from "@/i18n/config";

const SITE_URL = "https://petdex.dev";
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
    alternates: buildLocaleAlternates(
      "/advertise",
      hasLocale(locale) ? locale : undefined,
    ),
    openGraph: {
      title: t("title"),
      description: t("description"),
      url: `${SITE_URL}/advertise`,
      type: "website",
    },
  };
}

export default async function AdvertisePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("advertise");
  const { checkout } = await searchParams;
  const localeValue = locale as Locale;
  const createHref = withLocale("/advertise/new", localeValue);
  const dashboardHref = withLocale("/advertise/dashboard", localeValue);
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: t("metadata.title"),
    url: `${SITE_URL}/advertise`,
    description: t("metadata.description"),
    isPartOf: { "@type": "WebSite", "@id": `${SITE_URL}/#website` },
  };

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <JsonLd data={jsonLd} />
      <SiteHeader />
      <section className="petdex-cloud relative -mt-[84px] overflow-clip pt-[84px]">
        <div className="relative mx-auto flex w-full max-w-[1440px] flex-col gap-12 px-5 pt-12 pb-16 md:px-8 md:pt-16 md:pb-20">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_460px] lg:items-center">
            <div>
              <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
                {t("eyebrow")}
              </p>
              <h1 className="mt-4 max-w-5xl text-balance text-[44px] leading-[0.98] font-semibold tracking-tight md:text-[78px]">
                {t("hero.title")}
              </h1>
              <p className="mt-6 max-w-3xl text-base leading-7 text-muted-1 md:text-lg">
                {t("hero.body")}
              </p>

              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  href={createHref}
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-inverse px-6 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
                >
                  {t("landing.primaryCta")}
                  <ArrowRight className="size-4" />
                </Link>
                <Link
                  href={dashboardHref}
                  className="inline-flex h-12 items-center justify-center rounded-full border border-border-base bg-surface/72 px-6 text-sm font-medium text-foreground backdrop-blur transition hover:border-border-strong"
                >
                  {t("landing.secondaryCta")}
                </Link>
              </div>

              {checkout === "success" ? (
                <StatusCard tone="success" title={t("checkout.successTitle")}>
                  <span>{t("checkout.successBody")}</span>
                  <Link
                    href={dashboardHref}
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
            </div>

            <HeroMockup />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <ValueCard
              icon={<MousePointer2 className="size-4" />}
              title={t("sections.audience.title")}
            >
              {t("sections.audience.body")}
            </ValueCard>
            <ValueCard
              icon={<CheckCircle2 className="size-4" />}
              title={t("sections.placement.title")}
            >
              {t("sections.placement.body")}
            </ValueCard>
            <ValueCard
              icon={<BarChart3 className="size-4" />}
              title={t("sections.billing.title")}
            >
              {t("sections.billing.body")}
            </ValueCard>
            <ValueCard
              icon={<ShieldCheck className="size-4" />}
              title={t("legal.title")}
            >
              {t("legal.body")}
            </ValueCard>
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-[1440px] gap-5 px-5 pb-14 md:px-8 lg:grid-cols-[0.8fr_1.2fr]">
        <div className="rounded-[2rem] border border-border-base bg-surface/82 p-6 shadow-sm shadow-blue-950/5 backdrop-blur md:p-8">
          <p className="font-mono text-[11px] tracking-[0.22em] text-brand uppercase">
            {t("landing.pricingEyebrow")}
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
            {t("landing.pricingTitle")}
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted-2">
            {t("form.pricingTrust")}
          </p>
          <Link
            href={createHref}
            className="mt-6 inline-flex h-11 items-center justify-center rounded-full bg-inverse px-5 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
          >
            {t("landing.primaryCta")}
          </Link>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {PACKAGE_IDS.map((id) => {
            const pkg = AD_PACKAGES[id];
            return (
              <article
                key={id}
                className="rounded-[2rem] border border-border-base bg-surface/80 p-5 shadow-sm shadow-blue-950/5 backdrop-blur"
              >
                <p className="text-4xl font-semibold tracking-tight">
                  {formatUsd(pkg.priceCents)}
                </p>
                <p className="mt-3 font-mono text-[11px] tracking-[0.18em] text-brand uppercase">
                  {pkg.label}
                </p>
              </article>
            );
          })}
        </div>
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
            {t("landing.finalTitle")}
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted-2">
            {t("landing.finalBody")}
          </p>
          <Link
            href={createHref}
            className="mt-5 inline-flex h-10 items-center justify-center rounded-full border border-border-base bg-background px-4 text-sm font-medium text-foreground transition hover:border-border-strong"
          >
            {t("landing.primaryCta")}
          </Link>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}

function HeroMockup() {
  return (
    <div className="rounded-[2rem] border border-border-base bg-surface/82 p-4 shadow-xl shadow-blue-950/10 backdrop-blur">
      <div className="rounded-[1.5rem] border border-border-base bg-background p-4">
        <div className="flex items-center justify-between border-border-base border-b pb-3">
          <span className="font-mono text-[10px] tracking-[0.22em] text-muted-3 uppercase">
            Sponsored
          </span>
          <span className="rounded-full bg-chip-success-bg px-2 py-0.5 font-mono text-[10px] tracking-[0.16em] text-chip-success-fg uppercase">
            Live
          </span>
        </div>
        <div className="mt-4 aspect-[4/3] rounded-2xl bg-brand-tint dark:bg-brand-tint-dark" />
        <div className="mt-4 space-y-2">
          <div className="h-4 w-2/3 rounded-full bg-foreground/80" />
          <div className="h-3 w-full rounded-full bg-muted-4/30" />
          <div className="h-3 w-4/5 rounded-full bg-muted-4/30" />
        </div>
        <div className="mt-5 grid grid-cols-3 gap-2">
          {["5k", "2.4%", "$50"].map((item) => (
            <div
              key={item}
              className="rounded-2xl border border-border-base bg-surface/70 p-3 text-center"
            >
              <p className="font-mono text-lg font-semibold tracking-tight">
                {item}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ValueCard({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: string;
}) {
  return (
    <article className="rounded-3xl border border-border-base bg-surface/80 p-5 shadow-sm shadow-blue-950/5 backdrop-blur">
      <div className="inline-flex size-9 items-center justify-center rounded-full bg-brand-tint text-brand dark:bg-brand-tint-dark">
        {icon}
      </div>
      <h2 className="mt-4 text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-muted-2">{children}</p>
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
