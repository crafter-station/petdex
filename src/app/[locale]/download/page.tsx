import Image from "next/image";
import Link from "next/link";

import {
  ArrowRight,
  CheckCircle,
  Clock,
  MonitorSmartphone,
  Pointer,
  Zap,
} from "lucide-react";
import { getTranslations } from "next-intl/server";

import { buildLocaleAlternates } from "@/lib/locale-routing";

import { CommandLine } from "@/components/command-line";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata = {
  title: "Download Petdex Desktop",
  description:
    "Download Petdex Desktop for macOS. Your pet, floating beside every coding agent.",
  alternates: buildLocaleAlternates("/download"),
};

const RELEASES_URL =
  "https://github.com/crafter-station/petdex/releases/latest";

type DownloadPageProps = {
  searchParams: Promise<{ next?: string | string[] }>;
};

function parsePendingPet(next: string | string[] | undefined): string | null {
  const value = Array.isArray(next) ? next[0] : next;
  if (!value || !value.startsWith("install/")) return null;
  const slug = value.slice("install/".length);
  // Mirror the server slug regex so a malformed ?next= can't render anything.
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return null;
  return slug;
}

export default async function DownloadPage({
  searchParams,
}: DownloadPageProps) {
  const t = await getTranslations("download");
  const params = await searchParams;
  const pendingPet = parsePendingPet(params.next);

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

  return (
    <main className="relative min-h-dvh bg-background text-foreground">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[760px] overflow-clip"
      >
        <div className="absolute -top-40 left-1/2 size-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,oklch(from_var(--brand)_l_c_h/0.18),transparent_70%)] blur-3xl dark:bg-[radial-gradient(closest-side,oklch(from_var(--brand)_l_c_h/0.16),transparent_70%)]" />
        <div className="absolute top-32 left-[8%] size-[480px] rounded-full bg-[radial-gradient(closest-side,oklch(from_var(--brand-light)_l_c_h/0.22),transparent_75%)] blur-3xl dark:bg-[radial-gradient(closest-side,oklch(from_var(--gradient-a)_l_c_h/0.3),transparent_75%)] dark:opacity-50" />
        <div className="absolute top-52 right-[6%] size-[420px] rounded-full bg-[radial-gradient(closest-side,oklch(from_var(--brand-deep)_l_c_h/0.18),transparent_75%)] blur-3xl dark:bg-[radial-gradient(closest-side,oklch(from_var(--gradient-b)_l_c_h/0.25),transparent_75%)] dark:opacity-50" />
      </div>

      <SiteHeader />

      {pendingPet ? (
        <div className="relative z-10 border-border-base/60 border-b bg-brand/10 backdrop-blur-sm">
          <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-1 px-5 py-3 md:flex-row md:items-center md:gap-3 md:px-8">
            <p className="text-sm text-foreground">
              <span className="font-semibold text-brand">
                {t("pendingPet.eyebrow")}
              </span>{" "}
              {t("pendingPet.messageBefore")}{" "}
              <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs">
                {pendingPet}
              </code>{" "}
              {t("pendingPet.messageAfter")}
            </p>
            <p className="text-xs text-muted-2 md:ml-auto">
              {t("pendingPet.hint")}
            </p>
          </div>
        </div>
      ) : null}

      <section className="mx-auto w-full max-w-[1440px] px-5 pt-16 pb-12 md:px-8 md:pt-24">
        <div className="flex flex-col items-center text-center">
          <div className="relative size-40 drop-shadow-2xl md:size-64">
            <Image
              src="/brand/petdex-desktop-icon.png"
              alt="Petdex Desktop"
              fill
              className="object-contain"
              priority
            />
          </div>

          <p className="mt-8 font-mono text-xs tracking-[0.22em] text-brand uppercase">
            {t("eyebrow")}
          </p>
          <h1 className="mt-3 text-[48px] leading-[0.98] font-semibold tracking-tight md:text-[72px]">
            {t("title")}
          </h1>
          <p className="mt-5 max-w-lg text-balance text-base leading-7 text-muted-1 md:text-lg">
            {t("subtitle")}
          </p>

          <div className="mt-10 flex w-full flex-col items-center gap-3">
            <div className="flex w-full flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
              <a
                href={RELEASES_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-inverse px-6 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
              >
                {t("hero.downloadCta")}
                <ArrowRight className="size-4" />
              </a>

              <CommandLine
                command="npx petdex install desktop"
                source="download-hero"
                className="!h-12 w-full !rounded-full !px-5 !text-[13px] sm:w-auto sm:min-w-[280px]"
              />
            </div>
            <p className="text-xs text-muted-3">{t("hero.cliSubtext")}</p>
          </div>
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
            <li className="flex gap-5">
              <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-brand font-mono text-xs font-semibold text-on-inverse">
                1
              </span>
              <div className="flex flex-col gap-2">
                <p className="font-semibold text-foreground">
                  {t("setup.step1.title")}
                </p>
                <CommandLine
                  command="npx petdex install desktop"
                  source="download-step1"
                  className="w-full max-w-sm"
                />
              </div>
            </li>

            <li className="flex gap-5">
              <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-brand font-mono text-xs font-semibold text-on-inverse">
                2
              </span>
              <div className="flex flex-col gap-2">
                <p className="font-semibold text-foreground">
                  {t("setup.step2.title")}
                </p>
                <CommandLine
                  command="petdex hooks install"
                  source="download-step2"
                  className="w-full max-w-sm"
                />
                <p className="text-xs text-muted-3">{t("setup.step2.hint")}</p>
              </div>
            </li>

            <li className="flex gap-5">
              <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-brand font-mono text-xs font-semibold text-on-inverse">
                3
              </span>
              <div className="flex flex-col gap-2">
                <p className="font-semibold text-foreground">
                  {t("setup.step3.title")}
                </p>
                <CommandLine
                  command="petdex desktop start"
                  source="download-step3"
                  className="w-full max-w-sm"
                />
              </div>
            </li>

            <li className="flex gap-5">
              <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-surface font-mono text-xs font-semibold text-muted-2 ring-1 ring-border-base">
                4
              </span>
              <div className="flex flex-col gap-2">
                <p className="font-semibold text-foreground">
                  {t("setup.step4.title")}
                </p>
                <CommandLine
                  command="petdex update"
                  source="download-step4"
                  className="w-full max-w-sm"
                />
                <p className="text-xs text-muted-3">{t("setup.step4.hint")}</p>
              </div>
            </li>
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
            href="/docs"
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
