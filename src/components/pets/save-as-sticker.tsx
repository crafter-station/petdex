"use client";

import Link from "next/link";

import { Sticker } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { withLocale } from "@/lib/locale-routing";

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
      className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-border-base bg-surface/70 px-3.5 text-[13px] font-medium text-muted-2 backdrop-blur transition hover:bg-brand/10 hover:text-brand"
    >
      <Sticker className="size-4" />
      {t("openExplorer")}
    </Link>
  );
}
