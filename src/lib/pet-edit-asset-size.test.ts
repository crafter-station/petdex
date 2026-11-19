import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

import { HeadObjectCommand } from "@aws-sdk/client-s3";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import * as schema from "@/lib/db/schema";
import * as realRatelimit from "@/lib/ratelimit";

// `applyPetEdit` is the shared tail of the web and CLI edit routes. An
// oversized pending asset is worse here than at submit: it is promoted onto
// the live row on approval, and until then the public page serves the OLD
// bytes, so a reviewer never sees what will actually ship. The guard runs
// before any write, so a refused edit leaves the pet untouched.
//
// The db stub answers only the ownership lookup; any write throws, which is
// what proves the refusal happens before persistence.

process.env.R2_ACCOUNT_ID ??= "test-account";
process.env.R2_ACCESS_KEY_ID ??= "test-access-key";
process.env.R2_SECRET_ACCESS_KEY ??= "test-secret-key";
process.env.R2_BUCKET ??= "petdex-pets";

const r2mod = await import("@/lib/r2");
const { PET_ASSET_MAX_BYTES } = await import("@/lib/upload-limits");

type R2Like = { send: (command: unknown) => Promise<unknown> };
const client = r2mod.r2 as unknown as R2Like;
const originalSend = client.send;

const SLUG = "boba";
const BUCKET = "https://assets.petdex.dev";
const PENDING_SPRITE = `${BUCKET}/pets/${SLUG}-pending-0123456789ab/sprite.webp`;

let contentLength: number;
let wrote: boolean;
let row: typeof ROW;
// The write chain is stubbed down to .returning() so the ownership tests
// below can inspect the WHERE it carries and decide what the guarded write
// "matched". `writeThrows` preserves the first suites' behaviour: a write
// reached before the size guard must fail loudly.
let writeThrows = true;
let updateRows: unknown[] = [];
const updateWheres: unknown[] = [];
// `findFirst` is called more than once on the asset path: once by
// applyPetEdit's up-front ownership read, and again by queueEdit's re-read
// after a guarded write misses. `findFirstResults` (when set) hands out one
// result per call so a test can model the row vanishing between the two.
let findFirstResults: Array<typeof ROW | null> | null = null;
let findFirstCalls = 0;

const ROW = {
  id: "pet_1",
  slug: SLUG,
  ownerId: "user_1",
  status: "approved",
  displayName: "Boba",
  description: "A very round cat that sits on keyboards.",
  tags: [],
  spritesheetUrl: `${BUCKET}/pets/${SLUG}-fedcba987654/sprite.webp`,
  petJsonUrl: `${BUCKET}/pets/${SLUG}-fedcba987654/petjson.json`,
  zipUrl: `${BUCKET}/pets/${SLUG}-fedcba987654/zip.zip`,
  spriteVersionNumber: 2,
  editCount: 0,
  lastEditAt: null,
  approvedAt: null,
  pendingDisplayName: null,
  pendingDescription: null,
  pendingTags: null,
  pendingSubmittedAt: null,
  pendingSpritesheetUrl: null,
  pendingPetJsonUrl: null,
  pendingZipUrl: null,
  pendingSpritesheetWidth: null,
  pendingSpritesheetHeight: null,
  pendingSpriteVersionNumber: null,
  pendingDhash: null,
  pendingReviewId: null,
};

mock.module("server-only", () => ({}));
mock.module("@/lib/ratelimit", () => ({
  ...realRatelimit,
  editRatelimit: { limit: async () => ({ success: true }) },
}));
mock.module("@/lib/db/client", () => ({
  db: {
    query: {
      submittedPets: {
        findFirst: async () => {
          findFirstCalls += 1;
          if (findFirstResults) {
            return (
              findFirstResults[
                Math.min(findFirstCalls - 1, findFirstResults.length - 1)
              ] ?? null
            );
          }
          return row;
        },
      },
    },
    update: () => ({
      set: () => ({
        where: (condition: unknown) => {
          wrote = true;
          if (writeThrows) {
            throw new Error("write reached before the size check");
          }
          updateWheres.push(condition);
          return { returning: async () => updateRows };
        },
      }),
    }),
    execute: () => {
      wrote = true;
      if (writeThrows) {
        throw new Error("write reached before the size check");
      }
      // A query carrier for the batch below; the asset-path write builds its
      // statements with `db.execute(...)` and hands them to `db.batch`.
      return { __sql: true };
    },
    // The asset path (`queueAssetEditWithClaimGuard`) needs one of these two,
    // and takes `batch` first. Its second statement is the guarded UPDATE, so
    // `updateRows` decides what the write "matched".
    batch: async (queries: readonly unknown[]) => {
      wrote = true;
      if (writeThrows) {
        throw new Error("write reached before the size check");
      }
      if (queries.length !== 2) throw new Error("expected two statements");
      return [undefined, { rows: updateRows }];
    },
  },
  // The real schema: `applyPetEdit` builds its WHERE from
  // `schema.submittedPets.id`, so a bare `{}` throws before the guard runs.
  schema,
  executeAtomicReturning: async () => [],
  rowsOf: () => [],
}));

const { applyPetEdit } = await import("@/lib/pet-edit");

beforeEach(() => {
  wrote = false;
  row = { ...ROW };
  findFirstResults = null;
  findFirstCalls = 0;
  contentLength = PET_ASSET_MAX_BYTES + 1;
  updateRows = [];
  updateWheres.length = 0;
  client.send = async (command: unknown) => {
    if (!(command instanceof HeadObjectCommand)) {
      throw new Error("unexpected command");
    }
    return { ContentLength: contentLength };
  };
});

afterAll(() => {
  client.send = originalSend;
  mock.restore();
});

describe("applyPetEdit asset size guard", () => {
  it("refuses an oversized pending sprite before writing", async () => {
    const res = await applyPetEdit({
      id: "pet_1",
      userId: "user_1",
      body: {
        spritesheetUrl: PENDING_SPRITE,
        spritesheetWidth: 1536,
        spritesheetHeight: 2288,
        spriteVersionNumber: 2,
      },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "asset_too_large",
      field: "spritesheetUrl",
    });
    expect(wrote).toBe(false);
  });

  it("does not HEAD the bucket when no asset changed", async () => {
    // A text-only edit must not pay for a size check it cannot fail. The
    // write stub throws, so the outcome is a rejection — the assertion is the
    // HEAD count, which is what proves the guard skipped the bucket.
    let heads = 0;
    client.send = async () => {
      heads += 1;
      return { ContentLength: PET_ASSET_MAX_BYTES + 1 };
    };
    await expect(
      applyPetEdit({
        id: "pet_1",
        userId: "user_1",
        body: { displayName: "Boba the Second" },
      }),
    ).rejects.toThrow();
    expect(heads).toBe(0);
  });

  it("does not re-check an unchanged pending asset on a text-only edit", async () => {
    // The row already carries a pending sprite from an earlier edit. That
    // upload was verified when it was written, so a description change must
    // neither HEAD it again nor be refused for bytes it never touched — the
    // bug when the guard looked at every pending URL rather than the changed
    // ones.
    row.pendingSpritesheetUrl = PENDING_SPRITE;
    let heads = 0;
    client.send = async () => {
      heads += 1;
      return { ContentLength: PET_ASSET_MAX_BYTES + 1 };
    };
    await expect(
      applyPetEdit({
        id: "pet_1",
        userId: "user_1",
        body: { displayName: "Boba the Second" },
      }),
    ).rejects.toThrow();
    expect(heads).toBe(0);
  });
});

// The owner-scoped read at the top of applyPetEdit and the write that follows
// are separate statements. A claim reassigning the row in between used to
// leave the edit applied to a pet the caller no longer owned, so the write
// repeats the ownership check — the same close the withdraw and claim writes
// carry. These tests pin that the condition is on the statement (not only on
// the read) and that its outcome decides the response.
describe("applyPetEdit ownership re-check on the write", () => {
  beforeEach(() => {
    writeThrows = false;
    updateWheres.length = 0;
    // An existing pending edit makes tryAutoAccept decline before it reaches
    // the AI-judged auto-accept path, routing this into queueEdit — the
    // guarded write under test.
    row.pendingSubmittedAt = new Date();
  });

  it("carries the caller's ownership in the write itself", async () => {
    updateRows = [
      {
        pendingDisplayName: "Boba the Second",
        pendingDescription: null,
        pendingTags: null,
        pendingSubmittedAt: new Date(),
      },
    ];
    const res = await applyPetEdit({
      id: "pet_1",
      userId: "user_1",
      body: { displayName: "Boba the Second" },
    });
    expect(res.status).toBe(200);
    expect(updateWheres.length).toBe(1);
    const query = new PgDialect().sqlToQuery(updateWheres[0] as SQL);
    expect(query.sql).toContain('"owner_id"');
    expect(query.params).toContain("user_1");
  });

  it("answers not_found, not success, when the guard matches no row", async () => {
    // The row moved to another owner between the read and the write, so the
    // guarded UPDATE matched nothing. A success response here would tell the
    // caller an edit was queued that never landed.
    updateRows = [];
    const res = await applyPetEdit({
      id: "pet_1",
      userId: "user_1",
      body: { displayName: "Boba the Second" },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("queueEdit distinguishes a lost race from a claimed asset", () => {
  // The asset-path write has two predicates — owner_id and the GC-claim NOT
  // EXISTS — so a miss could be either. Reporting the claim's 409 for a
  // lost-ownership race told the caller an asset was unavailable when the pet
  // was no longer theirs; the text path and tryAutoAccept's comment both
  // promise 404. This pins the re-read that tells them apart.
  beforeEach(() => {
    writeThrows = false;
    updateWheres.length = 0;
    // An existing pending edit keeps this off the AI-judged auto-accept path.
    row.pendingSubmittedAt = new Date();
    // Within the limit, so the size guard does not short-circuit to 400 and
    // the request reaches the guarded write under test.
    contentLength = PET_ASSET_MAX_BYTES - 1;
  });

  it("answers 404 when the row is no longer the caller's", async () => {
    // Call 1: applyPetEdit's ownership read sees the row. Call 2: the guarded
    // write misses, so queueEdit re-reads — and the row is gone.
    findFirstResults = [{ ...ROW }, null];
    updateRows = [];
    const res = await applyPetEdit({
      id: "pet_1",
      userId: "user_1",
      body: {
        spritesheetUrl: PENDING_SPRITE,
        spritesheetWidth: 1536,
        spritesheetHeight: 2288,
        spriteVersionNumber: 2,
      },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("answers 409 when the row is still owned but its asset was claimed", async () => {
    // Same guarded write, same miss — but the re-read still finds our own row,
    // so the only explanation left is the GC claim.
    findFirstResults = [{ ...ROW }, { ...ROW }];
    updateRows = [];
    const res = await applyPetEdit({
      id: "pet_1",
      userId: "user_1",
      body: {
        spritesheetUrl: PENDING_SPRITE,
        spritesheetWidth: 1536,
        spritesheetHeight: 2288,
        spriteVersionNumber: 2,
      },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "asset_no_longer_available",
    });
  });
});
