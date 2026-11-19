import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";

import { db, schema } from "@/lib/db/client";
import { createNeonRatelimit } from "@/lib/neon-ratelimit";
import { publicTrafficGuardKey } from "@/lib/public-traffic-guard";
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

  // Same key helper the CLI collection routes and the proxy use: it prefers
  // the platform-set `x-real-ip` over a client-supplied `x-forwarded-for`,
  // so an anonymous caller cannot rotate the header and hand themselves a
  // fresh bucket on every request. (Signed-in callers are keyed by userId.)
  const key = userId ?? publicTrafficGuardKey(req.headers);
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
  // `req.json()` parses a literal `null` successfully — only malformed JSON
  // throws — and the property reads below then 500'd this anonymous endpoint.
  // Same boundary `notifications/read` and `pet-requests` carry.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const kind = VALID_KINDS.has(String(body.kind))
    ? (body.kind as "suggestion" | "bug" | "praise" | "other")
    : "suggestion";
  const message = String(body.message ?? "").trim();
  // `?.` only guards null/undefined; a number or object here threw
  // `.trim is not a function` and 500'd this anonymous endpoint. Coerce
  // like `message`/`kind` above, then validate the coerced string.
  // Bounded like its siblings: RFC 5321 caps an email at 254 octets, and
  // the regex below would happily pass a megabyte-long otherwise-valid
  // single block straight into the row.
  const email =
    String(body.email ?? "")
      .trim()
      .slice(0, 254) || null;
  const pageUrl =
    String(body.pageUrl ?? "")
      .trim()
      .slice(0, 500) || null;
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
