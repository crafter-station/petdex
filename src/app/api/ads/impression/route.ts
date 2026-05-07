import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";

import { recordAdImpression } from "@/lib/ads/queries";
import { validateImpressionInput } from "@/lib/ads/validation";
import { adImpressionRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const ip = clientIp(req);
  const limiterKey = ip ?? req.headers.get("user-agent") ?? "unknown";
  const lim = await adImpressionRatelimit.limit(limiterKey);
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

  const parsed = validateImpressionInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const { userId } = await auth();
  const userAgent = req.headers.get("user-agent")?.slice(0, 500) ?? null;
  const result = await recordAdImpression({
    ...parsed.value,
    userId: userId ?? null,
    anonymousId: userId ? null : parsed.value.sessionId,
    ipHash: ip ? hashValue(ip) : null,
    userAgentHash: userAgent ? hashValue(userAgent) : null,
  });

  return NextResponse.json({ ok: true, ...result });
}

function clientIp(req: Request): string | null {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip")?.trim() ??
    null
  );
}

function hashValue(value: string): string {
  const salt = new Date().toISOString().slice(0, 10);
  return createHash("sha256").update(`${salt}:${value}`).digest("hex");
}
