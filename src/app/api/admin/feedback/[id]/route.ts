import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";

import { isAdmin } from "@/lib/admin";
import { db, schema } from "@/lib/db/client";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

type Params = { id: string };

type PatchBody = {
  action: "address" | "archive" | "reopen";
  note?: string | null;
};

export async function PATCH(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!isAdmin(userId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (
    body.action !== "address" &&
    body.action !== "archive" &&
    body.action !== "reopen"
  ) {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const now = new Date();
  const patch: Record<string, unknown> =
    body.action === "address"
      ? {
          status: "addressed" as const,
          addressedAt: now,
          archivedAt: null,
        }
      : body.action === "archive"
        ? {
            status: "archived" as const,
            archivedAt: now,
            addressedAt: null,
          }
        : {
            status: "pending" as const,
            addressedAt: null,
            archivedAt: null,
          };

  if (typeof body.note === "string") {
    patch.adminNote = body.note.trim().slice(0, 500) || null;
  }

  const [row] = await db
    .update(schema.feedback)
    .set(patch)
    .where(eq(schema.feedback.id, id))
    .returning();

  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, status: row.status });
}
