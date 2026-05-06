import { updateTag } from "next/cache";
import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";

import { isAdmin } from "@/lib/admin";
import { db, schema } from "@/lib/db/client";
import { requireSameOrigin } from "@/lib/same-origin";
import { applySubmissionAction } from "@/lib/submission-decisions";
import { takedownPet } from "@/lib/takedown";

type Params = { id: string };

type PatchBody = {
  // 'pending' revives a previously rejected row back into the queue.
  action: "approve" | "reject" | "edit" | "pending";
  reason?: string | null;
  // edit-only fields (also accepted on approve to combine in one request)
  displayName?: string;
  description?: string;
  slug?: string;
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
    body.action !== "approve" &&
    body.action !== "reject" &&
    body.action !== "edit" &&
    body.action !== "pending"
  ) {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const result = await applySubmissionAction(id, body, { actor: "admin" });
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json({ ok: true, status: result.row.status });
}

// Hard takedown. Removes the pet row, every cross-table reference that
// stores its slug, and every R2 asset uploaded for the submission. The
// slug is freed so the original author (or anyone else) can re-submit.
//
// Use case: rights-holder asks to take down their own pet, DMCA, or
// any other reason where rejecting + leaving the row around isn't
// enough. For routine "this submission isn't a fit" cases prefer
// PATCH action: 'reject' so the audit trail stays.
type DeleteBody = {
  reason?: string | null;
};

export async function DELETE(
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

  let body: DeleteBody = {};
  try {
    body = (await req.json().catch(() => ({}))) as DeleteBody;
  } catch {
    body = {};
  }
  const reason = body.reason?.trim() || null;

  const pet = await db.query.submittedPets.findFirst({
    where: eq(schema.submittedPets.id, id),
  });
  if (!pet) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await takedownPet({
    pet,
    reason,
    source: "admin",
    actorId: userId ?? "unknown",
  });

  updateTag("gallery");
  updateTag(`pet:${pet.slug}`);
  updateTag(`profile:${pet.ownerId}`);

  return NextResponse.json({ ok: true });
}
