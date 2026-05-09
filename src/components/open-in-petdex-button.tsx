"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";

import { ArrowRight } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

type OpenInPetdexButtonProps = {
  slug: string;
};

/**
 * Hero CTA on /pets/<slug> that points the user at /download with a
 * pendingPet hint so the install banner picks the slug back up. macOS-
 * only for now since the desktop binary is mac-first.
 *
 * Why a plain link (not a `petdex://` scheme attempt yet):
 *
 * The desktop binary is currently shipped as a bare executable, not a
 * macOS .app bundle. macOS only registers URL schemes for bundles
 * declared via CFBundleURLTypes in Info.plist, so a `petdex://` link
 * would always fall through to the fallback redirect anyway. Skipping
 * the scheme attempt keeps the click predictable, avoids a confusing
 * 1500ms delay, and the copy stays honest. When we ship a real .app
 * bundle this component will gain back the scheme attempt path.
 *
 * Render rules:
 * - Server-renders nothing. The client detects platform after hydration
 *   and unhides on macOS so Linux/Windows/iOS users don't see a CTA
 *   that would dead-end at a binary they can't install.
 */
export function OpenInPetdexButton({ slug }: OpenInPetdexButtonProps) {
  const [mounted, setMounted] = useState(false);
  const [isMac, setIsMac] = useState(false);
  const t = useTranslations("openInPetdex");
  const locale = useLocale();

  useEffect(() => {
    setMounted(true);
    if (typeof navigator === "undefined") return;
    const ua = navigator.userAgent ?? "";
    const platform =
      (navigator as Navigator & { platform?: string }).platform ?? "";
    // Desktop macOS only. The download flow only ships a macOS
    // desktop binary (no iOS app exists), so showing this CTA on
    // iPhone/iPad would dead-end at /download. iPadOS reports as
    // "MacIntel" on Safari so we also need to rule out touch +
    // small viewport heuristics used by iPadOS in desktop mode.
    const isIos =
      /iPhone|iPad|iPod/i.test(platform) || /iPhone|iPad|iPod/i.test(ua);
    const looksLikeIpadDesktopMode =
      platform === "MacIntel" &&
      typeof navigator.maxTouchPoints === "number" &&
      navigator.maxTouchPoints > 1;
    if (isIos || looksLikeIpadDesktopMode) {
      setIsMac(false);
      return;
    }
    setIsMac(/^Mac/i.test(platform) || /Mac OS X/i.test(ua));
  }, []);

  if (!mounted || !isMac) return null;

  const downloadHref = `/${locale}/download?next=${encodeURIComponent(`install/${slug}`)}`;

  return (
    <Link
      href={downloadHref}
      aria-label={t("ariaLabel", { slug })}
      className="group relative isolate inline-flex w-full items-center gap-3 overflow-hidden rounded-2xl border border-brand/30 bg-gradient-to-br from-brand/15 via-brand-light/10 to-brand-deep/15 p-3 text-left shadow-[0_8px_32px_-8px_oklch(from_var(--brand)_l_c_h/0.35)] transition-all hover:border-brand/50 hover:shadow-[0_12px_40px_-8px_oklch(from_var(--brand)_l_c_h/0.45)] active:scale-[0.99]"
    >
      <span
        aria-hidden="true"
        className="-translate-x-full pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-white/15 to-transparent transition-transform duration-700 group-hover:translate-x-full dark:via-white/8"
      />

      <span className="relative grid size-12 shrink-0 place-items-center rounded-xl bg-surface shadow-md ring-1 ring-border-base/40">
        <Image
          src="/brand/petdex-desktop-icon.png"
          alt=""
          width={48}
          height={48}
          className="size-10 object-contain"
        />
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-[9px] tracking-[0.2em] text-brand uppercase">
            {t("eyebrow")}
          </span>
          <span className="relative grid size-1.5 place-items-center">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-70" />
            <span className="relative inline-flex size-full rounded-full bg-brand" />
          </span>
        </span>
        <span className="font-semibold text-foreground text-sm leading-tight">
          {t("label")}
        </span>
        <span className="text-muted-2 text-xs leading-tight">
          {t("subtitle")}
        </span>
      </span>

      <ArrowRight className="relative size-4 shrink-0 text-brand transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
