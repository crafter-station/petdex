import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { withdrawRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";
import { takedownPet } from "@/lib/takedown";

export const runtime = "nodejs";

// Owner self-service delete. Hard-removes a pet the caller owns:
// drops the DB row, every cross-table reference, and the R2 assets.
// The slug becomes available for someone else to reuse.
//
// Used by the "Remove from Petdex" entry in the per-card action menu
// when the viewer is the pet's owner. Mirrors the admin DELETE in
// /api/admin/[id] but is keyed by slug (the menu has the slug, not
// the pet id) and gated on owner_id rather than admin status.
//
// We deliberately do NOT support this for 'discover'-source pets the
// caller hasn't claimed — those need to go through the claim flow on
// /u/<handle> first so we know the actor really is the original
// author.
type DeleteBody = {
  reason?: string | null;
};

type Params = { slug: string };

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

  const lim = await withdrawRatelimit.limit(userId);
  if (!lim.success) {
    return NextResponse.json(
      { error: "rate_limited", retryAfter: lim.reset },
      { status: 429 },
    );
  }

  const { slug } = await ctx.params;
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) {
    return NextResponse.json({ error: "invalid_slug" }, { status: 400 });
  }

  let body: DeleteBody = {};
  try {
    body = (await req.json().catch(() => ({}))) as DeleteBody;
  } catch {
    body = {};
  }
  const reason = body.reason?.trim() || null;

  const pet = await db.query.submittedPets.findFirst({
    where: eq(schema.submittedPets.slug, slug),
  });
  if (!pet) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (pet.ownerId !== userId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (pet.source === "discover") {
    return NextResponse.json(
      {
        error: "claim_required",
        message:
          "This pet was added on your behalf. Claim it from your profile first, then delete it.",
      },
      { status: 409 },
    );
  }

  await takedownPet({
    pet,
    reason,
    source: "owner",
    actorId: userId,
    // Owner triggered it — no need to email/notify themselves.
    silent: true,
  });

  return NextResponse.json({ ok: true });
}
