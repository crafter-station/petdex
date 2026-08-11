import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { applyPetEdit, type PatchBody } from "@/lib/pet-edit";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

type Params = { id: string };

// PATCH = create-or-update a pending edit. Pet stays publicly approved
// with current values; admin sees a diff and approves/rejects.
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

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { id } = await ctx.params;
  return applyPetEdit({ id, userId, body });
}

// DELETE = withdraw the in-flight edit (no admin notice needed).
export async function DELETE(
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
  const row = await db.query.submittedPets.findFirst({
    where: and(
      eq(schema.submittedPets.id, id),
      eq(schema.submittedPets.ownerId, userId),
    ),
  });
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await db
    .update(schema.submittedPets)
    .set({
      pendingDisplayName: null,
      pendingDescription: null,
      pendingTags: null,
      pendingSubmittedAt: null,
      pendingRejectionReason: null,
      pendingSpritesheetUrl: null,
      pendingPetJsonUrl: null,
      pendingZipUrl: null,
      pendingSpritesheetWidth: null,
      pendingSpritesheetHeight: null,
      pendingSpriteVersionNumber: null,
      pendingDhash: null,
      pendingReviewId: null,
    })
    .where(eq(schema.submittedPets.id, id));

  return NextResponse.json({ ok: true });
}
