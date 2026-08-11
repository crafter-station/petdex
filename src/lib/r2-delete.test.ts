import { describe, expect, it } from "bun:test";

import { type R2DeleteBatchResult, summarizeR2DeleteBatch } from "@/lib/r2";

describe("R2 delete outcomes", () => {
  it("counts only confirmed keys and preserves per-key errors", () => {
    const result = summarizeR2DeleteBatch(["one", "two", "three"], {
      Deleted: [{ Key: "one" }, { Key: "two" }],
      Errors: [{ Key: "two", Code: "AccessDenied", Message: "denied" }],
    } as never);

    const expected: R2DeleteBatchResult = {
      deletedKeys: ["one", "three"],
      failures: [{ key: "two", code: "AccessDenied", message: "denied" }],
    };
    expect(result).toEqual(expected);
  });

  it("treats an omitted Deleted entry without an error as idempotent success", () => {
    expect(
      summarizeR2DeleteBatch(["already-gone"], { Errors: [] } as never),
    ).toEqual({ deletedKeys: ["already-gone"], failures: [] });
  });

  it("keeps explicit R2 errors as failures", () => {
    expect(
      summarizeR2DeleteBatch(["denied"], {
        Errors: [{ Key: "denied", Code: "AccessDenied", Message: "denied" }],
      } as never),
    ).toEqual({
      deletedKeys: [],
      failures: [{ key: "denied", code: "AccessDenied", message: "denied" }],
    });
  });
});
