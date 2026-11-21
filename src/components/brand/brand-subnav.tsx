import Link from "next/link";

import { withLocale } from "@/lib/locale-routing";
import { cn } from "@/lib/utils";

import type { Locale } from "@/i18n/config";

export type BrandSectionKey = "overview" | "logoSystem" | "brandAssets";

type BrandSubnavProps = {
  locale: Locale;
  active: BrandSectionKey;
  labels: Record<BrandSectionKey, string>;
};

const ITEMS: readonly { key: BrandSectionKey; pathname: string }[] = [
  { key: "overview", pathname: "/brand" },
  { key: "logoSystem", pathname: "/brand/logo-system" },
  { key: "brandAssets", pathname: "/brand/brand-assets" },
];

export function BrandSubnav({ locale, active, labels }: BrandSubnavProps) {
  return (
    <nav
      aria-label="Brand sections"
      className="inline-flex flex-wrap items-center gap-1 rounded-full border border-border-base bg-surface/80 p-1 backdrop-blur"
    >
      {ITEMS.map((item) => {
        const isCurrent = item.key === active;
        return (
          <Link
            key={item.key}
            href={withLocale(item.pathname, locale)}
            aria-current={isCurrent ? "page" : undefined}
            className={cn(
              "inline-flex h-9 items-center rounded-full px-4 text-sm font-medium transition",
              isCurrent
                ? "bg-brand text-on-inverse shadow-sm"
                : "text-muted-2 hover:bg-surface-muted hover:text-foreground",
            )}
          >
            {labels[item.key]}
          </Link>
        );
      })}
    </nav>
  );
}
