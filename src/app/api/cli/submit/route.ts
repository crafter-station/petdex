// Step 1 of the CLI submit flow: verify the OAuth bearer, rate-limit by
// userId-from-token, and presign 3 R2 PUT URLs the CLI uses to upload assets.
//
// We never trust identity fields in the body — userId/email/credit come from
// the verified Clerk userinfo response.

import { NextResponse } from "next/server";

import { isAdmin } from "@/lib/admin";
import { verifyCliBearer } from "@/lib/cli-auth";
import { presignPut } from "@/lib/r2";
import { cliVerifyRatelimit, submitRatelimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

const MAX_KEY_LEN = 80;
const MAX_BYTES = 8 * 1024 * 1024;

type Body = {
  slugHint?: string;
  petId?: string;
  spritesheetExt?: "webp" | "png";
};

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  return xff.split(",")[0]?.trim() || "anon";
}

export async function POST(req: Request): Promise<Response> {
  // Pre-auth rate limit by IP. Without this a bash loop with random
  // bearer tokens forces /oauth/userinfo lookups that burn Clerk quota
  // even though every one is rejected as 401.
  const verifyLim = await cliVerifyRatelimit.limit(clientIp(req));
  if (!verifyLim.success) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const principal = await verifyCliBearer(req.headers.get("authorization"));
  if (!principal) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Same rate limit bucket as web — bulk CLI uploads count against the user.
  if (!isAdmin(principal.userId)) {
    const lim = await submitRatelimit.limit(principal.userId);
    if (!lim.success) {
      return NextResponse.json(
        {
          error: "rate_limited",
          message: "Limit reached: 10 submissions / 24h.",
          retryAfter: lim.reset,
        },
        { status: 429 },
      );
    }
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const slugHint = sanitizeSlug(body.slugHint ?? body.petId ?? "pet");
  if (!slugHint) {
    return NextResponse.json({ error: "invalid_slug_hint" }, { status: 400 });
  }
  const ext: "webp" | "png" =
    body.spritesheetExt === "png" ? "png" : "webp";
  const spriteCT = ext === "png" ? "image/png" : "image/webp";

  const uploadId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);

  const files = [
    { role: "zip", ext: "zip", ct: "application/zip" },
    { role: "sprite", ext, ct: spriteCT },
    { role: "petjson", ext: "json", ct: "application/json" },
  ] as const;

  const presigned = await Promise.all(
    files.map(async (f) => {
      const key = `pets/${slugHint}-${uploadId}/${f.role}.${f.ext}`.slice(
        0,
        MAX_KEY_LEN + 32,
      );
      const result = await presignPut(key, f.ct);
      return { role: f.role, ...result };
    }),
  );

  return NextResponse.json({ ok: true, files: presigned, maxBytes: MAX_BYTES });
}

function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_KEY_LEN);
}
