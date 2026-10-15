// The pending-request pre-check and the INSERT are separate statements, so two
// concurrent requests for the same (collection, pet) both pass the check and
// the second INSERT hits `pet_collection_requests_pending_pair`. That used to
// bubble up as an uncaught 23505 → 500 on a plain double-click.
//
// Seeding a pending row would not prove anything here: the route's own
// pre-check reads it first and answers alreadyPending without ever inserting,
// so the assertion would pass with the fix reverted. The db is stubbed instead
// so the pre-check misses and the insert itself raises the conflict — the only
// path through the new catch. Runs in its own process (collection-routes.test.ts)
// because it replaces @/lib/db/client, which mock.module makes process-wide.
import { describe, expect, it, mock } from "bun:test";

import * as realSchema from "@/lib/db/schema";

mock.module("server-only", () => ({}));
mock.module("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user_1" }),
}));
mock.module("@/lib/same-origin", () => ({ requireSameOrigin: () => null }));
mock.module("@/lib/ratelimit", () => ({
  submitRatelimit: { limit: async () => ({ success: true, reset: 0 }) },
}));

// A 23505 as postgres-js surfaces it: the code hangs off `cause`.
function uniqueViolation(): Error {
  return Object.assign(new Error("duplicate key value"), {
    cause: { code: "23505" },
  });
}

let insertCalls = 0;
// After the conflicting insert, the route re-reads the pair to report its id.
let pendingAfterConflict: { id: string } | null = null;

const db = {
  query: {
    petCollections: {
      findFirst: async () => ({ id: "col_1", slug: "cozy" }),
    },
    submittedPets: {
      findFirst: async () => ({ slug: "boba", status: "approved" }),
    },
    petCollectionItems: { findFirst: async () => undefined },
    petCollectionRequests: {
      // The pre-check must miss, or the route never reaches the insert.
      findFirst: async () => pendingAfterConflict,
    },
  },
  insert: () => ({
    values: async () => {
      insertCalls += 1;
      // The first read (pre-check) saw nothing; the row appears between the
      // check and the insert, exactly as a concurrent request would do it.
      pendingAfterConflict = { id: "pcr_winner" };
      throw uniqueViolation();
    },
  }),
};

mock.module("@/lib/db/client", () => ({
  db,
  schema: realSchema,
  executeAtomicReturning: async () => [],
  rowsOf: () => [],
}));

const { POST } = await import("@/app/api/collections/[slug]/request/route");

describe("POST /api/collections/[slug]/request", () => {
  it("answers alreadyPending instead of 500 on a lost insert race", async () => {
    const res = await POST(
      new Request("https://petdex.dev/api/collections/cozy/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ petSlug: "boba", note: null }),
      }),
      { params: Promise.resolve({ slug: "cozy" }) },
    );
    expect(insertCalls).toBe(1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok?: boolean;
      alreadyPending?: boolean;
      id?: string | null;
    };
    expect(body.ok).toBe(true);
    expect(body.alreadyPending).toBe(true);
    expect(body.id).toBe("pcr_winner");
  });
});
