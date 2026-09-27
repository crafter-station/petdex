import { describe, expect, it, mock } from "bun:test";

import { PgDialect } from "drizzle-orm/pg-core";

import * as schema from "@/lib/db/schema";

mock.module("server-only", () => ({}));
mock.module("@/lib/db/client", () => ({ db: {}, schema }));

const {
  collectionApprovedPetsCondition,
  collectionApprovedPetsLockQuery,
  collectionEmptyMemberListCondition,
  collectionLocksForPetSlugQuery,
  collectionMutationStatusQuery,
  collectionPetSlugLockQuery,
  deleteCollectionItemsQuery,
  insertCollectionItemsQuery,
  parseCollectionMutationStatus,
} = await import("@/lib/collection-access");

const dialect = new PgDialect();

function requireQuery<T>(query: T | null): T {
  if (query === null) throw new Error("expected SQL query");
  return query;
}

describe("collection access SQL", () => {
  it("authorizes item writes against approved pets owned by the collection owner", () => {
    const query = dialect.sqlToQuery(
      requireQuery(
        insertCollectionItemsQuery(
          "collection-id",
          ["boba", "dora"],
          "user-id",
        ),
      ),
    );

    expect(query.sql).toContain('"owner_id" =');
    expect(query.sql).toContain("\"status\" = 'approved'");
    expect(query.sql).toContain('"position"');
    expect(query.sql).toContain("$3::integer");
    expect(query.params).toEqual([
      "collection-id",
      "boba",
      1,
      "dora",
      2,
      "collection-id",
      "user-id",
      "user-id",
      "boba",
      "dora",
      2,
    ]);
  });

  it("uses the same authorization condition for replacement deletes", () => {
    const query = dialect.sqlToQuery(
      requireQuery(
        deleteCollectionItemsQuery("collection-id", "user-id", ["boba"]),
      ),
    );

    // The parent-row ownership guard sits inside the EXISTS subquery. Assert
    // it there specifically: a bare toContain('"owner_id" =') is also
    // satisfied by the pet-authorization subquery below, so it would pass even
    // with the ownership guard deleted.
    expect(query.sql).toMatch(
      /WHERE "id" = \$\d+\s+AND "featured" = false AND "owner_id" = \$\d+/,
    );
    expect(query.sql).toContain("\"status\" = 'approved'");
    expect(query.sql).toContain('"slug" IN');
    // ownerId is bound twice: once for the parent guard, once for the pets.
    expect(query.params).toEqual([
      "collection-id",
      "collection-id",
      "user-id",
      "user-id",
      "boba",
      1,
    ]);
  });

  it("gates replacement item writes on a successful parent update when requested", () => {
    const options = { requireSuccessfulParentUpdate: true } as const;
    const insert = dialect.sqlToQuery(
      requireQuery(
        insertCollectionItemsQuery(
          "collection-id",
          ["boba"],
          "user-id",
          options,
        ),
      ),
    );
    const remove = dialect.sqlToQuery(
      requireQuery(
        deleteCollectionItemsQuery(
          "collection-id",
          "user-id",
          ["boba"],
          options,
        ),
      ),
    );

    expect(insert.sql).toContain('"pet_collections"."xmin"');
    expect(insert.sql).toContain("pg_current_xact_id()::xid");
    expect(remove.sql).toContain('"pet_collections"."xmin"');
    expect(remove.sql).toContain("pg_current_xact_id()::xid");
  });

  it("omits the parent guard when the caller does not request it", () => {
    // The off-state of the option above. Without this, dropping the option
    // entirely would still pass every test here, since both the insert and the
    // delete would simply always carry the guard.
    const insert = dialect.sqlToQuery(
      requireQuery(
        insertCollectionItemsQuery("collection-id", ["boba"], "user-id"),
      ),
    );
    const remove = dialect.sqlToQuery(
      requireQuery(
        deleteCollectionItemsQuery("collection-id", "user-id", ["boba"]),
      ),
    );

    expect(insert.sql).not.toContain('"pet_collections"."xmin"');
    expect(remove.sql).not.toContain('"pet_collections"."xmin"');
  });

  it("locks approved pet rows in deterministic slug order", () => {
    const query = dialect.sqlToQuery(
      requireQuery(
        collectionApprovedPetsLockQuery("user-id", ["dora", "boba", "dora"]),
      ),
    );

    expect(query.sql).toContain("FOR SHARE");
    expect(query.sql).toContain('ORDER BY "slug"');
    expect(query.params).toEqual(["user-id", "boba", "dora"]);
  });

  it("serializes pet slug mutations in deterministic order", () => {
    const query = dialect.sqlToQuery(
      requireQuery(collectionPetSlugLockQuery(["dora", "boba", "dora"])),
    );

    expect(query.sql).toContain("pg_advisory_xact_lock");
    expect(query.sql).toContain('ORDER BY locked."slug"');
    expect(query.params).toEqual(["boba", "dora"]);
  });

  it("locks current collection members before replacement or deletion", () => {
    const query = dialect.sqlToQuery(
      requireQuery(collectionPetSlugLockQuery(["dora"], "collection-id")),
    );

    expect(query.sql).toContain('FROM "pet_collection_items"');
    expect(query.sql).toContain('"cover_pet_slug"');
    expect(query.sql).toContain('"collection_id" =');
    expect(query.sql).toContain('ORDER BY locked."slug"');
    expect(query.params).toEqual(["dora", "collection-id", "collection-id"]);
  });

  it("locks collections that reference a pet before takedown cleanup", () => {
    const query = dialect.sqlToQuery(collectionLocksForPetSlugQuery("boba"));

    expect(query.sql).toContain('FROM "pet_collection_items"');
    expect(query.sql).toContain('FROM "pet_collections"');
    expect(query.sql).toContain('ORDER BY locked."id"');
    expect(query.params).toEqual(["boba", "boba"]);
  });

  it("accepts an empty pet list without an always-false condition", () => {
    expect(
      dialect.sqlToQuery(collectionApprovedPetsCondition("user-id", [])),
    ).toEqual({
      sql: "TRUE",
      params: [],
    });
  });

  it("gates an empty member list on the collection holding none", () => {
    // Non-empty lists must be unaffected: the condition has to be TRUE so the
    // UPDATE still matches and the replacement runs.
    expect(
      dialect.sqlToQuery(collectionEmptyMemberListCondition("c", ["boba"])),
    ).toEqual({ sql: "TRUE", params: [] });
    // So must a request that does not touch the members at all — a rename, or a
    // cover-only edit. An omitted list is not an empty one, and reading it as
    // one would refuse every rename of a collection that holds members.
    expect(
      dialect.sqlToQuery(collectionEmptyMemberListCondition("c", undefined)),
    ).toEqual({ sql: "TRUE", params: [] });
    // An empty list may only write while the collection holds no members. The
    // check reads the row at write time, so a member a concurrent writer adds
    // after the route's pre-lock read still blocks it.
    const query = dialect.sqlToQuery(
      collectionEmptyMemberListCondition("c", []),
    );
    expect(query.sql).toContain("NOT EXISTS");
    expect(query.sql).toContain('FROM "pet_collection_items"');
    expect(query.sql).toContain('"collection_id" = $1');
    expect(query.params).toEqual(["c"]);
  });

  it("refuses to build a replacement delete for an empty pet list", () => {
    // The regression this pins: with no `pet_slug IN` filter the statement was
    // a bare `DELETE FROM pet_collection_items WHERE collection_id = $1`, so a
    // request that cleared the members deleted every row — including members a
    // concurrent writer had just added. Every caller passes an explicit list,
    // so an empty one is never "delete everything" and must not reach the
    // database as a statement that cannot tell the two apart.
    expect(
      deleteCollectionItemsQuery("collection-id", "user-id", [], {
        requireSuccessfulParentUpdate: true,
      }),
    ).toBeNull();
    expect(
      deleteCollectionItemsQuery("collection-id", "user-id", []),
    ).toBeNull();
    // The non-empty form still builds, so the guard above is not simply
    // disabling the helper.
    expect(
      requireQuery(
        deleteCollectionItemsQuery("collection-id", "user-id", ["boba"]),
      ),
    ).toBeTruthy();
  });

  it("deduplicates pet slugs in the approval guard", () => {
    const query = dialect.sqlToQuery(
      collectionApprovedPetsCondition("user-id", ["boba", "boba"]),
    );

    expect(query.sql).toContain('"slug" IN ($2)');
    expect(query.sql).toContain(") = $3");
    expect(query.params).toEqual(["user-id", "boba", 1]);
  });

  it("builds a post-write status check for all mutation guards", () => {
    const query = dialect.sqlToQuery(
      collectionMutationStatusQuery({
        collectionId: "collection-id",
        ownerId: "user-id",
        petAuthorization: collectionApprovedPetsCondition("user-id", ["boba"]),
        coverPetSlug: "boba",
      }),
    );

    expect(query.sql).toContain('AS "collection_exists"');
    expect(query.sql).toContain('AS "pets_valid"');
    expect(query.sql).toContain('AS "cover_exists"');
    expect(query.sql).toContain('"pet_slug"');
    expect(query.params).toEqual([
      "collection-id",
      "user-id",
      "user-id",
      "boba",
      1,
      "collection-id",
      "boba",
    ]);
  });

  it("parses Postgres and Neon mutation status result shapes", () => {
    expect(
      parseCollectionMutationStatus({
        rows: [
          {
            collection_exists: "t",
            pets_valid: true,
            cover_exists: 1,
            empty_list_rejected: "f",
          },
        ],
      }),
    ).toEqual({
      collectionExists: true,
      petsValid: true,
      coverExists: true,
      emptyListRejected: false,
    });
    expect(
      parseCollectionMutationStatus([
        {
          collection_exists: false,
          pets_valid: "f",
          cover_exists: 0,
          empty_list_rejected: 1,
        },
      ]),
    ).toEqual({
      collectionExists: false,
      petsValid: false,
      coverExists: false,
      emptyListRejected: true,
    });
    // The field is part of the contract: a row that omits it is a shape the
    // route cannot act on, so it is rejected rather than defaulted to false —
    // a silent false would let an empty-list write report success.
    expect(() =>
      parseCollectionMutationStatus({
        rows: [{ collection_exists: "t", pets_valid: true, cover_exists: 1 }],
      }),
    ).toThrow("collection_mutation_status_invalid");
  });
});
