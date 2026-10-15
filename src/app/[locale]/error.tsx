"use client";

import Link from "next/link";
import { useEffect } from "react";

import { RotateCcw, Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { withLocale } from "@/lib/locale-routing";

import { hasLocale, type Locale } from "@/i18n/config";

// Route-level error boundary for every page under /[locale]. Without it a
// server-side failure in any of the data-fetching pages (collections,
// leaderboard, stickers, profile, pet detail) fell through to Next's built-in
// error page: English, no locale shell, and no way back. `reset` re-renders
// the segment, so a transient failure is retryable in place.
export default function LocaleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errorPage");
  const rawLocale = useLocale();
  const currentLocale: Locale = hasLocale(rawLocale) ? rawLocale : "en";

  useEffect(() => {
    console.error("[route] unhandled error in /[locale]", error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-5 px-6 text-center">
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">
        {t("title")}
      </h1>
      <p className="text-balance text-sm leading-6 text-muted-1">{t("body")}</p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-inverse px-5 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
        >
          <RotateCcw className="size-4" />
          {t("retry")}
        </button>
        <Link
          href={withLocale("/", currentLocale)}
          className="inline-flex h-11 items-center gap-2 rounded-full border border-border-base bg-surface px-5 text-sm font-medium text-foreground transition hover:border-border-strong"
        >
          <Search className="size-4" />
          {t("home")}
        </Link>
      </div>
    </main>
  );
}
