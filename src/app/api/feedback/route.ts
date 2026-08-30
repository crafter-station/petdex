import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";

import { db, schema } from "@/lib/db/client";
import { createNeonRatelimit } from "@/lib/neon-ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

const VALID_KINDS = new Set(["suggestion", "bug", "praise", "other"]);
const MAX_LEN = 4000;

const ratelimit = createNeonRatelimit({
  requests: 5,
  window: "1h",
  prefix: "petdex:feedback",
});

export async function POST(req: Request): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;
  const { userId } = await auth();

  const ipHeader =
    req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "";
  const ip = ipHeader.split(",")[0]?.trim() || "anon";
  const key = userId ?? ip;
  const { success } = await ratelimit.limit(key);
  if (!success) {
    return NextResponse.json(
      { error: "rate_limited", message: "Try again in an hour." },
      { status: 429 },
    );
  }

  let body: {
    kind?: string;
    message?: string;
    email?: string;
    pageUrl?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const kind = VALID_KINDS.has(String(body.kind))
    ? (body.kind as "suggestion" | "bug" | "praise" | "other")
    : "suggestion";
  const message = String(body.message ?? "").trim();
  const email = body.email?.trim() || null;
  const pageUrl = body.pageUrl?.trim().slice(0, 500) || null;
  const userAgent = req.headers.get("user-agent")?.slice(0, 500) ?? null;

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

  const id = `fb_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;

  await db.insert(schema.feedback).values({
    id,
    kind,
    message,
    email,
    pageUrl,
    userAgent,
    userId,
  });

  return NextResponse.json({ ok: true, id });
}
