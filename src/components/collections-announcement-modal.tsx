"use client";

import { useState } from "react";

import { ArrowRight, Sparkles, X } from "lucide-react";

type CollectionsAnnouncementModalProps = {
  onClose: () => void;
};

export function CollectionsAnnouncementModal({
  onClose,
}: CollectionsAnnouncementModalProps) {
  const [closing, setClosing] = useState(false);

  // Engagement is captured downstream via cta_browse clicks; the
  // announcement_shown / announcement_closed pair was pure noise.
  function close(_reason: "dismiss" | "cta_browse" | "later" = "dismiss") {
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
      aria-label="Petdex Collections announcement"
    >
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => close("dismiss")}
        className={`absolute inset-0 bg-slate-900/30 backdrop-blur-sm transition-opacity duration-200 ${
          closing ? "opacity-0" : "opacity-100"
        }`}
      />

      <div
        className={`relative w-full max-w-md overflow-hidden rounded-3xl border border-border-base bg-surface shadow-[0_30px_80px_-20px_rgba(56,71,245,0.45)] transition-all duration-200 ${
          closing ? "translate-y-2 opacity-0" : "translate-y-0 opacity-100"
        }`}
      >
        <div className="relative aspect-[16/9] w-full overflow-hidden bg-gradient-to-br from-gradient-a via-background to-gradient-b sm:aspect-[3/2]">
          {/* biome-ignore lint/performance/noImgElement: AI-generated marketing illustration */}
          <img
            src="/announcements/collections.webp"
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

        <div className="space-y-4 p-6">
          <div className="flex items-center gap-2">
            <span className="grid size-6 place-items-center rounded-full bg-brand text-on-brand">
              <Sparkles className="size-3" />
            </span>
            <p className="font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
              New · Petdex
            </p>
          </div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            Collections are here — catch them all
          </h2>
          <p className="text-sm leading-6 text-muted-2">
            We curated 10 themed sets to help you build your squad —{" "}
            <strong className="text-foreground">GRAYCRAFT</strong> mechs, Anime
            Heroes, Cats Universe, Dog Squad, Coders Club, Wizards & Mages, Meme
            Lords, and more.
          </p>
          <p className="text-sm leading-6 text-muted-2">
            Browse the collections, install your favourites, and watch for our
            upcoming{" "}
            <strong className="text-foreground">collector leaderboard</strong>.
          </p>

          <div className="flex items-center gap-2 pt-1">
            <a
              href="/collections"
              onClick={() => close("cta_browse")}
              className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full bg-inverse px-5 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
            >
              Browse collections
              <ArrowRight className="size-4" />
            </a>
            <button
              type="button"
              onClick={() => close("later")}
              className="inline-flex h-10 items-center justify-center rounded-full border border-border-base bg-surface px-4 text-sm font-medium text-muted-2 transition hover:border-border-strong"
            >
              Later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
