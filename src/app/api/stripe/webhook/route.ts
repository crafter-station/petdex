import { NextResponse } from "next/server";

import type Stripe from "stripe";

import { activateCampaignFromCheckout } from "@/lib/ads/queries";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json(
      { error: "stripe_webhook_secret_missing" },
      { status: 500 },
    );
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "signature_missing" }, { status: 400 });
  }

  const stripe = getStripe();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      await req.text(),
      signature,
      webhookSecret,
    );
  } catch {
    return NextResponse.json({ error: "signature_invalid" }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    if (session.payment_status === "paid") {
      const campaignId = session.metadata?.campaignId;
      if (campaignId) {
        await activateCampaignFromCheckout({
          campaignId,
          checkoutSessionId: session.id,
          paymentIntentId:
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : (session.payment_intent?.id ?? null),
        });
      }
    }
  }

  return NextResponse.json({ received: true });
}
