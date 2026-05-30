"use client";

import Image from "next/image";

import { Apple, ArrowDownToLine, Clock } from "lucide-react";

import {
  type MacArch,
  type Platform,
  useMacArch,
  usePlatform,
} from "@/lib/use-platform";

import { CommandLine } from "@/components/command-line";

const MACOS_ARM64_URL = "/api/desktop/latest-release?asset=darwin-arm64";
const MACOS_X64_URL = "/api/desktop/latest-release?asset=darwin-x64";

/**
 * The hero-row "Download for macOS" + CLI install CTA, rendered
 * differently per detected platform so we never offer a click that
 * dead-ends in a binary the user can't run.
 *
 *   macOS         → primary download button (direct binary)
 *   linux/win     → disabled "Coming soon" pill + still-works CLI note
 *                   (CLI itself runs on those platforms too, even if the
 *                   GUI binary isn't self-contained yet)
 *   ios/ipados    → "macOS-only desktop" coming-soon, no CTA at all
 *   android       → same as iOS
 *   unknown/other → neutral placeholder (SSR + first paint, or a
 *                   browser we couldn't classify)
 *
 * The CLI command line stays visible across every platform — the
 * `petdex install desktop` command just won't find a binary on
 * non-macOS today, but it returns a clear error rather than
 * pretending to install. That's still better DX than hiding the
 * mention entirely.
 */
export function DownloadCTA({
  primaryLabel,
  cliCommand,
  cliSubtext,
  manualLabel,
  manualSubtext,
  comingSoonLabel,
  desktopOnlyLabel,
}: {
  primaryLabel: string;
  cliCommand: string;
  cliSubtext: string;
  manualLabel: string;
  manualSubtext: string;
  comingSoonLabel: string;
  desktopOnlyLabel: string;
}) {
  const platform = usePlatform();
  const arch = useMacArch();

  return (
    <div className="mt-8 grid w-full min-w-0 gap-3">
      <div className="min-w-0 overflow-hidden rounded-lg border border-brand/20 bg-surface p-3 shadow-[0_18px_48px_-38px_rgba(15,23,42,0.55)]">
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
          <span className="relative grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg border border-brand/20 bg-background shadow-sm">
            <Image
              src="/brand/petdex-desktop-icon.png"
              alt=""
              fill
              className="object-contain p-1"
              sizes="44px"
            />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold text-foreground">
              {primaryLabel}
            </p>
            <p className="mt-0.5 text-sm leading-5 text-muted-2">
              {cliSubtext}
            </p>
          </div>
          <CommandLine
            command={cliCommand}
            source="download-hero-primary"
            className="!h-10 w-full min-w-0 max-w-full !rounded-lg !border-border-base !bg-background !px-3 !py-2 !text-[12px] sm:w-auto sm:min-w-[260px] sm:max-w-[340px]"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <ManualDownloadButton
          platform={platform}
          arch={arch}
          manualLabel={manualLabel}
          comingSoonLabel={comingSoonLabel}
          desktopOnlyLabel={desktopOnlyLabel}
        />
        <p className="text-xs leading-5 text-muted-3 sm:max-w-[260px]">
          {manualSubtext}
        </p>
      </div>
    </div>
  );
}

function ManualDownloadButton({
  platform,
  arch,
  manualLabel,
  comingSoonLabel,
  desktopOnlyLabel,
}: {
  platform: Platform;
  arch: MacArch;
  manualLabel: string;
  comingSoonLabel: string;
  desktopOnlyLabel: string;
}) {
  // SSR / first paint / browser we couldn't classify: render a
  // skeleton-ish neutral pill instead of flashing a wrong CTA.
  // Same height/width as the macOS button to avoid layout shift.
  if (platform === "unknown" || platform === "other") {
    return (
      <span
        aria-hidden="true"
        className="inline-flex h-11 w-full animate-pulse items-center justify-center rounded-lg bg-surface-muted text-sm text-muted-3 sm:w-[220px]"
      />
    );
  }

  if (platform === "macos") {
    // Apple Silicon (arm64) gets the M-series DMG. Intel users get
    // the x86_64 DMG. If we couldn't detect arch (Safari without
    // WebGL hints) we fall back to arm64 — most macOS users are on
    // Apple Silicon as of 2026, and Rosetta lets the arm64 binary
    // run on Intel anyway (slower, but it launches).
    const href = arch === "intel" ? MACOS_X64_URL : MACOS_ARM64_URL;
    const labelSuffix =
      arch === "intel"
        ? " (Intel)"
        : arch === "arm64"
          ? " (Apple Silicon)"
          : "";
    return (
      <a
        href={href}
        rel="noreferrer"
        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-border-base bg-surface px-4 text-sm font-medium text-foreground transition hover:border-border-strong hover:bg-surface-muted sm:w-auto sm:min-w-[220px]"
      >
        <ArrowDownToLine className="size-4" />
        {manualLabel}
        {labelSuffix ? (
          <span className="ml-1 text-xs opacity-75">{labelSuffix}</span>
        ) : null}
      </a>
    );
  }

  // Linux / Windows — binary not yet self-contained (sidecar bundling pending).
  if (platform === "linux" || platform === "windows") {
    return (
      <span
        aria-disabled="true"
        className="inline-flex h-11 w-full cursor-not-allowed items-center justify-center gap-2 rounded-lg border border-border-base bg-surface-muted px-4 text-sm font-medium text-muted-2 sm:w-auto sm:min-w-[220px]"
      >
        <Clock className="size-4" />
        {comingSoonLabel.replace(
          "{os}",
          platform === "windows" ? "Windows" : "Linux",
        )}
      </span>
    );
  }

  // Mobile + iPad — desktop app fundamentally won't run here.
  return (
    <span
      aria-disabled="true"
      className="inline-flex h-11 w-full cursor-not-allowed items-center justify-center gap-2 rounded-lg border border-border-base bg-surface-muted px-4 text-sm font-medium text-muted-2 sm:w-auto sm:min-w-[220px]"
    >
      <Apple className="size-4" />
      {desktopOnlyLabel}
    </span>
  );
}
