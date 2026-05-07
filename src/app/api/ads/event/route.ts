import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";

import { recordAdEvent } from "@/lib/ads/queries";
import { validateAdEventInput } from "@/lib/ads/validation";
import { adEventRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const limiterKey =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip")?.trim() ??
    req.headers.get("user-agent") ??
    "unknown";
  const lim = await adEventRatelimit.limit(limiterKey);
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

  const parsed = validateAdEventInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const { userId } = await auth();
  const result = await recordAdEvent({
    ...parsed.value,
    userId: userId ?? null,
    anonymousId: userId ? null : parsed.value.sessionId,
  });

  return NextResponse.json({ ok: true, ...result });
}
