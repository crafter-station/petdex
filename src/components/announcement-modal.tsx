"use client";

import Link from "next/link";
import { useState } from "react";

import { ArrowRight, Sparkles, X } from "lucide-react";

type AnnouncementModalProps = {
  onClose: () => void;
};

export function AnnouncementModal({ onClose }: AnnouncementModalProps) {
  const [closing, setClosing] = useState(false);

  // Note: previously tracked announcement_shown / announcement_closed
  // here. Combined those two events were 47% of all Web Analytics
  // events but produced zero actionable signal — removed to drop the
  // bill. Engagement is already visible through the actual CTA clicks
  // (cta_search / cta_requests) further down the funnel.
  function close(
    _reason: "dismiss" | "cta_search" | "cta_requests" = "dismiss",
  ) {
    setClosing(true);
    window.setTimeout(() => {
      onClose();
    }, 220);
  }

  return (
    <div
      className={`fixed inset-0 z-[70] flex items-end justify-center px-4 pb-4 sm:items-center sm:p-6 ${
        closing ? "pointer-events-none" : ""
      }`}
      role="dialog"
      aria-modal="true"
      aria-label="Petdex new feature announcement"
    >
      {/* Subtle backdrop — dismisses on click but doesn't dim heavily so the
 modal feels like a soft FYI, not a blocker. */}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => close("dismiss")}
        className={`absolute inset-0 bg-slate-900/30 backdrop-blur-sm transition-opacity duration-200 ${
          closing ? "opacity-0" : "opacity-100"
        }`}
      />

      <div
        className={`relative w-full max-w-md overflow-hidden rounded-3xl border border-border-base bg-surface text-foreground shadow-[0_30px_80px_-20px_rgba(56,71,245,0.45)] transition-all duration-200 ${
          closing ? "translate-y-2 opacity-0" : "translate-y-0 opacity-100"
        }`}
      >
        {/* Hero image */}
        <div className="relative aspect-[16/9] w-full overflow-hidden bg-gradient-to-br from-gradient-a via-background to-gradient-b sm:aspect-[3/2]">
          {/* biome-ignore lint/performance/noImgElement: AI-generated marketing illustration */}
          <img
            src="/announcements/vibe-search.webp"
            alt=""
            className="size-full object-cover"
          />
          <button
            type="button"
            onClick={() => close("dismiss")}
            aria-label="Close"
            className="absolute top-3 right-3 grid size-8 place-items-center rounded-full bg-surface/90 text-muted-2 shadow-sm transition hover:bg-surface hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-4 p-6">
          <div className="flex items-center gap-2">
            <span className="grid size-6 place-items-center rounded-full bg-brand text-white">
              <Sparkles className="size-3" />
            </span>
            <p className="font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
              New · Vibe search
            </p>
          </div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            Search by what a pet feels like
          </h2>
          <p className="text-sm leading-6 text-muted-2">
            Type{" "}
            <span className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              cozy night programmer
            </span>{" "}
            or{" "}
            <span className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              fierce dragon
            </span>{" "}
            and Petdex finds the closest matches by vibe — not just keyword.
          </p>
          <p className="text-sm leading-6 text-muted-2">
            Doesn't find what you wanted?{" "}
            <strong className="text-foreground">Request the pet</strong> and the
            community can upvote it. Most-asked land in the queue first.
          </p>

          <div className="flex items-center gap-2 pt-1">
            <Link
              href="/#gallery"
              onClick={() => close("cta_search")}
              className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full bg-inverse px-5 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
            >
              Try the search
              <ArrowRight className="size-4" />
            </Link>
            <Link
              href="/requests"
              onClick={() => close("cta_requests")}
              className="inline-flex h-10 items-center justify-center rounded-full border border-border-base bg-surface px-4 text-sm font-medium text-muted-2 transition hover:border-border-strong"
            >
              See requests
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
