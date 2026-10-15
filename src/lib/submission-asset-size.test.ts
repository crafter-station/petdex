import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

import { HeadObjectCommand } from "@aws-sdk/client-s3";

// `persistSubmission` is the shared tail of both submit routes (/api/submit
// and /api/cli/submit/register), so the size guard has to live here to cover
// both. This drives the real function and proves the oversized upload is
// refused BEFORE the row is written: the db stub throws on any use beyond the
// slug lookup, so a regression that moved the check after the insert would
// surface as a thrown error rather than a passing test.

process.env.R2_ACCOUNT_ID ??= "test-account";
process.env.R2_ACCESS_KEY_ID ??= "test-access-key";
process.env.R2_SECRET_ACCESS_KEY ??= "test-secret-key";
process.env.R2_BUCKET ??= "petdex-pets";

const r2mod = await import("@/lib/r2");
const { PET_ASSET_MAX_BYTES } = await import("@/lib/upload-limits");

type R2Like = { send: (command: unknown) => Promise<unknown> };
const client = r2mod.r2 as unknown as R2Like;
const originalSend = client.send;

let contentLength: number;
let insertCalled: boolean;

mock.module("server-only", () => ({}));

mock.module("@/lib/db/client", () => ({
  db: {
    // The slug lookup runs only after the size check passes; make any use of
    // the db loud so a reordering cannot pass silently.
    query: {
      submittedPets: {
        findFirst: async () => {
          insertCalled = true;
          throw new Error("db reached before the size check");
        },
      },
    },
    insert: () => {
      insertCalled = true;
      throw new Error("insert reached before the size check");
    },
  },
  schema: {},
  executeAtomicReturning: async () => [],
  rowsOf: () => [],
}));

const { persistSubmission } = await import("@/lib/submissions");

beforeEach(() => {
  insertCalled = false;
  contentLength = PET_ASSET_MAX_BYTES + 1;
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

const BUCKET = "https://assets.petdex.dev";
const UPLOAD_ID = "0123456789ab";

function bodyFor(slug: string) {
  return {
    petId: slug,
    displayName: "Boba",
    description: "A very round cat that sits on keyboards.",
    spritesheetUrl: `${BUCKET}/pets/${slug}-${UPLOAD_ID}/sprite.webp`,
    petJsonUrl: `${BUCKET}/pets/${slug}-${UPLOAD_ID}/petjson.json`,
    zipUrl: `${BUCKET}/pets/${slug}-${UPLOAD_ID}/zip.zip`,
  };
}

const PRINCIPAL = {
  userId: "user_1",
  email: "boba@example.com",
  username: "boba",
  imageUrl: null,
  firstName: "Bo",
  lastName: "Ba",
};

describe("persistSubmission asset size guard", () => {
  it("refuses an oversized sprite before writing the row", async () => {
    const result = await persistSubmission(bodyFor("boba") as never, PRINCIPAL);
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: "asset_too_large",
      field: "spritesheetUrl",
    });
    expect(insertCalled).toBe(false);
  });

  it("refuses an oversized zip, not only the sprite", async () => {
    // The sprite is fine; the zip is the one over the limit — which is the
    // common case, since a webp barely compresses but the zip carries the
    // whole atlas.
    client.send = async (command: unknown) => {
      const key = (command as HeadObjectCommand).input.Key ?? "";
      return {
        ContentLength: key.endsWith("zip.zip") ? PET_ASSET_MAX_BYTES + 1 : 1024,
      };
    };
    const result = await persistSubmission(bodyFor("boba") as never, PRINCIPAL);
    expect(result).toMatchObject({
      ok: false,
      error: "asset_too_large",
      field: "zipUrl",
    });
    expect(insertCalled).toBe(false);
  });

  it("passes the guard when every asset is within the limit", async () => {
    contentLength = 1024;
    // An oversized asset RESOLVES with { ok: false }; passing the guard walks
    // on into the row write, which the stub turns into a throw — so a thrown
    // outcome is the signal the guard let this submission through.
    const outcome = await persistSubmission(
      bodyFor("boba") as never,
      PRINCIPAL,
    ).then(
      () => "resolved",
      () => "threw",
    );
    expect(outcome).toBe("threw");
  });
});
