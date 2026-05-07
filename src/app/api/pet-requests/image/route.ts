import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";

import { presignPut } from "@/lib/r2";
import { presignRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

const ALLOWED_CT = new Set(["image/png", "image/webp", "image/jpeg"]);
const MAX_BYTES = 4 * 1024 * 1024;

type Body = {
  contentType?: string;
  size?: number;
};

export async function POST(req: Request): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const lim = await presignRatelimit.limit(userId);
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

  if (!body.contentType || !ALLOWED_CT.has(body.contentType)) {
    return NextResponse.json(
      { error: "unsupported_content_type", got: body.contentType },
      { status: 400 },
    );
  }
  if (
    typeof body.size !== "number" ||
    body.size <= 0 ||
    body.size > MAX_BYTES
  ) {
    return NextResponse.json(
      { error: "file_too_large", maxBytes: MAX_BYTES },
      { status: 400 },
    );
  }

  const uploadId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const ext =
    body.contentType === "image/png"
      ? "png"
      : body.contentType === "image/jpeg"
        ? "jpg"
        : "webp";
  const key = `requests/${userId.slice(-8).toLowerCase()}-${uploadId}/reference.${ext}`;

  return NextResponse.json({
    ok: true,
    ...(await presignPut(key, body.contentType)),
  });
}
