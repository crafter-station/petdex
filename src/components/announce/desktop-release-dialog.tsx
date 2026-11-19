"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";

import { ArrowDownToLine } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

import { localizePath } from "@/i18n/config";

// Bump the suffix to announce a later release; the old key stays
// dismissed so nobody who already closed v0.3.0 sees it again.
const SEEN_KEY = "petdex:announce:desktop-v030";

/**
 * The one dialog on this site that opens by itself.
 *
 * It waits a beat before showing: a modal that lands during first paint
 * reads as an interstitial and gets dismissed without being read, and
 * it would also fight the gallery for the user's first impression.
 *
 * Dismissal is remembered in localStorage rather than a cookie because
 * nothing here needs to reach the server, and a per-release key means
 * announcing the next version costs one string.
 */
export function DesktopReleaseDialog() {
  const [open, setOpen] = useState(false);
  const t = useTranslations("desktopAnnounce");
  const locale = useLocale();

  useEffect(() => {
    let seen = true;
    try {
      seen = window.localStorage.getItem(SEEN_KEY) === "1";
    } catch {
      // Private mode or blocked storage: treat it as seen. An
      // announcement that reappears every visit is worse than one
      // nobody sees.
    }
    if (seen) return;
    const timer = window.setTimeout(() => setOpen(true), 1200);
    return () => window.clearTimeout(timer);
  }, []);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      try {
        window.localStorage.setItem(SEEN_KEY, "1");
      } catch {}
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton
        className="max-w-[min(92vw,660px)] gap-0 overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">{t("title")}</DialogTitle>

        <Image
          src="/brand/announce/desktop-v030.png"
          alt={t("imageAlt")}
          width={1200}
          height={900}
          priority
          className="h-auto w-full"
        />

        <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm leading-5 text-muted-2">{t("body")}</p>
          <Link
            href={localizePath(locale, "/download")}
            onClick={() => handleOpenChange(false)}
            className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-brand px-5 text-sm font-semibold text-on-inverse transition hover:bg-brand-deep"
          >
            <ArrowDownToLine className="size-4" />
            {t("cta")}
          </Link>
        </div>
      </DialogContent>
    </Dialog>
  );
}
