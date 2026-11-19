"use client";

import { useEffect, useState } from "react";

import { useTranslations } from "next-intl";

import {
  buildCodexInstallUrl,
  isCodexDesktopOs,
  openCodexDeepLink,
} from "@/lib/codex-desktop-link";

import { CodexLogo } from "@/components/download/codex-logo";

type OpenInCodexButtonProps = {
  displayName: string;
  description: string;
  spritesheetUrl: string;
  spriteVersionNumber: 1 | 2;
};

/**
 * Secondary CTA on /pets/<slug>, below the primary "Open in Petdex
 * Desktop" button. Codex Desktop is OpenAI's app, not ours, so this
 * reads as a lower-weight outline button rather than the brand
 * gradient used for the Petdex CTA.
 *
 * Click behavior mirrors OpenInPetdexButton: try the codex:// scheme,
 * fall back if nothing answers. The fallback target is
 * chatgpt.com/codex/download (OpenAI's own download page) rather than
 * our /download route, because /download installs Petdex Desktop, a
 * different app that this button has nothing to do with. A user who
 * clicks "Open in Codex" without the app installed needs the app, not
 * our installer.
 *
 * Detection: Codex Desktop ships for macOS and Windows (unlike Petdex
 * Desktop, mac-only), so this unhides on both instead of macOS alone.
 */
export function OpenInCodexButton({
  displayName,
  description,
  spritesheetUrl,
  spriteVersionNumber,
}: OpenInCodexButtonProps) {
  const [mounted, setMounted] = useState(false);
  const [supported, setSupported] = useState(false);
  const t = useTranslations("openInCodex");

  useEffect(() => {
    setMounted(true);
    setSupported(isCodexDesktopOs());
  }, []);

  if (!mounted || !supported) return null;

  const fallbackHref = "https://chatgpt.com/codex/download";
  const deepLink = buildCodexInstallUrl({
    displayName,
    description,
    spritesheetUrl,
    spriteVersionNumber,
  });

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    openCodexDeepLink(deepLink, fallbackHref);
  }

  return (
    <a
      href={fallbackHref}
      target="_blank"
      rel="noreferrer"
      onClick={handleClick}
      aria-label={t("ariaLabel", { displayName })}
      className="group inline-flex w-full items-center gap-3 rounded-2xl border border-border-base bg-surface/80 p-3 text-left backdrop-blur transition-colors hover:border-brand-light/40 hover:bg-surface"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface ring-1 ring-border-base/40">
        <CodexLogo className="size-5" />
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium text-foreground text-sm leading-tight">
          {t("label")}
        </span>
        <span className="text-muted-3 text-xs leading-tight">
          {t("subtitle")}
        </span>
      </span>
    </a>
  );
}
