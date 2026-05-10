import Image from "next/image";
import Link from "next/link";

import { ArrowUpRight, Plus, Star } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { buildLocaleAlternates } from "@/lib/locale-routing";

import { GithubIcon } from "@/components/github-icon";
import { JsonLd } from "@/components/json-ld";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import builtWithData from "@/data/built-with.json";

const SITE_URL = "https://petdex.crafter.run";
const SUBMIT_ISSUE_URL =
  "https://github.com/crafter-station/petdex/issues/new?template=built-with.yml";
const REGISTRY_URL =
  "https://github.com/crafter-station/petdex/blob/main/src/data/built-with.json";

type Project = (typeof builtWithData.projects)[number];
type CategoryKey = keyof typeof builtWithData.categories;

const CATEGORY_ORDER: CategoryKey[] = [
  "wellness",
  "desktop-companion",
  "wearable",
  "sdk",
  "bundled",
  "pet-creator",
];

const CATEGORY_KEY_TO_I18N: Record<CategoryKey, string> = {
  wellness: "wellness",
  "desktop-companion": "desktopCompanion",
  wearable: "wearable",
  sdk: "sdk",
  bundled: "bundled",
  "pet-creator": "petCreator",
};

const PROJECT_PRIORITY: Record<string, number> = {
  pawpause: 0,
};

export const dynamic = "force-static";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "builtWith.metadata" });
  const total = builtWithData.projects.length;
  const title = t("titleTemplate", { total });
  const description = t("description", { total });
  return {
    title,
    description,
    alternates: buildLocaleAlternates("/built-with"),
    openGraph: {
      title,
      description,
      url: `${SITE_URL}/built-with`,
      type: "website",
    },
  };
}

function projectsByCategory(): Record<CategoryKey, Project[]> {
  const out = {} as Record<CategoryKey, Project[]>;
  for (const key of CATEGORY_ORDER) out[key] = [];
  for (const p of builtWithData.projects as Project[]) {
    const key = p.category as CategoryKey;
    if (out[key]) out[key].push(p);
  }
  for (const key of CATEGORY_ORDER) {
    out[key].sort((a, b) => {
      const pa = PROJECT_PRIORITY[a.slug] ?? 999;
      const pb = PROJECT_PRIORITY[b.slug] ?? 999;
      if (pa !== pb) return pa - pb;
      return b.stars - a.stars || a.name.localeCompare(b.name);
    });
  }
  return out;
}

export default async function BuiltWithPage() {
  const t = await getTranslations("builtWith");
  const grouped = projectsByCategory();
  const total = builtWithData.projects.length;
  const totalStars = builtWithData.projects.reduce(
    (sum, p) => sum + (p.stars || 0),
    0,
  );

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: t("title"),
    url: `${SITE_URL}/built-with`,
    description: t("metadata.description", { total }),
    hasPart: builtWithData.projects.map((p) => ({
      "@type": "SoftwareApplication",
      name: p.name,
      url: `https://github.com/${p.repo}`,
      applicationCategory: t(
        `categories.${CATEGORY_KEY_TO_I18N[p.category as CategoryKey]}.label`,
      ),
    })),
  };

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <JsonLd data={jsonLd} />
      <SiteHeader />

      <section className="petdex-cloud relative -mt-[84px] overflow-clip pt-[84px]">
        <div className="relative mx-auto flex w-full max-w-5xl flex-col px-5 pb-12 md:px-8">
          <div className="mt-12 max-w-2xl md:mt-16">
            <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
              {t("eyebrow")}
            </p>
            <h1 className="mt-3 text-balance text-[40px] leading-[1] font-semibold tracking-tight md:text-[64px]">
              {t("title")}
            </h1>
            <p className="mt-5 text-balance text-base leading-7 text-muted-1 md:text-lg">
              {t("subtitle", { total })}
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-3 text-sm text-muted-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-surface px-3 py-1">
                <Star className="size-3.5" />
                {t("stats.stars", { total: totalStars.toLocaleString() })}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-surface px-3 py-1">
                {t("stats.projects", { total })}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-surface px-3 py-1">
                {t("stats.categories", { total: CATEGORY_ORDER.length })}
              </span>
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href={SUBMIT_ISSUE_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-11 items-center gap-2 rounded-full bg-foreground px-5 text-sm font-semibold text-background transition hover:opacity-90"
              >
                <Plus className="size-4" />
                {t("cta.submit")}
              </Link>
              <a
                href="https://github.com/crafter-station/petdex"
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-11 items-center gap-2 rounded-full border border-border-base bg-surface px-4 text-sm font-medium text-muted-2 transition hover:border-border-strong"
              >
                <GithubIcon className="size-4" />
                {t("cta.starPetdex")}
              </a>
            </div>
          </div>
        </div>
      </section>

      {CATEGORY_ORDER.map((catKey) => {
        const items = grouped[catKey];
        if (!items.length) return null;
        const i18nKey = CATEGORY_KEY_TO_I18N[catKey];
        return (
          <section
            key={catKey}
            className="mx-auto w-full max-w-5xl px-5 py-10 md:px-8 md:py-14"
          >
            <div className="mb-6 flex items-baseline justify-between gap-4">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
                  {t(`categories.${i18nKey}.label`)}
                </h2>
                <p className="mt-1 text-sm leading-6 text-muted-2">
                  {t(`categories.${i18nKey}.description`)}
                </p>
              </div>
              <span className="font-mono text-xs text-muted-2">
                {items.length}
              </span>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((p) => (
                <ProjectCard
                  key={p.slug}
                  project={p}
                  screenshotAlt={t("card.screenshotAlt", { name: p.name })}
                  siteLabel={t("card.site")}
                />
              ))}
            </div>
          </section>
        );
      })}

      <section className="mx-auto w-full max-w-5xl px-5 pb-20 md:px-8">
        <div className="rounded-3xl border border-border-base bg-surface/80 p-6 md:p-10">
          <p className="font-mono text-[11px] tracking-[0.22em] text-brand uppercase">
            {t("submit.eyebrow")}
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight md:text-3xl">
            {t("submit.title")}
          </h2>
          <ol className="mt-4 grid list-decimal gap-2 pl-5 text-sm leading-6 text-muted-2 md:grid-cols-2">
            <li>{t("submit.step1")}</li>
            <li>{t("submit.step2")}</li>
            <li>{t("submit.step3")}</li>
            <li>{t("submit.step4")}</li>
          </ol>
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <Link
              href={SUBMIT_ISSUE_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 items-center gap-2 rounded-full bg-foreground px-5 text-sm font-semibold text-background transition hover:opacity-90"
            >
              <Plus className="size-4" />
              {t("submit.openIssue")}
            </Link>
            <Link
              href={REGISTRY_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-sm font-semibold text-brand hover:underline"
            >
              built-with.json
              <ArrowUpRight className="size-4" />
            </Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}

function ProjectCard({
  project,
  screenshotAlt,
  siteLabel,
}: {
  project: Project;
  screenshotAlt: string;
  siteLabel: string;
}) {
  const repoUrl = `https://github.com/${project.repo}`;
  const primaryHref = project.homepage || repoUrl;
  return (
    <article className="group flex flex-col overflow-hidden rounded-2xl border border-border-base bg-surface/80 transition hover:border-border-strong">
      <Link
        href={primaryHref}
        target="_blank"
        rel="noreferrer"
        className="relative block aspect-[16/10] overflow-hidden bg-background"
      >
        <Image
          src={project.screenshot}
          alt={screenshotAlt}
          fill
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
          className="object-cover transition group-hover:scale-[1.02]"
        />
      </Link>

      <div className="flex flex-1 flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-semibold tracking-tight">
            {project.name}
          </h3>
          {project.stars > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] text-muted-2">
              <Star className="size-3" />
              {project.stars.toLocaleString()}
            </span>
          ) : null}
        </div>
        <p className="line-clamp-3 text-sm leading-6 text-muted-2">
          {project.tagline}
        </p>

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
          {project.language ? (
            <span className="rounded-full bg-background px-2 py-0.5 font-mono text-[11px] text-muted-2">
              {project.language}
            </span>
          ) : null}
          {project.platforms.slice(0, 3).map((plat) => (
            <span
              key={plat}
              className="rounded-full bg-background px-2 py-0.5 font-mono text-[11px] text-muted-2"
            >
              {plat}
            </span>
          ))}
        </div>

        <div className="flex items-center gap-3 pt-1 text-xs">
          <a
            href={repoUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-muted-2 transition hover:text-foreground"
          >
            <GithubIcon className="size-3.5" />
            {project.repo}
          </a>
          {project.homepage ? (
            <a
              href={project.homepage}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-brand hover:underline"
            >
              {siteLabel}
              <ArrowUpRight className="size-3" />
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}
