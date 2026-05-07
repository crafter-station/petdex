"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Sparkles, X } from "lucide-react";

type Step = {
  /** CSS selector pointing at the element to highlight. The first match wins. */
  selector: string;
  /** Emoji-free eyebrow above the title. */
  eyebrow: string;
  title: string;
  body: string;
  /** Where to anchor the tooltip relative to the highlighted target. */
  placement?: "top" | "bottom" | "left" | "right";
};

const ALL_STEPS: Step[] = [
  {
    selector:
      'a[href="#gallery"], a[href="/#gallery"], a[href="/api/manifest"]',
    eyebrow: "What's new",
    title: "Petdex is now an index, not a list",
    body: "Browse 100+ animated companions, filter by vibe or kind, share any pet with one click. We'll show you the new bits in 30 seconds.",
    placement: "bottom",
  },
  {
    selector: '[aria-label^="More actions for"]',
    eyebrow: "Share",
    title: "Action menu on every card",
    body: "Three dots open Copy install, Copy link, Share to X / LinkedIn, Download ZIP. No more hopping pages just to grab the install command.",
    placement: "bottom",
  },
  {
    selector: 'a[href^="/vibe/"], a[href^="/kind/"]',
    eyebrow: "Discover",
    title: "Filter by vibe or kind",
    body: "Looking for cozy companions or focused workmates? The chips above the gallery deep-link to dedicated landing pages with related collections.",
    placement: "bottom",
  },
  {
    selector: 'a[href^="/u/"]',
    eyebrow: "Track",
    title: "Your submissions live on your profile",
    body: "Open your profile to see every submission's status. Withdraw pending ones, see install and like counts on approved ones.",
    placement: "bottom",
  },
];

type Rect = { top: number; left: number; width: number; height: number };

type OnboardingTourProps = {
  onClose: () => void;
};

export function OnboardingTour({ onClose }: OnboardingTourProps) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [steps, setSteps] = useState<Step[]>(ALL_STEPS);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => {
    onClose();
  }, [onClose]);

  const next = useCallback(() => {
    setStep((current) => {
      if (current < steps.length - 1) return current + 1;
      close();
      return current;
    });
  }, [close, steps.length]);

  const prev = useCallback(() => {
    setStep((current) => (current > 0 ? current - 1 : current));
  }, []);

  useEffect(() => {
    const visible = ALL_STEPS.filter(
      (s) => document.querySelector(s.selector) !== null,
    );
    if (visible.length === 0) {
      onClose();
      return;
    }
    setSteps(visible);
    setStep(0);
  }, [onClose]);

  // Compute the highlight rect for the current step. Re-measures on resize.
  useEffect(() => {
    const measure = () => {
      const target = steps[step]
        ? document.querySelector(steps[step].selector)
        : null;
      if (!target) {
        setRect(null);
        return;
      }
      const r = (target as HTMLElement).getBoundingClientRect();
      // Scroll into view if off-screen.
      if (r.top < 60 || r.top > window.innerHeight - 60) {
        (target as HTMLElement).scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }
      const fresh = (target as HTMLElement).getBoundingClientRect();
      setRect({
        top: fresh.top,
        left: fresh.left,
        width: fresh.width,
        height: fresh.height,
      });
    };
    // Measure now + after layout settles after smooth scroll.
    measure();
    const t = window.setTimeout(measure, 350);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, { passive: true });
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure);
    };
  }, [step, steps]);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight") next();
      if (e.key === "ArrowLeft") prev();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close, next, prev]);

  if (!steps[step]) return null;

  const current = steps[step];
  const padding = 8;

  // Build the tooltip placement. If we don't have a rect (target not in DOM),
  // we still show the tooltip centered as a generic announcement.
  const tooltipStyle: CSSProperties = (() => {
    if (!rect) {
      return {
        position: "fixed",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
      };
    }
    const placement = current.placement ?? "bottom";
    if (placement === "bottom") {
      return {
        position: "fixed",
        top: rect.top + rect.height + padding + 6,
        left: Math.max(
          16,
          Math.min(
            rect.left + rect.width / 2 - 180,
            (typeof window !== "undefined" ? window.innerWidth : 1280) - 360,
          ),
        ),
      };
    }
    if (placement === "top") {
      return {
        position: "fixed",
        bottom:
          (typeof window !== "undefined" ? window.innerHeight : 800) -
          rect.top +
          padding +
          6,
        left: Math.max(
          16,
          Math.min(
            rect.left + rect.width / 2 - 180,
            (typeof window !== "undefined" ? window.innerWidth : 1280) - 360,
          ),
        ),
      };
    }
    return {
      position: "fixed",
      top: rect.top,
      left: rect.left + rect.width + padding,
    };
  })();

  return (
    <>
      {/* Dimmed backdrop with cutout for the highlighted element. We use a
          big inset box-shadow trick rather than SVG masks to keep this
          dependency-free and work on any browser. */}
      <div
        className="pointer-events-auto fixed inset-0 z-[55]"
        onClick={close}
        aria-hidden="true"
      >
        {rect ? (
          <div
            className="pointer-events-none absolute rounded-2xl ring-2 ring-brand transition-all duration-200"
            style={{
              top: rect.top - padding,
              left: rect.left - padding,
              width: rect.width + padding * 2,
              height: rect.height + padding * 2,
              boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.42)",
            }}
          />
        ) : (
          <div className="absolute inset-0 bg-slate-900/40" />
        )}
      </div>

      <div
        ref={tooltipRef}
        role="dialog"
        aria-label="Petdex feature tour"
        style={tooltipStyle}
        className="z-[60] w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-3xl border border-border-base bg-surface shadow-2xl shadow-blue-950/25"
      >
        <div className="flex items-center justify-between border-b border-black/[0.06] px-4 py-3 dark:border-white/[0.06]">
          <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-brand uppercase">
            <Sparkles className="size-3.5" />
            {current.eyebrow}
            <span className="text-stone-300 dark:text-stone-600">·</span>
            <span className="text-muted-3">
              {step + 1}/{steps.length}
            </span>
          </div>
          <button
            type="button"
            aria-label="Skip tour"
            onClick={close}
            className="grid size-7 place-items-center rounded-full text-muted-4 transition hover:bg-surface-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="px-4 py-4">
          <h2 className="text-base font-semibold text-foreground">
            {current.title}
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted-2">{current.body}</p>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-black/[0.06] bg-background px-4 py-3 dark:border-white/[0.06]">
          <button
            type="button"
            onClick={close}
            className="text-xs font-medium text-muted-3 transition hover:text-stone-800 dark:hover:text-stone-200"
          >
            Skip
          </button>
          <div className="flex items-center gap-2">
            {step > 0 ? (
              <button
                type="button"
                onClick={prev}
                className="inline-flex h-9 items-center rounded-full border border-border-base bg-surface px-3.5 text-xs font-medium text-muted-2 transition hover:border-border-strong"
              >
                Back
              </button>
            ) : null}
            <button
              type="button"
              onClick={next}
              className="inline-flex h-9 items-center rounded-full bg-inverse px-4 text-xs font-medium text-on-inverse transition hover:bg-inverse-hover"
            >
              {step === steps.length - 1 ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
