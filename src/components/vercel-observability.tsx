"use client";

import type { ComponentProps } from "react";

import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

import {
  speedInsightsEnabled,
  webAnalyticsEnabled,
} from "@/lib/vercel-analytics";

type AnalyticsEvent = Parameters<
  NonNullable<ComponentProps<typeof Analytics>["beforeSend"]>
>[0];
type SpeedInsightsEvent = Parameters<
  NonNullable<ComponentProps<typeof SpeedInsights>["beforeSend"]>
>[0];

const LOW_VALUE_PATHS = [
  /^\/api(?:\/|$)/,
  /^\/(?:en|es|zh)?\/?my-feedback(?:\/|$)/,
  /^\/(?:en|es|zh)?\/?unsubscribe(?:\/|$)/,
];

export function VercelObservability() {
  const analyticsEnabled = webAnalyticsEnabled();
  const speedEnabled = speedInsightsEnabled();

  if (!(analyticsEnabled || speedEnabled)) return null;

  return (
    <>
      {analyticsEnabled ? (
        <Analytics beforeSend={filterAnalyticsEvent} />
      ) : null}
      {speedEnabled ? (
        <SpeedInsights
          sampleRate={speedInsightsSampleRate()}
          beforeSend={filterSpeedInsightsEvent}
        />
      ) : null}
    </>
  );
}

function filterAnalyticsEvent(event: AnalyticsEvent): AnalyticsEvent | null {
  return shouldDropEvent(event) ? null : event;
}

function filterSpeedInsightsEvent(
  event: SpeedInsightsEvent,
): SpeedInsightsEvent | null {
  return shouldDropEvent(event) ? null : event;
}

function shouldDropEvent(event: { url?: string; path?: string }): boolean {
  const pathname = pathnameFrom(event.url ?? event.path);
  return pathname
    ? LOW_VALUE_PATHS.some((pattern) => pattern.test(pathname))
    : false;
}

function pathnameFrom(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value, window.location.origin).pathname;
  } catch {
    return null;
  }
}

function speedInsightsSampleRate(): number {
  const raw = Number(
    process.env.NEXT_PUBLIC_PETDEX_SPEED_INSIGHTS_SAMPLE_RATE ?? 0.1,
  );
  if (!Number.isFinite(raw)) return 0.1;
  return Math.max(0, Math.min(1, raw));
}
