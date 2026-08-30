import { NextResponse } from "next/server";

import { verifyCliBearer } from "@/lib/cli-auth";
import { getDesktopLibrary } from "@/lib/desktop-library";
import { cliVerifyRatelimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  return forwarded.split(",")[0]?.trim() || "anon";
}

export async function GET(req: Request): Promise<Response> {
  const limit = await cliVerifyRatelimit.limit(clientIp(req));
  if (!limit.success) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const principal = await verifyCliBearer(req.headers.get("authorization"));
  if (!principal) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
