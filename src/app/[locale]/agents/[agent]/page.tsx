import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ArrowRight, Download, Palette, Terminal } from "lucide-react";
import { setRequestLocale } from "next-intl/server";

import { BRAND_JSON_LD, BRAND_SITE_URL } from "@/lib/brand-kit";
import { CODING_AGENTS, getCodingAgent } from "@/lib/coding-agents";
import { buildLocaleAlternates, withLocale } from "@/lib/locale-routing";

import { CommandLine } from "@/components/download/command-line";
import { JsonLd } from "@/components/layout/json-ld";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import { hasLocale, type Locale, locales } from "@/i18n/config";

export const revalidate = 3600;

const DISPLAY = {
  fontFamily: "var(--font-display), var(--font-cjk), sans-serif",
};
const BODY = {
  fontFamily: "var(--font-geist-sans), var(--font-cjk), sans-serif",
};
const PIXEL = { fontFamily: "var(--font-pixel), monospace" };

type UiCopy = {
  homeLabel: string;
  agentsLabel: string;
  eyebrow: string;
  badgeOpenSource: string;
  installLabel: string;
  downloadCta: string;
  brandCta: string;
  hookHeading: string;
  howItWorksHeading: string;
  faqHeading: string;
  moreAgentsHeading: string;
  moreAgentsBody: string;
  creditLine: string;
};

const UI_COPY: Record<Locale, UiCopy> = {
  en: {
    homeLabel: "Petdex",
    agentsLabel: "Coding Agents",
    eyebrow: "AGENT INTEGRATION",
    badgeOpenSource: "OPEN SOURCE",
    installLabel: "Install a pet with one command",
    downloadCta: "Download Petdex Desktop",
    brandCta: "Explore Brand Kit",
    hookHeading: "Hook Mechanism",
    howItWorksHeading: "How Petdex Works With",
    faqHeading: "Frequently Asked Questions",
    moreAgentsHeading: "More Supported Coding Agents",
    moreAgentsBody:
      "One Petdex Desktop app connects to every coding agent on your machine.",
    creditLine: "Created by Railly Hugo at Crafter Station.",
  },
  es: {
    homeLabel: "Petdex",
    agentsLabel: "Agentes de Codigo",
    eyebrow: "INTEGRACION DE AGENTE",
    badgeOpenSource: "OPEN SOURCE",
    installLabel: "Instala una mascota con un comando",
    downloadCta: "Descargar Petdex Desktop",
    brandCta: "Ver Brand Kit",
    hookHeading: "Mecanismo de Hooks",
    howItWorksHeading: "Como funciona Petdex con",
    faqHeading: "Preguntas Frecuentes",
    moreAgentsHeading: "Mas Agentes de Codigo Compatibles",
    moreAgentsBody:
      "Una sola app de Petdex Desktop se conecta con todos tus agentes locales.",
    creditLine: "Creado por Railly Hugo en Crafter Station.",
  },
  zh: {
    homeLabel: "Petdex",
    agentsLabel: "编码代理",
    eyebrow: "代理集成",
    badgeOpenSource: "开源项目",
    installLabel: "一行命令安装像素宠物",
    downloadCta: "下载 Petdex Desktop",
    brandCta: "浏览品牌规范",
    hookHeading: "Hook 集成机制",
    howItWorksHeading: "Petdex 如何联动",
    faqHeading: "常见问题",
    moreAgentsHeading: "更多支持的编码代理",
    moreAgentsBody:
      "一个 Petdex Desktop 应用即可同时连接你本机的所有编码代理。",
    creditLine: "由 Crafter Station 的 Railly Hugo 创建。",
  },
};

export function generateStaticParams() {
  return locales.flatMap((locale) =>
    CODING_AGENTS.map((agent) => ({
      locale,
      agent: agent.slug,
    })),
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; agent: string }>;
}): Promise<Metadata> {
  const { locale, agent } = await params;
  const codingAgent = getCodingAgent(agent);
  if (!codingAgent) return {};

  const localeValue: Locale = hasLocale(locale) ? locale : "en";
  const copy = codingAgent.copy[localeValue];
  const canonicalUrl = `${BRAND_SITE_URL}/agents/${codingAgent.slug}`;
  const ogDescription = `${copy.subtitle} Built by Railly Hugo at Crafter Station.`;

  return {
    title: `${copy.title} | Petdex`,
    description: ogDescription,
    alternates: buildLocaleAlternates(
      `/agents/${codingAgent.slug}`,
      localeValue,
    ),
    openGraph: {
      title: `Petdex for ${codingAgent.name}: ${copy.title}`,
      description: ogDescription,
      url: canonicalUrl,
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: `Petdex for ${codingAgent.name}`,
      description: ogDescription,
    },
  };
}

export default async function CodingAgentPage({
  params,
}: {
  params: Promise<{ locale: string; agent: string }>;
}) {
  const { locale, agent } = await params;
  const codingAgent = getCodingAgent(agent);
  if (!codingAgent) {
    notFound();
  }

  const localeValue: Locale = hasLocale(locale) ? locale : "en";
  setRequestLocale(localeValue);

  const copy = codingAgent.copy[localeValue];
  const ui = UI_COPY[localeValue];
  const pageUrl = `${BRAND_SITE_URL}${withLocale(`/agents/${codingAgent.slug}`, localeValue)}`;
  const otherAgents = CODING_AGENTS.filter(
    (entry) => entry.slug !== codingAgent.slug,
  );

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      ...BRAND_JSON_LD["@graph"],
      {
        "@type": "BreadcrumbList",
        "@id": `${pageUrl}#breadcrumb`,
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: ui.homeLabel,
            item: `${BRAND_SITE_URL}${withLocale("/", localeValue)}`,
          },
          {
            "@type": "ListItem",
            position: 2,
            name: codingAgent.name,
            item: pageUrl,
          },
        ],
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${BRAND_SITE_URL}/download#app`,
        name: "Petdex Desktop",
        applicationCategory: "DeveloperApplication",
        operatingSystem: "macOS, Windows, Linux",
        url: `${BRAND_SITE_URL}/download`,
        description: `Native floating pixel pet companion for ${codingAgent.name} and 9 other coding agents.`,
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "USD",
        },
        author: { "@id": "https://www.railly.dev/#person" },
        publisher: { "@id": "https://crafter.run/#organization" },
      },
      {
        "@type": "FAQPage",
        "@id": `${pageUrl}#faq`,
        mainEntity: copy.faqs.map((item) => ({
          "@type": "Question",
          name: item.q,
          acceptedAnswer: {
            "@type": "Answer",
            text: item.a,
          },
        })),
      },
    ],
  };

  return (
    <main className="min-h-dvh bg-background text-foreground" style={BODY}>
      <JsonLd data={jsonLd} />
      <SiteHeader />

      <section className="petdex-hero relative -mt-14 overflow-clip pt-14">
        <div className="mx-auto grid w-full max-w-[1440px] gap-10 px-5 pt-14 pb-16 md:grid-cols-[1.15fr_0.85fr] md:px-8 md:pt-24 md:pb-20">
          <div className="flex flex-col justify-center">
            <nav
              aria-label="Breadcrumb"
              className="mb-5 flex items-center gap-2 text-xs text-muted-3"
            >
              <Link
                href={withLocale("/", localeValue)}
                className="transition hover:text-foreground"
              >
                {ui.homeLabel}
              </Link>
              <span>/</span>
              <span>{ui.agentsLabel}</span>
              <span>/</span>
              <span className="font-medium text-foreground">
                {codingAgent.name}
              </span>
            </nav>

            <div className="flex flex-wrap items-center gap-2">
              <span className="toy-tag rounded-full bg-toy-volt px-2.5 py-1 text-[#101944] shadow-[0_2px_0_#C9A91F]">
                {ui.eyebrow}
              </span>
              <span className="toy-tag rounded-full bg-toy-sakura px-2.5 py-1 text-white shadow-[0_2px_0_#C24C72]">
                {codingAgent.vendor}
              </span>
              <span className="toy-tag rounded-full bg-toy-mint px-2.5 py-1 text-[#101944] shadow-[0_2px_0_#1D9A6C]">
                {ui.badgeOpenSource}
              </span>
            </div>

            <h1
              className="mt-4 max-w-3xl text-balance text-[40px] leading-[0.96] font-extrabold tracking-[-0.04em] md:text-[64px]"
              style={DISPLAY}
            >
              {copy.title}
            </h1>

            <p className="mt-5 max-w-2xl text-balance text-base leading-7 text-muted-1 md:text-lg">
              {copy.subtitle}
            </p>

            <div className="mt-7 max-w-md space-y-2">
              <p className="font-mono text-xs tracking-wider text-muted-3 uppercase">
                {ui.installLabel}
              </p>
              <CommandLine
                command={codingAgent.installCommand}
                className="btn-3d h-11 w-full"
              />
            </div>

            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href={withLocale("/download", localeValue)}
                className="toy-btn toy-btn-cobalt h-12 px-5 text-sm"
              >
                <Download className="size-4" />
                {ui.downloadCta}
              </Link>
              <Link
                href={withLocale("/brand", localeValue)}
                className="toy-btn toy-btn-pearl h-12 px-5 text-sm"
              >
                <Palette className="size-4" />
                {ui.brandCta}
              </Link>
            </div>
          </div>

          <div className="toy-shell flex flex-col justify-between gap-6 p-6 md:p-8">
            <div className="flex items-center justify-between">
              <span className="toy-tag text-toy-ink/70" style={PIXEL}>
                PETDEX x {codingAgent.slug.toUpperCase()}
              </span>
              <span className="toy-tag rounded-full bg-brand-tint px-2.5 py-1 text-brand dark:bg-brand-tint-dark">
                {codingAgent.name}
              </span>
            </div>

            <div className="flex items-center gap-4 rounded-2xl border border-border-base bg-surface/80 p-5">
              <div className="grid size-14 shrink-0 place-items-center rounded-2xl bg-background ring-1 ring-border-base">
                <Image
                  src={codingAgent.icon}
                  alt={codingAgent.name}
                  width={36}
                  height={36}
                  className="size-9 object-contain"
                />
              </div>
              <div className="min-w-0">
                <p className="text-lg font-semibold text-foreground">
                  {codingAgent.name}
                </p>
                <p className="text-sm text-muted-2">{codingAgent.vendor}</p>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 font-mono text-xs tracking-wider text-brand uppercase">
                <Terminal className="size-3.5" />
                <span>{ui.hookHeading}</span>
              </div>
              <p className="text-sm leading-6 text-muted-2">
                {codingAgent.hookMechanism}
              </p>
            </div>

            <p className="border-t border-border-base pt-4 text-xs text-muted-3">
              {ui.creditLine}
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto flex w-full max-w-[1440px] flex-col gap-12 px-5 py-14 md:px-8 md:py-20">
        <div className="toy-shell p-6 md:p-8">
          <h2
            className="text-2xl font-bold tracking-tight text-foreground md:text-3xl"
            style={DISPLAY}
          >
            {ui.howItWorksHeading} {codingAgent.name}
          </h2>
          <p className="mt-4 max-w-3xl text-base leading-7 text-muted-2 md:text-lg">
            {copy.howItWorks}
          </p>
        </div>

        <div className="space-y-6">
          <h2
            className="text-2xl font-bold tracking-tight text-foreground md:text-3xl"
            style={DISPLAY}
          >
            {ui.faqHeading}
          </h2>
          <div className="grid gap-4 md:grid-cols-3">
            {copy.faqs.map((item) => (
              <article
                key={item.q}
                className="toy-shell flex flex-col gap-2.5 p-6"
              >
                <h3 className="text-base font-semibold text-foreground">
                  {item.q}
                </h3>
                <p className="text-sm leading-6 text-muted-2">{item.a}</p>
              </article>
            ))}
          </div>
        </div>

        <div className="space-y-5">
          <div>
            <h2
              className="text-2xl font-bold tracking-tight text-foreground md:text-3xl"
              style={DISPLAY}
            >
              {ui.moreAgentsHeading}
            </h2>
            <p className="mt-2 text-sm text-muted-2 md:text-base">
              {ui.moreAgentsBody}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {otherAgents.map((entry) => (
              <Link
                key={entry.slug}
                href={withLocale(`/agents/${entry.slug}`, localeValue)}
                className="toy-shell group flex items-center justify-between gap-3 p-4 transition-transform duration-200 [transition-timing-function:var(--ease-bounce)] hover:-translate-y-0.5"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface ring-1 ring-border-base">
                    <Image
                      src={entry.icon}
                      alt={entry.name}
                      width={22}
                      height={22}
                      className="size-5 object-contain"
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {entry.name}
                    </p>
                    <p className="truncate text-xs text-muted-3">
                      {entry.vendor}
                    </p>
                  </div>
                </div>
                <ArrowRight className="size-4 shrink-0 text-muted-3 transition-transform group-hover:translate-x-0.5 group-hover:text-brand" />
              </Link>
            ))}
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
