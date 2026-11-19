"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, useTransition } from "react";

import { Globe } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { stripLocalePrefix, withLocale } from "@/lib/locale-routing";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

import { hasLocale, type Locale } from "@/i18n/config";

const OPTIONS: Array<{ locale: Locale; code: string; label: string }> = [
  { locale: "en", code: "EN", label: "English" },
  { locale: "es", code: "ES", label: "Español" },
  { locale: "zh", code: "ZH", label: "中文" },
];

// Suspense wrapper — useSearchParams forces Next to bail out of static
// generation unless the consumer is inside a Suspense boundary. Wrapping
// the inner component here means every <SiteHeader /> can keep rendering
// statically; only the locale switcher hydrates client-side.
export function LocaleSwitcher() {
  return (
    <Suspense
      fallback={
        <span className="grid size-8 place-items-center rounded-full border border-border-base bg-surface/70 text-muted-2">
          <Globe className="size-4" />
        </span>
      }
    >
      <LocaleSwitcherInner />
    </Suspense>
  );
}

function LocaleSwitcherInner() {
  const locale = useLocale();
  const currentLocale = hasLocale(locale) ? locale : "en";
  const current =
    OPTIONS.find((option) => option.locale === currentLocale) ?? OPTIONS[0];
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const router = useRouter();
  const t = useTranslations("header");
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function selectLocale(nextLocale: Locale) {
    if (nextLocale === currentLocale) {
      setOpen(false);
      return;
    }

    // Persist the choice for signed-in visitors so the next server render
    // already speaks their language. Signed-out visitors get a 401, which is
    // expected — the URL switch below still happens, so the rejection is
    // swallowed rather than surfaced. The `.catch` is what keeps a network
    // failure from becoming an unhandled rejection in the console.
    void fetch("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preferredLocale: nextLocale }),
    }).catch(() => {});

    const basePath = stripLocalePrefix(pathname);
    const query = searchParams.toString();
    // Hash survives the switch the way query does — /docs#install and
    // /#gallery are real navigation targets here, and dropping the visitor
    // back to the top of the localized page loses their place.
    const hash = typeof window === "undefined" ? "" : window.location.hash;
    const nextPath = withLocale(basePath, nextLocale);
    const href = `${nextPath}${query ? `?${query}` : ""}${hash}`;

    setOpen(false);
    startTransition(() => {
      router.replace(href, { scroll: false });
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`${t("language")}: ${current.label}`}
            className="inline-flex h-8 items-center gap-2 rounded-full border border-border-base bg-surface/70 px-3 text-xs font-semibold tracking-[0.2em] text-muted-2 uppercase backdrop-blur transition hover:bg-surface-muted hover:text-foreground data-popup-open:bg-surface-muted data-popup-open:text-foreground"
          />
        }
      >
        <Globe className="size-4" />
        <span>{current.code}</span>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={8}
        className="z-[70] min-w-40 gap-0 overflow-hidden rounded-2xl border border-border-base bg-surface p-0 shadow-xl shadow-blue-950/15 origin-(--transform-origin) transition-[opacity,transform] duration-150 ease-out data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0"
      >
        {OPTIONS.map((option) => (
          <button
            key={option.locale}
            type="button"
            disabled={isPending}
            onClick={() => selectLocale(option.locale)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-[13px] text-foreground transition hover:bg-surface-muted disabled:cursor-wait disabled:opacity-70"
          >
            <span>{option.label}</span>
            <span className="font-mono text-xs tracking-[0.2em] text-muted-2 uppercase">
              {option.code}
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
