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
  // A drizzle builder is awaitable AND chainable, so the stub is a resolved
  // promise with the next builder attached.
  function chain(table: unknown) {
    // submittedPets backs the authorization read; this suite approves whatever
    // it is asked about, since the guard under test is the member rule.
    const list =
      table === schema.petCollectionItems
        ? storedItems
        : table === schema.submittedPets
          ? storedItems
          : [];
    const pending = Promise.resolve(list);
    return Object.assign(pending, {
      orderBy: () => chain(table),
      limit: () => pending,
    });
  }
  const db = {
    query: {
      petCollections: {
        findFirst: async () => ({
          id: "c1",
          slug: "boba",
          title: "Stored",
          description: "",
          externalUrl: null,
          coverPetSlug: null,
          ownerId: "user_owner",
          featured: false,
        }),
      },
    },
    select: () => ({
      from: (table: unknown) => ({ where: () => chain(table) }),
    }),
  };
  return { db, schema };
});

const realCollectionAccess = await import("@/lib/collection-access");
const realCollectionSql = await import("@/lib/collection-sql");
const realCachedAggregates = await import("@/lib/db/cached-aggregates");
const realSameOrigin = await import("@/lib/same-origin");

/** Members the stored-items read returns for the cap and empty-list rules. */
let storedItems: Array<{ slug: string }> = [];
/** Everything the item delete was called with, so the guard is provable. */
const deleteCalls: Array<readonly string[]> = [];

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
  runCollectionMutation: async (input: {
    runTransaction: (tx: unknown) => Promise<unknown>;
  }) =>
    input.runTransaction({
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => [{ id: "c1" }] }),
        }),
      }),
      execute: async () => ({ rows: [] }),
    }),
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
      new Request("https://petdex.local/api/profile/collections/c1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: "c1" }) },
    ),
  );
}

beforeEach(() => {
  storedItems = [];
  deleteCalls.length = 0;
});

describe("PATCH /api/profile/collections/[id] empty member list", () => {
  it("refuses an empty list when the collection holds members", async () => {
    // An empty list is refused rather than read as "clear the collection".
    storedItems = [{ slug: "boba" }, { slug: "mochi" }];

    const response = await patch({ petSlugs: [] });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "empty_pet_slugs" });
    // Refused before the write: the stored members are read for the cap check
    // anyway, so the fast path rejects without building the delete. The atomic
    // condition in the UPDATE's WHERE is the backstop for the race this read
    // cannot see, and is covered directly in collection-access.test.ts.
    expect(deleteCalls).toHaveLength(0);
  });

  it("accepts an empty list when the collection already holds nothing", async () => {
    // The rule bounds the change, not the stored row: nothing to destroy means
    // nothing to refuse, and a row left empty by an older build stays
    // renameable.
    storedItems = [];

    const response = await patch({ petSlugs: [], title: "Renamed" });

    expect(response.status).toBe(200);
  });
});
