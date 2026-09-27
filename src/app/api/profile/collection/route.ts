import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, asc, eq, sql } from "drizzle-orm";

import {
  canManageCreatorCollections,
  collectionApprovedPetsCondition,
  collectionEmptyMemberListCondition,
  collectionMutationRows,
  collectionMutationStatusQuery,
  createOrReuseOwnerCollection,
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
import {
  collectionSlugBase,
  collectionSlugCandidates,
} from "@/lib/collection-slug";
import { collectionCoverForPetSlugsQuery } from "@/lib/collection-sql";
import { revalidateCollectionTags } from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CollectionRow = typeof schema.petCollections.$inferSelect;

async function findCollectionAfterMutationLock(
  collectionId: string,
  ownerId: string,
): Promise<CollectionRow | null> {
  return runCollectionMutation<CollectionRow | null>({
    collectionId,
    buildBatch: (client) => [
      client
        .select()
        .from(schema.petCollections)
        .where(
          and(
            eq(schema.petCollections.id, collectionId),
            eq(schema.petCollections.ownerId, ownerId),
            eq(schema.petCollections.featured, false),
          ),
        )
        .limit(1),
    ],
    runTransaction: async (tx) => {
      const rows = await tx
        .select()
        .from(schema.petCollections)
        .where(
          and(
            eq(schema.petCollections.id, collectionId),
            eq(schema.petCollections.ownerId, ownerId),
            eq(schema.petCollections.featured, false),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    parseBatch: (results) => {
      const rows = collectionMutationRows(results[0]);
      return (rows[0] as CollectionRow | undefined) ?? null;
    },
  });
}

export async function PATCH(req: Request): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(await canManageCreatorCollections(userId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: CollectionRequestBody;
  try {
    const parsed = await req.json();
    if (!isCollectionRequestBody(parsed)) throw new Error("invalid_body");
    body = parsed;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  let [collection] = await db
    .select()
    .from(schema.petCollections)
    .where(
      and(
        eq(schema.petCollections.ownerId, userId),
        eq(schema.petCollections.featured, false),
      ),
    )
    .orderBy(
      asc(schema.petCollections.createdAt),
      asc(schema.petCollections.id),
    )
    .limit(1);

  // Only the fields the request carries are validated. Substituting the stored
  // value for an omitted one widened the checks past the request: a row whose
  // stored description exceeded the limit — the database permits it, and the
  // ops scripts write directly — failed description_length on a rename, and
  // resending the value did not help. Every write below is gated on
  // `body.X !== undefined`, so nothing reads a merged value.
  //
  // The create path still needs a title, so an absent one is validated as the
  // empty string rather than skipped: this route both creates and edits, and
  // `normalizeCollectionPatch` would leave an omitted title absent — which the
  // create path then defaulted to "" *after* validation, letting a first-use
  // PATCH with no title create a collection whose title is empty. The validator
  // has to see the value the create will use, so the fallback happens before it
  // runs, not after.
  const titleForValidation = body.title ?? (collection ? undefined : "");
  let patchInput: ReturnType<typeof normalizeCollectionPatch>;
  try {
    patchInput = normalizeCollectionPatch({
      title: titleForValidation,
      description: body.description,
      petSlugs: body.petSlugs,
    });
  } catch (error) {
    return NextResponse.json(
      { error: collectionInputErrorCode(error) },
      { status: 400 },
    );
  }

  let input = {
    title: patchInput.title ?? collection?.title ?? "",
    description: patchInput.description ?? collection?.description ?? "",
    petSlugs: patchInput.petSlugs ?? [],
  };

  let externalUrl = collection?.externalUrl ?? null;
  if (body.externalUrl !== undefined) {
    const normalizedExternalUrl = normalizeCollectionExternalUrl(
      body.externalUrl,
    );
    if (normalizedExternalUrl === false) {
      return NextResponse.json({ error: "invalid_url" }, { status: 400 });
    }
    externalUrl = normalizedExternalUrl;
  }

  const requestedCover = normalizeCollectionCover(body.coverPetSlug);
  if (requestedCover === false) {
    return NextResponse.json({ error: "invalid_cover_pet" }, { status: 400 });
  }
  if (
    body.title === undefined &&
    body.description === undefined &&
    body.externalUrl === undefined &&
    body.coverPetSlug === undefined &&
    body.petSlugs === undefined
  ) {
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
  }

  let petSlugs: string[];
  if (body.petSlugs !== undefined) {
    const approvedPets = await db
      .select({ slug: schema.submittedPets.slug })
      .from(schema.submittedPets)
      .where(
        and(
          eq(schema.submittedPets.ownerId, userId),
          eq(schema.submittedPets.status, "approved"),
        ),
      );
    const allowedSlugs = new Set(approvedPets.map((pet) => pet.slug));
    // The cap bounds growth, not the stored row: a collection created before
    // the cap existed must stay editable. `collection` is the row this route
    // would update, or undefined when it is about to create one.
    const storedSlugs = collection
      ? (
          await db
            .select({ slug: schema.petCollectionItems.petSlug })
            .from(schema.petCollectionItems)
            .where(eq(schema.petCollectionItems.collectionId, collection.id))
        ).map((item) => item.slug)
      : null;
    if (collectionPetLimitExceeded(input.petSlugs, storedSlugs)) {
      return NextResponse.json(
        { error: "collection_pet_limit", max: MAX_COLLECTION_PETS },
        { status: 400 },
      );
    }
    if (input.petSlugs.some((slug) => !allowedSlugs.has(slug))) {
      return NextResponse.json(
        { error: "pet_not_owned_or_approved" },
        { status: 422 },
      );
    }
    // The empty-list rule is not checked here: it is enforced below against the
    // row the write targets, which is the only place it can be enforced once.
    petSlugs = input.petSlugs;
  } else if (collection) {
    const existingItems = await db
      .select({ slug: schema.petCollectionItems.petSlug })
      .from(schema.petCollectionItems)
      .where(eq(schema.petCollectionItems.collectionId, collection.id))
      .orderBy(asc(schema.petCollectionItems.position));
    petSlugs = existingItems.map((item) => item.slug);
  } else {
    petSlugs = [];
  }
  if (requestedCover !== null && !petSlugs.includes(requestedCover)) {
    return NextResponse.json(
      { error: "cover_not_in_collection" },
      { status: 400 },
    );
  }
  let coverPetSlug: string | null =
    body.coverPetSlug === undefined
      ? (collection?.coverPetSlug ?? petSlugs[0] ?? null)
      : requestedCover;

  let collectionWasCreated = false;

  if (!collection) {
    const profile = await db.query.userProfiles.findFirst({
      where: eq(schema.userProfiles.userId, userId),
    });
    const requestedSlug = await collectionSlugForOwner(
      profile?.handle ?? input.title,
    );
    const id = `col_${crypto.randomUUID().replace(/-/g, "")}`;
    const created = await createOrReuseOwnerCollection({
      id,
      slug: requestedSlug,
      title: input.title,
      description: input.description,
      ownerId: userId,
      externalUrl,
      coverPetSlug,
      petSlugs,
    });
    if (created.status === "slug_conflict") {
      return NextResponse.json(
        { error: "collection_slug_conflict" },
        { status: 409 },
      );
    }
    if (created.status === "pets_not_owned_or_approved") {
      return NextResponse.json(
        { error: "pet_not_owned_or_approved" },
        { status: 422 },
      );
    }
    if (created.status === "existing") {
      const existingCollection = await findCollectionAfterMutationLock(
        created.id,
        userId,
      );
      if (!existingCollection) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      collection = existingCollection;
      input = {
        title:
          body.title === undefined ? existingCollection.title : input.title,
        description:
          body.description === undefined
            ? existingCollection.description
            : input.description,
        petSlugs: input.petSlugs,
      };
      if (body.externalUrl === undefined) {
        externalUrl = existingCollection.externalUrl;
      }
      if (body.petSlugs === undefined) {
        const existingItems = await db
          .select({ slug: schema.petCollectionItems.petSlug })
          .from(schema.petCollectionItems)
          .where(eq(schema.petCollectionItems.collectionId, collection.id))
          .orderBy(asc(schema.petCollectionItems.position));
        petSlugs = existingItems.map((item) => item.slug);
        if (requestedCover !== null && !petSlugs.includes(requestedCover)) {
          return NextResponse.json(
            { error: "cover_not_in_collection" },
            { status: 400 },
          );
        }
        coverPetSlug =
          body.coverPetSlug === undefined
            ? collection.coverPetSlug
            : requestedCover;
      }
    } else {
      collection = {
        id,
        slug: created.slug,
        title: input.title,
        description: input.description,
        ownerId: userId,
        externalUrl,
        coverPetSlug,
        featured: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      collectionWasCreated = true;
    }
  }

  if (!collection) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (!collectionWasCreated) {
    const petsChanged = body.petSlugs !== undefined;
    // The empty-list rule is not checked here. It is enforced inside the write,
    // in guardedUpdateWhere, against the row the UPDATE actually targets — the
    // only row that matters, and one that the create-or-reuse path above may
    // have swapped in. A read here would be a second, weaker enforcement point:
    // it would see the same row in every case this path can reach, and it would
    // be racing a concurrent writer the atomic condition is not.
    if (petsChanged && body.coverPetSlug === undefined) {
      coverPetSlug = resolveCollectionCover(
        undefined,
        petSlugs,
        collection.coverPetSlug,
      );
    } else if (!petsChanged && body.coverPetSlug === undefined) {
      coverPetSlug = collection.coverPetSlug;
    }
    const updateSet = {
      ...(body.title !== undefined ? { title: input.title } : {}),
      ...(body.description !== undefined
        ? { description: input.description }
        : {}),
      ...(body.externalUrl !== undefined ? { externalUrl } : {}),
      ...(petsChanged || body.coverPetSlug !== undefined
        ? {
            coverPetSlug:
              petsChanged && body.coverPetSlug === undefined
                ? collectionCoverForPetSlugsQuery(petSlugs)
                : coverPetSlug,
          }
        : {}),
      updatedAt: new Date(),
    };
    const coverValidationRequired =
      !petsChanged &&
      body.coverPetSlug !== undefined &&
      requestedCover !== null;
    const mutationPetSlugs = petsChanged
      ? petSlugs
      : coverValidationRequired
        ? [requestedCover as string]
        : undefined;
    const deletedItems = petsChanged
      ? deleteCollectionItemsQuery(collection.id, userId, petSlugs, {
          requireSuccessfulParentUpdate: true,
        })
      : null;
    const insertedItems = petsChanged
      ? insertCollectionItemsQuery(collection.id, petSlugs, userId, {
          requireSuccessfulParentUpdate: true,
        })
      : null;
    const updateWhere = and(
      eq(schema.petCollections.id, collection.id),
      eq(schema.petCollections.ownerId, userId),
      eq(schema.petCollections.featured, false),
    );
    const petAuthorization = mutationPetSlugs
      ? collectionApprovedPetsCondition(userId, mutationPetSlugs)
      : sql`TRUE`;
    // An empty member list is only allowed to write while the collection holds
    // nothing. Judging it here, in the UPDATE's WHERE, is what keeps it true
    // against a member a concurrent writer adds after the pre-lock read.
    // The list is passed only when this request actually replaces the members.
    // `petSlugs` always has a value here — it falls back to the stored members,
    // or to [] for a create — so passing it unconditionally would ask the
    // condition to judge a list this request never wrote, and would make the
    // rule depend on that fallback happening to equal what the row holds.
    const emptyMemberListAllowed = collectionEmptyMemberListCondition(
      collection.id,
      petsChanged ? petSlugs : undefined,
    );
    const guardedUpdateWhere = coverValidationRequired
      ? and(
          updateWhere,
          petAuthorization,
          sql`EXISTS (
            SELECT 1
            FROM "pet_collection_items"
            WHERE "collection_id" = ${collection.id}
              AND "pet_slug" = ${requestedCover}
          )`,
        )
      : and(updateWhere, petAuthorization, emptyMemberListAllowed);
    const mutationStatusCheck =
      mutationPetSlugs || coverValidationRequired
        ? collectionMutationStatusQuery({
            collectionId: collection.id,
            ownerId: userId,
            petAuthorization,
            rejectEmptyPetList: petsChanged && petSlugs.length === 0,
            ...(coverValidationRequired
              ? { coverPetSlug: requestedCover as string }
              : {}),
          })
        : null;
    // update(0) then the optional deletes/inserts, then the optional status
    // select last. Keep this expression next to the buildBatch that matches it.
    const statusResultIndex =
      1 + (deletedItems ? 1 : 0) + (insertedItems ? 1 : 0);
    const mutation = await runCollectionMutation({
      collectionId: collection.id,
      petMutation: mutationPetSlugs
        ? { ownerId: userId, petSlugs: mutationPetSlugs }
        : undefined,
      buildBatch: (client) => [
        client
          .update(schema.petCollections)
          .set(updateSet)
          .where(guardedUpdateWhere)
          .returning({ id: schema.petCollections.id }),
        ...(deletedItems ? [client.execute(deletedItems)] : []),
        ...(insertedItems ? [client.execute(insertedItems)] : []),
        ...(mutationStatusCheck ? [client.execute(mutationStatusCheck)] : []),
      ],
      runTransaction: async (tx) => {
        const updatedRows = await tx
          .update(schema.petCollections)
          .set(updateSet)
          .where(guardedUpdateWhere)
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
        const updated = hasCollectionMutationRow(results[0]);
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
        const status = parseCollectionMutationStatus(
          results[statusResultIndex],
        );
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
  }

  await revalidateCollectionTags(collection.slug);

  return NextResponse.json({
    ok: true,
    collection: {
      id: collection.id,
      slug: collection.slug,
      title: input.title,
      description: input.description,
      externalUrl,
      coverPetSlug,
      petSlugs,
    },
  });
}

async function collectionSlugForOwner(seed: string): Promise<string> {
  const base = collectionSlugBase(seed);
  for (const candidate of collectionSlugCandidates(base)) {
    const existing = await db.query.petCollections.findFirst({
      where: eq(schema.petCollections.slug, candidate),
    });
    if (!existing) return candidate;
  }
  return `collection-${crypto.randomUUID().replace(/-/g, "")}`;
}
