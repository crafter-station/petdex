import "server-only";

import { and, sql as drizzleSql, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { PETDEX_EMBEDDING_MODEL } from "@/lib/embeddings";

// Cosine similarity threshold for auto-suggested matches. 0.70 chosen
// empirically — pet/request pairs above this score read as "obviously
// related" in spot checks; below it produces too many noisy matches.
// Tune downward if admins want a wider funnel, upward if the queue
// gets noisy. Manual claims bypass this threshold entirely.
export const AUTO_MATCH_THRESHOLD = 0.7;
export const AUTO_MATCH_TOP_K = 5;

export type CandidateSource = "auto" | "manual";
export type CandidateStatus = "pending" | "approved" | "rejected";

// Run after a submitted pet transitions to status='approved'. Looks
// up open requests whose embedding lies within AUTO_MATCH_THRESHOLD of
// the pet's own embedding, and writes them as pending candidates.
//
// No-ops gracefully when the pet has no embedding (older rows) or no
// open requests cross the threshold. Idempotent: re-running won't
// create duplicates because (pet_id, request_id) is the primary key
// of pet_request_candidates.
export async function autoSuggestCandidates(petId: string): Promise<{
  inserted: number;
  scannedRequests: number;
}> {
  const pet = await db.query.submittedPets.findFirst({
    columns: { id: true, status: true },
    where: eq(schema.submittedPets.id, petId),
  });
  if (!pet || pet.status !== "approved") {
    return { inserted: 0, scannedRequests: 0 };
  }

  // Pull pet embedding via raw SQL — drizzle column type for pgvector
  // isn't first-class; we cast to text and parse the vector literal.
  const petRow = await db.execute<{
    embedding: string | null;
    embedding_model: string | null;
  }>(drizzleSql`
    SELECT embedding::text AS embedding, embedding_model
    FROM submitted_pets
    WHERE id = ${petId}
    LIMIT 1
  `);
  const petEmbeddingText = petRow.rows[0]?.embedding;
  const petEmbeddingModel = petRow.rows[0]?.embedding_model;
  if (!petEmbeddingText || petEmbeddingModel !== PETDEX_EMBEDDING_MODEL) {
    return { inserted: 0, scannedRequests: 0 };
  }

  // Cosine search against open requests with a matching embedding.
  // Distance <=> returns 0 (identical) to 2 (opposite); similarity =
  // 1 - distance. Filter at SQL level so we only fetch candidates.
  const matches = await db.execute<{
    request_id: string;
    similarity: number;
  }>(drizzleSql`
    SELECT
      pr.id AS request_id,
      1 - (pr.embedding <=> ${petEmbeddingText}::vector) AS similarity
    FROM pet_requests pr
    WHERE pr.status = 'open'
      AND pr.embedding IS NOT NULL
      AND pr.embedding_model = ${PETDEX_EMBEDDING_MODEL}
      AND 1 - (pr.embedding <=> ${petEmbeddingText}::vector) >= ${AUTO_MATCH_THRESHOLD}
    ORDER BY pr.embedding <=> ${petEmbeddingText}::vector
    LIMIT ${AUTO_MATCH_TOP_K}
  `);

  if (matches.rows.length === 0) {
    return { inserted: 0, scannedRequests: 0 };
  }

  // Insert candidates, skipping any (pet, request) pair that already
  // exists. ON CONFLICT keeps re-runs idempotent without raising.
  const values = matches.rows.map((row) => ({
    petId,
    requestId: row.request_id,
    similarity: row.similarity,
    source: "auto" as CandidateSource,
    status: "pending" as CandidateStatus,
  }));

  const inserted = await db
    .insert(schema.petRequestCandidates)
    .values(values)
    .onConflictDoNothing({
      target: [
        schema.petRequestCandidates.petId,
        schema.petRequestCandidates.requestId,
      ],
    })
    .returning({ petId: schema.petRequestCandidates.petId });

  return {
    inserted: inserted.length,
    scannedRequests: matches.rows.length,
  };
}

// Manual claim from /requests UI. The pet must be approved and owned
// by the caller; the request must be open. Returns "exists" if a
// candidate is already pending for this pair (same pet, same request).
export async function createManualCandidate(args: {
  petId: string;
  requestId: string;
  ownerId: string;
}): Promise<
  | { ok: true }
  | { ok: false; reason: "pet_not_found" | "not_owner" | "pet_not_approved" }
  | { ok: false; reason: "request_not_found" | "request_not_open" }
  | { ok: false; reason: "exists" }
> {
  const pet = await db.query.submittedPets.findFirst({
    columns: { id: true, status: true, ownerId: true },
    where: eq(schema.submittedPets.id, args.petId),
  });
  if (!pet) return { ok: false, reason: "pet_not_found" };
  if (pet.ownerId !== args.ownerId) return { ok: false, reason: "not_owner" };
  if (pet.status !== "approved")
    return { ok: false, reason: "pet_not_approved" };

  const request = await db.query.petRequests.findFirst({
    columns: { id: true, status: true },
    where: eq(schema.petRequests.id, args.requestId),
  });
  if (!request) return { ok: false, reason: "request_not_found" };
  if (request.status !== "open")
    return { ok: false, reason: "request_not_open" };

  const existing = await db.query.petRequestCandidates.findFirst({
    columns: { petId: true, status: true },
    where: and(
      eq(schema.petRequestCandidates.petId, args.petId),
      eq(schema.petRequestCandidates.requestId, args.requestId),
    ),
  });
  if (existing) return { ok: false, reason: "exists" };

  await db.insert(schema.petRequestCandidates).values({
    petId: args.petId,
    requestId: args.requestId,
    similarity: null,
    source: "manual",
    status: "pending",
  });

  return { ok: true };
}

// Lists pending candidates for the admin queue, joined with pet and
// request snapshots so the UI can render previews without a second
// round of queries.
export async function listPendingCandidates(limit = 50): Promise<
  Array<{
    petId: string;
    requestId: string;
    similarity: number | null;
    source: CandidateSource;
    suggestedAt: Date;
    pet: {
      slug: string;
      displayName: string;
      spritesheetUrl: string;
      ownerId: string;
      creditName: string | null;
    };
    request: {
      query: string;
      upvoteCount: number;
      imageUrl: string | null;
    };
  }>
> {
  const rows = await db.execute<{
    pet_id: string;
    request_id: string;
    similarity: number | null;
    source: string;
    suggested_at: Date;
    pet_slug: string;
    pet_display_name: string;
    pet_spritesheet_url: string;
    pet_owner_id: string;
    pet_credit_name: string | null;
    request_query: string;
    request_upvote_count: number;
    request_image_url: string | null;
    request_image_review_status: string;
  }>(drizzleSql`
    SELECT
      c.pet_id, c.request_id, c.similarity, c.source, c.suggested_at,
      p.slug AS pet_slug,
      p.display_name AS pet_display_name,
      p.spritesheet_url AS pet_spritesheet_url,
      p.owner_id AS pet_owner_id,
      p.credit_name AS pet_credit_name,
      r.query AS request_query,
      r.upvote_count AS request_upvote_count,
      r.image_url AS request_image_url,
      r.image_review_status AS request_image_review_status
    FROM pet_request_candidates c
    JOIN submitted_pets p ON p.id = c.pet_id
    JOIN pet_requests r ON r.id = c.request_id
    WHERE c.status = 'pending'
      AND p.status = 'approved'
      AND r.status = 'open'
    ORDER BY c.suggested_at DESC
    LIMIT ${limit}
  `);

  return rows.rows.map((row) => ({
    petId: row.pet_id,
    requestId: row.request_id,
    similarity: row.similarity,
    source: row.source as CandidateSource,
    suggestedAt: row.suggested_at,
    pet: {
      slug: row.pet_slug,
      displayName: row.pet_display_name,
      spritesheetUrl: row.pet_spritesheet_url,
      ownerId: row.pet_owner_id,
      creditName: row.pet_credit_name,
    },
    request: {
      query: row.request_query,
      upvoteCount: row.request_upvote_count,
      imageUrl:
        row.request_image_review_status === "approved"
          ? row.request_image_url
          : null,
    },
  }));
}

// Approve resolves a pending candidate into the canonical "fulfilled"
// state on the request, and auto-rejects any other pending candidates
// for the same request (only one pet can fulfill a request).
//
// Returns the request id, fulfilled pet id, and the owner of that pet
// so the caller can grant badges / dispatch notifications without a
// second lookup.
export async function approveCandidate(args: {
  petId: string;
  requestId: string;
  resolvedBy: string;
}): Promise<
  | {
      ok: true;
      petOwnerId: string;
      petSlug: string;
      petDisplayName: string;
      requestQuery: string;
      requesterId: string | null;
    }
  | { ok: false; reason: "not_found" | "not_pending" }
> {
  const candidate = await db.query.petRequestCandidates.findFirst({
    where: and(
      eq(schema.petRequestCandidates.petId, args.petId),
      eq(schema.petRequestCandidates.requestId, args.requestId),
    ),
  });
  if (!candidate) return { ok: false, reason: "not_found" };
  if (candidate.status !== "pending")
    return { ok: false, reason: "not_pending" };

  const pet = await db.query.submittedPets.findFirst({
    columns: { id: true, slug: true, displayName: true, ownerId: true },
    where: eq(schema.submittedPets.id, args.petId),
  });
  if (!pet) return { ok: false, reason: "not_found" };

  const request = await db.query.petRequests.findFirst({
    columns: { id: true, query: true, requestedBy: true },
    where: eq(schema.petRequests.id, args.requestId),
  });
  if (!request) return { ok: false, reason: "not_found" };

  const now = new Date();

  // Resolve this candidate → approved
  await db
    .update(schema.petRequestCandidates)
    .set({
      status: "approved",
      resolvedAt: now,
      resolvedBy: args.resolvedBy,
    })
    .where(
      and(
        eq(schema.petRequestCandidates.petId, args.petId),
        eq(schema.petRequestCandidates.requestId, args.requestId),
      ),
    );

  // Auto-reject siblings: any other pending candidate for the same
  // request loses now that we picked a winner.
  await db
    .update(schema.petRequestCandidates)
    .set({
      status: "rejected",
      resolvedAt: now,
      resolvedBy: args.resolvedBy,
      rejectionReason: "another_candidate_approved",
    })
    .where(
      and(
        eq(schema.petRequestCandidates.requestId, args.requestId),
        eq(schema.petRequestCandidates.status, "pending"),
      ),
    );

  // Mark the request fulfilled with the chosen pet.
  await db
    .update(schema.petRequests)
    .set({
      status: "fulfilled",
      fulfilledPetSlug: pet.slug,
      updatedAt: now,
    })
    .where(eq(schema.petRequests.id, args.requestId));

  return {
    ok: true,
    petOwnerId: pet.ownerId,
    petSlug: pet.slug,
    petDisplayName: pet.displayName,
    requestQuery: request.query,
    requesterId: request.requestedBy,
  };
}

export async function rejectCandidate(args: {
  petId: string;
  requestId: string;
  resolvedBy: string;
  reason?: string;
}): Promise<{ ok: true } | { ok: false; reason: "not_found" | "not_pending" }> {
  const candidate = await db.query.petRequestCandidates.findFirst({
    columns: { petId: true, status: true },
    where: and(
      eq(schema.petRequestCandidates.petId, args.petId),
      eq(schema.petRequestCandidates.requestId, args.requestId),
    ),
  });
  if (!candidate) return { ok: false, reason: "not_found" };
  if (candidate.status !== "pending")
    return { ok: false, reason: "not_pending" };

  await db
    .update(schema.petRequestCandidates)
    .set({
      status: "rejected",
      resolvedAt: new Date(),
      resolvedBy: args.resolvedBy,
      rejectionReason: args.reason ?? null,
    })
    .where(
      and(
        eq(schema.petRequestCandidates.petId, args.petId),
        eq(schema.petRequestCandidates.requestId, args.requestId),
      ),
    );

  return { ok: true };
}

// Lists pending candidates for a single user — used by /requests UI
// to mark pets that are already submitted as candidates so the modal
// can grey them out.
export async function getCandidatesForOwner(
  ownerId: string,
): Promise<
  Array<{ petId: string; requestId: string; status: CandidateStatus }>
> {
  const rows = await db.execute<{
    pet_id: string;
    request_id: string;
    status: string;
  }>(drizzleSql`
    SELECT c.pet_id, c.request_id, c.status
    FROM pet_request_candidates c
    JOIN submitted_pets p ON p.id = c.pet_id
    WHERE p.owner_id = ${ownerId}
  `);
  return rows.rows.map((row) => ({
    petId: row.pet_id,
    requestId: row.request_id,
    status: row.status as CandidateStatus,
  }));
}
