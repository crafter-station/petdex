import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";

import { createAdCampaign } from "@/lib/ads/queries";
import { validateAdCampaignInput } from "@/lib/ads/validation";
import { adCampaignRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const lim = await adCampaignRatelimit.limit(userId);
  if (!lim.success) {
    return NextResponse.json(
      { error: "rate_limited", retryAfter: lim.reset },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = validateAdCampaignInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const campaignId = await createAdCampaign({
    userId,
    ...parsed.value,
  });

  return NextResponse.json({ ok: true, campaignId });
}
