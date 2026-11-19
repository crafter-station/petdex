import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, desc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { toCurrentR2PublicUrl } from "@/lib/r2-public-url";

export const runtime = "nodejs";

// Per-user data on a URL that carries no user identity, so an intermediary
// must not reuse it. Same reason as `/api/notifications` and
// `/api/pet-requests`, which say `private, no-store`; this one said nothing.
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

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

  return NextResponse.json(
    {
      pets: rows.map((row) => ({
        ...row,
        spritesheetUrl: toCurrentR2PublicUrl(row.spritesheetUrl),
      })),
    },
    { headers: PRIVATE_HEADERS },
  );
}
