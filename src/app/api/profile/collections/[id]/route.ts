import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, eq, sql } from "drizzle-orm";

import {
  canManageCreatorCollections,
  collectionApprovedPetsCondition,
  collectionEmptyMemberListCondition,
  collectionMutationStatusQuery,
  deleteCollectionItemsQuery,
  hasCollectionMutationRow,
  insertCollectionItemsQuery,
  parseCollectionMutationStatus,
  runCollectionMutation,
} from "@/lib/collection-access";
import { collectionPetLimitExceeded } from "@/lib/collection-constants";
import {
  type CollectionRequestBody,
  collectionInputErrorCode,
  isCollectionRequestBody,
  MAX_COLLECTION_PETS,
  normalizeCollectionCover,
  normalizeCollectionExternalUrl,
  normalizeCollectionPatch,
  resolveCollectionCover,
} from "@/lib/collection-input";
import { collectionCoverForPetSlugsQuery } from "@/lib/collection-sql";
import { revalidateCollectionTags } from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { id: string };

// Edit one of the caller's personal collections. Featured/admin
// collections are NOT editable here even if owner_id matches — those
// are admin-curated.
export async function PATCH(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(await canManageCreatorCollections(userId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;

  const collection = await db.query.petCollections.findFirst({
    where: eq(schema.petCollections.id, id),
  });
  if (!collection || collection.ownerId !== userId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (collection.featured) {
    return NextResponse.json(
      { error: "featured_not_editable" },
      { status: 403 },
    );
  }

  let body: CollectionRequestBody;
  try {
    const parsed = await req.json();
    if (!isCollectionRequestBody(parsed)) throw new Error("invalid_body");
    body = parsed;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // Only the fields the request carries are validated. Substituting the stored
  // value for an omitted one widened the checks past the request: a row whose
  // stored description exceeded the limit — the database permits it, and the
  // ops scripts write directly — failed description_length on a rename or a
  // cover-only edit, and resending the value did not help. Every write below is
  // gated on `body.X !== undefined`, so nothing reads a merged value.
  let patchInput: ReturnType<typeof normalizeCollectionPatch>;
  try {
    patchInput = normalizeCollectionPatch({
      title: body.title,
      description: body.description,
      petSlugs: body.petSlugs,
    });
  } catch (error) {
    return NextResponse.json(
      { error: collectionInputErrorCode(error) },
      { status: 400 },
    );
  }

  const patch: Partial<typeof schema.petCollections.$inferInsert> = {};

  if (body.title !== undefined) {
    patch.title = patchInput.title;
  }

  if (body.description !== undefined) {
    patch.description = patchInput.description;
  }

  if (body.externalUrl !== undefined) {
    const u = normalizeCollectionExternalUrl(body.externalUrl);
    if (u === false) {
      return NextResponse.json({ error: "invalid_url" }, { status: 400 });
    }
    patch.externalUrl = u;
  }

  const requestedCover = normalizeCollectionCover(body.coverPetSlug);
  if (requestedCover === false) {
    return NextResponse.json({ error: "invalid_cover_pet" }, { status: 400 });
  }

  let petSlugs: string[] | undefined;
  if (body.petSlugs !== undefined) {
    // The guard above and the validator agree: a body that named the field
    // produced a list. Narrowing here keeps the rest of the block on a
    // definitely-present array rather than coercing an impossible undefined to
    // [], which would read as "empty the collection".
    const requestedPetSlugs = patchInput.petSlugs;
    if (requestedPetSlugs === undefined) {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }
    const approvedPets = await db
      .select({ slug: schema.submittedPets.slug })
      .from(schema.submittedPets)
      .where(
        and(
          eq(schema.submittedPets.ownerId, userId),
          eq(schema.submittedPets.status, "approved"),
        ),
      );
    const allowedSlugs = new Set(approvedPets.map((p) => p.slug));
    // The cap bounds growth, not the stored row. A collection created before
    // the cap existed can hold more than MAX_COLLECTION_PETS, and rejecting
    // that list would leave the row uneditable — not even a title fix — until
    // its owner deleted members. Over-cap is allowed while it adds nothing.
    const storedItems = await db
      .select({ slug: schema.petCollectionItems.petSlug })
      .from(schema.petCollectionItems)
      .where(eq(schema.petCollectionItems.collectionId, id));
    if (
      collectionPetLimitExceeded(
        requestedPetSlugs,
        storedItems.map((item) => item.slug),
      )
    ) {
      return NextResponse.json(
        { error: "collection_pet_limit", max: MAX_COLLECTION_PETS },
        { status: 400 },
      );
    }
    if (requestedPetSlugs.some((slug) => !allowedSlugs.has(slug))) {
      return NextResponse.json(
        { error: "pet_not_owned_or_approved" },
        { status: 422 },
      );
    }
    // An empty list is refused rather than applied. It no longer risks deleting
    // every member — deleteCollectionItemsQuery returns null for an empty list,
    // so the statement cannot be built — but it would still be a silent no-op:
    // the parent update succeeds, no member changes, and the response reports
    // an empty list the collection does not have.
    // This is the fast path, and it is free: `storedItems` was already read for
    // the cap check. It cannot be the only enforcement point, because a
    // concurrent writer can add a member after this read — the UPDATE's WHERE
    // carries collectionEmptyMemberListCondition for exactly that case, and the
    // status check below reports it. Only refuse when there is something to
    // keep, so a row left empty by an older build stays renameable.
    if (requestedPetSlugs.length === 0 && storedItems.length > 0) {
      return NextResponse.json({ error: "empty_pet_slugs" }, { status: 400 });
    }
    petSlugs = requestedPetSlugs;
    if (requestedCover !== null && !petSlugs.includes(requestedCover)) {
      return NextResponse.json(
        { error: "cover_not_in_collection" },
        { status: 400 },
      );
    }
    patch.coverPetSlug = resolveCollectionCover(
      // Absent and blank both normalize to null, and the helper has to tell
      // them apart: absent preserves, blank clears.
      body.coverPetSlug === undefined ? undefined : requestedCover,
      petSlugs,
      collection.coverPetSlug,
    );
  } else if (body.coverPetSlug !== undefined) {
    // Cover-only update — verify the slug is currently in the collection.
    const items = await db
      .select({ slug: schema.petCollectionItems.petSlug })
      .from(schema.petCollectionItems)
      .where(eq(schema.petCollectionItems.collectionId, id));
    const set = new Set(items.map((r) => r.slug));
    if (requestedCover !== null && !set.has(requestedCover)) {
      return NextResponse.json(
        { error: "cover_not_in_collection" },
        { status: 400 },
      );
    }
    patch.coverPetSlug = requestedCover;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
  }

  patch.updatedAt = new Date();
  const updatePatch = {
    ...patch,
    ...(body.petSlugs !== undefined && body.coverPetSlug === undefined
      ? {
          coverPetSlug: collectionCoverForPetSlugsQuery(petSlugs ?? []),
        }
      : {}),
  };
  const coverValidationRequired =
    body.petSlugs === undefined &&
    body.coverPetSlug !== undefined &&
    requestedCover !== null;
  const mutationPetSlugs =
    body.petSlugs !== undefined
      ? (petSlugs ?? [])
      : coverValidationRequired
        ? [requestedCover as string]
        : undefined;
  const updateBaseWhere = and(
    eq(schema.petCollections.id, id),
    eq(schema.petCollections.ownerId, userId),
    eq(schema.petCollections.featured, false),
  );
  const petAuthorization = mutationPetSlugs
    ? collectionApprovedPetsCondition(userId, mutationPetSlugs)
    : sql`TRUE`;
  // An empty member list is only allowed to write while the collection holds
  // nothing. Judging it here, in the UPDATE's WHERE, is what keeps it true
  // against a member a concurrent writer adds after the pre-lock read.
  // `petSlugs` is undefined when this request does not touch the members, which
  // the condition reads as "no restriction" — passing [] instead would refuse
  // every rename of a collection that holds members.
  const emptyMemberListAllowed = collectionEmptyMemberListCondition(
    id,
    petSlugs,
  );
  const updateWhere = coverValidationRequired
    ? and(
        updateBaseWhere,
        petAuthorization,
        sql`EXISTS (
          SELECT 1
          FROM "pet_collection_items"
          WHERE "collection_id" = ${id}
            AND "pet_slug" = ${requestedCover}
        )`,
      )
    : and(updateBaseWhere, petAuthorization, emptyMemberListAllowed);
  const mutationStatusCheck =
    mutationPetSlugs || coverValidationRequired
      ? collectionMutationStatusQuery({
          collectionId: id,
          ownerId: userId,
          petAuthorization,
          rejectEmptyPetList:
            body.petSlugs !== undefined && petSlugs?.length === 0,
          ...(coverValidationRequired
            ? { coverPetSlug: requestedCover as string }
            : {}),
        })
      : null;
  const deletedItems =
    body.petSlugs !== undefined
      ? deleteCollectionItemsQuery(id, userId, petSlugs ?? [], {
          requireSuccessfulParentUpdate: true,
        })
      : null;
  const insertedItems =
    body.petSlugs !== undefined
      ? insertCollectionItemsQuery(id, petSlugs ?? [], userId, {
          requireSuccessfulParentUpdate: true,
        })
      : null;
  // update(0) then the optional deletes/inserts, then the optional status
  // select last. Keep this expression next to the buildBatch that matches it.
  const statusResultIndex =
    1 + (deletedItems ? 1 : 0) + (insertedItems ? 1 : 0);
  const mutation = await runCollectionMutation({
    collectionId: id,
    petMutation: mutationPetSlugs
      ? { ownerId: userId, petSlugs: mutationPetSlugs }
      : undefined,
    buildBatch: (client) => [
      client
        .update(schema.petCollections)
        .set(updatePatch)
        .where(updateWhere)
        .returning({ id: schema.petCollections.id }),
      ...(deletedItems ? [client.execute(deletedItems)] : []),
      ...(insertedItems ? [client.execute(insertedItems)] : []),
      ...(mutationStatusCheck ? [client.execute(mutationStatusCheck)] : []),
    ],
    runTransaction: async (tx) => {
      const updatedRows = await tx
        .update(schema.petCollections)
        .set(updatePatch)
        .where(updateWhere)
        .returning({ id: schema.petCollections.id });
      if (updatedRows.length > 0) {
        if (deletedItems) await tx.execute(deletedItems);
        if (insertedItems) await tx.execute(insertedItems);
        return {
          updated: true,
          collectionExists: true,
          petsValid: true,
          coverExists: true,
          emptyListRejected: false,
        };
      }
      if (mutationStatusCheck) {
        const status = parseCollectionMutationStatus(
          await tx.execute(mutationStatusCheck),
        );
        return { updated: false, ...status };
      }
      return {
        updated: false,
        collectionExists: false,
        petsValid: true,
        coverExists: true,
        emptyListRejected: false,
      };
    },
    parseBatch: (results) => {
      const updateResult = results[0];
      const updated = hasCollectionMutationRow(updateResult);
      if (!mutationStatusCheck) {
        return {
          updated,
          collectionExists: updated,
          petsValid: true,
          coverExists: true,
          emptyListRejected: false,
        };
      }
      // Derived from the same conditions that built the array above, so
      // appending a statement to buildBatch cannot silently move the status
      // row out from under this lookup.
      const status = parseCollectionMutationStatus(results[statusResultIndex]);
      return {
        updated,
        ...status,
      };
    },
  });
  if (!mutation.updated) {
    if (!mutation.collectionExists) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (!mutation.petsValid) {
      return NextResponse.json(
        { error: "pet_not_owned_or_approved" },
        { status: 422 },
      );
    }
    if (coverValidationRequired && !mutation.coverExists) {
      return NextResponse.json(
        { error: "cover_not_in_collection" },
        { status: 400 },
      );
    }
    if (mutation.emptyListRejected) {
      return NextResponse.json({ error: "empty_pet_slugs" }, { status: 400 });
    }
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await revalidateCollectionTags(collection.slug);

  return NextResponse.json({ ok: true });
}

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

  const { id } = await ctx.params;

  const collection = await db.query.petCollections.findFirst({
    where: eq(schema.petCollections.id, id),
  });
  if (!collection || collection.ownerId !== userId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (collection.featured) {
    return NextResponse.json(
      { error: "featured_not_deletable" },
      { status: 403 },
    );
  }

  const deleted = await runCollectionMutation({
    collectionId: id,
    lockExistingPetSlugs: true,
    buildBatch: (client) => [
      client
        .delete(schema.petCollections)
        .where(
          and(
            eq(schema.petCollections.id, id),
            eq(schema.petCollections.ownerId, userId),
            eq(schema.petCollections.featured, false),
          ),
        )
        .returning({ id: schema.petCollections.id }),
    ],
    runTransaction: async (tx) => {
      const deletedRows = await tx
        .delete(schema.petCollections)
        .where(
          and(
            eq(schema.petCollections.id, id),
            eq(schema.petCollections.ownerId, userId),
            eq(schema.petCollections.featured, false),
          ),
        )
        .returning({ id: schema.petCollections.id });
      return deletedRows.length > 0;
    },
    parseBatch: (results) => hasCollectionMutationRow(results[0]),
  });
  if (!deleted)
    return NextResponse.json({ error: "not_found" }, { status: 404 });

  await revalidateCollectionTags(collection.slug);

  return NextResponse.json({ ok: true });
}
