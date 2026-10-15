// Owner-submitted "please add my pet to this collection" request.
// Identity comes from Clerk auth; we re-verify pet ownership server-side
// so a malicious body field can't smuggle somebody else's slug in.
//
// Rate-limited per user via the existing submitRatelimit bucket because
// submission spam = curation spam, and the cap is generous enough that
// legitimate creators never hit it.

import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import {
  BLOCKED_KEYWORD_REASON,
  containsBlockedKeyword,
} from "@/lib/keyword-blocklist";
import { submitRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";
import { containsUrl, URL_BLOCKED_REASON } from "@/lib/url-blocklist";

export const runtime = "nodejs";

type Body = { petSlug?: string; note?: string };

export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const lim = await submitRatelimit.limit(userId);
  if (!lim.success) {
    return NextResponse.json(
      { error: "rate_limited", retryAfter: lim.reset },
      { status: 429 },
    );
  }

  const { slug } = await ctx.params;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  // `req.json()` accepts a literal `null`; the property reads below would
  // otherwise throw and 500. Same boundary as `notifications/read`.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const petSlug = body.petSlug?.toString().trim().toLowerCase();
  if (!petSlug) {
    return NextResponse.json({ error: "invalid_pet_slug" }, { status: 400 });
  }
  const note = body.note?.toString().trim().slice(0, 500) || null;

  const noteUrlHit = containsUrl(["note", note]);
  if (noteUrlHit) {
    return NextResponse.json(
      {
        error: "url_in_field",
        field: noteUrlHit.field,
        message: URL_BLOCKED_REASON,
      },
      { status: 422 },
    );
  }

  if (containsBlockedKeyword(note, petSlug)) {
    return NextResponse.json(
      { error: "blocked_content", message: BLOCKED_KEYWORD_REASON },
      { status: 422 },
    );
  }

  // Find the collection. We accept either featured or community
  // collections — the community surface might let users vote on
  // unofficial sets later, and this endpoint already gates on
  // ownership of the pet.
  // Stored slugs are lowercase; the read path lowercases too, so a mixed-case
  // URL like /collections/Franchise-Pokemon/request must match or the page
  // works while its request action 404s.
  const collection = await db.query.petCollections.findFirst({
    where: eq(schema.petCollections.slug, slug.toLowerCase()),
  });
  if (!collection) {
    return NextResponse.json(
      { error: "collection_not_found" },
      { status: 404 },
    );
  }

  // Verify the pet is approved AND belongs to this user.
  const pet = await db.query.submittedPets.findFirst({
    where: and(
      eq(schema.submittedPets.slug, petSlug),
      eq(schema.submittedPets.ownerId, userId),
    ),
  });
  if (!pet) {
    return NextResponse.json({ error: "pet_not_owned" }, { status: 403 });
  }
  if (pet.status !== "approved") {
    return NextResponse.json({ error: "pet_not_approved" }, { status: 400 });
  }

  // Already in the collection? Don't queue a duplicate request.
  const alreadyMember = await db.query.petCollectionItems.findFirst({
    where: and(
      eq(schema.petCollectionItems.collectionId, collection.id),
      eq(schema.petCollectionItems.petSlug, petSlug),
    ),
  });
  if (alreadyMember) {
    return NextResponse.json(
      { error: "already_in_collection" },
      { status: 409 },
    );
  }

  // Pending request already on file? Surface that instead of inserting
  // a duplicate. The unique index would catch it but the error message
  // is more helpful when we look it up first.
  const existingPending = await db.query.petCollectionRequests.findFirst({
    where: and(
      eq(schema.petCollectionRequests.collectionId, collection.id),
      eq(schema.petCollectionRequests.petSlug, petSlug),
      eq(schema.petCollectionRequests.status, "pending"),
    ),
  });
  if (existingPending) {
    return NextResponse.json(
      { ok: true, alreadyPending: true, id: existingPending.id },
      { status: 200 },
    );
  }

  const id = `pcr_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
  try {
    await db.insert(schema.petCollectionRequests).values({
      id,
      collectionId: collection.id,
      petSlug,
      requestedBy: userId,
      note,
    });
  } catch (error) {
    // The pending check above is a separate statement, so two concurrent
    // requests (double-click, retry) both pass it and the second INSERT
    // hits `pet_collection_requests_pending_pair`. Answer the same
    // alreadyPending body the check would have instead of a 500.
    if (isUniqueViolation(error)) {
      const pending = await db.query.petCollectionRequests.findFirst({
        where: and(
          eq(schema.petCollectionRequests.collectionId, collection.id),
          eq(schema.petCollectionRequests.petSlug, petSlug),
          eq(schema.petCollectionRequests.status, "pending"),
        ),
      });
      return NextResponse.json(
        { ok: true, alreadyPending: true, id: pending?.id ?? null },
        { status: 200 },
      );
    }
    throw error;
  }

  return NextResponse.json({ ok: true, id }, { status: 201 });
}
