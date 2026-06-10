import { NextResponse } from "next/server";

import { getMetricsForSlug, getMetricsSummary } from "@/lib/db/metrics";
import { PET_METRICS_CACHE_CONTROL } from "@/lib/pet-metrics-cache";
import { metricsReadRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

// Public read of per-pet counters + global summary used by the radar.
// Hoisted off the ISR shell so pet detail pages stay byte-stable
// between regenerations — every counter tick used to invalidate the
// rendered HTML and bill an ISR write. CDN caches this response per
// slug, so bot traffic flattens out at the edge instead of touching
// the function.
const CACHE_HEADERS = {
  "Cache-Control": PET_METRICS_CACHE_CONTROL,
};

type Params = { slug: string };

export async function GET(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const lim = await metricsReadRatelimit.limit(ip);
  if (!lim.success) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const { slug } = await ctx.params;
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) {
    return NextResponse.json({ error: "invalid_slug" }, { status: 400 });
  }

  const [metrics, summary] = await Promise.all([
    getMetricsForSlug(slug),
    getMetricsSummary(),
  ]);

  return NextResponse.json({ ...metrics, summary }, { headers: CACHE_HEADERS });
}
