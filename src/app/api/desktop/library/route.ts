import { NextResponse } from "next/server";

import { verifyCliBearer } from "@/lib/cli-auth";
import { getDesktopLibrary } from "@/lib/desktop-library";
import { publicTrafficGuardKey } from "@/lib/public-traffic-guard";
import { cliVerifyRatelimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

// This route answers per-user data on a URL that carries no user identity, so
// no intermediary may reuse any branch of it — including the failures. A bare
// 401/429 is heuristically cacheable on a GET, and the deployment runs a
// cache-everything rule in front.
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

export async function GET(req: Request): Promise<Response> {
  const limit = await cliVerifyRatelimit.limit(
    publicTrafficGuardKey(req.headers),
  );
  if (!limit.success) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: PRIVATE_HEADERS },
    );
  }

  const principal = await verifyCliBearer(req.headers.get("authorization"));
  if (!principal) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: PRIVATE_HEADERS },
    );
  }

  const library = await getDesktopLibrary(principal.userId);
  return NextResponse.json(
    {
      user: {
        id: principal.userId,
        email: principal.email,
        username: principal.username,
        imageUrl: principal.imageUrl,
        firstName: principal.firstName,
        lastName: principal.lastName,
      },
      ...library,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
