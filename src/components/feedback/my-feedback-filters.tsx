"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { Bell, CheckCheck, Clock, Inbox } from "lucide-react";
import { useTranslations } from "next-intl";

type Filter = "unread" | "replied" | "waiting" | "all";

const FILTERS: Array<{
  value: Filter;
  label: string;
  icon: React.ReactNode;
}> = [
  { value: "unread", label: "Unread", icon: <Bell className="size-3.5" /> },
  {
    value: "replied",
    label: "Replied",
    icon: <CheckCheck className="size-3.5" />,
  },
  { value: "waiting", label: "Waiting", icon: <Clock className="size-3.5" /> },
  { value: "all", label: "All", icon: <Inbox className="size-3.5" /> },
];

export function MyFeedbackFilters({
  counts,
  defaultFilter,
}: {
  counts: Record<Filter, number>;
  defaultFilter: Filter;
}) {
  const t = useTranslations("myFeedback.filters");
  const params = useSearchParams();
  const current = (params?.get("filter") ?? defaultFilter) as Filter;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {FILTERS.map((f) => {
        const active = current === f.value;
        const count = counts[f.value];
        // Drop ?filter= when it would equal the default — keeps URLs clean.
        const href =
          f.value === defaultFilter
            ? "/my-feedback"
            : `/my-feedback?filter=${f.value}`;
        return (
          <Link
            key={f.value}
            href={href}
            // aria-current is the screen-reader half of the `active` styling —
            // color alone is the only other signal.
            aria-current={active ? "page" : undefined}
            className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition ${
              active
                ? "border-inverse bg-inverse text-on-inverse"
                : "border-black/10 bg-surface text-muted-2 hover:border-black/30 dark:border-white/10 dark:hover:border-white/30"
            }`}
          >
            {f.icon}
            {t(f.value)}
            <span
              className={`font-mono text-[10px] ${
                active ? "text-white/70" : "text-stone-400"
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
