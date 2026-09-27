import * as BunTest from "bun:test";
import { beforeEach, describe, expect, it } from "bun:test";

import * as schema from "@/lib/db/schema";

const testMock = (
  BunTest as typeof BunTest & {
    mock: { module: (specifier: string, factory: () => object) => void };
  }
).mock;

// collection-access imports "server-only", which throws outside a server
// component context, so it is imported dynamically: a static import would be
// evaluated before the stub below runs.
testMock.module("server-only", () => ({}));

testMock.module("@/lib/db/client", () => {
  // Drizzle chains are thenable AND expose the next builder, so a stub has to
  // be both: `where(...)` is awaited directly for the member reads and has
  // `.orderBy()` for the ordered ones.
  function rows(table: unknown) {
    if (table === schema.petCollections) {
      return foundCollection ? [foundCollection] : [];
    }
    if (table === schema.petCollectionItems) {
      // Member reads target the row this request will write. The route reads
      // that row's members more than once (the pre-lock cap check, the
      // else-branch fallback for an omitted list, and the reuse branch's own
      // read), and which list applies changes once the create-or-reuse path
      // swaps in a different row. Rather than guess from the query shape, the
      // fixture serves one list until the test says the swap happened.
      return swapped ? reusedItems : preLockItems;
    }
    // submittedPets: the approved-pet set the authorization check reads.
    return approvedPets;
  }
  // A drizzle builder is awaitable AND chainable, so the stub is a resolved
  // promise with the next builder attached. Writing it as a `then` property
  // instead trips lint/suspicious/noThenProperty.
  function chain(table: unknown) {
    const pending = Promise.resolve(rows(table));
    return Object.assign(pending, {
      orderBy: () => chain(table),
      limit: () => pending,
    });
  }
  const db = {
    query: {
      userProfiles: { findFirst: async () => ({ handle: "lulu" }) },
      petCollections: { findFirst: async () => foundCollection },
    },
    select: () => ({
      from: (table: unknown) => ({
        where: () => chain(table),
      }),
    }),
  };
  return { db, schema };
});

const realCollectionAccess = await import("@/lib/collection-access");
const realCollectionSql = await import("@/lib/collection-sql");
const realCachedAggregates = await import("@/lib/db/cached-aggregates");
const realSameOrigin = await import("@/lib/same-origin");

/** The row the pre-lock lookup finds. Null makes the route create or reuse. */
let foundCollection: Record<string, unknown> | null = null;
/** Members the pre-lock lookup reads for the cap comparison. */
let preLockItems: Array<{ slug: string }> = [];
/**
 * Members the reused row holds. The create-or-reuse path can hand back a row
 * the pre-lock lookup never saw, so these are tracked separately: collapsing
 * them into one list is what hid the case this suite exists for.
 */
let reusedItems: Array<{ slug: string }> = [];
/** The approved-pet set the authorization check reads. */
let approvedPets: Array<{ slug: string }> = [];
/** Set once the create-or-reuse path has swapped in the row it will write. */
let swapped = false;
/** The row the lock helper projects for the reuse path. */
let reusedRow: Record<string, unknown> = {};
/** What createOrReuseOwnerCollection resolves to. */
let reuseResult: Record<string, unknown> = { status: "created", slug: "boba" };
/**
 * The input the create path handed to createOrReuseOwnerCollection. Its title is
 * what the request actually asked to create, which is the value the validator
 * has to have seen.
 */
const createInputs: Array<Record<string, unknown>> = [];
/** Everything the item delete was called with, so the guard is provable. */
const deleteCalls: Array<readonly string[]> = [];
/**
 * Statements the write path actually executed. The empty-list rule lives in the
 * parent UPDATE's WHERE, so "the delete was never built" is no longer the
 * guarantee — a blocked write still builds it. What matters is that it never
 * runs, which is what this records.
 */
const deleteExecutions: unknown[] = [];
let mutationCalls = 0;

// Bun's mock.module makes this factory the module namespace for the whole run,
// so a partial stub is a SyntaxError in any suite loaded afterwards that links a
// name it omits — and a dozen routes import from this specifier. Importing the
// real module to spread it is not an option: evaluating @clerk/nextjs/server
// initializes Clerk and hangs the run, so every export is stubbed by name.
// Keep this list in step with the package's exports.
const clerkStub = {
  auth: async () => ({ userId: "user_owner" }),
  buildClerkProps: () => ({}),
  clerkClient: {},
  clerkFrontendApiProxy: () => new Response(null, { status: 501 }),
  clerkMiddleware: () => () => new Response(null, { status: 501 }),
  createClerkClient: () => ({}),
  createFrontendApiProxyHandlers: () => ({}),
  createRouteMatcher: () => () => false,
  currentUser: async () => null,
  getAuth: async () => ({ userId: "user_owner" }),
  reverificationError: () => null,
  reverificationErrorResponse: () => new Response(null, { status: 403 }),
  verifyToken: async () => null,
};
testMock.module("@clerk/nextjs/server", () => clerkStub);

testMock.module("@/lib/same-origin", () => ({
  ...realSameOrigin,
  requireSameOrigin: () => null,
}));

testMock.module("@/lib/collection-access", () => ({
  ...realCollectionAccess,
  canManageCreatorCollections: async () => true,
  createOrReuseOwnerCollection: async (input: Record<string, unknown>) => {
    createInputs.push(input);
    return reuseResult;
  },
  deleteCollectionItemsQuery: (
    _id: string,
    _owner: string,
    slugs: readonly string[],
  ) => {
    deleteCalls.push(slugs);
    return {};
  },
  insertCollectionItemsQuery: () => ({}),
  collectionMutationStatusQuery: () => ({}),
  parseCollectionMutationStatus: () => ({
    collectionExists: true,
    petsValid: true,
    coverExists: true,
    emptyListRejected: false,
  }),
  hasCollectionMutationRow: () => true,
  // Two callers share this helper. findCollectionAfterMutationLock runs a
  // select and projects a row; the write path runs an update and reports a
  // verdict. They are told apart by the presence of `petMutation`, which only
  // the write path sets — the lock helper never passes it.
  runCollectionMutation: async (input: {
    petMutation?: { petSlugs: readonly string[] };
    runTransaction: (tx: unknown) => Promise<unknown>;
  }) => {
    mutationCalls += 1;
    const isWritePath = input.petMutation !== undefined;
    // The lock helper only runs on the create-or-reuse path, which is exactly
    // when the written row becomes the reused one.
    if (!isWritePath) swapped = true;
    // Simulate the empty-list condition that lives in the UPDATE's WHERE. It
    // reads the row the write targets, so the fixture it consults is the one
    // the swap selected. When it fails the update matches nothing and the
    // status check reports why — the route turns that into empty_pet_slugs.
    if (isWritePath && input.petMutation?.petSlugs.length === 0) {
      const members = swapped ? reusedItems : preLockItems;
      if (members.length > 0) {
        return {
          updated: false,
          collectionExists: true,
          petsValid: true,
          coverExists: true,
          emptyListRejected: true,
        };
      }
    }
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [reusedRow] }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => [{ id: "c2" }] }),
        }),
      }),
      execute: async (statement: unknown) => {
        // Only reached when the parent update matched. The empty-list rule now
        // lives in that UPDATE's WHERE, so a member-changing write that gets
        // here is one the condition allowed — record it so a test can prove the
        // destructive statement was never executed, not merely never built.
        if (statement !== undefined) deleteExecutions.push(statement);
        return { rows: [] };
      },
    };
    const result = await input.runTransaction(tx);
    // The lock helper's parseBatch reads whatever runTransaction returns; the
    // write path's result is used directly.
    return isWritePath ? result : (result as { rows?: unknown });
  },
  collectionMutationRows: () => [
    {
      id: "c2",
      slug: "boba",
      title: "Stored",
      description: "",
      externalUrl: null,
      coverPetSlug: null,
      featured: false,
    },
  ],
}));

testMock.module("@/lib/collection-sql", () => ({
  ...realCollectionSql,
  collectionCoverForPetSlugsQuery: () => ({}),
}));

testMock.module("@/lib/db/cached-aggregates", () => ({
  ...realCachedAggregates,
  revalidateCollectionTags: async () => {},
}));

function patch(body: Record<string, unknown>) {
  return import("./route").then(({ PATCH }) =>
    PATCH(
      new Request("https://petdex.local/api/profile/collection", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
}

beforeEach(() => {
  foundCollection = null;
  preLockItems = [];
  reusedItems = [];
  approvedPets = [];
  swapped = false;
  reusedRow = {
    id: "c2",
    slug: "boba",
    title: "Stored",
    description: "",
    externalUrl: null,
    coverPetSlug: null,
    featured: false,
  };
  reuseResult = { status: "created", slug: "boba" };
  deleteCalls.length = 0;
  deleteExecutions.length = 0;
  createInputs.length = 0;
  mutationCalls = 0;
});

describe("PATCH /api/profile/collection empty member list", () => {
  it("refuses an empty list when the collection it found holds members", async () => {
    foundCollection = {
      id: "c1",
      slug: "boba",
      title: "Stored",
      description: "",
      externalUrl: null,
      coverPetSlug: "boba",
      featured: false,
    };
    preLockItems = [{ slug: "boba" }];

    const response = await patch({ petSlugs: [] });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "empty_pet_slugs" });
    // The rule is enforced inside the UPDATE, so the write is attempted and
    // matches nothing; nothing downstream of it may run.
    expect(deleteExecutions).toHaveLength(0);
    expect(mutationCalls).toBe(1);
  });

  it("refuses an empty list when the reused row holds members", async () => {
    // The case the pre-lock check cannot see: the lookup found nothing, so it
    // had no members to compare against and let the request through — but
    // create-or-reuse then handed back a row another request had just created,
    // and that row holds members. The condition reads the row the UPDATE
    // targets, so it sees them and blocks the write.
    foundCollection = null;
    preLockItems = [];
    reuseResult = { status: "existing", id: "c2", slug: "boba" };
    reusedItems = [{ slug: "boba" }, { slug: "mochi" }];

    const response = await patch({ title: "Stored", petSlugs: [] });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "empty_pet_slugs" });
    // The delete builder is reached, but its statement must never execute.
    expect(deleteExecutions).toHaveLength(0);
  });

  it("accepts an empty list on a reused row that holds nothing", async () => {
    // The rule bounds the change, not the stored row: nothing to destroy means
    // nothing to refuse.
    foundCollection = null;
    preLockItems = [];
    reuseResult = { status: "existing", id: "c2", slug: "boba" };
    reusedItems = [];

    const response = await patch({ title: "Stored", petSlugs: [] });

    // 200 and the write proceeded with the empty list: nothing to destroy, so
    // it is the no-op the rule permits rather than a refusal.
    expect(response.status).toBe(200);
    expect(deleteCalls).toEqual([[]]);
  });
});

describe("PATCH /api/profile/collection requires a title when it creates", () => {
  it("refuses a first-use PATCH that names no title", async () => {
    // This route both creates and edits. A create needs a title, and the
    // validator has to see the value the create will use: when an omitted title
    // was left absent by the patch validator and defaulted to "" *after*
    // validation, a first-use PATCH with no title created a collection whose
    // title was empty — below the 2-character minimum every other path
    // enforces. The fallback now happens before the validator runs.
    foundCollection = null;

    const response = await patch({});

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "title_length" });
    expect(createInputs).toHaveLength(0);
  });

  it("refuses a first-use PATCH with a one-character title", async () => {
    foundCollection = null;

    const response = await patch({ title: "x" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "title_length" });
    expect(createInputs).toHaveLength(0);
  });

  it("still creates with a valid title", async () => {
    foundCollection = null;

    const response = await patch({ title: "My set" });

    expect(response.status).toBe(200);
    expect(createInputs).toHaveLength(1);
    expect(createInputs[0]?.title).toBe("My set");
  });

  it("does not require a title on a request that edits an existing row", async () => {
    // The other half: an edit may omit the title, because the stored one is
    // what the write keeps. Requiring it here would make a description-only or
    // cover-only edit fail.
    foundCollection = {
      id: "c1",
      slug: "boba",
      title: "Stored",
      description: "",
      externalUrl: null,
      coverPetSlug: null,
      featured: false,
    };

    const response = await patch({ description: "new copy" });

    expect(response.status).toBe(200);
    expect(createInputs).toHaveLength(0);
  });
});
