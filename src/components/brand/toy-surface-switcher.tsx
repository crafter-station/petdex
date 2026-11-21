"use client";

import { type ReactNode, useState } from "react";

import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";

import { cn } from "@/lib/utils";

export type ToySurface = "pearl" | "navy" | "checker";

const SURFACE_CLASS: Record<ToySurface, string> = {
  pearl: "bg-[#F7F8FC]",
  navy: "bg-[#101944]",
  checker:
    "bg-[linear-gradient(45deg,#E4E7F2_25%,transparent_25%,transparent_75%,#E4E7F2_75%),linear-gradient(45deg,#E4E7F2_25%,transparent_25%,transparent_75%,#E4E7F2_75%)] bg-[length:20px_20px] bg-[position:0_0,10px_10px] bg-white",
};

type ToySurfaceSwitcherProps = {
  labels: Record<ToySurface, string>;
  ariaLabel: string;
  children: ReactNode;
  className?: string;
};

export function ToySurfaceSwitcher({
  labels,
  ariaLabel,
  children,
  className,
}: ToySurfaceSwitcherProps) {
  const [surface, setSurface] = useState<ToySurface>("pearl");

  return (
    <div className={cn("toy-shell flex flex-col gap-4 p-4 md:p-5", className)}>
      <SegmentedControl<ToySurface>
        value={surface}
        onValueChange={(next) => {
          if (next) setSurface(next);
        }}
        aria-label={ariaLabel}
        className="relative inline-flex self-start rounded-2xl bg-shell-pearl-edge/70 p-1 shadow-[inset_0_2px_4px_rgba(16,25,68,0.15)]"
      >
        <SegmentedControlIndicator className="absolute top-[var(--segmented-control-indicator-top)] left-[var(--segmented-control-indicator-left)] h-[var(--segmented-control-indicator-height)] w-[var(--segmented-control-indicator-width)] rounded-xl bg-gradient-to-b from-[#5876FF] to-[#2B46D9] shadow-[inset_0_2px_0_rgba(255,255,255,0.4),0_3px_0_#162472] transition-all duration-200 [transition-timing-function:var(--ease-bounce)]" />
        {(Object.keys(labels) as ToySurface[]).map((key) => (
          <SegmentedControlItem
            key={key}
            value={key}
            className={(state) =>
              cn(
                "relative z-10 px-3.5 py-1.5 text-[10px] tracking-[0.12em] uppercase transition-colors",
                state.checked ? "text-white" : "text-toy-ink/60",
              )
            }
            style={{ fontFamily: "var(--font-pixel), monospace" }}
          >
            {labels[key]}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
      <div
        className={cn(
          "grid min-h-56 place-items-center rounded-[1.25rem] p-8 shadow-[inset_0_3px_10px_rgba(16,25,68,0.18)] transition-colors",
          SURFACE_CLASS[surface],
        )}
      >
        {children}
      </div>
    </div>
  );
}
