"use client";

import { useState } from "react";

import { ArrowRight, Download } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

type OpenInPetdexButtonProps = {
  slug: string;
};

/**
 * Triggers `petdex://install/{slug}` and falls back to /download?next=...
 * if Petdex Desktop isn't installed (no scheme handler -> browser stays
 * focused after a short delay).
 *
 * Detection trick: launch the URL, set a 1500ms timer, and if the window
 * still has focus when it fires we assume nothing claimed the scheme.
 * macOS hands focus to the .app on a successful launch, so the blur
 * listener clears the fallback timer.
 */
export function OpenInPetdexButton({ slug }: OpenInPetdexButtonProps) {
  const [pending, setPending] = useState(false);
  const t = useTranslations("openInPetdex");
  const locale = useLocale();

  const handleClick = () => {
    if (pending) return;
    setPending(true);

    const downloadHref = `/${locale}/download?next=${encodeURIComponent(`install/${slug}`)}`;
    const fallbackTimer = window.setTimeout(() => {
      if (document.hasFocus()) {
        window.location.href = downloadHref;
      }
      setPending(false);
    }, 1500);

    const onBlur = () => {
      window.clearTimeout(fallbackTimer);
      window.removeEventListener("blur", onBlur);
      setPending(false);
    };
    window.addEventListener("blur", onBlur);

    // Fire the scheme. If Petdex.app is registered, macOS hands the URL
    // to the app (or launches it cold). If nothing is registered, the
    // browser silently no-ops and we fall through to the timer.
    window.location.href = `petdex://install/${slug}`;
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      className="group inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-brand px-6 text-sm font-medium text-on-inverse transition hover:bg-brand-deep disabled:opacity-70 sm:w-auto"
    >
      <Download className="size-4" />
      {pending ? t("opening") : t("label")}
      <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
    </button>
  );
}
