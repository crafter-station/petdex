"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";

import { ArrowRight, Sparkles, X } from "lucide-react";

type DesktopAnnouncementModalProps = {
  onClose: () => void;
};

export function DesktopAnnouncementModal({
  onClose,
}: DesktopAnnouncementModalProps) {
  const [closing, setClosing] = useState(false);

  function close(_reason: "dismiss" | "cta_download" | "cta_docs" = "dismiss") {
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
        <div className="relative flex aspect-[16/9] w-full items-center justify-center overflow-hidden bg-gradient-to-br from-gradient-a via-background to-gradient-b sm:aspect-[3/2]">
          <div className="relative size-28 drop-shadow-xl sm:size-36">
            <Image
              src="/brand/petdex-desktop-icon.png"
              alt=""
              fill
              className="object-contain"
            />
          </div>
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
            <span className="grid size-6 place-items-center rounded-full bg-brand text-white">
              <Sparkles className="size-3" />
            </span>
            <p className="font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
              New · Desktop App
            </p>
          </div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            Petdex now floats beside your coding agent
          </h2>
          <p className="text-sm leading-6 text-muted-2">
            Drop a pet on your screen that reacts to every Claude, Codex,
            Gemini, or OpenCode tool call. Frameless, always on top, drags with
            momentum.
          </p>
          <p className="text-sm leading-6 text-muted-2">
            macOS today. Linux and Windows soon.
          </p>

          <div className="flex items-center gap-2 pt-1">
            <Link
              href="/download"
              onClick={() => close("cta_download")}
              className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full bg-inverse px-5 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
            >
              Download
              <ArrowRight className="size-4" />
            </Link>
            <Link
              href="/download#how-it-works"
              onClick={() => close("cta_docs")}
              className="inline-flex h-10 items-center justify-center rounded-full border border-border-base bg-surface px-4 text-sm font-medium text-muted-2 transition hover:border-border-strong"
            >
              See how it works
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
