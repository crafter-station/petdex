import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

import { DeleteObjectsCommand } from "@aws-sdk/client-s3";

import * as schema from "@/lib/db/schema";

// The withdraw route deletes R2 objects after removing the row. Its asset URLs
// are NOT pinned to the caller's namespace (`validateSubmission` accepts any
// `/pets/`, `/curated/`, `/community/` path), so a submission can point at
// another pet's live spritesheet — deleting on the row's word alone would let
// any user destroy an arbitrary object. These tests pin the reference re-check
// that prevents it, and that an owner's genuinely orphaned asset still goes.
//
// The R2 client is stubbed by replacing `r2.send` on the module singleton, not
// with `mock.module("@/lib/r2")`. `mock.module` is process-wide and its undo
// is not reliable across files on Bun 1.4.2: a bare `{ deleteR2Objects }`
// replacement here reached `r2.test.ts` loaded later, and `getSignedUrl` died
// on `client.config.endpointProvider`. Patching the method leaves every other
// export — and the client's `config` — intact.

const BUCKET = "https://assets.petdex.dev";
const UPLOAD = "0123456789ab";
const BASE_ROW = {
  id: "pet_1",
  ownerId: "user_1",
  slug: "boba",
  status: "pending",
  spritesheetUrl: `${BUCKET}/pets/boba-${UPLOAD}/sprite.webp`,
  petJsonUrl: `${BUCKET}/pets/boba-${UPLOAD}/petjson.json`,
  zipUrl: `${BUCKET}/pets/boba-${UPLOAD}/zip.zip`,
};
// Mutable per test: some cases point a field at another pet's live key.
let row = { ...BASE_ROW };

let referenced = false;
let deleted: string[] = [];
let deletedBatches = 0;
// Whether the guarded pet DELETE matched a row. false models a concurrent
// approve/claim winning between the route's read and its write.
let petDeleted = true;
// The statements the route handed to `executeAtomicReturning`, rendered to
// SQL text. The route's race guard reads the pet DELETE's rows, so that
// statement MUST carry `RETURNING` — without it every driver reports zero
// rows and the guard would deny a withdraw that in fact succeeded. The stub
// below cannot model that (it fabricates rows), so assert on the SQL instead.
let atomicStatements: string[] = [];
// The reference-protection SELECTs the cleanup issues. Its rendered SQL is
// what exposed the format mismatch: the keyList carried `pets/...` while the
// URL columns reduced to `/pets/...`, so the guard never matched anything.
let referenceStatements: string[] = [];

function statementText(query: unknown): string {
  const chunks = (
    query as { getSQL?: () => { queryChunks?: unknown[] } }
  )?.getSQL?.()?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      const value = (chunk as { value?: unknown }).value;
      return Array.isArray(value) ? value.join("") : String(value ?? "");
    })
    .join("");
}

mock.module("server-only", () => ({}));
mock.module("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user_1" }),
}));
mock.module("@/lib/same-origin", () => ({ requireSameOrigin: () => null }));
mock.module("@/lib/ratelimit", () => ({
  withdrawRatelimit: { limit: async () => ({ success: true }) },
}));
mock.module("@/lib/db/client", () => ({
  db: {
    query: { submittedPets: { findFirst: async () => row } },
    execute: async (query: unknown) => {
      referenceStatements.push(statementText(query));
      return referenced ? [{ "?column?": 1 }] : [];
    },
  },
  schema,
  // Statement order is [pet delete, reviews delete]; only the pet delete's
  // rows decide whether the withdraw took effect.
  executeAtomicReturning: async (statements: unknown[]) => {
    atomicStatements = statements.map(statementText);
    return [petDeleted ? [{ id: row.id }] : [], []];
  },
  rowsOf: (result: unknown) => (Array.isArray(result) ? result : []),
}));

const r2mod = await import("@/lib/r2");
type R2Like = { send: (command: unknown) => Promise<unknown> };
const r2Client = r2mod.r2 as unknown as R2Like;
const originalSend = r2Client.send;
r2Client.send = async (command: unknown) => {
  if (command instanceof DeleteObjectsCommand) {
    deletedBatches += 1;
    const objects = command.input.Delete?.Objects ?? [];
    deleted = objects.map((o) => o.Key ?? "").filter(Boolean);
    return { Deleted: deleted.map((Key) => ({ Key })) };
  }
  return originalSend(command);
};

const { POST } = await import("@/app/api/my-pets/[id]/withdraw/route");

afterAll(() => {
  r2Client.send = originalSend;
  mock.restore();
});

beforeEach(() => {
  row = { ...BASE_ROW };
  referenced = false;
  deleted = [];
  deletedBatches = 0;
  petDeleted = true;
  atomicStatements = [];
  referenceStatements = [];
});

/**
 * The route's cleanup is fire-and-forget behind dynamic imports, so poll
 * briefly rather than guessing at a microtask count.
 */
async function settle(when: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!when() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Wait for any cleanup started by the previous test to finish before the next
 * one resets the counters. The route's cleanup is detached, so without this a
 * delete from the prior test can land mid-way through the following test and
 * make `deletedBatches` read 2 (or attribute a delete to the wrong case).
 * Two extra macrotask turns cover the two awaits (dynamic import + delete)
 * after the last observed batch.
 */
async function quiesce(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}

async function withdraw(): Promise<Response> {
  return POST(
    new Request("https://petdex.dev/api/my-pets/pet_1/withdraw", {
      method: "POST",
      headers: { origin: "https://petdex.dev", host: "petdex.dev" },
    }) as never,
    {
      params: Promise.resolve({ id: "pet_1" }),
    },
  );
}

describe("withdraw asset cleanup", () => {
  it("returns the rows the race guard reads, so a lost race is visible", async () => {
    // Without `RETURNING` the pet DELETE reports zero rows on every driver,
    // which would make the route answer "only_pending_can_be_withdrawn" for
    // the withdraw it just performed. Asserted on the SQL text because the
    // stub above fabricates the rows and cannot model a driver's behaviour.
    await withdraw();
    expect(atomicStatements).toHaveLength(2);
    expect(atomicStatements[0]).toContain("RETURNING");
    expect(atomicStatements[0]).toContain("'pending'");
    // Drain this test's own detached cleanup so it cannot land during the
    // next test and inflate its `deletedBatches`.
    await quiesce();
  });

  it("deletes the owner's orphaned assets when nothing references them", async () => {
    const res = await withdraw();
    expect(res.status).toBe(200);
    await settle(() => deletedBatches > 0);
    expect(deletedBatches).toBe(1);
    expect(deleted).toContain(`pets/boba-${UPLOAD}/sprite.webp`);
    expect(deleted).toContain(`pets/boba-${UPLOAD}/zip.zip`);
  });

  it("does NOT delete a key another row still references", async () => {
    // A submission pointed its asset URLs at another pet's object; the
    // reference row keeps it alive, so the withdraw must leave R2 alone.
    referenced = true;
    const res = await withdraw();
    expect(res.status).toBe(200);
    await quiesce();
    expect(deletedBatches).toBe(0);
  });

  it("compares reference keys in the same format on both sides", async () => {
    // keyFromR2PublicUrl() yields `pets/...` (no leading slash) while the
    // URL columns reduced by the SQL regexp keep theirs (`/pets/...`); a
    // bare IN between the two never matched, so the reference guard was
    // silently inert and the cleanup deleted keys another row pointed at.
    // The SQL must strip the leading slash before comparing.
    await withdraw();
    await quiesce();
    expect(referenceStatements.length).toBeGreaterThan(0);
    for (const stmt of referenceStatements) {
      expect(stmt).toContain("ltrim(");
    }
    await quiesce();
  });

  it("does NOT delete a live pet key the row merely points at", async () => {
    // The reference check is a second net; the guard that actually holds is
    // the key-shape filter. A row can point its spritesheet at another pet's
    // *live* object — `validateSubmission` only pins the host and the `/pets/`
    // prefix — and a live object is `pets/<slug>/sprite.webp` (or the derived
    // `thumb.webp` / `preview.webp`), which is not the submission-upload shape.
    // Nothing in the DB references the derived thumb, so the reference check
    // alone would pass and delete it; the shape filter is what refuses. Model
    // the worst case: the reference check says "not referenced".
    referenced = false;
    row.spritesheetUrl = `${BUCKET}/pets/victim-slug/thumb.webp`;
    row.petJsonUrl = `${BUCKET}/pets/victim-slug/petjson.json`;
    row.zipUrl = `${BUCKET}/pets/victim-slug/zip.zip`;
    const res = await withdraw();
    expect(res.status).toBe(200);
    await quiesce();
    expect(deletedBatches).toBe(0);
  });

  it("deletes only the caller's own upload-shaped keys from a mixed row", async () => {
    // One field points at the caller's real upload, another at a victim's live
    // sprite. Only the caller's key goes; the victim's is left alone even
    // though the reference check found nothing.
    referenced = false;
    row.spritesheetUrl = `${BUCKET}/pets/boba-${UPLOAD}/sprite.webp`;
    row.petJsonUrl = `${BUCKET}/pets/victim-slug/petjson.json`;
    row.zipUrl = `${BUCKET}/pets/victim-slug/zip.zip`;
    const res = await withdraw();
    expect(res.status).toBe(200);
    await settle(() => deletedBatches > 0);
    await quiesce();
    expect(deletedBatches).toBe(1);
    expect(deleted).toEqual([`pets/boba-${UPLOAD}/sprite.webp`]);
  });

  it("reports not-withdrawable and skips cleanup when the guards lost the race", async () => {
    // A concurrent approve/claim won between the route's read and its write:
    // the guarded pet DELETE matched 0 rows, so the pet survived and its
    // reviews must too. The response has to say so instead of `ok:true`, and
    // no R2 cleanup may run for a withdrawal that never happened.
    petDeleted = false;
    const res = await withdraw();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "only_pending_can_be_withdrawn",
    });
    await quiesce();
    expect(deletedBatches).toBe(0);
  });
});
