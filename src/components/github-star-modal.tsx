"use client";

import { useState } from "react";

import { ArrowRight, Star, X } from "lucide-react";

type GithubStarModalProps = {
  onClose: () => void;
};

export function GithubStarModal({ onClose }: GithubStarModalProps) {
  const [closing, setClosing] = useState(false);

  // Engagement is captured downstream via cta_star clicks; the
  // announcement_shown / announcement_closed pair was pure noise.
  function close(_reason: "dismiss" | "cta_star" | "later" = "dismiss") {
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
      aria-label="Petdex GitHub star request"
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
        {/* Hero — gpt-image-2 illustration. Mirror the
            AnnouncementModal's 3:2 aspect so the two modals feel
            consistent. */}
        <div className="relative aspect-[16/9] w-full overflow-hidden bg-gradient-to-br from-gradient-a via-background to-gradient-b sm:aspect-[3/2]">
          {/* biome-ignore lint/performance/noImgElement: AI-generated marketing illustration */}
          <img
            src="/announcements/github-star.webp"
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
            <span className="grid size-6 place-items-center rounded-full bg-amber-400 text-amber-950">
              <Star className="size-3 fill-current" />
            </span>
            <p className="font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
              Open source · Petdex
            </p>
          </div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            Help Petdex grow — star us on GitHub
          </h2>
          <p className="text-sm leading-6 text-muted-2">
            Petdex is fully open source. Every star helps more pet creators find
            the project, and gives us cover to keep shipping freely (sounds,
            leaderboard, the upcoming web pet studio…).
          </p>
          <p className="text-sm leading-6 text-muted-2">
            Takes ten seconds.{" "}
            <strong className="text-foreground">
              No account required if you already have GitHub.
            </strong>
          </p>

          <div className="flex items-center gap-2 pt-1">
            <a
              href="https://github.com/crafter-station/petdex"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => close("cta_star")}
              className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full bg-inverse px-5 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
            >
              <Star className="size-4 fill-current" />
              Star on GitHub
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
