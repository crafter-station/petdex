import { NextResponse } from "next/server";

import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { incrementZipDownloadCount } from "@/lib/db/metrics";
import { trackZipRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

type Params = { slug: string };

function clientKey(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  return xff.split(",")[0]?.trim() || "anon";
}

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
  const { success } = await trackZipRatelimit.limit(clientKey(req));
  if (!success) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const { slug } = await ctx.params;
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) {
    return NextResponse.json({ error: "invalid_slug" }, { status: 400 });
  }

  const exists = await db.query.submittedPets.findFirst({
    where: eq(schema.submittedPets.slug, slug),
    columns: { slug: true, status: true },
  });
  if (!exists || exists.status !== "approved") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await incrementZipDownloadCount(slug);
  return NextResponse.json({ ok: true });
}
