import { NextResponse } from "next/server";

import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { getMetricsForSlug, getMetricsSummary } from "@/lib/db/metrics";
import { PET_METRICS_CACHE_CONTROL } from "@/lib/pet-metrics-cache";
import { publicTrafficGuardKey } from "@/lib/public-traffic-guard";
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

// Errors are never shareable: see the 429 below.
const NO_STORE = { "Cache-Control": "no-store" };

type Params = { slug: string };

export async function GET(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const lim = await metricsReadRatelimit.limit(
    publicTrafficGuardKey(req.headers),
  );
  if (!lim.success) {
    // Every non-200 here has to be uncacheable: the success path is
    // `public, max-age=300` and the edge keys on the URL alone, so a cached
    // 429 would be served to every later caller for this slug.
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: NO_STORE },
    );
  }

  const { slug } = await ctx.params;
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) {
    return NextResponse.json(
      { error: "invalid_slug" },
      { status: 400, headers: NO_STORE },
    );
  }

  // Withdrawn, rejected, or never-approved pets answer 404 like the page
  // and /variants do. Without this, /pets/<slug> 404s while /metrics kept
  // returning 200 with counters — a "404 page but live metrics" signal a
  // slug dictionary could use to confirm a pet existed and was taken down.
  const pet = await db
    .select({ slug: schema.submittedPets.slug })
    .from(schema.submittedPets)
    .where(
      and(
        eq(schema.submittedPets.slug, slug),
        eq(schema.submittedPets.status, "approved"),
      ),
    )
    .limit(1);
  if (pet.length === 0) {
    return NextResponse.json(
      { error: "not_found" },
      { status: 404, headers: NO_STORE },
    );
  }

  const [metrics, summary] = await Promise.all([
    getMetricsForSlug(slug),
    getMetricsSummary(),
  ]);

  return NextResponse.json({ ...metrics, summary }, { headers: CACHE_HEADERS });
}
