"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useLocale, useTranslations } from "next-intl";

import { localizePath } from "@/i18n/config";

const TABS: Array<{
  href: string;
  key:
    | "submissions"
    | "edits"
    | "requests"
    | "collections"
    | "feedback"
    | "manifest"
    | "insights";
  match: (pathname: string) => boolean;
}> = [
  {
    href: "/admin",
    key: "submissions",
    match: (p) => p === "/admin",
  },
  {
    href: "/admin/edits",
    key: "edits",
    match: (p) => p.startsWith("/admin/edits"),
  },
  {
    href: "/admin/requests",
    key: "requests",
    match: (p) => p.startsWith("/admin/requests"),
  },
  {
    href: "/admin/collection-requests",
    key: "collections",
    match: (p) => p.startsWith("/admin/collection-requests"),
  },
  {
    href: "/admin/feedback",
    key: "feedback",
    match: (p) => p.startsWith("/admin/feedback"),
  },
  {
    href: "/admin/manifest",
    key: "manifest",
    match: (p) => p.startsWith("/admin/manifest"),
  },
  {
    href: "/admin/insights",
    key: "insights",
    match: (p) => p.startsWith("/admin/insights"),
  },
];

export function AdminTabs() {
  const t = useTranslations("admin.tabs");
  const locale = useLocale();
  const pathname = usePathname() ?? "/admin";
  const normalizedPath =
    locale === "en" ? pathname : pathname.replace(`/${locale}`, "") || "/";

  return (
    <nav
      aria-label={t("ariaLabel")}
      className="flex items-center gap-1 border-b border-border-base"
    >
      {TABS.map((tab) => {
        const active = tab.match(normalizedPath);
        return (
          <Link
            key={tab.href}
            href={localizePath(locale, tab.href)}
            aria-current={active ? "page" : undefined}
            className={`-mb-px relative inline-flex h-10 items-center px-4 text-sm transition ${
              active
                ? "font-medium text-foreground"
                : "text-muted-3 hover:text-muted-1"
            }`}
          >
            {t(tab.key)}
            {active ? (
              <span className="absolute right-0 bottom-0 left-0 h-[2px] rounded-full bg-brand" />
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
