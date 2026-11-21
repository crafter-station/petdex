import Link from "next/link";

import { getTranslations } from "next-intl/server";

import { BRAND_JSON_LD } from "@/lib/brand-kit";
import { buildLocaleAlternates, withLocale } from "@/lib/locale-routing";
import { getApprovedPetCount } from "@/lib/pets";

import { StaticCommandLine } from "@/components/download/static-command-line";
import { JsonLd } from "@/components/layout/json-ld";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import { hasLocale } from "@/i18n/config";

const SITE_URL = "https://petdex.dev";

export const revalidate = 3600;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "about.metadata" });

  return {
    title: t("title"),
    description: t("description"),
    alternates: buildLocaleAlternates(
      "/about",
      hasLocale(locale) ? locale : undefined,
    ),
    openGraph: {
      title: t("ogTitle"),
      description: t("ogDescription"),
      url: `${SITE_URL}/about`,
      type: "website",
    },
  };
}

export default async function AboutPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const localeValue = hasLocale(locale) ? locale : "en";
  const totalPets = await getApprovedPetCount();
  const t = await getTranslations("about");
  const faq = [
    { q: t("faq.items.whatIs.q"), a: t("faq.items.whatIs.a") },
    { q: t("faq.items.install.q"), a: t("faq.items.install.a") },
    { q: t("faq.items.origin.q"), a: t("faq.items.origin.a") },
    { q: t("faq.items.submit.q"), a: t("faq.items.submit.a") },
    { q: t("faq.items.openSource.q"), a: t("faq.items.openSource.a") },
    { q: t("faq.items.taxonomy.q"), a: t("faq.items.taxonomy.a") },
    { q: t("faq.items.money.q"), a: t("faq.items.money.a") },
  ];
  const browseLinks = [
    [t("browse.links.creatures"), withLocale("/kind/creature", localeValue)],
    [t("browse.links.objects"), withLocale("/kind/object", localeValue)],
    [t("browse.links.characters"), withLocale("/kind/character", localeValue)],
    [t("browse.links.cozy"), withLocale("/vibe/cozy", localeValue)],
    [t("browse.links.playful"), withLocale("/vibe/playful", localeValue)],
    [t("browse.links.focused"), withLocale("/vibe/focused", localeValue)],
    [t("browse.links.mystical"), withLocale("/vibe/mystical", localeValue)],
    [t("browse.links.wholesome"), withLocale("/vibe/wholesome", localeValue)],
  ] as const;

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      ...BRAND_JSON_LD["@graph"],
      {
        "@type": "AboutPage",
        "@id": `${SITE_URL}/about#webpage`,
        name: t("metadata.ogTitle"),
        url: `${SITE_URL}/about`,
        description: t("metadata.ogDescription"),
        isPartOf: { "@id": `${SITE_URL}/#website` },
        author: { "@id": "https://railly.dev/#person" },
        publisher: { "@id": "https://crafter.run/#organization" },
      },
      {
        "@type": "FAQPage",
        "@id": `${SITE_URL}/about#faq`,
        url: `${SITE_URL}/about`,
        isPartOf: { "@id": `${SITE_URL}/#website` },
        author: { "@id": "https://railly.dev/#person" },
        publisher: { "@id": "https://crafter.run/#organization" },
        mainEntity: faq.map((item) => ({
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
    <main className="min-h-dvh bg-background text-foreground">
      <JsonLd data={jsonLd} />
      <SiteHeader />
      <section className="petdex-hero relative -mt-14 overflow-clip pt-14">
        <div className="relative mx-auto flex w-full max-w-[1440px] flex-col px-5 pb-10 md:px-8">
          <div className="mt-12 flex flex-col items-center text-center md:mt-16">
            <p className="toy-tag inline-block rounded-full bg-toy-volt px-2.5 py-1 text-[#101944] shadow-[0_2px_0_#C9A91F]">
              {t("eyebrow")}
            </p>
            <h1 className="mt-4 text-balance text-[40px] leading-[1] font-semibold tracking-tight md:text-[64px]">
              {t("hero.title")}
            </h1>
            <p className="mt-5 max-w-2xl text-balance text-base leading-7 text-muted-1 md:text-lg">
              {t.rich("hero.body", {
                totalPets,
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
            <StaticCommandLine
              command="npx petdex install boba"
              className="mt-5 w-full max-w-sm"
            />
          </div>
        </div>
      </section>

      <section className="mx-auto flex w-full max-w-3xl flex-col gap-12 px-5 py-14 md:px-8 md:py-20">
        <div className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            {t("sections.what.title")}
          </h2>
          <p className="text-base leading-7 text-muted-2 md:text-lg">
            {t("sections.what.body1")}
          </p>
          <p className="text-base leading-7 text-muted-2 md:text-lg">
            {t("sections.what.body2.beforeCozy")}{" "}
            <Link
              href={withLocale("/vibe/cozy", localeValue)}
              className="text-brand underline-offset-2 hover:underline"
            >
              {t("sections.what.body2.cozyLabel")}
            </Link>{" "}
            {t("sections.what.body2.middle")}{" "}
            <Link
              href={withLocale("/vibe/focused", localeValue)}
              className="text-brand underline-offset-2 hover:underline"
            >
              {t("sections.what.body2.focusedLabel")}
            </Link>
            {t("sections.what.body2.afterFocused")}
          </p>
        </div>

        <div className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            {t("sections.pack.title")}
          </h2>
          <p className="text-base leading-7 text-muted-2 md:text-lg">
            {t("sections.pack.beforePetJson")}{" "}
            <code className="rounded bg-brand-tint px-1 py-0.5 text-brand dark:bg-brand-tint-dark">
              pet.json
            </code>{" "}
            {t("sections.pack.betweenFiles")}{" "}
            <code className="rounded bg-brand-tint px-1 py-0.5 text-brand dark:bg-brand-tint-dark">
              spritesheet.webp
            </code>{" "}
            {t("sections.pack.afterSpritesheet")}
          </p>
        </div>

        <div className="space-y-5">
          <div className="space-y-2">
            <p className="toy-tag text-toy-cobalt dark:text-[#9BB2FF]">FAQ</p>
            <h2 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
              {t("faq.title")}
            </h2>
          </div>
          <div className="space-y-4">
            {faq.map((item, index) => (
              <article
                key={item.q}
                className="toy-shell space-y-2 rounded-3xl p-6"
              >
                <p className="toy-tag text-toy-cobalt dark:text-[#9BB2FF]">
                  0{index + 1}
                </p>
                <h3 className="text-lg font-semibold text-foreground">
                  {item.q}
                </h3>
                <p className="text-base leading-7 text-muted-2">{item.a}</p>
              </article>
            ))}
          </div>
        </div>

        <div className="toy-shell space-y-4 rounded-3xl p-6 md:p-8">
          <p className="toy-tag text-toy-cobalt dark:text-[#9BB2FF]">INDEX</p>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            {t("browse.title")}
          </h2>
          <div className="flex flex-wrap gap-2.5 pt-1">
            {browseLinks.map(([label, href]) => (
              <Link
                key={href}
                href={href}
                className="toy-btn toy-btn-pearl h-9 rounded-full px-3.5 text-sm text-muted-1 hover:text-foreground"
              >
                {label}
              </Link>
            ))}
          </div>
        </div>

        <aside className="toy-shell flex flex-col items-start justify-between gap-4 rounded-3xl p-6 sm:flex-row sm:items-center md:p-8">
          <div className="space-y-1.5">
            <p className="toy-tag text-toy-cobalt dark:text-[#9BB2FF]">
              Crafter Station
            </p>
            <p className="text-base font-semibold text-foreground">
              Built by Railly Hugo at Crafter Station
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <a
              href="https://railly.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="toy-btn toy-btn-cobalt h-10 rounded-full px-4 text-sm"
            >
              railly.dev
            </a>
            <a
              href="https://crafter.run"
              target="_blank"
              rel="noopener noreferrer"
              className="toy-btn toy-btn-pearl h-10 rounded-full px-4 text-sm"
            >
              crafter.run
            </a>
          </div>
        </aside>
      </section>

      <SiteFooter />
    </main>
  );
}
