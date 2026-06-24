import { describe, expect, it } from "bun:test";

import { submissionOwnerNotificationHref } from "@/lib/submission-decisions";

describe("submissionOwnerNotificationHref", () => {
  it("links approved submissions to the public pet page", () => {
    expect(
      submissionOwnerNotificationHref({
        slug: "boba",
        status: "approved",
      }),
    ).toBe("/pets/boba");
  });

  it("uses the stable my-pets redirect for rejected submissions", () => {
    expect(
      submissionOwnerNotificationHref({
        slug: "eleven",
        status: "rejected",
      }),
    ).toBe("/my-pets");
  });
});
