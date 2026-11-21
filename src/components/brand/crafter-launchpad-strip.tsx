"use client";

import { useEffect, useState } from "react";

import { ArrowUpRight } from "lucide-react";

import {
  type CrafterLaunchpadApp,
  getFeaturedLaunchpadDrop,
  getLaunchpadDismissKey,
} from "@/lib/crafter-launchpad";
import { cn } from "@/lib/utils";

interface CrafterLaunchpadStripProps {
  drop?: CrafterLaunchpadApp | null;
  className?: string;
}

export function CrafterLaunchpadStrip({
  drop = getFeaturedLaunchpadDrop(),
  className,
}: CrafterLaunchpadStripProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!drop) return;
    try {
      const dismissed =
        window.localStorage.getItem(getLaunchpadDismissKey(drop.id)) === "1";
      setVisible(!dismissed);
    } catch {
      setVisible(true);
    }
  }, [drop]);

  if (!drop || !visible) {
    return null;
  }

  const handleDismiss = () => {
    setVisible(false);
    try {
      window.localStorage.setItem(getLaunchpadDismissKey(drop.id), "1");
    } catch {}
  };

  return (
    <aside
      aria-label={`From Crafter Station: ${drop.name}`}
      className={cn(
        "toy-shell relative flex flex-col gap-4 rounded-3xl px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6",
        className,
      )}
    >
      <div className="min-w-0 pr-8 sm:pr-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="toy-tag rounded-full bg-toy-volt px-2.5 py-0.5 text-[#101944] shadow-[0_2px_0_#C9A91F]">
            From Crafter Station
          </span>
          <span className="toy-tag text-toy-cobalt dark:text-[#9BB2FF]">
            {drop.badge}
          </span>
        </div>
        <div className="mt-2.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <h2 className="text-lg font-semibold tracking-[-0.025em] text-foreground">
            {drop.name}
          </h2>
          <p className="text-sm leading-6 text-muted-1">{drop.tagline}</p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <a
          href={drop.url}
          target="_blank"
          rel="noreferrer"
          className="toy-btn toy-btn-pearl h-10 rounded-full px-4 text-xs text-brand"
        >
          Visit {drop.name}
          <ArrowUpRight className="size-3.5" />
        </a>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label={`Dismiss ${drop.name} announcement`}
          className="inline-flex size-8 items-center justify-center rounded-full text-base leading-none text-muted-2 transition hover:bg-surface hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          <span aria-hidden="true">&times;</span>
        </button>
      </div>
    </aside>
  );
}
