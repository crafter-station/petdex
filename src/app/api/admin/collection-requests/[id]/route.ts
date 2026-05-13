// Admin: approve / reject a pet→collection request. Approval inserts
// a row into petCollectionItems at the next available position and
// stamps the request with `decided_*`. Rejection just stamps the
// reason. Both are idempotent re-reads of the existing row state.

import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, desc, eq } from "drizzle-orm";

import { isAdmin } from "@/lib/admin";
import { invalidateCollectionBacklinks } from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

type Params = { id: string };
type PatchBody = {
  action: "approve" | "reject";
  reason?: string | null;
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
  if (body.action !== "approve" && body.action !== "reject") {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const request = await db.query.petCollectionRequests.findFirst({
    where: eq(schema.petCollectionRequests.id, id),
  });
  if (!request) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (request.status !== "pending") {
    return NextResponse.json(
      { error: "already_decided", status: request.status },
      { status: 409 },
    );
  }

  // Re-verify ownership + approved status at decision time so an
  // ownership flip between submit and approve can't smuggle somebody
  // else's pet into a featured set.
  const pet = await db.query.submittedPets.findFirst({
    where: eq(schema.submittedPets.slug, request.petSlug),
  });
  if (
    !pet ||
    pet.status !== "approved" ||
    pet.ownerId !== request.requestedBy
  ) {
    await db
      .update(schema.petCollectionRequests)
      .set({
        status: "rejected",
        decidedAt: new Date(),
        decidedBy: userId ?? null,
        rejectionReason: "ownership_or_status_changed",
      })
      .where(eq(schema.petCollectionRequests.id, id));
    return NextResponse.json(
      { error: "ownership_or_status_changed" },
      { status: 409 },
    );
  }

  if (body.action === "reject") {
    await db
      .update(schema.petCollectionRequests)
      .set({
        status: "rejected",
        decidedAt: new Date(),
        decidedBy: userId ?? null,
        rejectionReason: body.reason?.toString().slice(0, 500) ?? null,
      })
      .where(eq(schema.petCollectionRequests.id, id));
    return NextResponse.json({ ok: true });
  }

  // Approve: insert into pet_collection_items if not already in. Pick
  // the next position so the new pet lands at the end of the list.
  const existing = await db.query.petCollectionItems.findFirst({
    where: and(
      eq(schema.petCollectionItems.collectionId, request.collectionId),
      eq(schema.petCollectionItems.petSlug, request.petSlug),
    ),
  });
  if (!existing) {
    const last = await db
      .select({ position: schema.petCollectionItems.position })
      .from(schema.petCollectionItems)
      .where(eq(schema.petCollectionItems.collectionId, request.collectionId))
      .orderBy(desc(schema.petCollectionItems.position))
      .limit(1);
    const nextPosition = (last[0]?.position ?? -1) + 1;
    await db.insert(schema.petCollectionItems).values({
      collectionId: request.collectionId,
      petSlug: request.petSlug,
      position: nextPosition,
    });
  }
  await db
    .update(schema.petCollectionRequests)
    .set({
      status: "approved",
      decidedAt: new Date(),
      decidedBy: userId ?? null,
    })
    .where(eq(schema.petCollectionRequests.id, id));
  await invalidateCollectionBacklinks(request.petSlug);

  return NextResponse.json({ ok: true });
}
