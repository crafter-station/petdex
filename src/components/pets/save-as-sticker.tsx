"use client";

import Link from "next/link";

import { Sticker } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { withLocale } from "@/lib/locale-routing";
import { cn } from "@/lib/utils";

import { buttonVariants } from "@/components/ui/button";

import { hasLocale } from "@/i18n/config";

type Props = {
  slug: string;
  displayName: string;
  collectionSlug: string;
};

export function SaveAsSticker({ slug, displayName, collectionSlug }: Props) {
  const rawLocale = useLocale();
  const locale = hasLocale(rawLocale) ? rawLocale : "en";
  const t = useTranslations("stickers");
  const params = new URLSearchParams({
    reaction: "waiting",
    pet: slug,
    treatment: "outline",
  });

  return (
    <Link
      href={`${withLocale(`/stickers/${collectionSlug}`, locale)}?${params.toString()}`}
      aria-label={`${t("openExplorer")} · ${displayName}`}
      className={cn(
        buttonVariants({ variant: "pearl", size: "lg" }),
        "gap-2 rounded-xl px-3.5 text-[13px] font-medium",
      )}
    >
      <Sticker className="size-4" />
      {t("openExplorer")}
    </Link>
  );
}
