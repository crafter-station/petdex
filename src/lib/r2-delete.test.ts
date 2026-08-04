import { describe, expect, it } from "bun:test";

import { type R2DeleteBatchResult, summarizeR2DeleteBatch } from "@/lib/r2";

describe("R2 delete outcomes", () => {
  it("counts only confirmed keys and preserves per-key errors", () => {
    const result = summarizeR2DeleteBatch(["one", "two", "three"], {
      Deleted: [{ Key: "one" }, { Key: "two" }],
      Errors: [{ Key: "two", Code: "AccessDenied", Message: "denied" }],
    } as never);

    const expected: R2DeleteBatchResult = {
      deletedKeys: ["one"],
      failures: [
        { key: "two", code: "AccessDenied", message: "denied" },
        {
          key: "three",
          code: "not_confirmed",
          message: "R2 did not confirm deletion",
        },
      ],
    };
    expect(result).toEqual(expected);
  });
});
