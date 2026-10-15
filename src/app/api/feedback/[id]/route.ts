import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

type Params = { id: string };

type PatchBody = {
  notifyEmail?: boolean;
};

export async function PATCH(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;

  const row = await db.query.feedback.findFirst({
    where: eq(schema.feedback.id, id),
  });
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (row.userId !== userId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  // A literal `null` body parses fine, then `body.notifyEmail` throws —
  // match the 400 the sibling routes answer instead of a 500.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  if (typeof body.notifyEmail !== "boolean") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // Re-state the ownership condition in the WHERE: the read above is not in
  // the same transaction, so a between-the-two-writes change would otherwise
  // let this update ride on a stale row.
  const [updated] = await db
    .update(schema.feedback)
    .set({ notifyEmail: body.notifyEmail })
    .where(and(eq(schema.feedback.id, id), eq(schema.feedback.userId, userId)))
    .returning();

  if (!updated) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({ ok: true, notifyEmail: updated.notifyEmail });
}
