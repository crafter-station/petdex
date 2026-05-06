import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";

import { isAdmin } from "@/lib/admin";
import { db, schema } from "@/lib/db/client";
import { createNotification } from "@/lib/notifications";
import { requireSameOrigin } from "@/lib/same-origin";

type Params = { id: string };

type PatchBody = {
  action: "fulfill" | "dismiss" | "reopen" | "approve_image" | "reject_image";
  petSlug?: string;
  reason?: string;
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
    body.action !== "fulfill" &&
    body.action !== "dismiss" &&
    body.action !== "reopen" &&
    body.action !== "approve_image" &&
    body.action !== "reject_image"
  ) {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const row = await db.query.petRequests.findFirst({
    where: eq(schema.petRequests.id, id),
  });
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (body.action === "approve_image") {
    if (!row.imageUrl) {
      return NextResponse.json({ error: "missing_image" }, { status: 400 });
    }
    await db
      .update(schema.petRequests)
      .set({
        imageReviewStatus: "approved",
        imageRejectionReason: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.petRequests.id, id));
    return NextResponse.json({ ok: true, imageReviewStatus: "approved" });
  }

  if (body.action === "reject_image") {
    if (!row.imageUrl) {
      return NextResponse.json({ error: "missing_image" }, { status: 400 });
    }
    await db
      .update(schema.petRequests)
      .set({
        imageReviewStatus: "rejected",
        imageRejectionReason: (body.reason ?? "").trim() || null,
        updatedAt: new Date(),
      })
      .where(eq(schema.petRequests.id, id));
    return NextResponse.json({ ok: true, imageReviewStatus: "rejected" });
  }

  if (body.action === "fulfill") {
    const slug = (body.petSlug ?? "")
      .trim()
      .toLowerCase()
      .replace(/^\/?pets\//, "");
    if (!slug) {
      return NextResponse.json({ error: "missing_slug" }, { status: 400 });
    }
    const pet = await db.query.submittedPets.findFirst({
      where: and(
        eq(schema.submittedPets.slug, slug),
        eq(schema.submittedPets.status, "approved"),
      ),
    });
    if (!pet) {
      return NextResponse.json(
        { error: "pet_not_found_or_not_approved", slug },
        { status: 400 },
      );
    }

    await db
      .update(schema.petRequests)
      .set({
        status: "fulfilled",
        fulfilledPetSlug: pet.slug,
        updatedAt: new Date(),
      })
      .where(eq(schema.petRequests.id, id));

    if (row.requestedBy) {
      void createNotification({
        userId: row.requestedBy,
        kind: "request_fulfilled",
        payload: {
          requestId: row.id,
          requestQuery: row.query,
          petSlug: pet.slug,
          petName: pet.displayName,
        },
        href: `/pets/${pet.slug}`,
      }).catch(() => {});
    }

    return NextResponse.json({ ok: true, status: "fulfilled" });
  }

  if (body.action === "dismiss") {
    await db
      .update(schema.petRequests)
      .set({ status: "dismissed", updatedAt: new Date() })
      .where(eq(schema.petRequests.id, id));
    return NextResponse.json({ ok: true, status: "dismissed" });
  }

  // reopen
  await db
    .update(schema.petRequests)
    .set({
      status: "open",
      fulfilledPetSlug: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.petRequests.id, id));
  return NextResponse.json({ ok: true, status: "open" });
}
