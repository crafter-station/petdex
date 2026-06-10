import Image from "next/image";
import Link from "next/link";

import {
  ArrowRight,
  CheckCircle,
  Clock,
  Command,
  MonitorSmartphone,
  Pointer,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { buildLocaleAlternates } from "@/lib/locale-routing";
import { getPet } from "@/lib/pets";

import { CommandLine } from "@/components/command-line";
import { DownloadCTA } from "@/components/download-cta";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { StaticPetSprite } from "@/components/static-pet-sprite";

import { hasLocale } from "@/i18n/config";
import { buildSetupSteps, parsePendingInstallSlugs } from "./setup-steps";

const SITE_URL = "https://petdex.dev";
const DEFAULT_PREVIEW_PET_SLUG = "boba";
const DEFAULT_PREVIEW_PET = {
  displayName: "Boba",
  spritesheetPath: "https://assets.petdex.dev/curated/boba/spritesheet.webp",
};

// Auto-detected /download/opengraph-image is locale-prefixed
// (/en/download/opengraph-image) and next-intl rewrites that with a
// 307. Most social scrapers (Discord, X) do not follow OG redirects
// and silently fall back to the parent layout's image, so unfurls
// would show the generic Petdex card instead of the desktop hero.
// Pin the URL to the locale-stripped path the same way per-collection
// metadata does.
const OG_IMAGE = `${SITE_URL}/download/opengraph-image`;

// Public page now (admin gate lifted on 2026-05-10 alongside the
// petdex:// URL scheme + 9-state bubble UI launch). Index + follow
// so the desktop landing surfaces in search.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return {
    title: "Download Petdex Desktop",
    description:
      "Download Petdex Desktop for macOS. Your pet, floating beside every coding agent.",
    alternates: buildLocaleAlternates(
      "/download",
      hasLocale(locale) ? locale : undefined,
    ),
    openGraph: {
      title: "Petdex Desktop",
      description:
        "Your pet, floating beside every coding agent. macOS native.",
      url: `${SITE_URL}/download`,
      images: [{ url: OG_IMAGE, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Petdex Desktop",
      description: "Your pet, floating beside every coding agent.",
      images: [OG_IMAGE],
    },
  };
}

// Force-dynamic so the latest-release fetch runs per request —
// otherwise users see a cached release tag that drifts behind
// what's actually on GitHub.
export const dynamic = "force-dynamic";

type DownloadPageProps = {
  searchParams: Promise<{ next?: string | string[] }>;
};

export default async function DownloadPage({
  searchParams,
}: DownloadPageProps) {
  const t = await getTranslations("download");
  const locale = await getLocale();
  const params = await searchParams;
  const pendingInstallSlugs = parsePendingInstallSlugs(params.next);
  const activationCommand =
    pendingInstallSlugs && pendingInstallSlugs.length > 0
      ? `npx petdex init && npx petdex install ${pendingInstallSlugs.join(" ")}`
      : "npx petdex init";
  const pendingLabel =
    pendingInstallSlugs && pendingInstallSlugs.length > 0
      ? pendingInstallSlugs.length === 1
        ? pendingInstallSlugs[0]
        : pendingInstallSlugs.join(", ")
      : null;
  const previewIsPending = (pendingInstallSlugs?.length ?? 0) > 0;
  const previewSlug = pendingInstallSlugs?.[0] ?? DEFAULT_PREVIEW_PET_SLUG;
  const resolvedPreviewPet = await getPet(previewSlug);
  const previewPet = resolvedPreviewPet
    ? {
        displayName: resolvedPreviewPet.displayName,
        spritesheetPath: resolvedPreviewPet.spritesheetPath,
      }
    : previewSlug === DEFAULT_PREVIEW_PET_SLUG
      ? DEFAULT_PREVIEW_PET
      : null;
  const previewPetName = previewPet?.displayName ?? pendingLabel;

  const features = [
    {
      icon: Zap,
      title: t("features.crossAgent.title"),
      description: t("features.crossAgent.description"),
    },
    {
      icon: MonitorSmartphone,
      title: t("features.alwaysWithYou.title"),
      description: t("features.alwaysWithYou.description"),
    },
    {
      icon: Pointer,
      title: t("features.pickYourFighter.title"),
      description: t("features.pickYourFighter.description"),
    },
  ];

  const platforms = [
    {
      name: t("platforms.macos.name"),
      detail: t("platforms.macos.detail"),
      available: true,
    },
    {
      name: t("platforms.linux.name"),
      detail: t("platforms.linux.detail"),
      available: false,
    },
    {
      name: t("platforms.windows.name"),
      detail: t("platforms.windows.detail"),
      available: false,
    },
  ];

  const activationItems = [
    {
      icon: Command,
      label: t("activation.items.hooks"),
    },
    {
      icon: ShieldCheck,
      label: t("activation.items.desktop"),
    },
    {
      icon: Sparkles,
      label: t("activation.items.pet"),
    },
  ];

  return (
    <main className="relative min-h-dvh bg-background text-foreground">
      <SiteHeader />

      <section className="mx-auto w-full max-w-[1440px] px-5 pt-10 pb-12 md:px-8 md:pt-16">
        <div className="grid min-w-0 items-center gap-10 lg:grid-cols-[minmax(0,0.95fr)_minmax(420px,1fr)]">
          <div className="min-w-0 max-w-2xl">
            <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
              {t("eyebrow")}
            </p>
            <h1 className="mt-3 text-pretty text-[40px] leading-[0.98] font-semibold tracking-tight sm:text-[52px] md:text-[72px]">
              {t("title")}
            </h1>
            <p className="mt-5 max-w-xl text-pretty text-base leading-7 text-muted-1 md:text-lg">
              {t("subtitle")}
            </p>

            {pendingLabel ? (
              <div className="mt-6 inline-flex max-w-full items-center gap-2 rounded-lg border border-brand/20 bg-brand-tint px-3 py-2 text-sm text-brand-deep dark:bg-brand-tint-dark dark:text-brand-light">
                <Sparkles className="size-4 shrink-0" />
                <span className="min-w-0">
                  {t("pendingPet.messageBefore")}{" "}
                  <code className="rounded bg-surface/80 px-1.5 py-0.5 font-mono text-xs">
                    {pendingLabel}
                  </code>{" "}
                  {t("pendingPet.messageAfter")}
                </span>
              </div>
            ) : null}

            <DownloadCTA
              primaryLabel={t("hero.primaryTitle")}
              cliCommand={activationCommand}
              cliSubtext={t("hero.cliSubtext")}
              manualLabel={t("hero.manualLabel")}
              manualSubtext={t("hero.manualSubtext")}
              comingSoonLabel={t("hero.comingSoon")}
              desktopOnlyLabel={t("hero.desktopOnly")}
            />

            <div className="mt-5 grid gap-2 sm:grid-cols-3">
              {activationItems.map((item) => {
                const Icon = item.icon;
                return (
                  <div
                    key={item.label}
                    className="flex min-w-0 items-center gap-2 rounded-lg border border-border-base bg-surface px-3 py-2 text-sm text-muted-1"
                  >
                    <Icon className="size-4 shrink-0 text-brand" />
                    <span className="truncate">{item.label}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <DesktopActivationPreview
            pendingLabel={previewPetName}
            pendingPet={previewPet}
            title={t("preview.title")}
            status={t("preview.status")}
            terminalLabel={t("preview.terminalLabel")}
            agentLabel={t("preview.agentLabel")}
            petLabel={
              previewPetName
                ? previewIsPending
                  ? t("preview.pendingPet", { slug: previewPetName })
                  : t("preview.demoPet", { slug: previewPetName })
                : t("preview.defaultPet")
            }
          />
        </div>
      </section>

      <section
        id="what-it-does"
        className="mx-auto w-full max-w-[1440px] px-5 py-16 md:px-8"
      >
        <div className="text-center">
          <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
            {t("features.eyebrow")}
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
            {t("features.title")}
          </h2>
        </div>

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {features.map((feature) => {
            const Icon = feature.icon;
            return (
              <div
                key={feature.title}
                className="flex flex-col gap-4 rounded-3xl border border-border-base bg-surface p-6"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-tint text-brand ring-1 ring-brand/15 dark:bg-brand-tint-dark dark:ring-brand/25">
                  <Icon className="size-5" />
                </span>
                <div>
                  <h3 className="text-base font-semibold text-foreground">
                    {feature.title}
                  </h3>
                  <p className="mt-1.5 text-sm leading-6 text-muted-2">
                    {feature.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section
        id="how-it-works"
        className="mx-auto w-full max-w-[1440px] px-5 py-16 md:px-8"
      >
        <div className="mx-auto max-w-2xl">
          <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
            {t("setup.eyebrow")}
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
            {t("setup.title")}
          </h2>

          <ol className="mt-10 flex flex-col gap-8">
            {buildSetupSteps(t, pendingInstallSlugs).map((step, idx) => {
              const number = idx + 1;
              const dotClass = step.dimmed
                ? "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-surface font-mono text-xs font-semibold text-muted-2 ring-1 ring-border-base"
                : "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-brand font-mono text-xs font-semibold text-on-inverse";
              return (
                <li key={step.key} className="flex gap-5">
                  <span className={dotClass}>{number}</span>
                  <div className="flex flex-col gap-2">
                    <p className="font-semibold text-foreground">
                      {step.title}
                    </p>
                    <CommandLine
                      command={step.command}
                      source={`download-${step.key}`}
                      className="w-full max-w-sm"
                    />
                    {step.hint ? (
                      <p className="text-xs text-muted-3">{step.hint}</p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1440px] px-5 py-16 md:px-8">
        <div className="mx-auto max-w-2xl">
          <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
            {t("platforms.eyebrow")}
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
            {t("platforms.title")}
          </h2>

          <div className="mt-8 flex flex-col divide-y divide-border-base overflow-hidden rounded-2xl border border-border-base bg-surface">
            {platforms.map((platform) => (
              <div
                key={platform.name}
                className="flex items-center justify-between gap-4 px-5 py-4"
              >
                <div>
                  <p className="font-medium text-foreground">{platform.name}</p>
                  <p className="text-sm text-muted-3">{platform.detail}</p>
                </div>
                {platform.available ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-600 ring-1 ring-emerald-500/20 dark:text-emerald-400">
                    <CheckCircle className="size-3.5" />
                    {t("platforms.available")}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-muted px-3 py-1 text-xs font-medium text-muted-3 ring-1 ring-border-base">
                    <Clock className="size-3.5" />
                    {t("platforms.comingSoon")}
                  </span>
                )}
              </div>
            ))}
          </div>

          <p className="mt-4 text-sm text-muted-3">{t("platforms.footer")}</p>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1440px] px-5 py-10 md:px-8">
        <div className="mx-auto max-w-2xl">
          <Link
            href={`/${locale}/docs`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-brand transition hover:text-brand-deep"
          >
            {t("docsLink")}
            <ArrowRight className="size-4" />
          </Link>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}

function DesktopActivationPreview({
  pendingLabel,
  pendingPet,
  title,
  status,
  terminalLabel,
  agentLabel,
  petLabel,
}: {
  pendingLabel: string | null;
  pendingPet: { displayName: string; spritesheetPath: string } | null;
  title: string;
  status: string;
  terminalLabel: string;
  agentLabel: string;
  petLabel: string;
}) {
  return (
    <div className="relative min-w-0 overflow-hidden rounded-lg border border-border-base bg-surface p-4 shadow-[0_32px_90px_-60px_rgba(15,23,42,0.6)]">
      <div className="absolute inset-x-0 top-0 h-1 bg-brand" />
      <div className="flex items-center gap-2 border-border-base border-b pb-3">
        <span className="size-3 rounded-full bg-rose-400" />
        <span className="size-3 rounded-full bg-amber-400" />
        <span className="size-3 rounded-full bg-emerald-400" />
        <span className="ml-2 truncate text-xs font-medium text-muted-3">
          Petdex Desktop
        </span>
      </div>

      <div className="grid gap-4 pt-5 sm:grid-cols-[1fr_160px]">
        <div className="space-y-3">
          <div className="rounded-lg border border-border-base bg-background p-4">
            <p className="text-xs font-medium text-muted-3">{terminalLabel}</p>
            <div className="mt-3 space-y-2 font-mono text-xs">
              <p>
                <span className="text-brand">$</span>{" "}
                <span className="text-foreground">npx petdex init</span>
              </p>
              <p className="text-muted-3">✓ {agentLabel}</p>
              <p className="text-muted-3">✓ {petLabel}</p>
            </div>
          </div>

          <div className="rounded-lg border border-border-base bg-background p-4">
            <div className="flex items-start gap-3">
              <div className="relative size-12 shrink-0">
                <Image
                  src="/brand/petdex-desktop-icon.png"
                  alt=""
                  fill
                  className="object-contain"
                  sizes="48px"
                />
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-foreground">{title}</p>
                <p className="mt-1 text-sm leading-5 text-muted-2">{status}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="relative min-h-[210px] overflow-hidden rounded-lg border border-border-base bg-[linear-gradient(135deg,var(--surface-muted),var(--surface))] p-3">
          <div className="absolute inset-x-3 top-3 rounded-lg border border-border-base bg-surface/80 p-3">
            <div className="h-2 w-24 rounded-full bg-border-base" />
            <div className="mt-2 h-2 w-16 rounded-full bg-border-base/70" />
          </div>
          {pendingPet ? (
            <div className="pet-sprite-stage absolute right-4 bottom-7 grid size-28 place-items-center rounded-lg border border-brand/20 bg-surface shadow-xl">
              <StaticPetSprite
                src={pendingPet.spritesheetPath}
                state="idle"
                scale={0.46}
                label={pendingPet.displayName}
              />
            </div>
          ) : (
            <div className="absolute right-5 bottom-7 grid size-24 place-items-center rounded-lg border border-brand/20 bg-surface shadow-xl">
              <Image
                src="/brand/petdex-desktop-icon.png"
                alt="Petdex Desktop"
                width={80}
                height={80}
                className="object-contain"
              />
            </div>
          )}
          {pendingLabel ? (
            <span className="absolute bottom-3 left-3 max-w-[120px] truncate rounded-lg bg-brand px-2 py-1 text-xs font-medium text-on-inverse">
              {pendingLabel}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
