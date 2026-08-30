import Image from "next/image";
import Link from "next/link";

import {
  ArrowUpRightIcon,
  CodeIcon,
  DesktopIcon,
  HeartIcon,
  PackageIcon,
  PaintBrushIcon,
  PlusIcon,
  StarIcon,
  WatchIcon,
} from "@phosphor-icons/react/ssr";
import { getTranslations } from "next-intl/server";

import { formatLocalizedNumber } from "@/lib/format-number";
import { buildLocaleAlternates } from "@/lib/locale-routing";

import { GithubIcon } from "@/components/brand/github-icon";
import { JsonLd } from "@/components/layout/json-ld";
import { PetSprite } from "@/components/pets/pet-sprite";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import builtWithData from "@/data/built-with.json";
import { hasLocale } from "@/i18n/config";

const SITE_URL = "https://petdex.dev";
const SUBMIT_ISSUE_URL =
  "https://github.com/crafter-station/petdex/issues/new?template=built-with.yml";
const REGISTRY_URL =
  "https://github.com/crafter-station/petdex/blob/main/src/data/built-with.json";
const BOBA_PREVIEW = "https://assets.petdex.dev/pets/boba/preview.webp";
const MALLOW_PREVIEW = "https://assets.petdex.dev/pets/mallow/preview.webp";

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

const CATEGORY_ICONS = {
  wellness: HeartIcon,
  "desktop-companion": DesktopIcon,
  wearable: WatchIcon,
  sdk: CodeIcon,
  bundled: PackageIcon,
  "pet-creator": PaintBrushIcon,
} satisfies Record<CategoryKey, typeof HeartIcon>;

function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.startsWith("https://") || value.startsWith("http://")
    ? value
    : null;
}

function projectsByCategory(): Record<CategoryKey, Project[]> {
  const out = {} as Record<CategoryKey, Project[]>;
  for (const key of CATEGORY_ORDER) out[key] = [];
  for (const project of builtWithData.projects as Project[]) {
    const key = project.category as CategoryKey;
    if (out[key]) out[key].push(project);
  }
  for (const key of CATEGORY_ORDER) {
    out[key].sort((a, b) => {
      const priorityA = PROJECT_PRIORITY[a.slug] ?? 999;
      const priorityB = PROJECT_PRIORITY[b.slug] ?? 999;
      if (priorityA !== priorityB) return priorityA - priorityB;
      return b.stars - a.stars || a.name.localeCompare(b.name);
    });
  }
  return out;
}

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
    alternates: buildLocaleAlternates(
      "/built-with",
      hasLocale(locale) ? locale : undefined,
    ),
    openGraph: {
      title,
      description,
      url: `${SITE_URL}/built-with`,
      type: "website",
    },
  };
}

export default async function BuiltWithPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("builtWith");
  const grouped = projectsByCategory();
  const total = builtWithData.projects.length;
  const totalStars = builtWithData.projects.reduce(
    (sum, project) => sum + project.stars,
    0,
  );
  const featured = (grouped.wellness[0] ??
    builtWithData.projects[0]) as Project;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: t("title"),
    url: `${SITE_URL}/built-with`,
    description: t("metadata.description", { total }),
    hasPart: builtWithData.projects.map((project) => ({
      "@type": "SoftwareApplication",
      name: project.name,
      url: `https://github.com/${project.repo}`,
      applicationCategory: t(
        `categories.${CATEGORY_KEY_TO_I18N[project.category as CategoryKey]}.label`,
      ),
    })),
  };

  return (
    <main className="min-h-dvh overflow-x-clip bg-background text-foreground">
      <JsonLd data={jsonLd} />
      <SiteHeader />

      <section className="petdex-hero relative -mt-14 overflow-hidden border-b border-border-base pt-14 xl:h-[56dvh]">
        <div className="pointer-events-none absolute inset-x-0 bottom-0 mx-auto h-px max-w-7xl bg-gradient-to-r from-transparent via-brand/50 to-transparent" />
        <div className="relative mx-auto grid w-full max-w-7xl lg:grid-cols-[minmax(0,0.88fr)_minmax(520px,1.12fr)] xl:h-full">
          <div className="relative flex min-h-[500px] flex-col justify-center border-border-base px-5 py-12 sm:px-8 lg:border-r lg:px-12 lg:py-8 xl:h-full xl:min-h-0">
            <div className="relative z-10 max-w-2xl">
              <p className="font-mono text-[11px] font-medium tracking-[0.24em] text-brand uppercase">
                {t("eyebrow")}
              </p>
              <h1 className="mt-5 max-w-[620px] text-balance text-[46px] leading-[0.98] font-semibold tracking-[-0.05em] sm:text-[58px] lg:text-[48px] xl:text-[62px] [@media(min-width:1280px)_and_(max-height:900px)]:mt-2.5 [@media(min-width:1280px)_and_(max-height:900px)]:text-[48px]">
                {t("title")}
              </h1>
              <p className="mt-6 max-w-xl text-pretty text-base leading-7 text-muted-1 sm:text-lg sm:leading-8 [@media(min-width:1280px)_and_(max-height:900px)]:mt-3.5 [@media(min-width:1280px)_and_(max-height:900px)]:text-base [@media(min-width:1280px)_and_(max-height:900px)]:leading-[26px]">
                {t("subtitle", { total })}
              </p>

              <div className="mt-9 flex flex-wrap items-center gap-3 [@media(min-width:1280px)_and_(max-height:900px)]:mt-[18px]">
                <Link
                  href={SUBMIT_ISSUE_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-3d-brand inline-flex h-11 items-center gap-2 rounded-full bg-brand-deep px-5 text-[13px] font-semibold text-white transition hover:bg-brand"
                >
                  <PlusIcon className="size-4" weight="bold" />
                  {t("cta.submit")}
                </Link>
                <Link
                  href="#registry"
                  className="inline-flex h-11 items-center gap-2 rounded-full border border-border-base bg-surface/70 px-5 text-[13px] font-semibold text-muted-1 backdrop-blur transition hover:border-brand/40 hover:text-foreground"
                >
                  {t("cta.browseRegistry")}
                  <ArrowUpRightIcon className="size-4" weight="bold" />
                </Link>
              </div>
            </div>

            <div className="relative z-10 mt-10 grid grid-cols-2 border-y border-border-base sm:grid-cols-4 [@media(min-width:1280px)_and_(max-height:900px)]:mt-4">
              <Stat value={total.toString()} label={t("stats.projectsLabel")} />
              <Stat
                value={CATEGORY_ORDER.length.toString()}
                label={t("stats.categoriesLabel")}
              />
              <Stat
                value={formatLocalizedNumber(totalStars, locale)}
                label={t("stats.starsLabel")}
              />
              <Stat
                value={builtWithData.lastUpdated.slice(5).replace("-", ".")}
                label={t("stats.updatedLabel")}
              />
            </div>

            <div className="pointer-events-none absolute bottom-3 left-2 hidden -rotate-6 drop-shadow-[0_18px_36px_rgba(39,71,255,0.28)] xl:-left-12 xl:block">
              <PetSprite
                src={MALLOW_PREVIEW}
                layout="row"
                scale={0.48}
                label="Mallow pet"
              />
            </div>
          </div>

          <FeaturedProject
            project={featured}
            screenshotAlt={t("card.screenshotAlt", { name: featured.name })}
            siteLabel={t("card.site")}
          />
        </div>
      </section>

      <section className="relative border-b border-border-base bg-surface/25 xl:h-[44dvh]">
        <div className="mx-auto flex w-full max-w-7xl flex-col px-5 py-10 sm:px-8 lg:px-12 lg:py-6 xl:h-full">
          <div className="grid gap-6 border-b border-border-base pb-5 lg:grid-cols-[0.7fr_1.3fr] lg:items-end">
            <div>
              <p className="font-mono text-[11px] font-medium tracking-[0.24em] text-brand uppercase">
                {t("chapters.eyebrow")}
              </p>
              <h2 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
                {t("chapters.title")}
              </h2>
            </div>
            <p className="max-w-2xl text-base leading-7 text-muted-1 lg:justify-self-end">
              {t("chapters.description")}
            </p>
          </div>

          <div className="relative grid flex-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {CATEGORY_ORDER.map((categoryKey, index) => {
              const items = grouped[categoryKey];
              const i18nKey = CATEGORY_KEY_TO_I18N[categoryKey];
              const Icon = CATEGORY_ICONS[categoryKey];
              return (
                <article
                  key={categoryKey}
                  className="group relative flex min-h-[285px] flex-col border-b border-border-base px-1 py-6 sm:px-6 sm:[&:nth-child(odd)]:border-r lg:[&:nth-child(3n+1)]:border-r lg:[&:nth-child(3n+2)]:border-r xl:min-h-0 xl:border-b-0 xl:border-r xl:px-5 xl:py-4 xl:last:border-r-0"
                >
                  <div className="flex items-center justify-between">
                    <Icon className="size-5 text-brand" weight="duotone" />
                    <span className="font-mono text-[10px] tracking-[0.18em] text-muted-2 uppercase">
                      0{index + 1}
                    </span>
                  </div>
                  <h3 className="mt-4 text-base font-semibold tracking-tight">
                    {t(`categories.${i18nKey}.label`)}
                  </h3>
                  <p className="mt-2 min-h-[54px] text-xs leading-[18px] text-muted-2">
                    {t(`categories.${i18nKey}.description`)}
                  </p>
                  <div className="mt-4 divide-y divide-border-base border-y border-border-base">
                    {items.slice(0, 3).map((project) => (
                      <a
                        key={project.slug}
                        href={`#${project.slug}`}
                        className="flex min-h-8 items-center gap-2.5 py-1.5 text-xs font-medium text-muted-1 transition hover:text-brand"
                      >
                        <span className="relative size-6 shrink-0 overflow-hidden rounded border border-border-base bg-background">
                          <Image
                            src={project.screenshot}
                            alt=""
                            fill
                            sizes="24px"
                            className="object-cover"
                          />
                        </span>
                        <span className="truncate">{project.name}</span>
                      </a>
                    ))}
                  </div>
                  <a
                    href={`#category-${categoryKey}`}
                    className="mt-auto inline-flex items-center gap-1.5 pt-3 font-mono text-[10px] font-medium tracking-[0.12em] text-muted-2 uppercase transition group-hover:text-brand"
                  >
                    {t("chapters.viewAll", { count: items.length })}
                    <ArrowUpRightIcon className="size-3" weight="bold" />
                  </a>
                </article>
              );
            })}

            <div className="pointer-events-none absolute -right-14 bottom-1 hidden rotate-6 drop-shadow-[0_18px_36px_rgba(39,71,255,0.3)] xl:block">
              <PetSprite
                src={BOBA_PREVIEW}
                layout="row"
                scale={0.5}
                label="Boba pet"
              />
            </div>
          </div>
        </div>
      </section>

      <section id="registry" className="scroll-mt-20">
        <div className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8 lg:px-12 lg:py-24">
          <div className="grid gap-7 border-b border-border-base pb-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
            <div>
              <p className="font-mono text-[11px] font-medium tracking-[0.24em] text-brand uppercase">
                {t("registry.eyebrow")}
              </p>
              <h2 className="mt-3 text-balance text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
                {t("registry.title")}
              </h2>
            </div>
            <p className="max-w-2xl text-base leading-7 text-muted-1 lg:justify-self-end">
              {t("registry.description")}
            </p>
          </div>

          {CATEGORY_ORDER.map((categoryKey, categoryIndex) => {
            const items = grouped[categoryKey];
            const i18nKey = CATEGORY_KEY_TO_I18N[categoryKey];
            const Icon = CATEGORY_ICONS[categoryKey];
            return (
              <section
                id={`category-${categoryKey}`}
                key={categoryKey}
                className="scroll-mt-20 border-b border-border-base py-12 last:border-b-0 lg:grid lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-12 lg:py-16"
              >
                <div className="mb-7 lg:sticky lg:top-24 lg:mb-0 lg:self-start">
                  <div className="flex items-center gap-3">
                    <Icon className="size-5 text-brand" weight="duotone" />
                    <span className="font-mono text-[10px] tracking-[0.18em] text-muted-2 uppercase">
                      Chapter 0{categoryIndex + 1}
                    </span>
                  </div>
                  <h3 className="mt-5 text-2xl font-semibold tracking-[-0.025em]">
                    {t(`categories.${i18nKey}.label`)}
                  </h3>
                  <p className="mt-3 text-sm leading-6 text-muted-2">
                    {t(`categories.${i18nKey}.description`)}
                  </p>
                  <p className="mt-5 font-mono text-[10px] tracking-[0.14em] text-brand uppercase">
                    {items.length} {t("registry.entries")}
                  </p>
                </div>

                <div className="divide-y divide-border-base border-y border-border-base">
                  {items.map((project) => (
                    <ProjectRow
                      key={project.slug}
                      project={project}
                      locale={locale}
                      evidenceLabel={t("registry.evidence")}
                      siteLabel={t("card.site")}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </section>

      <section className="border-y border-border-base bg-surface/30">
        <div className="mx-auto grid w-full max-w-7xl gap-8 px-5 py-12 sm:px-8 lg:grid-cols-[1fr_auto] lg:items-center lg:px-12">
          <div>
            <p className="font-mono text-[11px] font-medium tracking-[0.24em] text-brand uppercase">
              {t("submit.eyebrow")}
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-[-0.035em]">
              {t("submit.title")}
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-1">
              {t("submit.summary")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-4 lg:justify-end">
            <Link
              href={SUBMIT_ISSUE_URL}
              target="_blank"
              rel="noreferrer"
              className="btn-3d-brand inline-flex h-11 items-center gap-2 rounded-full bg-brand-deep px-5 text-[13px] font-semibold text-white transition hover:bg-brand"
            >
              <PlusIcon className="size-4" weight="bold" />
              {t("submit.openIssue")}
            </Link>
            <Link
              href={REGISTRY_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-sm font-semibold text-brand hover:underline"
            >
              built-with.json
              <ArrowUpRightIcon className="size-4" weight="bold" />
            </Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="border-border-base px-3 py-4 even:border-l sm:border-l sm:first:border-l-0">
      <p className="font-mono text-lg font-semibold tracking-[-0.04em] text-foreground">
        {value}
      </p>
      <p className="mt-0.5 whitespace-nowrap font-mono text-[8px] tracking-[0.1em] text-muted-2 uppercase">
        {label}
      </p>
    </div>
  );
}

function FeaturedProject({
  project,
  screenshotAlt,
  siteLabel,
}: {
  project: Project;
  screenshotAlt: string;
  siteLabel: string;
}) {
  const repoUrl = `https://github.com/${project.repo}`;
  const homepageUrl = safeHttpUrl(project.homepage);
  const primaryHref = homepageUrl ?? repoUrl;

  return (
    <article className="relative flex min-h-[500px] flex-col justify-center bg-surface/20 px-5 py-10 sm:px-8 lg:px-12 lg:py-8 xl:h-full xl:min-h-0">
      <div className="absolute inset-y-0 left-0 w-px bg-gradient-to-b from-transparent via-brand/40 to-transparent lg:hidden" />
      <Link
        href={primaryHref}
        target="_blank"
        rel="noreferrer"
        className="group relative block aspect-[1280/577] overflow-hidden border border-border-base bg-background shadow-[0_28px_80px_rgba(0,0,0,0.22)]"
      >
        <Image
          src={project.screenshot}
          alt={screenshotAlt}
          fill
          loading="eager"
          sizes="(max-width: 1024px) 100vw, 55vw"
          className="object-cover transition duration-500 group-hover:scale-[1.015]"
        />
        <div className="absolute inset-0 ring-1 ring-inset ring-white/10" />
      </Link>

      <div className="mt-5 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-start">
        <div>
          <h2 className="text-2xl font-semibold tracking-[-0.04em]">
            {project.name}
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-1">
            {project.tagline}
          </p>
        </div>
        <a
          href={primaryHref}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand hover:underline"
        >
          {homepageUrl ? siteLabel : project.repo}
          <ArrowUpRightIcon className="size-4" weight="bold" />
        </a>
      </div>
    </article>
  );
}

function ProjectRow({
  project,
  locale,
  evidenceLabel,
  siteLabel,
}: {
  project: Project;
  locale: string;
  evidenceLabel: string;
  siteLabel: string;
}) {
  const repoUrl = `https://github.com/${project.repo}`;
  const homepageUrl = safeHttpUrl(project.homepage);
  const primaryHref = homepageUrl ?? repoUrl;

  return (
    <article
      id={project.slug}
      className="group scroll-mt-20 py-5 first:pt-0 last:pb-0 sm:grid sm:grid-cols-[112px_minmax(0,1fr)] sm:gap-5"
    >
      <a
        href={primaryHref}
        target="_blank"
        rel="noreferrer"
        className="relative mb-4 block aspect-[16/10] overflow-hidden border border-border-base bg-surface sm:mb-0"
      >
        <Image
          src={project.screenshot}
          alt=""
          fill
          sizes="112px"
          className="object-cover transition duration-300 group-hover:scale-[1.03]"
        />
      </a>

      <div className="min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div>
            <h4 className="text-base font-semibold tracking-tight">
              {project.name}
            </h4>
            <p className="mt-1 text-sm leading-5 text-muted-1">
              {project.tagline}
            </p>
          </div>
          <a
            href={primaryHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-brand hover:underline"
          >
            {homepageUrl ? siteLabel : project.repo}
            <ArrowUpRightIcon className="size-3.5" weight="bold" />
          </a>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[10px] text-muted-2">
          <span>{project.language}</span>
          <span>{project.platforms.slice(0, 3).join(" · ")}</span>
          {project.stars > 0 ? (
            <span className="inline-flex items-center gap-1">
              <StarIcon className="size-3" weight="fill" />
              {formatLocalizedNumber(project.stars, locale)}
            </span>
          ) : null}
          <a
            href={repoUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 transition hover:text-foreground"
          >
            <GithubIcon className="size-3" />
            {project.repo}
          </a>
        </div>

        <p className="mt-3 line-clamp-1 text-[11px] leading-5 text-muted-2">
          <span className="font-mono text-[9px] tracking-[0.12em] text-brand uppercase">
            {evidenceLabel}
          </span>{" "}
          “{project.evidence.quote}”
        </p>
      </div>
    </article>
  );
}
