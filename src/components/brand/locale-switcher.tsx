"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, useTransition } from "react";

import { Globe } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { stripLocalePrefix, withLocale } from "@/lib/locale-routing";

import { Button, buttonVariants } from "@/components/ui/button";
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
        <span
          className={buttonVariants({
            variant: "petdex-pill",
            size: "icon-lg",
          })}
        >
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

    void fetch("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preferredLocale: nextLocale }),
    });

    const basePath = stripLocalePrefix(pathname);
    const query = searchParams.toString();
    const nextPath = withLocale(basePath, nextLocale);
    const href = query ? `${nextPath}?${query}` : nextPath;

    setOpen(false);
    startTransition(() => {
      router.replace(href, { scroll: false });
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="petdex-pill"
            size="lg"
            aria-label={`${t("language")}: ${current.label}`}
            className="gap-2 px-3 font-semibold tracking-[0.2em] uppercase"
          />
        }
      >
        <Globe className="size-4" />
        <span>{current.code}</span>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={8}
        className="z-[70] min-w-40 gap-0.5 overflow-hidden rounded-2xl border border-border-base bg-surface p-1 shadow-xl shadow-blue-950/15 origin-(--transform-origin) transition-[opacity,transform] duration-150 ease-out data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0"
      >
        {OPTIONS.map((option) => (
          <Button
            key={option.locale}
            type="button"
            variant="ghost"
            disabled={isPending}
            onClick={() => selectLocale(option.locale)}
            className="h-auto w-full justify-between px-3 py-2 text-left text-[13px] font-normal text-foreground disabled:cursor-wait disabled:opacity-70"
          >
            <span>{option.label}</span>
            <span className="font-mono text-xs tracking-[0.2em] text-muted-2 uppercase">
              {option.code}
            </span>
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
