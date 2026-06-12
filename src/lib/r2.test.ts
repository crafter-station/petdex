import { describe, expect, it } from "bun:test";

describe("presignPut", () => {
  it("does not sign an empty payload checksum for browser uploads", async () => {
    process.env.R2_ACCOUNT_ID = "62819ee0a8411123c2635cbf37b577c1";
    process.env.R2_ACCESS_KEY_ID = "test";
    process.env.R2_SECRET_ACCESS_KEY = "test";
    process.env.R2_BUCKET = "petdex-pets";

    const { presignPut } = await import("./r2");
    const presigned = await presignPut(
      "pets/test-upload/petjson.json",
      "application/json",
    );

    const url = new URL(presigned.uploadUrl);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain(
      "content-type",
    );
    expect(url.searchParams.get("X-Amz-Content-Sha256")).toBe(
      "UNSIGNED-PAYLOAD",
    );
    expect(url.searchParams.has("x-amz-checksum-crc32")).toBe(false);
    expect(url.searchParams.has("x-amz-sdk-checksum-algorithm")).toBe(false);
  });
});
