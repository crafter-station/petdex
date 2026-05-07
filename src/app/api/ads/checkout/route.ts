import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";

import {
  getPendingOwnedCampaign,
  setCampaignCheckoutSession,
} from "@/lib/ads/queries";
import { adCheckoutRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";
import { getSiteUrl, getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

type Body = {
  campaignId?: string;
  locale?: string;
};

export async function POST(req: Request): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const lim = await adCheckoutRatelimit.limit(userId);
  if (!lim.success) {
    return NextResponse.json(
      { error: "rate_limited", retryAfter: lim.reset },
      { status: 429 },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.campaignId) {
    return NextResponse.json(
      { error: "campaign_id_required" },
      { status: 400 },
    );
  }

  const campaign = await getPendingOwnedCampaign(body.campaignId, userId);
  if (!campaign) {
    return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });
  }

  const localePrefix =
    body.locale && body.locale !== "en" ? `/${body.locale}` : "";
  const returnBase = `${getSiteUrl()}${localePrefix}/advertise`;
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    allow_promotion_codes: true,
    customer_email: campaign.contactEmail,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: campaign.priceCents,
          product_data: {
            name: `Petdex sponsored card - ${campaign.packageViews.toLocaleString()} impressions`,
            description: campaign.title,
          },
        },
      },
    ],
    metadata: {
      campaignId: campaign.id,
      userId,
      packageViews: String(campaign.packageViews),
    },
    success_url: `${returnBase}?checkout=success`,
    cancel_url: `${returnBase}?checkout=cancelled`,
  });

  await setCampaignCheckoutSession(campaign.id, session.id);

  return NextResponse.json({ ok: true, url: session.url });
}
