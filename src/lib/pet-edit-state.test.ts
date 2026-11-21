import { describe, expect, it } from "bun:test";

import {
  buildPendingEditPatch,
  pendingEditIsNoOp,
  toPendingEditView,
} from "@/lib/pet-edit-state";

function row(overrides: Record<string, unknown> = {}) {
  return {
    pendingDisplayName: "Existing name",
    pendingDescription: null,
    pendingTags: ["old-tag"],
    pendingSubmittedAt: new Date("2026-08-01T00:00:00Z"),
    pendingRejectionReason: "needs review",
    pendingSpritesheetUrl:
      "https://assets.petdex.dev/pets/sample-pet-pending-0123456789ab/sprite.webp",
    pendingPetJsonUrl: null,
    pendingZipUrl: null,
    pendingSpritesheetWidth: 1536,
    pendingSpritesheetHeight: 1872,
    pendingSpriteVersionNumber: 2,
    pendingDhash: "0123456789abcdef",
    pendingReviewId: "review-1",
    ...overrides,
  } as never;
}

describe("pending edit state", () => {
  it("starts from the current pending values instead of clearing them", () => {
    const patch = buildPendingEditPatch(row());
    expect(patch.pendingDisplayName).toBe("Existing name");
    expect(patch.pendingTags).toEqual(["old-tag"]);
    expect(patch.pendingSpritesheetUrl).toContain("pending-0123456789ab");
    expect(patch.pendingSpriteVersionNumber).toBe(2);
    expect(patch.pendingDhash).toBe("0123456789abcdef");
    expect(patch.pendingReviewId).toBe("review-1");
  });

  it("treats equal pending values as a no-op", () => {
    const current = row();
    expect(pendingEditIsNoOp(current, buildPendingEditPatch(current))).toBe(
      true,
    );
  });

  it("detects a change even when the target is null to withdraw a pending value", () => {
    const current = row();
    const patch = buildPendingEditPatch(current);
    patch.pendingDisplayName = null;
    expect(pendingEditIsNoOp(current, patch)).toBe(false);
  });

  it("compares pending tags as a set", () => {
    const current = row();
    const patch = buildPendingEditPatch(current);
    patch.pendingTags = ["old-tag"];
    expect(pendingEditIsNoOp(current, patch)).toBe(true);
    patch.pendingTags = ["new-tag"];
    expect(pendingEditIsNoOp(current, patch)).toBe(false);
  });

  it("detects a pending sprite version change", () => {
    const current = row();
    const patch = buildPendingEditPatch(current);
    patch.pendingSpriteVersionNumber = 1;
    expect(pendingEditIsNoOp(current, patch)).toBe(false);
  });
});

describe("pending edit view", () => {
  const live = "https://assets.petdex.dev/pets/sample-pet/sprite.webp";
  const pendingSprite =
    "https://assets.petdex.dev/pets/sample-pet-pending-0123456789ab/sprite.webp";
  const source = {
    spritesheetUrl: live,
    pendingDisplayName: "New name",
    pendingDescription: null,
    pendingTags: ["cat"],
    pendingSubmittedAt: new Date("2026-08-01T00:00:00Z"),
    pendingSpritesheetUrl: pendingSprite,
  };

  it("carries the pending spritesheet so View edit can preview it", () => {
    expect(toPendingEditView(source)).toEqual({
      displayName: "New name",
      description: null,
      tags: ["cat"],
      submittedAt: "2026-08-01T00:00:00.000Z",
      spritesheetUrl: pendingSprite,
    });
  });

  it("omits the spritesheet when it is missing or matches the live one", () => {
    expect(
      toPendingEditView({ ...source, pendingSpritesheetUrl: null })
        ?.spritesheetUrl,
    ).toBeNull();
    expect(
      toPendingEditView({ ...source, pendingSpritesheetUrl: live })
        ?.spritesheetUrl,
    ).toBeNull();
  });

  it("returns null without a pending submission", () => {
    expect(toPendingEditView({ ...source, pendingSubmittedAt: null })).toBe(
      null,
    );
  });

  it("keeps a string timestamp from raw SQL rows", () => {
    expect(
      toPendingEditView({
        ...source,
        pendingSubmittedAt: "2026-08-01T00:00:00.000Z",
      })?.submittedAt,
    ).toBe("2026-08-01T00:00:00.000Z");
  });
});
