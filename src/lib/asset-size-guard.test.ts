import { afterAll, beforeEach, describe, expect, it } from "bun:test";

import { HeadObjectCommand } from "@aws-sdk/client-s3";

// The presigned PUT pins the key and content-type but not the body size, so a
// caller can declare a small file at presign time and PUT a larger one. These
// tests drive the real `checkR2ObjectSize` and `findOversizedAsset`, so the
// HEAD, the limit comparison, and the fail-open path are the ones that ship.
//
// The R2 client is the module singleton; `r2.send` is replaced in place (an
// own property shadowing the prototype method) and restored afterward, rather
// than `mock.module`-ing `@/lib/r2`, because `checkR2ObjectSize` calls the
// closure's `r2` — a spread module mock would leave the real client in play.

process.env.R2_ACCOUNT_ID ??= "test-account";
process.env.R2_ACCESS_KEY_ID ??= "test-access-key";
process.env.R2_SECRET_ACCESS_KEY ??= "test-secret-key";
process.env.R2_BUCKET ??= "petdex-pets";

const r2mod = await import("@/lib/r2");
const { checkR2ObjectSize } = r2mod;
const { findOversizedAsset } = await import("@/lib/asset-size-guard");
const { PET_ASSET_MAX_BYTES } = await import("@/lib/upload-limits");

type R2Like = { send: (command: unknown) => Promise<unknown> };
const client = r2mod.r2 as unknown as R2Like;
const originalSend = client.send;

const BUCKET_URL = "https://assets.petdex.dev";
const KEY = "pets/boba-0123456789ab/sprite.webp";
const URL = `${BUCKET_URL}/${KEY}`;

let heads: Map<string, { contentLength: number | null } | "missing" | "error">;
let sendCalls: string[];

beforeEach(() => {
  heads = new Map();
  sendCalls = [];
  client.send = async (command: unknown) => {
    if (!(command instanceof HeadObjectCommand)) {
      throw new Error(`unexpected command: ${String(command)}`);
    }
    const key = String(command.input.Key);
    sendCalls.push(key);
    const result = heads.get(key) ?? "missing";
    if (result === "missing") {
      throw Object.assign(new Error("Not Found"), { name: "NotFound" });
    }
    if (result === "error") {
      throw new Error("R2 is having a moment");
    }
    return { ContentLength: result.contentLength ?? undefined };
  };
});

afterAll(() => {
  client.send = originalSend;
});

describe("checkR2ObjectSize", () => {
  it("accepts an object at or under the limit", async () => {
    heads.set(KEY, { contentLength: PET_ASSET_MAX_BYTES });
    expect(await checkR2ObjectSize(KEY, PET_ASSET_MAX_BYTES)).toEqual({
      ok: true,
      bytes: PET_ASSET_MAX_BYTES,
      missing: false,
    });
  });

  it("flags an object one byte over the limit", async () => {
    heads.set(KEY, { contentLength: PET_ASSET_MAX_BYTES + 1 });
    expect(await checkR2ObjectSize(KEY, PET_ASSET_MAX_BYTES)).toEqual({
      ok: false,
      bytes: PET_ASSET_MAX_BYTES + 1,
      maxBytes: PET_ASSET_MAX_BYTES,
      missing: false,
    });
  });

  it("lets a missing object through, flagged as missing", async () => {
    // No entry seeded: the stub throws NotFound. The check itself is not
    // oversized's concern, but the flag lets a caller whose contract needs
    // the object to exist refuse it.
    expect(await checkR2ObjectSize(KEY, PET_ASSET_MAX_BYTES)).toEqual({
      ok: true,
      bytes: null,
      missing: true,
    });
  });

  it("lets a response without ContentLength through", async () => {
    heads.set(KEY, { contentLength: null });
    expect(await checkR2ObjectSize(KEY, PET_ASSET_MAX_BYTES)).toEqual({
      ok: true,
      bytes: null,
      missing: false,
    });
  });

  it("propagates a non-NotFound error to the caller", async () => {
    heads.set(KEY, "error");
    await expect(checkR2ObjectSize(KEY, PET_ASSET_MAX_BYTES)).rejects.toThrow(
      "R2 is having a moment",
    );
  });
});

describe("findOversizedAsset", () => {
  const sprite = { field: "spritesheetUrl", label: "sprite", url: URL };

  it("returns null when every asset is within the limit", async () => {
    heads.set(KEY, { contentLength: 1024 });
    expect(await findOversizedAsset([sprite])).toBeNull();
  });

  it("names the field, the size, and the limit", async () => {
    const over = PET_ASSET_MAX_BYTES + 5 * 1024 * 1024;
    heads.set(KEY, { contentLength: over });
    const violation = await findOversizedAsset([sprite]);
    expect(violation).not.toBeNull();
    expect(violation?.field).toBe("spritesheetUrl");
    expect(violation?.label).toBe("sprite");
    expect(violation?.bytes).toBe(over);
    expect(violation?.maxBytes).toBe(PET_ASSET_MAX_BYTES);
    // Reads like the presign route's own message, so the user sees the same
    // sentence whether the size was caught at presign or at registration.
    expect(violation?.message).toBe(
      "Your sprite is 13.0 MB, over the 8.0 MB limit.",
    );
  });

  it("reports the FIRST oversized asset and stops checking the rest", async () => {
    // Both oversized on purpose: "first" is only pinned if there is more than
    // one, and "stops" is only pinned if something follows the one that
    // failed — a lone oversized last entry can neither distinguish order nor
    // observe an early return.
    const zipKey = "pets/boba-0123456789ab/zip.zip";
    heads.set(KEY, { contentLength: PET_ASSET_MAX_BYTES + 1 });
    heads.set(zipKey, { contentLength: PET_ASSET_MAX_BYTES + 1 });
    const violation = await findOversizedAsset([
      sprite,
      {
        field: "zipUrl",
        label: "zip",
        url: `${BUCKET_URL}/${zipKey}`,
      },
    ]);
    expect(violation?.field).toBe("spritesheetUrl");
    // The sprite failed first; the zip was never looked at.
    expect(sendCalls).toEqual([KEY]);
  });

  it("skips a URL that does not resolve to a bucket key", async () => {
    const violation = await findOversizedAsset([
      {
        field: "spritesheetUrl",
        label: "sprite",
        url: "https://evil.example/x",
      },
    ]);
    expect(violation).toBeNull();
    // Not our bucket: no HEAD is attempted at all.
    expect(sendCalls).toHaveLength(0);
  });

  it("fails open when the HEAD errors for a reason other than missing", async () => {
    heads.set(KEY, "error");
    expect(await findOversizedAsset([sprite])).toBeNull();
  });
});
