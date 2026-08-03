import { afterEach, describe, expect, it } from "bun:test";

import {
  hasPublishedStickerArtifact,
  isCurrentStickerExportAllowed,
  isCurrentStickerPublication,
  isStickerExplorerEnabled,
  STICKER_ARTIFACT_VERSION,
  STICKER_EXPORT_POLICY_VERSION,
  STICKER_EXPORT_SCOPE,
} from "@/lib/sticker-export-policy";

const originalEnabled = process.env.STICKER_EXPLORER_ENABLED;
const originalDisabled = process.env.STICKER_EXPORT_DISABLED;

afterEach(() => {
  process.env.STICKER_EXPLORER_ENABLED = originalEnabled;
  process.env.STICKER_EXPORT_DISABLED = originalDisabled;
});

describe("sticker export policy", () => {
  it("requires an approved pet and an approval for its current sprite", () => {
    const pet = { status: "approved" as const, spriteSha256: "sprite-v2" };
    const approval = {
      petId: "pet-1",
      scope: STICKER_EXPORT_SCOPE,
      status: "allowed" as const,
      sourceSha256: "sprite-v2",
      policyVersion: STICKER_EXPORT_POLICY_VERSION,
      reviewedBy: "admin",
      reason: "approved for sticker export",
      reviewedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(isCurrentStickerExportAllowed(pet, approval)).toBe(true);
    expect(
      isCurrentStickerExportAllowed(pet, {
        ...approval,
        sourceSha256: "sprite-v1",
      }),
    ).toBe(false);
  });

  it("requires the complete current publication matrix", () => {
    const pet = { status: "approved" as const, spriteSha256: "sprite-v2" };
    const publication = {
      petId: "pet-1",
      sourceSha256: "sprite-v2",
      artifactVersion: STICKER_ARTIFACT_VERSION,
      states: [
        "idle",
        "running-right",
        "running-left",
        "waving",
        "jumping",
        "failed",
        "waiting",
        "running",
        "review",
      ],
      formats: ["webp", "png"],
      profiles: ["web", "whatsapp"],
      treatments: ["clean", "outline"],
      objectCount: 55,
      totalBytes: 123,
      manifestSha256: "manifest",
      status: "complete" as const,
      cleanupStatus: "not_required" as const,
      cleanupError: null,
      publishedAt: new Date(),
      revokedAt: null,
      updatedAt: new Date(),
    };

    expect(isCurrentStickerPublication(pet, publication)).toBe(true);
    expect(
      isCurrentStickerPublication(pet, {
        ...publication,
        treatments: ["clean"],
      }),
    ).toBe(false);
    expect(
      isCurrentStickerPublication(pet, {
        ...publication,
        profiles: ["web"],
      }),
    ).toBe(false);
    expect(
      hasPublishedStickerArtifact(
        publication,
        "waiting",
        "webp",
        "outline",
        "whatsapp",
      ),
    ).toBe(true);
    expect(
      hasPublishedStickerArtifact(
        publication,
        "waiting",
        "png",
        "outline",
        "whatsapp",
      ),
    ).toBe(false);
  });

  it("keeps the explorer disabled unless explicitly enabled", () => {
    process.env.STICKER_EXPLORER_ENABLED = "1";
    delete process.env.STICKER_EXPORT_DISABLED;
    expect(isStickerExplorerEnabled()).toBe(true);

    process.env.STICKER_EXPORT_DISABLED = "true";
    expect(isStickerExplorerEnabled()).toBe(false);
  });
});
