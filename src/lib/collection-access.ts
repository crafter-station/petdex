import "server-only";

import { type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import { MAX_OWNER_COLLECTIONS } from "@/lib/collection-constants";
import { db } from "@/lib/db/client";

// Re-exported so the existing server callers keep importing it from here.
// The value itself lives in collection-constants so client components can
// read the same cap without pulling in this server-only module.
export { MAX_OWNER_COLLECTIONS };

const MAX_COLLECTION_SLUG_ATTEMPTS = 6;

export type CreateOwnerCollectionInput = {
  id: string;
  slug: string;
  title: string;
  description: string;
  ownerId: string;
  externalUrl: string | null;
  coverPetSlug: string | null;
  petSlugs: string[];
};

type CollectionMutationBatchRunner = {
  batch: (queries: readonly BatchItem<"pg">[]) => Promise<readonly unknown[]>;
};

export type CollectionMutationTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

export type CollectionPetMutation = {
  ownerId: string;
  petSlugs: readonly string[];
};

export type CollectionItemWriteOptions = {
  /** Only write items after the guarded parent collection update succeeded. */
  requireSuccessfulParentUpdate?: boolean;
};

export function collectionMutationLock(collectionId: string) {
  return sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${collectionId}, 0))
  `;
}

/**
 * Lock every collection that currently references a pet slug. Takedowns use
 * this after taking the slug lock and before touching collection items, which
 * keeps their lock order aligned with collection mutations.
 */
export function collectionLocksForPetSlugQuery(petSlug: string) {
  return sql`
    SELECT pg_advisory_xact_lock(hashtextextended(locked."id", 0))
    FROM (
      SELECT "collection_id" AS "id"
      FROM "pet_collection_items"
      WHERE "pet_slug" = ${petSlug}
      UNION
      SELECT "id"
      FROM "pet_collections"
      WHERE "cover_pet_slug" = ${petSlug}
    ) AS locked
    ORDER BY locked."id"
  `;
}

/**
 * Serialize collection writes with pet takedowns. Slugs are locked in a
 * stable order before any collection lock or pet row lock is acquired so two
 * collections that share pets cannot deadlock while a takedown is waiting.
 */
export function collectionPetSlugLockQuery(
  petSlugs: readonly string[],
  collectionId?: string,
) {
  if (collectionId === undefined) {
    if (petSlugs.length === 0) return null;
    const lockedPetSlugs = [...new Set(petSlugs)].sort();
    const values = sql.join(
      lockedPetSlugs.map((petSlug) => sql`(${petSlug})`),
      sql`, `,
    );
    return sql`
      SELECT pg_advisory_xact_lock(hashtextextended(locked."slug", 0))
      FROM (VALUES ${values}) AS locked("slug")
      ORDER BY locked."slug"
    `;
  }

  const requestedSlugs = [...new Set(petSlugs)].sort();
  const requested =
    requestedSlugs.length === 0
      ? sql`SELECT NULL::text AS "slug" WHERE false`
      : sql`
          SELECT requested."slug"
          FROM (VALUES ${sql.join(
            requestedSlugs.map((petSlug) => sql`(${petSlug})`),
            sql`, `,
          )}) AS requested("slug")
        `;
  const existing =
    collectionId === undefined
      ? sql`SELECT NULL::text AS "slug" WHERE false`
      : sql`
          SELECT "pet_slug" AS "slug"
          FROM "pet_collection_items"
          WHERE "collection_id" = ${collectionId}
          UNION
          SELECT "cover_pet_slug" AS "slug"
          FROM "pet_collections"
          WHERE "id" = ${collectionId}
        `;
  return sql`
    SELECT pg_advisory_xact_lock(hashtextextended(locked."slug", 0))
    FROM (
      ${requested}
      UNION
      ${existing}
    ) AS locked
    WHERE locked."slug" IS NOT NULL
    ORDER BY locked."slug"
  `;
}

export function deleteCollectionItemsQuery(
  collectionId: string,
  ownerId?: string,
  petSlugs?: readonly string[],
  options?: CollectionItemWriteOptions,
) {
  // An empty list is not "delete everything" — it is nothing to delete, and
  // the statement it used to build (no `pet_slug IN` filter at all) deleted
  // every member of the collection. Every caller passes an explicit list and
  // reaches this with an empty one exactly when the request would clear the
  // collection, which the routes refuse; returning null makes that refusal
  // structural rather than a guard each caller has to remember, and mirrors
  // insertCollectionItemsQuery. Dropping a collection does not come through
  // here at all — it deletes the parent row and lets the foreign key cascade.
  //
  // The DELETE is deliberately not scoped by `pet_slug IN (petSlugs)`. It is
  // the first half of a replace — every caller pairs it with
  // insertCollectionItemsQuery in the same transaction — so removing the whole
  // list and re-inserting the proposed one is the intent, and narrowing the
  // DELETE would leave the members the request dropped. `petSlugs` is read
  // here only to build the authorization condition below.
  //
  // What makes that safe is the two conditions this carries, and both are
  // load-bearing: the parent `xmin` guard, so a request whose UPDATE matched
  // nothing deletes nothing, and the approved-and-owned condition, so a pet
  // un-approved between the route's read and this statement blocks the write
  // rather than being silently dropped from the collection. Neither is
  // optional; dropping either one turns a refused request into data loss.
  if (petSlugs !== undefined && petSlugs.length === 0) return null;
  const ownerCondition =
    ownerId === undefined ? sql`` : sql` AND "owner_id" = ${ownerId}`;
  const parentMutationCondition = collectionItemWriteParentCondition(options);
  const petAuthorization =
    ownerId === undefined || petSlugs === undefined
      ? sql``
      : sql` AND ${collectionApprovedPetsCondition(ownerId, petSlugs)}`;
  return sql`
    DELETE FROM "pet_collection_items"
    WHERE "collection_id" = ${collectionId}
      AND EXISTS (
        SELECT 1
        FROM "pet_collections"
        WHERE "id" = ${collectionId}
          AND "featured" = false${ownerCondition}${parentMutationCondition}
      )
      ${petAuthorization}
  `;
}

export function insertCollectionItemsQuery(
  collectionId: string,
  petSlugs: string[],
  ownerId?: string,
  options?: CollectionItemWriteOptions,
) {
  if (petSlugs.length === 0) return null;
  const ownerCondition =
    ownerId === undefined ? sql`` : sql` AND "owner_id" = ${ownerId}`;
  const parentMutationCondition = collectionItemWriteParentCondition(options);
  const petAuthorization =
    ownerId === undefined
      ? sql``
      : sql` AND ${collectionApprovedPetsCondition(ownerId, petSlugs)}`;
  const values = sql.join(
    petSlugs.map(
      (petSlug, position) => sql`(${petSlug}, ${position + 1}::integer)`,
    ),
    sql`, `,
  );
  return sql`
    INSERT INTO "pet_collection_items" (
      "collection_id",
      "pet_slug",
      "position"
    )
    SELECT ${collectionId}, item_values."pet_slug", item_values."position"
    FROM (VALUES ${values}) AS item_values("pet_slug", "position")
    WHERE EXISTS (
      SELECT 1
        FROM "pet_collections"
        WHERE "id" = ${collectionId}
        AND "featured" = false${ownerCondition}${parentMutationCondition}${petAuthorization}
    )
  `;
}

function collectionItemWriteParentCondition(
  options?: CollectionItemWriteOptions,
) {
  return options?.requireSuccessfulParentUpdate
    ? sql` AND "pet_collections"."xmin" = pg_current_xact_id()::xid`
    : sql``;
}

export function collectionApprovedPetsCondition(
  ownerId: string,
  petSlugs: readonly string[],
) {
  const uniquePetSlugs = [...new Set(petSlugs)];
  if (uniquePetSlugs.length === 0) return sql`TRUE`;
  return sql`
    (
      SELECT count(*)
      FROM "submitted_pets"
      WHERE "owner_id" = ${ownerId}
        AND "status" = 'approved'
        AND "slug" IN (${collectionPetSlugValues(uniquePetSlugs)})
    ) = ${uniquePetSlugs.length}
  `;
}

export function collectionApprovedPetsLockQuery(
  ownerId: string,
  petSlugs: readonly string[],
) {
  if (petSlugs.length === 0) return null;
  const lockedPetSlugs = [...new Set(petSlugs)].sort();
  return sql`
    SELECT "slug"
    FROM "submitted_pets"
    WHERE "owner_id" = ${ownerId}
      AND "status" = 'approved'
      AND "slug" IN (${collectionPetSlugValues(lockedPetSlugs)})
    ORDER BY "slug"
    FOR SHARE
  `;
}

/**
 * Guards a write that would replace the members with an empty list: it may only
 * proceed while the collection holds none.
 *
 * The routes refuse an empty list, but they read the stored members before
 * taking the collection lock, and a concurrent writer can add one in between.
 * Putting the rule in the UPDATE's WHERE instead makes it hold against whatever
 * the row looks like when the statement runs: the update matches nothing, and
 * the status check reports emptyListRejected so the caller still gets the
 * refusal rather than a success that describes a member list the collection
 * does not have.
 *
 * `petSlugs` is the list the request would write, or `undefined` when the
 * request does not touch the members at all (a rename, or a cover-only edit).
 * The distinction is the whole point: an omitted list must not be read as an
 * empty one, or every rename of a collection that holds members would be
 * refused. Non-empty lists are unaffected either way.
 */
export function collectionEmptyMemberListCondition(
  collectionId: string,
  petSlugs: readonly string[] | undefined,
): SQL {
  if (petSlugs === undefined || petSlugs.length > 0) return sql`TRUE`;
  return sql`NOT EXISTS (
    SELECT 1
    FROM "pet_collection_items"
    WHERE "collection_id" = ${collectionId}
  )`;
}

export type CollectionMutationStatus = {
  collectionExists: boolean;
  petsValid: boolean;
  coverExists: boolean;
  /**
   * True when the write was an empty member list against a collection that
   * still holds members. The routes refuse that shape, but the check they do
   * before taking the lock reads the members the request found, and a
   * concurrent writer can add one in between. Evaluating it here — inside the
   * lock, after the parent update matched nothing — is what makes the refusal
   * hold against a row that changed under it.
   */
  emptyListRejected: boolean;
};

/**
 * Re-check mutation guards after the write attempt while the collection lock
 * is still held. This distinguishes a missing collection from a pet or cover
 * guard that became invalid between request validation and the update.
 */
export function collectionMutationStatusQuery(input: {
  collectionId: string;
  ownerId: string;
  petAuthorization: SQL;
  coverPetSlug?: string;
  /**
   * Set when the write would replace the members with an empty list. Only that
   * shape can be an accidental clear, so the member check is skipped entirely
   * for every other write.
   */
  rejectEmptyPetList?: boolean;
}) {
  const coverExists =
    input.coverPetSlug === undefined
      ? sql`TRUE`
      : sql`EXISTS (
          SELECT 1
          FROM "pet_collection_items"
          WHERE "collection_id" = ${input.collectionId}
            AND "pet_slug" = ${input.coverPetSlug}
        )`;
  const emptyListRejected = input.rejectEmptyPetList
    ? sql`EXISTS (
        SELECT 1
        FROM "pet_collection_items"
        WHERE "collection_id" = ${input.collectionId}
      )`
    : sql`FALSE`;
  return sql`
    SELECT
      EXISTS (
        SELECT 1
        FROM "pet_collections"
        WHERE "id" = ${input.collectionId}
          AND "owner_id" = ${input.ownerId}
          AND "featured" = false
      ) AS "collection_exists",
      ${input.petAuthorization} AS "pets_valid",
      ${coverExists} AS "cover_exists",
      ${emptyListRejected} AS "empty_list_rejected"
  `;
}

export function parseCollectionMutationStatus(
  result: unknown,
): CollectionMutationStatus {
  const rows = collectionMutationRows(result);
  const row = rows[0];
  if (!row) throw new Error("collection_mutation_status_missing");
  const collectionExists = parseBoolean(row.collection_exists);
  const petsValid = parseBoolean(row.pets_valid);
  const coverExists = parseBoolean(row.cover_exists);
  const emptyListRejected = parseBoolean(row.empty_list_rejected);
  if (
    collectionExists === null ||
    petsValid === null ||
    coverExists === null ||
    emptyListRejected === null
  ) {
    throw new Error("collection_mutation_status_invalid");
  }
  return { collectionExists, petsValid, coverExists, emptyListRejected };
}

function collectionPetSlugValues(petSlugs: readonly string[]) {
  return sql.join(
    petSlugs.map((petSlug) => sql`${petSlug}`),
    sql`, `,
  );
}

export function hasCollectionMutationRow(result: unknown): boolean {
  const rows = collectionMutationRows(result);
  const row = rows[0];
  return Boolean(row && typeof row.id === "string");
}

export function collectionMutationRows(
  result: unknown,
): Array<Record<string, unknown>> {
  const rows = Array.isArray(result)
    ? result
    : result !== null && typeof result === "object"
      ? (result as { rows?: unknown }).rows
      : null;
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row): row is Record<string, unknown> =>
      row !== null && typeof row === "object" && !Array.isArray(row),
  );
}

export async function runCollectionMutation<T>(input: {
  collectionId: string;
  petMutation?: CollectionPetMutation;
  /** Lock current item slugs before deleting a collection parent. */
  lockExistingPetSlugs?: boolean;
  buildBatch: (client: typeof db) => readonly BatchItem<"pg">[];
  runTransaction: (tx: CollectionMutationTransaction) => Promise<T>;
  parseBatch: (results: readonly unknown[]) => T;
}): Promise<T> {
  const batch = getCollectionMutationBatchRunner();
  const petLock = input.petMutation
    ? collectionApprovedPetsLockQuery(
        input.petMutation.ownerId,
        input.petMutation.petSlugs,
      )
    : null;
  const petSlugLock =
    input.petMutation || input.lockExistingPetSlugs
      ? collectionPetSlugLockQuery(
          input.petMutation?.petSlugs ?? [],
          input.collectionId,
        )
      : null;
  if (batch) {
    const results = await batch.batch([
      ...(petSlugLock ? [db.execute(petSlugLock)] : []),
      db.execute(collectionMutationLock(input.collectionId)),
      ...(petLock ? [db.execute(petLock)] : []),
      ...input.buildBatch(db),
    ]);
    return input.parseBatch(
      results.slice((petSlugLock ? 1 : 0) + 1 + (petLock ? 1 : 0)),
    );
  }

  return db.transaction(async (tx) => {
    if (petSlugLock) await tx.execute(petSlugLock);
    await tx.execute(collectionMutationLock(input.collectionId));
    if (petLock) await tx.execute(petLock);
    return input.runTransaction(tx);
  });
}

export type CreateOwnerCollectionResult =
  | { status: "created"; slug: string }
  | { status: "cap" }
  | { status: "pets_not_owned_or_approved" }
  | { status: "slug_conflict" };

/**
 * Creates a personal collection while serializing all creates for one owner.
 * Neon HTTP has no interactive transaction API, so its batch path starts with
 * the same transaction-scoped advisory lock used by local Postgres.
 */
export async function createOwnerCollection(
  input: CreateOwnerCollectionInput,
): Promise<CreateOwnerCollectionResult> {
  for (let attempt = 0; attempt < MAX_COLLECTION_SLUG_ATTEMPTS; attempt++) {
    const slug =
      attempt === 0
        ? input.slug
        : `${input.slug}-${randomSlugSuffix()}-${attempt}`;
    const outcome = await createOwnerCollectionAttempt({ ...input, slug });
    if (!outcome.petsValid) {
      return { status: "pets_not_owned_or_approved" };
    }
    if (outcome.created) return { status: "created", slug };
    if (!outcome.underCap) return { status: "cap" };
  }
  return { status: "slug_conflict" };
}

export type CreateOrReuseOwnerCollectionResult =
  | { status: "created"; id: string; slug: string }
  | { status: "existing"; id: string; slug: string }
  | { status: "pets_not_owned_or_approved" }
  | { status: "slug_conflict" };

/**
 * Ensures the legacy profile collection exists without allowing two first-use
 * requests to create separate personal collections for the same owner.
 *
 * The owner check and insert are part of the same lock scope. This matters for
 * Neon HTTP, where an interactive transaction is not available: the state
 * query and item insert are sent together through batch().
 */
export async function createOrReuseOwnerCollection(
  input: CreateOwnerCollectionInput,
): Promise<CreateOrReuseOwnerCollectionResult> {
  for (let attempt = 0; attempt < MAX_COLLECTION_SLUG_ATTEMPTS; attempt++) {
    const slug =
      attempt === 0
        ? input.slug
        : `${input.slug}-${randomSlugSuffix()}-${attempt}`;
    const outcome = await createOrReuseOwnerCollectionAttempt({
      ...input,
      slug,
    });
    if (outcome.status !== "slug_conflict") return outcome;
  }
  return { status: "slug_conflict" };
}

type CollectionCreateState = {
  created: boolean;
  underCap: boolean;
  petsValid: boolean;
};

async function createOwnerCollectionAttempt(
  input: CreateOwnerCollectionInput,
): Promise<CollectionCreateState> {
  const lock = sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${input.ownerId}, 0))
  `;
  const petLock = collectionApprovedPetsLockQuery(
    input.ownerId,
    input.petSlugs,
  );
  const petSlugLock = collectionPetSlugLockQuery(input.petSlugs);
  const petsValid = collectionApprovedPetsCondition(
    input.ownerId,
    input.petSlugs,
  );
  const insert = sql`
    WITH inserted AS (
      INSERT INTO "pet_collections" (
        "id",
        "slug",
        "title",
        "description",
        "owner_id",
        "featured",
        "external_url",
        "cover_pet_slug",
        "updated_at"
      )
      SELECT
        ${input.id},
        ${input.slug},
        ${input.title},
        ${input.description},
        ${input.ownerId},
        false,
        ${input.externalUrl},
        ${input.coverPetSlug},
        now()
      WHERE (
        SELECT count(*)
        FROM "pet_collections"
        WHERE "owner_id" = ${input.ownerId}
          AND "featured" = false
      ) < ${MAX_OWNER_COLLECTIONS}
        AND ${petsValid}
      ON CONFLICT ("slug") DO NOTHING
      RETURNING "id"
    )
    SELECT
      EXISTS (SELECT 1 FROM inserted) AS "created",
      (
        SELECT count(*)
        FROM "pet_collections"
        WHERE "owner_id" = ${input.ownerId}
          AND "featured" = false
      ) < ${MAX_OWNER_COLLECTIONS} AS "under_cap",
      ${petsValid} AS "pets_valid"
  `;
  const items = insertCollectionItemsQuery(
    input.id,
    input.petSlugs,
    input.ownerId,
    // The Neon batch path executes every statement even when the parent
    // insert was skipped because the slug was already taken. The xmin guard
    // makes this write conditional on this transaction having created the
    // parent row.
    { requireSuccessfulParentUpdate: true },
  );

  const batch = getCollectionMutationBatchRunner();
  if (batch) {
    const queries = [
      ...(petSlugLock ? [db.execute(petSlugLock)] : []),
      db.execute(lock),
      ...(petLock ? [db.execute(petLock)] : []),
      db.execute(insert),
      ...(items ? [db.execute(items)] : []),
    ];
    const results = await batch.batch(queries);
    return parseCollectionCreateState(
      results[(petSlugLock ? 1 : 0) + 1 + (petLock ? 1 : 0)],
    );
  }

  return db.transaction(async (tx) => {
    if (petSlugLock) await tx.execute(petSlugLock);
    await tx.execute(lock);
    if (petLock) await tx.execute(petLock);
    const state = parseCollectionCreateState(await tx.execute(insert));
    if (state.created && items) await tx.execute(items);
    return state;
  });
}

type CreateOrReuseOwnerCollectionState =
  | { status: "created"; id: string; slug: string }
  | { status: "existing"; id: string; slug: string }
  | { status: "pets_not_owned_or_approved" }
  | { status: "slug_conflict" };

async function createOrReuseOwnerCollectionAttempt(
  input: CreateOwnerCollectionInput,
): Promise<CreateOrReuseOwnerCollectionState> {
  const ownerLock = sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${input.ownerId}, 0))
  `;
  const petLock = collectionApprovedPetsLockQuery(
    input.ownerId,
    input.petSlugs,
  );
  const petSlugLock = collectionPetSlugLockQuery(input.petSlugs);
  const petsValid = collectionApprovedPetsCondition(
    input.ownerId,
    input.petSlugs,
  );
  const stateQuery = sql`
    WITH existing AS MATERIALIZED (
      SELECT "pet_collections"."id", "pet_collections"."slug"
      FROM "pet_collections"
      WHERE "pet_collections"."owner_id" = ${input.ownerId}
        AND "pet_collections"."featured" = false
      ORDER BY "pet_collections"."created_at", "pet_collections"."id"
      LIMIT 1
    ),
    inserted AS (
      INSERT INTO "pet_collections" (
        "id",
        "slug",
        "title",
        "description",
        "owner_id",
        "featured",
        "external_url",
        "cover_pet_slug",
        "updated_at"
      )
      SELECT
        ${input.id},
        ${input.slug},
        ${input.title},
        ${input.description},
        ${input.ownerId},
        false,
        ${input.externalUrl},
        ${input.coverPetSlug},
        now()
      WHERE NOT EXISTS (SELECT 1 FROM existing)
        AND (
          SELECT count(*)
          FROM "pet_collections"
          WHERE "owner_id" = ${input.ownerId}
            AND "featured" = false
        ) < ${MAX_OWNER_COLLECTIONS}
        AND ${petsValid}
      ON CONFLICT ("slug") DO NOTHING
      RETURNING "id", "slug"
    )
    SELECT 'existing'::text AS "status", existing."id", existing."slug"
    FROM existing
    UNION ALL
    SELECT 'created'::text AS "status", inserted."id", inserted."slug"
    FROM inserted
    UNION ALL
    SELECT 'slug_conflict'::text AS "status",
      NULL::text AS "id",
      NULL::text AS "slug"
    WHERE NOT EXISTS (SELECT 1 FROM existing)
      AND NOT EXISTS (SELECT 1 FROM inserted)
      AND ${petsValid}
    UNION ALL
    SELECT 'pets_not_owned_or_approved'::text AS "status",
      NULL::text AS "id",
      NULL::text AS "slug"
    WHERE NOT EXISTS (SELECT 1 FROM existing)
      AND NOT EXISTS (SELECT 1 FROM inserted)
      AND NOT (${petsValid})
  `;
  const items = insertCollectionItemsQuery(
    input.id,
    input.petSlugs,
    input.ownerId,
    // In the reuse path an existing owner collection is a valid outcome, but
    // its members must not be replaced by the losing first-use request.
    { requireSuccessfulParentUpdate: true },
  );

  const batch = getCollectionMutationBatchRunner();
  if (batch) {
    const queries = [
      ...(petSlugLock ? [db.execute(petSlugLock)] : []),
      db.execute(ownerLock),
      ...(petLock ? [db.execute(petLock)] : []),
      db.execute(stateQuery),
      ...(items ? [db.execute(items)] : []),
    ];
    const results = await batch.batch(queries);
    return parseCreateOrReuseOwnerCollectionState(
      results[(petSlugLock ? 1 : 0) + 1 + (petLock ? 1 : 0)],
    );
  }

  return db.transaction(async (tx) => {
    if (petSlugLock) await tx.execute(petSlugLock);
    await tx.execute(ownerLock);
    if (petLock) await tx.execute(petLock);
    const state = parseCreateOrReuseOwnerCollectionState(
      await tx.execute(stateQuery),
    );
    if (state.status === "created" && items) await tx.execute(items);
    return state;
  });
}

function getCollectionMutationBatchRunner(): CollectionMutationBatchRunner | null {
  const candidate = db as unknown as Partial<CollectionMutationBatchRunner>;
  if (typeof candidate.batch !== "function") return null;
  return { batch: candidate.batch.bind(db) };
}

function parseCollectionCreateState(result: unknown): CollectionCreateState {
  const rows = Array.isArray(result)
    ? result
    : result !== null && typeof result === "object"
      ? (result as { rows?: unknown }).rows
      : null;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (row === null || typeof row !== "object") {
    throw new Error("collection_create_state_missing");
  }
  const created = parseBoolean((row as Record<string, unknown>).created);
  const underCap = parseBoolean((row as Record<string, unknown>).under_cap);
  const petsValid = parseBoolean((row as Record<string, unknown>).pets_valid);
  if (created === null || underCap === null || petsValid === null) {
    throw new Error("collection_create_state_invalid");
  }
  return { created, underCap, petsValid };
}

function parseCreateOrReuseOwnerCollectionState(
  result: unknown,
): CreateOrReuseOwnerCollectionState {
  const rows = Array.isArray(result)
    ? result
    : result !== null && typeof result === "object"
      ? (result as { rows?: unknown }).rows
      : null;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (row === null || typeof row !== "object") {
    throw new Error("collection_create_state_missing");
  }
  const record = row as Record<string, unknown>;
  const status = record.status;
  if (
    status !== "created" &&
    status !== "existing" &&
    status !== "pets_not_owned_or_approved" &&
    status !== "slug_conflict"
  ) {
    throw new Error("collection_create_state_invalid");
  }
  if (status === "slug_conflict" || status === "pets_not_owned_or_approved") {
    return { status };
  }
  if (typeof record.id !== "string" || typeof record.slug !== "string") {
    throw new Error("collection_create_state_invalid");
  }
  return { status, id: record.id, slug: record.slug };
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "t" || value === "true" || value === 1) return true;
  if (value === "f" || value === "false" || value === 0) return false;
  return null;
}

function randomSlugSuffix(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

// Personal collections are open to every signed-in user. The endpoint
// still validates ownership of the pets being added and the cap, so
// the gate exists at the action level (you can only edit your own
// collection items, you can only create up to MAX_OWNER_COLLECTIONS).
//
// Kept as an async function so existing callers (`await canManage...`)
// don't have to change shape.
export async function canManageCreatorCollections(
  userId: string | null | undefined,
): Promise<boolean> {
  return Boolean(userId);
}
