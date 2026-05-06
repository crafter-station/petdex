"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { useLocale, useTranslations } from "next-intl";

import { localizePath } from "@/i18n/config";

type Status = "pending" | "addressed" | "archived" | "all";
type Kind = "all" | "suggestion" | "bug" | "praise" | "other";

const STATUS_FILTERS: Array<{ value: Status }> = [
  { value: "pending" },
  { value: "addressed" },
  { value: "archived" },
  { value: "all" },
];

const KIND_FILTERS: Array<{ value: Kind }> = [
  { value: "all" },
  { value: "suggestion" },
  { value: "bug" },
  { value: "praise" },
  { value: "other" },
];

function buildHref(locale: string, status: Status, kind: Kind): string {
  const params = new URLSearchParams();
  if (status !== "pending") params.set("status", status);
  if (kind !== "all") params.set("kind", kind);
  const qs = params.toString();
  const base = localizePath(locale, "/admin/feedback");
  return qs ? `${base}?${qs}` : base;
}

export function AdminFeedbackFilters({
  statusCounts,
  kindCounts,
}: {
  statusCounts: Record<Status, number>;
  kindCounts: Record<Kind, number>;
}) {
  const tStatus = useTranslations("admin.feedback.filters");
  const tKinds = useTranslations("admin.kinds");
  const locale = useLocale();
  const params = useSearchParams();
  const currentStatus = (params?.get("status") ?? "pending") as Status;
  const currentKind = (params?.get("kind") ?? "all") as Kind;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {STATUS_FILTERS.map((f) => {
          const active = currentStatus === f.value;
          const count = statusCounts[f.value];
          return (
            <Link
              key={f.value}
              href={buildHref(locale, f.value, currentKind)}
              className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition ${
                active
                  ? "border-inverse bg-inverse text-on-inverse"
                  : "border-black/10 bg-surface text-muted-2 hover:border-black/30 dark:border-white/10 dark:hover:border-white/30"
              }`}
            >
              {tStatus(f.value)}
              <span
                className={`font-mono text-[10px] ${
                  active ? "text-white/60" : "text-stone-400"
                }`}
              >
                {count}
              </span>
            </Link>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {KIND_FILTERS.map((f) => {
          const active = currentKind === f.value;
          const count = kindCounts[f.value];
          return (
            <Link
              key={f.value}
              href={buildHref(locale, currentStatus, f.value)}
              className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] transition ${
                active
                  ? "border-brand bg-brand/10 text-brand"
                  : "border-black/10 bg-surface text-muted-3 hover:border-black/30"
              }`}
            >
              {tKinds(f.value)}
              <span
                className={`font-mono text-[10px] ${
                  active ? "text-brand/70" : "text-stone-400"
                }`}
              >
                {count}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
