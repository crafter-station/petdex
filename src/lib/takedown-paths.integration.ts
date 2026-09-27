import { beforeEach, describe, expect, it, mock } from "bun:test";

import { PgDialect } from "drizzle-orm/pg-core";

import * as schema from "@/lib/db/schema";

// takedownPet has two write paths, and only one of them runs in any given
// deployment: Neon HTTP has no interactive transaction, so it goes through
// db.batch, while local Postgres uses db.transaction. The batch path is the one
// whose result slicing matters — it reads the affected collection slugs and the
// delete outcome out of a flat result array by position — and nothing else
// executes it.
//
// This suite drives both paths with a fake runner, so the slicing that decides
// which statement's rows reach which consumer actually executes instead of only
// being string-compared.
const dialect = new PgDialect();

type SqlCarrier = { __sql: unknown };

/** "batch" exercises db.batch; "transaction" removes it so the other path runs. */
let mode: "batch" | "transaction" = "batch";
let submittedSql: string[] = [];
/** Rows the fake runner returns for each statement whose text matches a marker. */
let rowsForMarkers: Array<{ marker: string; rows: unknown[] }> = [];
let transactionOpened = false;

function queryText(item: unknown): string {
  const target = (item as SqlCarrier).__sql ?? item;
  return dialect.sqlToQuery(target as never).sql;
}

function rowsFor(text: string): unknown[] {
  return (
    rowsForMarkers.find((entry) => text.includes(entry.marker))?.rows ?? []
  );
}

mock.module("server-only", () => ({}));

// Every side effect takedownPet reaches for is stubbed: the point is the write
// path's statement order and result slicing, not R2, email, or notifications.
let deletedKeys: string[] = [];
let revalidatedTags: string[] = [];
let notified: string[] = [];
mock.module("@/lib/r2", () => ({
  keyFromR2Url: (url: string | null | undefined) => url ?? null,
  deleteR2Objects: async (keys: string[]) => {
    deletedKeys = keys;
  },
}));
mock.module("@/lib/db/cached-aggregates", () => ({
  AGGREGATE_KEYS: {
    facets: "facets",
    approvedCount: "approvedCount",
    metricsSummary: "metricsSummary",
    batches: "batches",
    variantIndex: "variantIndex",
    metricsIndex: "metricsIndex",
  },
  invalidateAggregates: async () => {},
  invalidateCollectionBacklinks: async () => {},
  invalidateMetricCaches: async () => {},
  invalidatePetCaches: async () => {},
  revalidateCollectionTags: async (...slugs: string[]) => {
    revalidatedTags = slugs;
  },
}));
mock.module("@/lib/notifications", () => ({
  createNotification: async (input: { userId: string }) => {
    notified.push(input.userId);
  },
}));
mock.module("@/lib/user-locale", () => ({
  getPreferredLocaleForUser: async () => "en",
}));
mock.module("@/lib/email-templates/submission-takedown", () => ({
  renderSubmissionTakedownEmail: () => ({ subject: "s", html: "h", text: "t" }),
}));

mock.module("@/lib/db/client", () => {
  // The batch runner is read off the client at call time, so the property has to
  // appear and disappear with `mode` rather than being fixed at registration.
  const db = {
    execute: (query: unknown): SqlCarrier => ({ __sql: query }),
    get batch() {
      if (mode !== "batch") return undefined;
      return async (queries: readonly unknown[]) => {
        submittedSql = queries.map((query) => queryText(query));
        return queries.map((query) => ({ rows: rowsFor(queryText(query)) }));
      };
    },
    transaction: async (body: (tx: unknown) => Promise<unknown>) => {
      transactionOpened = true;
      const tx = {
        execute: async (query: unknown) => {
          const text = queryText(query);
          submittedSql.push(text);
          return { rows: rowsFor(text) };
        },
      };
      return body(tx);
    },
  };
  // mock.module is process-wide for the whole run, and a suite that links a name
  // this factory omits fails with a SyntaxError. Export the real schema.
  return { db, schema };
});

const { takedownPet } = await import("@/lib/takedown");

/** A submittedPets row with just the fields takedownPet reads. */
function petFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "pet_1",
    slug: "boba",
    status: "approved",
    ownerId: "user_owner",
    ownerEmail: null,
    displayName: "Boba",
    spritesheetUrl: "https://cdn.petdex.dev/pets/boba/spritesheet.webp",
    petJsonUrl: "https://cdn.petdex.dev/pets/boba/pet.json",
    zipUrl: "https://cdn.petdex.dev/pets/boba/pet.zip",
    soundUrl: null,
    ...overrides,
  } as never;
}

/** The delete of the pet row is what reports whether the takedown happened. */
const DELETE_MARKER = 'DELETE FROM "submitted_pets"';
const COLLECTIONS_MARKER = "SELECT DISTINCT";

beforeEach(() => {
  mode = "batch";
  submittedSql = [];
  rowsForMarkers = [];
  transactionOpened = false;
  deletedKeys = [];
  revalidatedTags = [];
  notified = [];
});

function statementsBeforeDelete(): string[] {
  const index = submittedSql.findIndex((s) => s.includes(DELETE_MARKER));
  return index === -1 ? [] : submittedSql.slice(0, index);
}

describe("takedownPet batch path", () => {
  it("submits the locks, then the cleanups, then the delete", async () => {
    rowsForMarkers = [{ marker: DELETE_MARKER, rows: [{ id: "pet_1" }] }];

    await takedownPet({
      pet: petFixture(),
      source: "owner",
      actorId: "user_owner",
      silent: true,
    });

    expect(transactionOpened).toBe(false);
    const before = statementsBeforeDelete();
    // Slug lock, collection locks, affected-collection read, pet row lock. The
    // slug lock selects nothing (it hashes the slug), which is how it is told
    // apart from the collection lock that selects the ids to lock.
    expect(before[0]).toContain("pg_advisory_xact_lock");
    expect(before[0]).not.toContain("FROM");
    expect(before[1]).toContain("pg_advisory_xact_lock");
    expect(before[1]).toContain("FROM");
    expect(before[2]).toContain(COLLECTIONS_MARKER);
    expect(before[3]).toContain("FOR UPDATE");
    // Every lock precedes every cleanup, and the delete comes last of all.
    expect(
      before
        .slice(4)
        .every((s) => s.includes("DELETE") || s.includes("UPDATE")),
    ).toBe(true);
    expect(submittedSql[submittedSql.length - 1]).toContain(DELETE_MARKER);
  });

  it("reads the affected collection slugs from the third statement", async () => {
    // If the slicing handed the wrong rows to readCollectionSlugs, the tags
    // revalidated below would be wrong or missing. This is the assertion that
    // makes the positional read (results[2]) load-bearing.
    rowsForMarkers = [
      {
        marker: COLLECTIONS_MARKER,
        rows: [{ slug: "col-a" }, { slug: "col-b" }],
      },
      { marker: DELETE_MARKER, rows: [{ id: "pet_1" }] },
    ];

    await takedownPet({
      pet: petFixture(),
      source: "owner",
      actorId: "user_owner",
      silent: true,
    });

    expect(revalidatedTags).toEqual(["col-a", "col-b"]);
  });

  it("does nothing else when the delete matched no row", async () => {
    // A repeated or stale takedown: the gate let nothing through, so the delete
    // returned no row. R2 assets and the owner notification must be untouched.
    rowsForMarkers = [{ marker: DELETE_MARKER, rows: [] }];

    const result = await takedownPet({
      pet: petFixture({ ownerEmail: "owner@example.com" }),
      source: "owner",
      actorId: "user_owner",
      silent: false,
    });

    expect(result).toEqual({ ok: true, slug: "boba", removedR2Keys: [] });
    expect(deletedKeys).toEqual([]);
    expect(revalidatedTags).toEqual([]);
    expect(notified).toEqual([]);
  });

  it("deletes R2 assets and revalidates tags once the delete matched", async () => {
    rowsForMarkers = [{ marker: DELETE_MARKER, rows: [{ id: "pet_1" }] }];

    const result = await takedownPet({
      pet: petFixture(),
      source: "owner",
      actorId: "user_owner",
      silent: true,
    });

    // keyFromR2Url is stubbed to echo the url, so the stored source URLs appear
    // verbatim; the public derivatives come from petPublicArtifactKeys.
    expect(result.removedR2Keys).toContain(
      "https://cdn.petdex.dev/pets/boba/spritesheet.webp",
    );
    expect(deletedKeys.length).toBeGreaterThan(0);
  });

  it("notifies the owner when the takedown is not silenced", async () => {
    rowsForMarkers = [{ marker: DELETE_MARKER, rows: [{ id: "pet_1" }] }];

    await takedownPet({
      pet: petFixture(),
      source: "admin",
      actorId: "user_admin",
      silent: false,
    });

    expect(notified).toEqual(["user_owner"]);
  });
});

describe("takedownPet transaction path", () => {
  it("runs the locks, the cleanups, and the delete inside one transaction", async () => {
    mode = "transaction";
    rowsForMarkers = [{ marker: DELETE_MARKER, rows: [{ id: "pet_1" }] }];

    await takedownPet({
      pet: petFixture(),
      source: "owner",
      actorId: "user_owner",
      silent: true,
    });

    expect(transactionOpened).toBe(true);
    const before = statementsBeforeDelete();
    expect(before[0]).toContain("pg_advisory_xact_lock");
    expect(before[1]).toContain("pg_advisory_xact_lock");
    expect(before[2]).toContain(COLLECTIONS_MARKER);
    expect(before[3]).toContain("FOR UPDATE");
    expect(submittedSql[submittedSql.length - 1]).toContain(DELETE_MARKER);
  });

  it("reads the affected collection slugs inside the transaction", async () => {
    mode = "transaction";
    rowsForMarkers = [
      { marker: COLLECTIONS_MARKER, rows: [{ slug: "col-x" }] },
      { marker: DELETE_MARKER, rows: [{ id: "pet_1" }] },
    ];

    await takedownPet({
      pet: petFixture(),
      source: "owner",
      actorId: "user_owner",
      silent: true,
    });

    expect(revalidatedTags).toEqual(["col-x"]);
  });

  it("returns early when the delete matched no row", async () => {
    mode = "transaction";
    rowsForMarkers = [{ marker: DELETE_MARKER, rows: [] }];

    const result = await takedownPet({
      pet: petFixture(),
      source: "owner",
      actorId: "user_owner",
      silent: true,
    });

    expect(transactionOpened).toBe(true);
    expect(result).toEqual({ ok: true, slug: "boba", removedR2Keys: [] });
    expect(deletedKeys).toEqual([]);
  });
});
