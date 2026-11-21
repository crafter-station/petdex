import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";

import { getCollectionCandidatesForPet } from "@/lib/collections";
import { db, schema } from "@/lib/db/client";
import { toPendingEditView } from "@/lib/pet-edit-state";

export const runtime = "nodejs";

type Params = { slug: string };

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

export async function GET(
  _req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ isOwner: false }, { headers: PRIVATE_HEADERS });
  }

  const { slug } = await ctx.params;
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) {
    return NextResponse.json(
      { error: "invalid_slug" },
      { status: 400, headers: PRIVATE_HEADERS },
    );
  }

  const row = await db.query.submittedPets.findFirst({
    where: eq(schema.submittedPets.slug, slug),
  });

  if (!row || row.status !== "approved" || row.ownerId !== userId) {
    return NextResponse.json({ isOwner: false }, { headers: PRIVATE_HEADERS });
  }

  const collectionSuggest = await getCollectionCandidatesForPet(slug, userId);

  return NextResponse.json(
    {
      isOwner: true,
      petId: row.id,
      currentTags: (row.tags as string[]) ?? [],
      pending: toPendingEditView(row),
      lastRejection: row.pendingRejectionReason,
      collectionSuggest,
    },
    { headers: PRIVATE_HEADERS },
  );
}
