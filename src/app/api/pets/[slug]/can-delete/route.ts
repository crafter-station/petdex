import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";

// Tells the client menu whether the current viewer is allowed to hard-
// delete this pet. The check has to happen server-side because the
// public PetdexPet shape deliberately omits ownerId (we don't want
// Clerk user ids in any client bundle or API payload).
//
// The actual delete still re-checks ownership in DELETE /api/pets/
// [slug]/owner — this endpoint is only a UI-affordance hint, never a
// security boundary.
type Params = { slug: string };

export async function GET(
  _req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { canDelete: false },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const { slug } = await ctx.params;
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) {
    return NextResponse.json({ error: "invalid_slug" }, { status: 400 });
  }

  const pet = await db.query.submittedPets.findFirst({
    where: eq(schema.submittedPets.slug, slug),
    columns: { ownerId: true, source: true },
  });
  if (!pet) {
    return NextResponse.json(
      { canDelete: false },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const canDelete = pet.ownerId === userId && pet.source !== "discover";

  return NextResponse.json(
    { canDelete },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
