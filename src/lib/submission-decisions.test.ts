import { describe, expect, it } from "bun:test";

// `LEADERBOARD_CACHE_KEYS` lives in `@/lib/db/cached-aggregates`, which has no
// heavy transitive deps — unlike `@/lib/leaderboard`, which reaches
// `@/lib/db/client` and throws at module load without a `DATABASE_URL`.
const { AGGREGATE_KEYS, LEADERBOARD_CACHE_KEYS } = await import(
  "@/lib/db/cached-aggregates"
);

const { planPublicArtifacts, submissionOwnerNotificationHref } = await import(
  "@/lib/submission-decisions"
);

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

describe("the leaderboard cache is invalidated on a status flip", () => {
  // The leaderboard keys are per-metric (`…:leaderboard:v1:pets`), so the
  // approve/reject invalidation has to name every suffix. This branch added
  // the cache without invalidating it, and an approved pet stayed off the
  // leaderboard for the full 5-minute TTL. Two guards: the key list covers
  // every metric the page queries, and the decision path actually flushes it.
  it("covers every metric the leaderboard page queries", () => {
    const flushed = new Set(LEADERBOARD_CACHE_KEYS);
    for (const metric of [
      "pets",
      "likes",
      "installs",
      "rising",
      "collectors",
    ] as const) {
      expect(
        flushed.has(`${AGGREGATE_KEYS.leaderboard}:${metric}`),
        metric,
      ).toBe(true);
    }
  });

  it("the approve/reject path flushes those keys", async () => {
    // Source guard: the invalidation lives inside a large DB-writing function
    // that a unit test cannot reach without a database. Assert the wiring
    // directly — dropping `...LEADERBOARD_CACHE_KEYS` from the flush is the
    // exact regression this pins.
    const source = await Bun.file(
      new URL("./submission-decisions.ts", import.meta.url),
    ).text();
    const approveFlush = source.slice(
      source.indexOf('body.action === "approve"'),
      source.indexOf('body.action === "edit"'),
    );
    expect(approveFlush).toContain("...LEADERBOARD_CACHE_KEYS");
  });
});
