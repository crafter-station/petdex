"use client";

import { useEffect, useMemo, useRef } from "react";

import { useLocale } from "next-intl";

import type { PublicFeedAd } from "@/lib/ads/queries";

import { AdCard } from "@/components/ads/ad-card";

export function FeedAdSlot({ ad }: { ad: PublicFeedAd }) {
  const locale = useLocale();
  const ref = useRef<HTMLDivElement | null>(null);
  const sentRef = useRef(false);
  const hoverSentRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const visibleStartedAtRef = useRef<number | null>(null);
  const visibleTotalMsRef = useRef(0);
  const sessionId = useMemo(getAdSessionId, []);
  const slotId = useMemo(() => crypto.randomUUID(), []);

  useEffect(() => {
    const el = ref.current;
    if (!el || sentRef.current) return;

    const clearTimer = () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry || sentRef.current) return;
        const visible =
          entry.isIntersecting &&
          entry.intersectionRatio >= 0.5 &&
          document.visibilityState === "visible";
        if (!visible) {
          if (visibleStartedAtRef.current != null) {
            visibleTotalMsRef.current +=
              performance.now() - visibleStartedAtRef.current;
            visibleStartedAtRef.current = null;
          }
          clearTimer();
          return;
        }
        visibleStartedAtRef.current ??= performance.now();
        if (timerRef.current != null) return;
        timerRef.current = window.setTimeout(() => {
          sentRef.current = true;
          observer.disconnect();
          sendImpression({
            campaignId: ad.id,
            sessionId,
            requestId: `${slotId}:impression`,
            visibleMs: 2000,
            path: window.location.pathname,
            locale,
          });
        }, 2000);
      },
      { threshold: [0, 0.5, 1] },
    );

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        if (visibleStartedAtRef.current != null) {
          visibleTotalMsRef.current +=
            performance.now() - visibleStartedAtRef.current;
          visibleStartedAtRef.current = null;
        }
        clearTimer();
      }
    };

    observer.observe(el);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearTimer();
      let timeInViewMs = visibleTotalMsRef.current;
      if (visibleStartedAtRef.current != null) {
        timeInViewMs += performance.now() - visibleStartedAtRef.current;
        visibleStartedAtRef.current = null;
        visibleTotalMsRef.current = timeInViewMs;
      }
      timeInViewMs = Math.round(timeInViewMs);
      if (timeInViewMs > 0) {
        sendAdEvent({
          campaignId: ad.id,
          kind: "time_in_view",
          sessionId,
          requestId: `${slotId}:time_in_view`,
          durationMs: timeInViewMs,
          path: window.location.pathname,
          locale,
        });
      }
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [ad.id, locale, sessionId, slotId]);

  function totalVisibleTime(): number {
    if (visibleStartedAtRef.current != null) {
      visibleTotalMsRef.current +=
        performance.now() - visibleStartedAtRef.current;
      visibleStartedAtRef.current = null;
    }
    return Math.round(visibleTotalMsRef.current);
  }

  function sendInteraction(kind: "hover" | "click") {
    const timeInViewMs = totalVisibleTime();
    sendAdEvent({
      campaignId: ad.id,
      kind,
      sessionId,
      requestId: `${slotId}:${kind}`,
      durationMs: timeInViewMs,
      path: window.location.pathname,
      locale,
    });
  }

  return (
    <div ref={ref} className="h-full">
      <AdCard
        ad={ad}
        onClick={() => sendInteraction("click")}
        onHover={() => {
          if (hoverSentRef.current) return;
          hoverSentRef.current = true;
          sendInteraction("hover");
        }}
      />
    </div>
  );
}

function sendImpression(payload: {
  campaignId: string;
  sessionId: string;
  requestId: string;
  visibleMs: number;
  path: string;
  locale: string;
}) {
  const body = JSON.stringify(payload);
  if (navigator.sendBeacon) {
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon("/api/ads/impression", blob)) return;
  }
  void fetch("/api/ads/impression", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  });
}

function sendAdEvent(payload: {
  campaignId: string;
  kind: "hover" | "click" | "dismissed" | "time_in_view";
  sessionId: string;
  requestId: string;
  durationMs: number | null;
  path: string;
  locale: string;
}) {
  const body = JSON.stringify(payload);
  if (navigator.sendBeacon) {
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon("/api/ads/event", blob)) return;
  }
  void fetch("/api/ads/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  });
}

function getAdSessionId(): string {
  const key = "petdex_ad_session";
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const next = crypto.randomUUID();
    window.sessionStorage.setItem(key, next);
    return next;
  } catch {
    return crypto.randomUUID();
  }
}
