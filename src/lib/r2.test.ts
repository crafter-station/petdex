// Regression tests for presigned R2 upload URLs.
//
// Run: bun test src/lib/r2.test.ts
//
// Issue #465: AWS SDK v3 started injecting flexible-checksum query params
// (x-amz-checksum-crc32, x-amz-sdk-checksum-algorithm) into presigned
// PutObject URLs. Because the presign runs with an empty body, the signed
// checksum is for zero bytes, so the browser's real PUT of pet.json is
// rejected by R2 as an opaque CORS network error. The S3 client is
// configured with requestChecksumCalculation: "WHEN_REQUIRED" to suppress
// this. These tests lock that behavior in.

import { describe, expect, it } from "bun:test";

process.env.R2_ACCOUNT_ID ??= "test-account";
process.env.R2_ACCESS_KEY_ID ??= "test-access-key";
process.env.R2_SECRET_ACCESS_KEY ??= "test-secret-key";
process.env.R2_BUCKET ??= "petdex-pets";

const { presignPut } = await import("@/lib/r2");

describe("presignPut", () => {
  it("does not include flexible-checksum query params", async () => {
    const { uploadUrl } = await presignPut(
      "submissions/test/pet.json",
      "application/json",
    );
    const url = new URL(uploadUrl);

    expect(url.searchParams.has("x-amz-checksum-crc32")).toBe(false);
    expect(url.searchParams.has("x-amz-sdk-checksum-algorithm")).toBe(false);
    // Catch any other checksum variant the SDK might add (crc32c, sha256...).
    for (const key of url.searchParams.keys()) {
      expect(key.toLowerCase()).not.toContain("checksum");
    }
  });

  it("signs content-type so the browser PUT matches the signature", async () => {
    const { uploadUrl } = await presignPut(
      "submissions/test/pet.json",
      "application/json",
    );
    const signedHeaders = new URL(uploadUrl).searchParams.get(
      "X-Amz-SignedHeaders",
    );

    expect(signedHeaders).toContain("content-type");
  });

  it("returns the public URL and key for the object", async () => {
    const result = await presignPut(
      "submissions/test/pet.json",
      "application/json",
    );

    expect(result.key).toBe("submissions/test/pet.json");
    expect(result.publicUrl).toContain("submissions/test/pet.json");
  });
});
