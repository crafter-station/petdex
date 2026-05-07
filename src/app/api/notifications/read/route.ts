import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

type Body =
  | { all: true }
  | { ids: string[] };

// POST /api/notifications/read body { all: true } -> mark every unread
// notification of the current user as read. body { ids: [...] } ->
// mark a specific subset (used when the user clicks a notification).
export async function POST(req: Request): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const now = new Date();

  if ("all" in body && body.all === true) {
    await db
      .update(schema.notifications)
      .set({ readAt: now })
      .where(
        and(
          eq(schema.notifications.userId, userId),
          isNull(schema.notifications.readAt),
        ),
      );
    return NextResponse.json({ ok: true });
  }

  if ("ids" in body && Array.isArray(body.ids) && body.ids.length > 0) {
    const ids = body.ids.filter((v) => typeof v === "string");
    if (ids.length === 0) {
      return NextResponse.json({ error: "invalid_ids" }, { status: 400 });
    }
    await db
      .update(schema.notifications)
      .set({ readAt: now })
      .where(
        and(
          eq(schema.notifications.userId, userId),
          inArray(schema.notifications.id, ids),
        ),
      );
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "invalid_body" }, { status: 400 });
}
