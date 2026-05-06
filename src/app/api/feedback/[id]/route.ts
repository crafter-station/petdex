import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { requireSameOrigin } from "@/lib/same-origin";

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

  if (typeof body.notifyEmail !== "boolean") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const [updated] = await db
    .update(schema.feedback)
    .set({ notifyEmail: body.notifyEmail })
    .where(eq(schema.feedback.id, id))
    .returning();

  return NextResponse.json({ ok: true, notifyEmail: updated.notifyEmail });
}
