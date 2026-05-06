import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";

import { isAdmin } from "@/lib/admin";
import { db, schema } from "@/lib/db/client";
import { requireSameOrigin } from "@/lib/same-origin";

// Toggle the `featured` flag on an approved pet. Featured pets land
// at the top of the gallery, get pinned tier in the curated sort, and
// pre-fill the home page's hero strip when their slug matches the
// hand-picked LANDING_COLLECTION_ORDER set in /[locale]/page.tsx.
//
// Lives at its own route (not folded into PATCH /api/admin/[id]) so
// the existing approve/reject/edit flow stays narrow. The page still
// fires plain optimistic-style PATCH calls; this one is a focused
// "elevate / demote" toggle.
type Params = { id: string };

type PatchBody = {
  featured: boolean;
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
  if (typeof body.featured !== "boolean") {
    return NextResponse.json({ error: "invalid_featured" }, { status: 400 });
  }

  const [row] = await db
    .update(schema.submittedPets)
    .set({ featured: body.featured })
    .where(eq(schema.submittedPets.id, id))
    .returning({
      id: schema.submittedPets.id,
      slug: schema.submittedPets.slug,
      status: schema.submittedPets.status,
      featured: schema.submittedPets.featured,
    });

  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (row.status !== "approved") {
    // We allow the flag flip on non-approved rows so the admin can
    // pre-feature a pet that hasn't been approved yet. The gallery
    // queries already filter on status='approved' so a pre-flagged
    // pending pet only goes live after approval. Just log it.
    console.info("[feature] flagged non-approved pet", {
      id,
      slug: row.slug,
      featured: row.featured,
      by: userId,
    });
  }

  return NextResponse.json({ ok: true, featured: row.featured });
}
