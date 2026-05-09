import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";

import { isAdmin } from "@/lib/admin";
import { getTelemetrySummary } from "@/lib/telemetry/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { userId } = await auth();
  if (!isAdmin(userId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const summary = await getTelemetrySummary();
  return NextResponse.json(summary);
}
