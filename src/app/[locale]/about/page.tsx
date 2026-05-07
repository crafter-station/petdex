import Link from "next/link";

import { getTranslations } from "next-intl/server";

import { buildLocaleAlternates } from "@/lib/locale-routing";
import { getApprovedPetCount } from "@/lib/pets";

import { CommandLine } from "@/components/command-line";
import { JsonLd } from "@/components/json-ld";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

const SITE_URL = "https://petdex.crafter.run";

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
    alternates: buildLocaleAlternates("/about"),
    openGraph: {
      title: t("ogTitle"),
      description: t("ogDescription"),
      url: `${SITE_URL}/about`,
      type: "website",
    },
  };
}

export default async function AboutPage() {
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
    [t("browse.links.creatures"), "/kind/creature"],
    [t("browse.links.objects"), "/kind/object"],
    [t("browse.links.characters"), "/kind/character"],
    [t("browse.links.cozy"), "/vibe/cozy"],
    [t("browse.links.playful"), "/vibe/playful"],
    [t("browse.links.focused"), "/vibe/focused"],
    [t("browse.links.mystical"), "/vibe/mystical"],
    [t("browse.links.wholesome"), "/vibe/wholesome"],
  ] as const;

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "AboutPage",
      name: t("metadata.ogTitle"),
      url: `${SITE_URL}/about`,
      description: t("metadata.ogDescription"),
      isPartOf: { "@type": "WebSite", "@id": `${SITE_URL}/#website` },
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faq.map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: {
          "@type": "Answer",
          text: item.a,
        },
      })),
    },
  ];

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <JsonLd data={jsonLd} />
      <section className="petdex-cloud relative overflow-clip">
        <div className="relative mx-auto flex w-full max-w-[1440px] flex-col px-5 pt-5 pb-10 md:px-8">
          <SiteHeader />
          <div className="mt-12 flex flex-col items-center text-center md:mt-16">
            <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
              {t("eyebrow")}
            </p>
            <h1 className="mt-3 text-balance text-[40px] leading-[1] font-semibold tracking-tight md:text-[64px]">
              {t("hero.title")}
            </h1>
            <p className="mt-5 max-w-2xl text-balance text-base leading-7 text-muted-1 md:text-lg">
              {t.rich("hero.body", {
                totalPets,
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
            <CommandLine
              command="npx petdex install boba"
              source="about-hero"
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
              href="/vibe/cozy"
              className="text-brand underline-offset-2 hover:underline"
            >
              {t("sections.what.body2.cozyLabel")}
            </Link>{" "}
            {t("sections.what.body2.middle")}{" "}
            <Link
              href="/vibe/focused"
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

        <div className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            {t("faq.title")}
          </h2>
          <div className="space-y-6">
            {faq.map((item) => (
              <article key={item.q} className="space-y-2">
                <h3 className="text-lg font-semibold text-foreground">
                  {item.q}
                </h3>
                <p className="text-base leading-7 text-muted-2">{item.a}</p>
              </article>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            {t("browse.title")}
          </h2>
          <div className="flex flex-wrap gap-2">
            {browseLinks.map(([label, href]) => (
              <Link
                key={href}
                href={href}
                className="inline-flex h-9 items-center rounded-full border border-border-base bg-surface px-3 text-sm text-muted-2 transition hover:border-border-strong"
              >
                {label}
              </Link>
            ))}
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
