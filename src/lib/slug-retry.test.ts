import { afterAll, describe, expect, it, mock } from "bun:test";

import * as schema from "@/lib/db/schema";

// The slug-collision retry is the fix for a 500 that a concurrent same-slug
// submission used to cause, and it is the code whose violation check was
// silently dead (drizzle puts `code` on `.cause`, not on the wrapper). It is
// unreachable through `persistSubmission` without a database that can really
// raise 23505, so the helper is driven directly: the insert rejects with a
// drizzle-shaped error, and the retry must re-resolve the slug and succeed.

mock.module("server-only", () => ({}));

let insertedSlugs: string[] = [];
/** Slugs the stub pretends another row already owns. */
let takenSlugs = new Set<string>();
/** On the next insert, "lose" the race: record the slug as taken, then throw. */
let loseRaceOnce = false;

function uniqueViolation(): Error {
  return Object.assign(new Error("Failed query"), {
    name: "DrizzleQueryError",
    cause: Object.assign(new Error("duplicate key value"), { code: "23505" }),
  });
}

/** Pull the bound slug out of drizzle's `eq(column, value)` node. */
function slugFromWhere(where: unknown): string {
  const seen = new Set<unknown>();
  const stack: unknown[] = [where];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    const record = node as Record<string, unknown>;
    if (typeof record.value === "string") return record.value;
    for (const value of Object.values(record)) {
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return "";
}

mock.module("@/lib/db/client", () => ({
  db: {
    query: {
      submittedPets: {
        findFirst: async (options: { where: unknown }) =>
          takenSlugs.has(slugFromWhere(options.where)) ? {} : undefined,
      },
    },
    insert: () => ({
      values: async (row: { slug: string }) => {
        if (loseRaceOnce) {
          // A concurrent submission won the slug between the check and the
          // insert; the row it wrote is now visible.
          loseRaceOnce = false;
          takenSlugs.add(row.slug);
          throw uniqueViolation();
        }
        insertedSlugs.push(row.slug);
      },
    }),
  },
  // The real schema: `resolveUniqueSlug` builds `eq(schema.submittedPets.slug,
  // …)` and drizzle needs the real column to render the node.
  schema,
  executeAtomicReturning: async () => [],
  rowsOf: () => [],
}));

const { insertSubmissionWithUniqueSlug } = await import("@/lib/submissions");

afterAll(() => {
  mock.restore();
});

const INPUT = { id: "pet_1", requestedSlug: "boba", values: {} as never };

describe("insertSubmissionWithUniqueSlug", () => {
  it("inserts the requested slug when it is free", async () => {
    insertedSlugs = [];
    takenSlugs = new Set();
    loseRaceOnce = false;
    expect(await insertSubmissionWithUniqueSlug(INPUT)).toBe("boba");
    expect(insertedSlugs).toEqual(["boba"]);
  });

  it("re-resolves the slug and retries after losing the race", async () => {
    insertedSlugs = [];
    takenSlugs = new Set();
    // "boba" looks free at check time, then a concurrent insert takes it.
    loseRaceOnce = true;
    expect(await insertSubmissionWithUniqueSlug(INPUT)).toBe("boba-2");
    expect(insertedSlugs).toEqual(["boba-2"]);
  });

  it("gives up after repeated collisions rather than looping forever", async () => {
    insertedSlugs = [];
    takenSlugs = new Set(["boba"]);
    loseRaceOnce = false;
    // Every candidate is taken, so resolveUniqueSlug's random-suffix fallback
    // is the only slug left; make the insert reject it too by throwing always.
    let attempts = 0;
    const { db } = (await import("@/lib/db/client")) as unknown as {
      db: {
        insert: () => { values: (row: { slug: string }) => Promise<void> };
      };
    };
    db.insert = () => ({
      values: async () => {
        attempts += 1;
        throw uniqueViolation();
      },
    });
    await expect(insertSubmissionWithUniqueSlug(INPUT)).rejects.toThrow();
    // Bounded: the loop retries the insert at most 5 times before giving up.
    // Exact, not `toBeLessThanOrEqual` — a bound the code never reaches would
    // satisfy that while an unbounded loop just runs until the suite timeout.
    expect(attempts).toBe(5);
  });
});
