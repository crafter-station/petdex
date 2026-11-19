import { NextResponse } from "next/server";

import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { incrementZipDownloadCount } from "@/lib/db/metrics";
import { publicTrafficGuardKey } from "@/lib/public-traffic-guard";
import { trackZipRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

// The sibling metrics/like routes mark every error response no-store so an
// edge cache in front of the app can never hold a stale 404/429 against a
// pet that was just approved or un-deleted. This route answers POST, which
// CDNs don't cache by default, but the header costs nothing and keeps the
// contract uniform across the family.
const NO_STORE = { "Cache-Control": "no-store" } as const;

type Params = { slug: string };

export async function POST(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  // Anyone, signed-in or not, can hit this endpoint — but we cap by IP
  // and require the slug to actually exist. Without these, a bash loop
  // can inflate any pet's zip-download counter and pollute pet_metrics
  // with rows for fake slugs.
  const { success } = await trackZipRatelimit.limit(
    publicTrafficGuardKey(req.headers),
  );
  if (!success) {
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

  const exists = await db.query.submittedPets.findFirst({
    where: eq(schema.submittedPets.slug, slug),
    columns: { slug: true, status: true },
  });
  if (!exists || exists.status !== "approved") {
    return NextResponse.json(
      { error: "not_found" },
      { status: 404, headers: NO_STORE },
    );
  }

  await incrementZipDownloadCount(slug);
  return NextResponse.json({ ok: true });
}
