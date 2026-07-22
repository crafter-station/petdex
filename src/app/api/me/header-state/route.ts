import { NextResponse } from "next/server";

import { INITIAL_HEADER_STATE } from "@/lib/header-state";

export const runtime = "nodejs";

// GET /api/me/header-state -> single aggregate the SiteHeader needs on
// every page-view (notifications unread, feedback unread, caught
// slugs, profile handle).
//
// No database in this repo, so there's nothing to aggregate — always
// return the same empty state a signed-out/no-notifications visitor
// would have seen anyway.
export async function GET(): Promise<Response> {
  return NextResponse.json(INITIAL_HEADER_STATE, {
    headers: {
      "Cache-Control":
        "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
      Vary: "Cookie",
    },
  });
}
