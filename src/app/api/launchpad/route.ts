import { NextResponse } from "next/server";

import { getActiveLaunchpadDrops } from "@/lib/crafter-launchpad";

export const runtime = "nodejs";
export const revalidate = 3600;

export function GET() {
  return NextResponse.json(
    {
      drops: getActiveLaunchpadDrops(),
      updatedAt: new Date().toISOString(),
    },
    {
      headers: {
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      },
    },
  );
}
