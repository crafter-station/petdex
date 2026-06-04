import { track as vercelTrack } from "@vercel/analytics";

type TrackArgs = Parameters<typeof vercelTrack>;

export function track(...args: TrackArgs): void {
  if (!webAnalyticsEnabled()) return;
  vercelTrack(...args);
}

export function webAnalyticsEnabled(): boolean {
  return enabled(process.env.NEXT_PUBLIC_PETDEX_ENABLE_WEB_ANALYTICS);
}

export function speedInsightsEnabled(): boolean {
  return enabled(process.env.NEXT_PUBLIC_PETDEX_ENABLE_SPEED_INSIGHTS);
}

function enabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}
