import { NextResponse } from "next/server";

export const runtime = "nodejs";

// No database in this repo — there's nowhere for a notification to have
// been written, so this always reports empty.
export async function GET() {
  return NextResponse.json({ items: [], unreadCount: 0 });
}
