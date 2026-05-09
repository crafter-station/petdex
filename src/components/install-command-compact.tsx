"use client";

import Link from "next/link";

import { ArrowRight } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { CommandLine } from "@/components/command-line";

type InstallCommandCompactProps = {
  slug: string;
};

/**
 * Minimal install line for the pet hero. One row: the npx command +
 * copy button, with a discreet link to the full install guide. The
 * verbose tutorial (Curl tab, Terminal.app instructions, "Activate in
 * Codex") lives under the state viewer below the hero — at this point
 * in the flow it would compete with the primary "Open in Petdex
 * Desktop" CTA above.
 */
export function InstallCommandCompact({ slug }: InstallCommandCompactProps) {
  const t = useTranslations("installCompact");
  const locale = useLocale();

  return (
    <div className="flex flex-col gap-2">
      <CommandLine
        command={`npx petdex install ${slug}`}
        source="pet-hero-compact"
        className="!h-12 w-full !rounded-2xl !px-4 !text-[13px]"
      />
      <Link
        href={`/${locale}/docs#install`}
        className="group inline-flex items-center gap-1 self-start text-muted-3 text-xs transition hover:text-foreground"
      >
        {t("seeGuide")}
        <ArrowRight className="size-3 transition group-hover:translate-x-0.5" />
      </Link>
    </div>
  );
}
