"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { useLocale, useTranslations } from "next-intl";

import { localizePath } from "@/i18n/config";

const FILTERS: Array<{
  value:
    | "all"
    | "pending"
    | "held"
    | "review_failed"
    | "auto_approved"
    | "auto_rejected"
    | "approved"
    | "rejected"
    | "discovered";
}> = [
  { value: "pending" },
  { value: "held" },
  { value: "review_failed" },
  { value: "auto_approved" },
  { value: "auto_rejected" },
  { value: "discovered" },
  { value: "approved" },
  { value: "rejected" },
  { value: "all" },
];

export function AdminStatusFilter({
  counts,
  basePath = "/admin",
}: {
  counts: {
    all: number;
    pending: number;
    held: number;
    review_failed: number;
    auto_approved: number;
    auto_rejected: number;
    approved: number;
    rejected: number;
    discovered: number;
  };
  basePath?: "/admin" | "/collaborator";
}) {
  const t = useTranslations("admin.status");
  const locale = useLocale();
  const params = useSearchParams();
  const current = (params?.get("status") ?? "pending") as
    | "all"
    | "pending"
    | "held"
    | "review_failed"
    | "auto_approved"
    | "auto_rejected"
    | "approved"
    | "rejected"
    | "discovered";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {FILTERS.map((f) => {
        const active = current === f.value;
        const href =
          f.value === "pending"
            ? localizePath(locale, basePath)
            : `${localizePath(locale, basePath)}?status=${f.value}`;
        const count = counts[f.value];
        return (
          <Link
            key={f.value}
            href={href}
            className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition ${
              active
                ? "border-inverse bg-inverse text-on-inverse"
                : "border-border-base bg-surface text-muted-2 hover:border-border-strong"
            }`}
          >
            {t(f.value)}
            <span
              className={`font-mono text-[10px] ${
                active ? "text-on-inverse/60" : "text-muted-3"
              }`}
            >
              {count}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
