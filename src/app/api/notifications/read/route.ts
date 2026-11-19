import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

type Body = { all: true } | { ids: string[] };

// The notification list the panel renders is capped well below this; the
// limit exists so a hand-rolled request cannot push an unbounded bind-
// parameter array into `inArray`.
const MAX_MARK_IDS = 200;

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
  // `req.json()` resolves `null` without throwing, and `"all" in null` is a
  // TypeError — this 500'd on a literal `null` body. Reject non-objects the
  // way the pet-requests and like routes do.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
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
    // Each id is a bind parameter for `inArray`, so a long list reaches
    // Postgres' parameter ceiling. Refuse an oversized list rather than
    // silently marking only its first N — a partial success that answers
    // `ok` is a lie the caller cannot see.
    const ids = body.ids.filter((v) => typeof v === "string");
    if (ids.length === 0) {
      return NextResponse.json({ error: "invalid_ids" }, { status: 400 });
    }
    if (ids.length > MAX_MARK_IDS) {
      return NextResponse.json(
        { error: "too_many_ids", max: MAX_MARK_IDS },
        { status: 400 },
      );
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
