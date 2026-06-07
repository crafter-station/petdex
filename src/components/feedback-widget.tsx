"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

import { ArrowUp, MessageCircle } from "lucide-react";
import { useTranslations } from "next-intl";

import { safeGetItem, safeSetItem } from "@/lib/utils";

import type {
  FeedbackKind,
  FeedbackSubmitState,
} from "@/components/feedback-popover";

const FeedbackPopover = dynamic(
  () =>
    import("@/components/feedback-popover").then((mod) => mod.FeedbackPopover),
  { loading: () => null, ssr: false },
);

const DRAG_THRESHOLD_PX = 6;
const FEEDBACK_POSITION_KEY = "petdex_feedback_widget_bottom";

export function FeedbackWidget() {
  const t = useTranslations("feedback");
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<FeedbackKind>("suggestion");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<FeedbackSubmitState>({ tag: "idle" });
  const [bottomOffset, setBottomOffset] = useState<number | null>(null);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const suppressClickUntilRef = useRef(0);

  const getDefaultBottom = useCallback(() => {
    if (typeof window === "undefined") return 24;
    return window.matchMedia("(min-width: 768px)").matches ? 24 : 16;
  }, []);

  const clampBottom = useCallback(
    (value: number) => {
      if (typeof window === "undefined") return value;
      const margin = getDefaultBottom();
      const measuredHeight = shellRef.current?.offsetHeight;
      const widgetHeight =
        measuredHeight && measuredHeight > 0 ? measuredHeight : 44;
      const maxBottom = Math.max(
        margin,
        window.innerHeight - widgetHeight - margin,
      );
      return Math.min(Math.max(value, margin), maxBottom);
    },
    [getDefaultBottom],
  );

  const setClampedBottom = useCallback(
    (value: number) => {
      setBottomOffset(clampBottom(value));
    },
    [clampBottom],
  );

  useEffect(() => {
    const stored = safeGetItem(FEEDBACK_POSITION_KEY);
    const parsed = stored === null ? NaN : Number(stored);
    setClampedBottom(Number.isFinite(parsed) ? parsed : getDefaultBottom());
  }, [getDefaultBottom, setClampedBottom]);

  useEffect(() => {
    const onResize = () => {
      setBottomOffset((current) => clampBottom(current ?? getDefaultBottom()));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampBottom, getDefaultBottom]);

  useEffect(() => {
    if (!shellRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setBottomOffset((current) => clampBottom(current ?? getDefaultBottom()));
    });
    observer.observe(shellRef.current);
    return () => observer.disconnect();
  }, [clampBottom, getDefaultBottom]);

  useEffect(() => {
    const clampCurrentPosition = () => {
      setBottomOffset((current) => clampBottom(current ?? getDefaultBottom()));
    };
    if (!open) {
      clampCurrentPosition();
      return;
    }
    const frame = window.requestAnimationFrame(clampCurrentPosition);
    return () => window.cancelAnimationFrame(frame);
  }, [open, clampBottom, getDefaultBottom]);

  useEffect(() => {
    let frame = 0;
    const check = () => {
      frame = 0;
      setShowBackToTop(window.scrollY > window.innerHeight);
    };
    const onScroll = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  const onBackToTopClick = useCallback(() => {
    if (Date.now() < suppressClickUntilRef.current) return;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  }, []);

  const onTriggerPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;

      const pointerId = event.pointerId;
      const startY = event.clientY;
      const startBottom = bottomOffset ?? getDefaultBottom();
      let moved = false;
      suppressClickUntilRef.current = 0;

      function handleMove(ev: PointerEvent) {
        if (ev.pointerId !== pointerId) return;
        const dy = ev.clientY - startY;
        if (!moved && Math.abs(dy) > DRAG_THRESHOLD_PX) {
          moved = true;
          suppressClickUntilRef.current = Number.POSITIVE_INFINITY;
        }
        if (!moved) return;
        ev.preventDefault();
        setClampedBottom(startBottom - dy);
      }

      function handleUp(ev: PointerEvent) {
        if (ev.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleUp);
        if (moved) {
          const nextBottom = clampBottom(startBottom - (ev.clientY - startY));
          setBottomOffset(nextBottom);
          suppressClickUntilRef.current = Date.now() + 350;
          safeSetItem(FEEDBACK_POSITION_KEY, String(nextBottom));
        }
      }

      window.addEventListener("pointermove", handleMove, { passive: false });
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleUp);
    },
    [bottomOffset, clampBottom, getDefaultBottom, setClampedBottom],
  );

  const onTriggerClick = useCallback(() => {
    if (Date.now() < suppressClickUntilRef.current) {
      return;
    }
    setOpen(true);
  }, []);

  const closeFeedback = useCallback(() => {
    setOpen(false);
  }, []);

  const resetDraft = useCallback(() => {
    setMessage("");
    setEmail("");
    setKind("suggestion");
    setState({ tag: "idle" });
  }, []);

  useEffect(() => {
    if (state.tag !== "ok") return;
    const timer = window.setTimeout(() => {
      resetDraft();
      setOpen(false);
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [resetDraft, state.tag]);

  return (
    <div
      ref={shellRef}
      className="fixed right-4 bottom-4 z-40 md:right-6 md:bottom-6"
      style={bottomOffset === null ? undefined : { bottom: bottomOffset }}
    >
      {open ? (
        <FeedbackPopover
          email={email}
          kind={kind}
          message={message}
          onClose={closeFeedback}
          setEmail={setEmail}
          setKind={setKind}
          setMessage={setMessage}
          setState={setState}
          state={state}
        />
      ) : (
        <div className="flex flex-col items-end gap-1.5">
          {showBackToTop ? (
            <button
              type="button"
              aria-label={t("backToTop")}
              onClick={onBackToTopClick}
              onPointerDown={onTriggerPointerDown}
              className="group/back peer relative inline-flex h-11 w-11 touch-none select-none items-center justify-center rounded-full border border-border-base bg-surface text-muted-2 shadow-lg shadow-blue-950/10 transition hover:border-border-strong hover:text-foreground hover:shadow-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
            >
              <ArrowUp className="size-4 text-brand" />
              <span className="pointer-events-none absolute right-[calc(100%+0.5rem)] hidden whitespace-nowrap rounded-md border border-border-base bg-surface px-2 py-1 text-xs font-medium text-foreground shadow-md group-hover/back:block group-focus-visible/back:block">
                {t("backToTop")}
              </span>
            </button>
          ) : null}
          <button
            type="button"
            aria-label={t("trigger")}
            onClick={onTriggerClick}
            onPointerDown={onTriggerPointerDown}
            className="group/feedback relative inline-flex h-11 w-11 touch-none select-none items-center justify-center rounded-full border border-border-base bg-surface text-muted-2 shadow-lg shadow-blue-950/10 transition hover:border-border-strong hover:text-foreground hover:shadow-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
          >
            <MessageCircle className="size-4 text-brand" />
            <span className="pointer-events-none absolute right-[calc(100%+0.5rem)] hidden whitespace-nowrap rounded-md border border-border-base bg-surface px-2 py-1 text-xs font-medium text-foreground shadow-md group-hover/feedback:block group-focus-visible/feedback:block">
              {t("trigger")}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
