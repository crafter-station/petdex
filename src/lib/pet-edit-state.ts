import type { SubmittedPet } from "@/lib/db/schema";
import { toCurrentR2PublicUrl } from "@/lib/r2-public-url";
import type { SpriteVersionNumber } from "@/lib/types";

export type PendingEditView = {
  displayName: string | null;
  description: string | null;
  tags: string[] | null;
  submittedAt: string;
  spritesheetUrl: string | null;
};

type PendingEditSource = {
  spritesheetUrl: string;
  pendingDisplayName: string | null;
  pendingDescription: string | null;
  pendingTags: unknown;
  pendingSubmittedAt: Date | string | null;
  pendingSpritesheetUrl: string | null;
};

export function toPendingEditView(
  row: PendingEditSource,
): PendingEditView | null {
  if (!row.pendingSubmittedAt) return null;
  const pendingSprite = row.pendingSpritesheetUrl;
  return {
    displayName: row.pendingDisplayName,
    description: row.pendingDescription,
    tags: (row.pendingTags as string[] | null) ?? null,
    submittedAt:
      row.pendingSubmittedAt instanceof Date
        ? row.pendingSubmittedAt.toISOString()
        : row.pendingSubmittedAt,
    spritesheetUrl:
      pendingSprite && pendingSprite !== row.spritesheetUrl
        ? toCurrentR2PublicUrl(pendingSprite)
        : null,
  };
}

export type PendingEditPatch = {
  pendingDisplayName: string | null;
  pendingDescription: string | null;
  pendingTags: string[] | null;
  pendingSubmittedAt: Date;
  pendingRejectionReason: null;
  pendingSpritesheetUrl: string | null;
  pendingPetJsonUrl: string | null;
  pendingZipUrl: string | null;
  pendingSpritesheetWidth: number | null;
  pendingSpritesheetHeight: number | null;
  pendingSpriteVersionNumber: SpriteVersionNumber | null;
  pendingDhash: string | null;
  pendingReviewId: string | null;
};

export function buildPendingEditPatch(row: SubmittedPet): PendingEditPatch {
  return {
    pendingDisplayName: row.pendingDisplayName ?? null,
    pendingDescription: row.pendingDescription ?? null,
    pendingTags: row.pendingTags ?? null,
    pendingSubmittedAt: row.pendingSubmittedAt ?? new Date(),
    pendingRejectionReason: null,
    pendingSpritesheetUrl: row.pendingSpritesheetUrl ?? null,
    pendingPetJsonUrl: row.pendingPetJsonUrl ?? null,
    pendingZipUrl: row.pendingZipUrl ?? null,
    pendingSpritesheetWidth: row.pendingSpritesheetWidth ?? null,
    pendingSpritesheetHeight: row.pendingSpritesheetHeight ?? null,
    pendingSpriteVersionNumber:
      row.pendingSpriteVersionNumber === 1 ||
      row.pendingSpriteVersionNumber === 2
        ? row.pendingSpriteVersionNumber
        : null,
    pendingDhash: row.pendingDhash ?? null,
    pendingReviewId: row.pendingReviewId ?? null,
  };
}

function sameArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((value, index) => value === sb[index]);
}

function sameNullableTags(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return sameArray(a, b);
}

export function pendingEditIsNoOp(
  row: SubmittedPet,
  patch: PendingEditPatch,
): boolean {
  return (
    patch.pendingDisplayName === (row.pendingDisplayName ?? null) &&
    patch.pendingDescription === (row.pendingDescription ?? null) &&
    sameNullableTags(patch.pendingTags, row.pendingTags ?? null) &&
    patch.pendingSpritesheetUrl === (row.pendingSpritesheetUrl ?? null) &&
    patch.pendingPetJsonUrl === (row.pendingPetJsonUrl ?? null) &&
    patch.pendingZipUrl === (row.pendingZipUrl ?? null) &&
    patch.pendingSpritesheetWidth === (row.pendingSpritesheetWidth ?? null) &&
    patch.pendingSpritesheetHeight === (row.pendingSpritesheetHeight ?? null) &&
    patch.pendingSpriteVersionNumber ===
      (row.pendingSpriteVersionNumber === 1 ||
      row.pendingSpriteVersionNumber === 2
        ? row.pendingSpriteVersionNumber
        : null)
  );
}
