"use client";

import Image from "next/image";

import { Apple, ArrowDownToLine } from "lucide-react";

import {
  type MacArch,
  type Platform,
  useMacArch,
  usePlatform,
} from "@/lib/use-platform";
import { cn } from "@/lib/utils";

import { CommandLine } from "@/components/download/command-line";
import { buttonVariants } from "@/components/ui/button";

const MACOS_ARM64_URL = "/api/desktop/latest-release?asset=darwin-arm64";
const MACOS_X64_URL = "/api/desktop/latest-release?asset=darwin-x64";
const WINDOWS_X64_URL = "/api/desktop/latest-release?asset=win32-x64";
const LINUX_X64_URL = "/api/desktop/latest-release?asset=linux-x64";

/**
 * The hero-row "Download for macOS" + CLI install CTA, rendered
 * differently per detected platform so we never offer a click that
 * dead-ends in a binary the user can't run.
 *
 *   macOS         → primary download button (DMG)
 *   windows/linux → direct download of the native binary
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
  desktopOnlyLabel,
}: {
  primaryLabel: string;
  cliCommand: string;
  cliSubtext: string;
  manualLabel: string;
  manualSubtext: string;
  desktopOnlyLabel: string;
}) {
  const platform = usePlatform();
  const arch = useMacArch();

  return (
    <div className="mt-8 grid w-full min-w-0 gap-3">
      <div className="min-w-0 overflow-hidden rounded-2xl border border-brand/20 bg-surface p-3 shadow-[0_18px_48px_-38px_rgba(15,23,42,0.55)]">
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
          <span className="relative grid size-11 shrink-0 place-items-center overflow-hidden rounded-xl border border-brand/20 bg-background shadow-sm">
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
            className="!h-10 w-full min-w-0 max-w-full !rounded-xl !border-border-base !bg-background !px-3 !py-2 !text-[12px] sm:w-auto sm:min-w-[260px] sm:max-w-[340px]"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <ManualDownloadButton
          platform={platform}
          arch={arch}
          manualLabel={manualLabel}
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
  desktopOnlyLabel,
}: {
  platform: Platform;
  arch: MacArch;
  manualLabel: string;
  desktopOnlyLabel: string;
}) {
  const manualButtonClassName = cn(
    buttonVariants({
      variant: "petdex-secondary",
      size: "petdex-pill",
    }),
    "h-11 w-full gap-2 text-sm sm:w-auto sm:min-w-[220px]",
  );

  // SSR / first paint / browser we couldn't classify: render a
  // skeleton-ish neutral pill instead of flashing a wrong CTA.
  // Same height/width as the macOS button to avoid layout shift.
  if (platform === "unknown" || platform === "other") {
    return (
      <span
        aria-hidden="true"
        className="inline-flex h-11 w-full animate-pulse items-center justify-center rounded-xl bg-surface-muted text-sm text-muted-3 sm:w-[220px]"
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
      <a href={href} rel="noreferrer" className={manualButtonClassName}>
        <ArrowDownToLine className="size-4" />
        {manualLabel}
        {labelSuffix ? (
          <span className="ml-1 text-xs opacity-75">{labelSuffix}</span>
        ) : null}
      </a>
    );
  }

  // Windows ships a real binary in every desktop release, so it gets the
  // same direct download macOS does.
  if (platform === "windows") {
    return (
      <a
        href={WINDOWS_X64_URL}
        rel="noreferrer"
        className={manualButtonClassName}
      >
        <ArrowDownToLine className="size-4" />
        {manualLabel}
      </a>
    );
  }

  // Linux ships a binary too, from the native build. The endpoint
  // answers 404 until a release carries that asset, which is the
  // honest failure: a stale pill would keep hiding a build that works.
  if (platform === "linux") {
    return (
      <a
        href={LINUX_X64_URL}
        rel="noreferrer"
        className={manualButtonClassName}
      >
        <ArrowDownToLine className="size-4" />
        {manualLabel}
      </a>
    );
  }

  // Mobile + iPad — desktop app fundamentally won't run here.
  return (
    <span
      aria-disabled="true"
      className={cn(
        manualButtonClassName,
        "pointer-events-none cursor-not-allowed opacity-60",
      )}
    >
      <Apple className="size-4" />
      {desktopOnlyLabel}
    </span>
  );
}
