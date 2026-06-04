"use client";

import Link from "next/link";
import { useState } from "react";

import { ArrowRight, Palette } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { CodexLogo } from "@/components/codex-logo";
import { CodexThemeDialog } from "@/components/codex-theme-dialog";
import { CommandLine } from "@/components/command-line";
import { Button } from "@/components/ui/button";

type InstallCommandCompactProps = {
  slug: string;
  displayName: string;
};

/**
 * Minimal install line for the pet hero. Two columns on md+: the npx
 * command on the left and a "Theme my Codex" card on the right that
 * opens a dialog with a Codex Desktop theme derived from the pet's
 * dominant color. On mobile they stack. A discreet link to the full
 * install guide sits underneath. The verbose tutorial (Curl tab,
 * Terminal.app instructions, "Activate in Codex") lives under the
 * state viewer below the hero so it does not compete with the primary
 * "Open in Petdex Desktop" CTA above.
 */
export function InstallCommandCompact({
  slug,
  displayName,
}: InstallCommandCompactProps) {
  const t = useTranslations("installCompact");
  const locale = useLocale();
  const [themeOpen, setThemeOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <div className="grid items-stretch gap-2 md:grid-cols-[1fr_auto]">
        <CommandLine
          command={`npx petdex install ${slug}`}
          source="pet-hero-compact"
          className="!h-12 w-full !rounded-2xl !px-4 !text-[13px]"
        />
        <Button
          variant="outline"
          onClick={() => setThemeOpen(true)}
          className="group/theme h-12 max-w-full gap-2 overflow-hidden rounded-2xl border-border-base bg-surface/80 px-3 text-left text-[12px] text-foreground backdrop-blur hover:border-brand-light/40 hover:bg-surface md:px-4"
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface ring-1 ring-border-base/40">
            <CodexLogo className="size-4" />
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[12px] font-semibold text-foreground">
              {t("themeCodexLabel")}
            </span>
            <span className="truncate text-[10px] text-muted-3">
              {t("themeCodexHint")}
            </span>
          </span>
          <Palette className="size-3.5 shrink-0 text-muted-3 transition group-hover/theme:text-brand" />
        </Button>
      </div>
      <Link
        href={`/${locale}/docs#install`}
        prefetch={false}
        className="group inline-flex items-center gap-1 self-start text-muted-3 text-xs transition hover:text-foreground"
      >
        {t("seeGuide")}
        <ArrowRight className="size-3 transition group-hover:translate-x-0.5" />
      </Link>
      <CodexThemeDialog
        open={themeOpen}
        onOpenChange={setThemeOpen}
        petSlug={slug}
        petDisplayName={displayName}
      />
    </div>
  );
}
