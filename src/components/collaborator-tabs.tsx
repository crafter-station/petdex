"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useLocale, useTranslations } from "next-intl";

import { localizePath } from "@/i18n/config";

const TABS: Array<{
  href: string;
  key: "submissions" | "edits" | "requests" | "collections" | "wechatQr";
  match: (pathname: string) => boolean;
}> = [
  {
    href: "/collaborator",
    key: "submissions",
    match: (p) => p === "/collaborator",
  },
  {
    href: "/collaborator/edits",
    key: "edits",
    match: (p) => p.startsWith("/collaborator/edits"),
  },
  {
    href: "/collaborator/requests",
    key: "requests",
    match: (p) => p.startsWith("/collaborator/requests"),
  },
  {
    href: "/collaborator/collection-requests",
    key: "collections",
    match: (p) => p.startsWith("/collaborator/collection-requests"),
  },
  {
    href: "/collaborator/wechat-qr",
    key: "wechatQr",
    match: (p) => p.startsWith("/collaborator/wechat-qr"),
  },
];

export function CollaboratorTabs({
  showReviewTabs = true,
}: {
  showReviewTabs?: boolean;
}) {
  const t = useTranslations("collaborator.tabs");
  const locale = useLocale();
  const pathname = usePathname() ?? "/collaborator";
  const normalizedPath =
    locale === "en" ? pathname : pathname.replace(`/${locale}`, "") || "/";
  const tabs = showReviewTabs
    ? TABS
    : TABS.filter((tab) => tab.key === "wechatQr");

  return (
    <nav
      aria-label={t("ariaLabel")}
      className="flex items-center gap-1 overflow-x-auto border-b border-border-base"
    >
      {tabs.map((tab) => {
        const active = tab.match(normalizedPath);
        return (
          <Link
            key={tab.href}
            href={localizePath(locale, tab.href)}
            aria-current={active ? "page" : undefined}
            className={`-mb-px relative inline-flex h-10 shrink-0 items-center px-4 text-sm transition ${
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
