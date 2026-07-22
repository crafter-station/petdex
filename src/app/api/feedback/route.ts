import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";

import { feedbackRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

const MAX_LEN = 4000;

export async function POST(req: Request): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;
  const { userId } = await auth();

  // 5 submissions per hour per IP / per user.
  const ipHeader =
    req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "";
  const ip = ipHeader.split(",")[0]?.trim() || "anon";
  const key = userId ?? ip;
  const { success } = await feedbackRatelimit.limit(key);
  if (!success) {
    return NextResponse.json(
      { error: "rate_limited", message: "Try again in an hour." },
      { status: 429 },
    );
  }

  let body: { message?: string; email?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const message = String(body.message ?? "").trim();
  const email = body.email?.trim() || null;

  if (message.length < 4) {
    return NextResponse.json({ error: "message_too_short" }, { status: 400 });
  }
  if (message.length > MAX_LEN) {
    return NextResponse.json(
      { error: "message_too_long", maxLen: MAX_LEN },
      { status: 400 },
    );
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }

  // No database in this repo — validated input is accepted but not
  // persisted anywhere.
  const id = `fb_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;

  return NextResponse.json({ ok: true, id });
}
