import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, desc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";

export const runtime = "nodejs";

// Compact list of the signed-in user's approved pets — used by the
// "I have a pet for this" modal on /requests to populate a selector.
// Returns id + slug + displayName + spritesheet (and nothing else, so
// we don't accidentally leak owner_email or pending edits).
export async function GET(): Promise<Response> {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rows = await db
    .select({
      id: schema.submittedPets.id,
      slug: schema.submittedPets.slug,
      displayName: schema.submittedPets.displayName,
      spritesheetUrl: schema.submittedPets.spritesheetUrl,
    })
    .from(schema.submittedPets)
    .where(
      and(
        eq(schema.submittedPets.ownerId, userId),
        eq(schema.submittedPets.status, "approved"),
      ),
    )
    .orderBy(desc(schema.submittedPets.approvedAt));

  return NextResponse.json({ pets: rows });
}
