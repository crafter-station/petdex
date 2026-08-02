import { describe, expect, it } from "bun:test";

import {
  planPublicArtifacts,
  submissionOwnerNotificationHref,
} from "@/lib/submission-decisions";

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

describe("planPublicArtifacts", () => {
  const base = {
    action: "edit" as const,
    wasApproved: true,
    isApproved: true,
    slugChanged: false,
    spritesheetChanged: false,
  };

  it("republishes when the sprite is swapped under the same slug", () => {
    const plan = planPublicArtifacts({ ...base, spritesheetChanged: true });
    expect(plan.republish).toBe(true);
    // The keys did not move, so nothing is orphaned.
    expect(plan.deleteOld).toBe(false);
  });

  it("republishes and clears the old keys on a rename", () => {
    const plan = planPublicArtifacts({ ...base, slugChanged: true });
    expect(plan.republish).toBe(true);
    expect(plan.deleteOld).toBe(true);
  });

  it("leaves artifacts alone when an edit changes neither", () => {
    const plan = planPublicArtifacts(base);
    expect(plan.republish).toBe(false);
    expect(plan.deleteOld).toBe(false);
  });

  it("deletes without republishing when a pet stops being approved", () => {
    const plan = planPublicArtifacts({
      ...base,
      action: "reject",
      isApproved: false,
    });
    expect(plan.republish).toBe(false);
    expect(plan.deleteOld).toBe(true);
  });

  it("publishes nothing for a pet that was never approved", () => {
    const plan = planPublicArtifacts({
      ...base,
      wasApproved: false,
      spritesheetChanged: true,
    });
    expect(plan.republish).toBe(false);
    expect(plan.deleteOld).toBe(false);
  });
});
