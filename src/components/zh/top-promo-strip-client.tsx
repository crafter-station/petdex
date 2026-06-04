"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { ChevronRight } from "lucide-react";

import { withLocale } from "@/lib/locale-routing";

export type StripItem = {
  slug: string;
  name: string;
  freshness: "just-dropped" | "this-week" | "featured";
};

type Props = {
  items: StripItem[];
  intervalMs?: number;
};

const COPY: Record<
  StripItem["freshness"],
  { label: string; tail: string; emoji: string }
> = {
  "just-dropped": {
    emoji: "🔥",
    label: "新上线 NEW DROP",
    tail: "刚刚加入 JUST DROPPED",
  },
  "this-week": {
    emoji: "✨",
    label: "本周新品 NEW THIS WEEK",
    tail: "查看 VIEW",
  },
  featured: {
    emoji: "🐾",
    label: "推荐 FEATURED",
    tail: "查看 VIEW",
  },
};

const SCROLL_THRESHOLD_PX = 16;

export function TopPromoStripClient({ items, intervalMs = 4000 }: Props) {
  const [index, setIndex] = useState(0);
  const [atTop, setAtTop] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (items.length <= 1) return;

    function startInterval() {
      intervalRef.current = setInterval(() => {
        if (!document.hidden) {
          setIndex((i) => (i + 1) % items.length);
        }
      }, intervalMs);
    }

    function handleVisibility() {
      if (document.hidden) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } else {
        startInterval();
      }
    }

    startInterval();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [items.length, intervalMs]);

  useEffect(() => {
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        setAtTop(window.scrollY <= SCROLL_THRESHOLD_PX);
        ticking = false;
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const baseClasses = `fixed top-0 left-0 right-0 z-50 h-8 bg-[#0a0e1f] border-b border-amber-500/20 flex items-center justify-center transition-transform duration-200 ease-out ${
    atTop ? "translate-y-0" : "-translate-y-full"
  }`;

  if (items.length === 0) {
    return (
      <div className={baseClasses}>
        <span className="flex items-center gap-1 text-xs font-medium text-white/70">
          🐾 欢迎来到 Petdex Welcome
          <ChevronRight className="w-3 h-3 ml-0.5" />
        </span>
      </div>
    );
  }

  const current = items[index];
  const copy = COPY[current.freshness];
  const href = withLocale(`/pets/${current.slug}`, "zh");

  return (
    <div className={baseClasses}>
      <Link
        href={href}
        prefetch={false}
        className="group flex min-h-[44px] items-center gap-1 px-3 text-xs font-medium text-white hover:text-amber-400 transition-colors sm:min-h-0 sm:px-0"
      >
        <span>{copy.emoji}</span>
        <span className="text-amber-400">{copy.label}</span>
        <span className="text-white/40 mx-1">·</span>
        <span className="max-w-[6rem] truncate font-semibold sm:max-w-none">
          {current.name}
        </span>
        <span className="hidden text-white/40 mx-1 sm:inline">·</span>
        <span className="hidden text-white/70 sm:inline">{copy.tail}</span>
        <ChevronRight className="w-3 h-3 ml-0.5 text-white/60 group-hover:text-amber-400 group-hover:translate-x-0.5 transition-all" />
      </Link>
    </div>
  );
}
