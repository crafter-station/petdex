import "server-only";

import { NextResponse } from "next/server";

import { and, eq, sql } from "drizzle-orm";

import { findOversizedAsset } from "@/lib/asset-size-guard";
import {
  AGGREGATE_KEYS,
  invalidateAggregates,
  invalidatePetCaches,
} from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";
import type { SubmittedPet } from "@/lib/db/schema";
import { decideAutoAccept } from "@/lib/edit-policy";
import {
  BLOCKED_KEYWORD_REASON,
  containsBlockedKeyword,
} from "@/lib/keyword-blocklist";
import { createNotification } from "@/lib/notifications";
import { isPendingAssetUrl, type PendingAssetRole } from "@/lib/pending-asset";
import {
  PENDING_ASSET_GC_LOCK_KEY,
  pendingAssetKeysFromUrls,
} from "@/lib/pending-asset-gc";
import {
  buildPendingEditPatch,
  type PendingEditPatch,
  pendingEditIsNoOp,
} from "@/lib/pet-edit-state";
import { editRatelimit } from "@/lib/ratelimit";
import { refreshSimilarityFor } from "@/lib/similarity";
import { normalizeSpriteVersionNumber } from "@/lib/sprite-version";
import { MIN_SPRITE_DIM } from "@/lib/submissions-validation";
import { containsUrl, URL_BLOCKED_REASON } from "@/lib/url-blocklist";

export type PatchBody = {
  displayName?: string;
  description?: string;
  tags?: string[];
  spritesheetUrl?: string;
  spritesheetWidth?: number;
  spritesheetHeight?: number;
  petJsonUrl?: string;
  spriteVersionNumber?: 1 | 2;
  zipUrl?: string;
};

const TAG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const MAX_TAGS = 8;
const DESC_MAX = 280;

type PendingPatch = PendingEditPatch;

type EditFlags = {
  assetTouched: boolean;
};

function normalizeTags(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of input) {
    if (typeof t !== "string") continue;
    const v = t.trim().toLowerCase();
    if (!TAG_RE.test(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function sameArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function applyTextFields(
  row: SubmittedPet,
  body: PatchBody,
  patch: PendingPatch,
): Response | null {
  if (typeof body.displayName === "string") {
    const value = body.displayName.trim().slice(0, 60);
    if (value.length < 2) {
      return NextResponse.json(
        { error: "display_name_too_short" },
        { status: 400 },
      );
    }
    patch.pendingDisplayName = value === row.displayName ? null : value;
  }

  if (typeof body.description === "string") {
    const value = body.description.trim();
    if (value.length < 10) {
      return NextResponse.json(
        { error: "description_too_short" },
        { status: 400 },
      );
    }
    if (value.length > DESC_MAX) {
      return NextResponse.json(
        {
          error: "description_too_long",
          message: `Description must be ${DESC_MAX} characters or fewer (got ${value.length}).`,
        },
        { status: 400 },
      );
    }
    patch.pendingDescription = value === row.description ? null : value;
  }

  if (body.tags !== undefined) {
    const tags = normalizeTags(body.tags);
    if (tags === null) {
      return NextResponse.json({ error: "invalid_tags" }, { status: 400 });
    }
    const currentTags = row.tags ?? [];
    patch.pendingTags = sameArray(tags, currentTags) ? null : tags;
  }

  return null;
}

function applyAssetFields(
  row: SubmittedPet,
  body: PatchBody,
  patch: PendingPatch,
  flags: EditFlags,
): Response | null {
  const spriteVersion =
    body.spriteVersionNumber === undefined
      ? null
      : normalizeSpriteVersionNumber(body.spriteVersionNumber);
  if (spriteVersion && !spriteVersion.ok) {
    return NextResponse.json(
      {
        error: "invalid_sprite_version",
        field: "spriteVersionNumber",
        message: "spriteVersionNumber must be omitted, 1, or 2.",
      },
      { status: 400 },
    );
  }

  const setAsset = (
    role: PendingAssetRole,
    value: string,
    currentValue: string,
    field: "spritesheetUrl" | "petJsonUrl" | "zipUrl",
    pendingField:
      | "pendingSpritesheetUrl"
      | "pendingPetJsonUrl"
      | "pendingZipUrl",
  ): Response | null => {
    const target = value === currentValue ? null : value;
    if (target !== null && !isPendingAssetUrl(target, row.slug, role)) {
      return NextResponse.json(
        { error: "invalid_asset_url", field },
        { status: 400 },
      );
    }

    if (patch[pendingField] !== target) {
      patch[pendingField] = target;
      patch.pendingDhash = null;
      patch.pendingReviewId = null;
      flags.assetTouched = true;
    }
    return null;
  };

  if (typeof body.spritesheetUrl === "string") {
    const previousUrl = patch.pendingSpritesheetUrl;
    const previousWidth = patch.pendingSpritesheetWidth;
    const previousHeight = patch.pendingSpritesheetHeight;
    const error = setAsset(
      "sprite",
      body.spritesheetUrl,
      row.spritesheetUrl,
      "spritesheetUrl",
      "pendingSpritesheetUrl",
    );
    if (error) return error;
    if (patch.pendingSpritesheetUrl !== null) {
      // `typeof === "number"` alone let 1536.5, Infinity and 1e21 through to
      // an `integer` column, where Postgres rejects them and the whole edit
      // 500s instead of 400ing. The submit path validates the same fields
      // with Number.isSafeInteger plus a floor (submissions-validation.ts);
      // match it, and treat a bad value the same as a missing one.
      const validDim = (value: unknown): value is number =>
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= MIN_SPRITE_DIM;
      if (validDim(body.spritesheetWidth)) {
        patch.pendingSpritesheetWidth = body.spritesheetWidth;
      } else if (previousUrl !== patch.pendingSpritesheetUrl) {
        patch.pendingSpritesheetWidth = null;
      }
      if (validDim(body.spritesheetHeight)) {
        patch.pendingSpritesheetHeight = body.spritesheetHeight;
      } else if (previousUrl !== patch.pendingSpritesheetUrl) {
        patch.pendingSpritesheetHeight = null;
      }
    } else {
      patch.pendingSpritesheetWidth = null;
      patch.pendingSpritesheetHeight = null;
    }
    if (
      patch.pendingSpritesheetWidth !== previousWidth ||
      patch.pendingSpritesheetHeight !== previousHeight
    ) {
      patch.pendingDhash = null;
      patch.pendingReviewId = null;
    }
  }

  if (typeof body.petJsonUrl === "string") {
    const previousPetJsonUrl = patch.pendingPetJsonUrl;
    const error = setAsset(
      "petjson",
      body.petJsonUrl,
      row.petJsonUrl,
      "petJsonUrl",
      "pendingPetJsonUrl",
    );
    if (error) return error;
    if (patch.pendingPetJsonUrl !== null) {
      patch.pendingSpriteVersionNumber =
        spriteVersion?.ok === true ? spriteVersion.version : 1;
    } else if (previousPetJsonUrl !== patch.pendingPetJsonUrl) {
      patch.pendingSpriteVersionNumber = null;
    }
  } else if (patch.pendingPetJsonUrl !== null && spriteVersion?.ok === true) {
    patch.pendingSpriteVersionNumber = spriteVersion.version;
  }

  if (typeof body.zipUrl === "string") {
    const error = setAsset(
      "zip",
      body.zipUrl,
      row.zipUrl,
      "zipUrl",
      "pendingZipUrl",
    );
    if (error) return error;
  }

  return null;
}

function validatePatchContent(patch: PendingPatch): Response | null {
  const urlHit = containsUrl(
    ["displayName", patch.pendingDisplayName],
    ["description", patch.pendingDescription],
    ...((patch.pendingTags ?? []).map((t) => ["tag", t]) as Array<
      [string, string]
    >),
  );
  if (urlHit) {
    return NextResponse.json(
      {
        error: "url_in_field",
        field: urlHit.field,
        pattern: urlHit.pattern,
        message: URL_BLOCKED_REASON,
      },
      { status: 422 },
    );
  }

  if (
    containsBlockedKeyword(
      patch.pendingDisplayName,
      patch.pendingDescription,
      ...(patch.pendingTags ?? []),
    )
  ) {
    return NextResponse.json(
      { error: "blocked_content", message: BLOCKED_KEYWORD_REASON },
      { status: 422 },
    );
  }

  return null;
}

function hasAssetEdit(patch: PendingPatch): boolean {
  return (
    patch.pendingSpritesheetUrl !== null ||
    patch.pendingPetJsonUrl !== null ||
    patch.pendingZipUrl !== null ||
    patch.pendingSpriteVersionNumber !== null
  );
}

/**
 * Reject an edit whose newly uploaded assets are larger than the presign
 * allowed.
 *
 * Same gap as the submission path — a presigned PUT does not bind the body to
 * the declared size — but the stake is higher here: an oversized pending asset
 * is promoted to the live row on approval, and the pending key is not what the
 * public page serves until then, so a reviewer may never see the bytes that
 * will actually ship. Runs before any row write, so a refused edit leaves the
 * pet untouched rather than half-updated.
 *
 * Only assets this edit *changed* are checked. An unchanged pending URL was
 * verified when it was written (the guard precedes every write), so re-HEADing
 * it on a text-only edit would cost three requests — and could reject a
 * description change for bytes the user never touched, if an asset queued
 * before this guard existed were oversized.
 */
async function assertPendingAssetsWithinLimit(
  row: SubmittedPet,
  patch: PendingPatch,
): Promise<Response | null> {
  const candidates: Array<{
    field: string;
    label: string;
    url: string | null;
    current: string | null;
  }> = [
    {
      field: "spritesheetUrl",
      label: "sprite",
      url: patch.pendingSpritesheetUrl,
      current: row.pendingSpritesheetUrl ?? null,
    },
    {
      field: "petJsonUrl",
      label: "petjson",
      url: patch.pendingPetJsonUrl,
      current: row.pendingPetJsonUrl ?? null,
    },
    {
      field: "zipUrl",
      label: "zip",
      url: patch.pendingZipUrl,
      current: row.pendingZipUrl ?? null,
    },
  ];
  const changed = candidates.filter((asset) => asset.url !== asset.current);
  if (changed.length === 0) return null;

  const violation = await findOversizedAsset(
    changed.flatMap((asset) =>
      asset.url
        ? [{ field: asset.field, label: asset.label, url: asset.url }]
        : [],
    ),
  );
  if (!violation) return null;
  return NextResponse.json(
    {
      error: "asset_too_large",
      field: violation.field,
      maxBytes: violation.maxBytes,
      size: violation.bytes,
      message: violation.message,
    },
    { status: 400 },
  );
}

async function persistAutoAcceptedEdit(
  id: string,
  ownerId: string,
  row: SubmittedPet,
  patch: PendingPatch,
): Promise<boolean> {
  const liveUpdate: Record<string, unknown> = {
    pendingDisplayName: null,
    pendingDescription: null,
    pendingTags: null,
    pendingSpriteVersionNumber: null,
    pendingSubmittedAt: null,
    pendingRejectionReason: null,
    pendingAutoApprovedAt: new Date(),
    editCount: (row.editCount ?? 0) + 1,
    lastEditAt: new Date(),
  };
  if (patch.pendingDisplayName !== null) {
    liveUpdate.displayName = patch.pendingDisplayName;
  }
  if (patch.pendingDescription !== null) {
    liveUpdate.description = patch.pendingDescription;
  }
  if (patch.pendingTags !== null) liveUpdate.tags = patch.pendingTags;

  const applied = await db
    .update(schema.submittedPets)
    .set(liveUpdate)
    // The ownership check above is a separate statement: a claim moving the
    // row to another owner between it and this write would still apply the
    // edit. Repeating the guard here is the same TOCTOU close the withdraw
    // and claim writes do — no row coming back means the row is no longer
    // ours, and there is nothing to notify or invalidate about.
    .where(
      and(
        eq(schema.submittedPets.id, id),
        eq(schema.submittedPets.ownerId, ownerId),
      ),
    )
    .returning({
      slug: schema.submittedPets.slug,
      ownerId: schema.submittedPets.ownerId,
      displayName: schema.submittedPets.displayName,
    });
  if (applied.length === 0) return false;

  void refreshSimilarityFor(id).catch(() => {});
  await invalidateAggregates(AGGREGATE_KEYS.variantIndex);
  await invalidatePetCaches(row.slug);

  void createNotification({
    userId: row.ownerId,
    kind: "edit_approved",
    payload: {
      petSlug: row.slug,
      petName: patch.pendingDisplayName ?? row.displayName,
      auto: true,
    },
    href: `/pets/${row.slug}`,
    // fire-and-forget, but a silent drop is indistinguishable from success —
    // log so a missing notification is at least visible in the logs.
  }).catch((err) =>
    console.warn("[notify] edit_approved notification failed:", err),
  );

  return true;
}

async function tryAutoAccept(
  id: string,
  userId: string,
  row: SubmittedPet,
  patch: PendingPatch,
  flags: EditFlags,
): Promise<Response | null> {
  if (
    row.pendingSubmittedAt !== null ||
    flags.assetTouched ||
    hasAssetEdit(patch)
  ) {
    return null;
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // submitted_pets stores a cumulative edit counter, not an edit history.
  // Treat the counter as the recent count while lastEditAt is inside the
  // window; after the window expires the counter is no longer evidence of a
  // recent edit. This is conservative and avoids the old count(*) query,
  // which always returned one row for the pet itself.
  const editCountLast24h =
    row.lastEditAt && row.lastEditAt >= since ? (row.editCount ?? 0) : 0;

  const decision = await decideAutoAccept({
    currentDisplayName: row.displayName,
    currentDescription: row.description,
    currentTags: row.tags ?? [],
    currentSpritesheetUrl: row.spritesheetUrl,
    currentPetJsonUrl: row.petJsonUrl,
    currentZipUrl: row.zipUrl,
    currentApprovedAt: row.approvedAt ?? null,
    pendingDisplayName: patch.pendingDisplayName,
    pendingDescription: patch.pendingDescription,
    pendingTags: patch.pendingTags,
    pendingSpritesheetUrl: null,
    pendingPetJsonUrl: null,
    pendingZipUrl: null,
    editCountLast24h,
  });
  if (!decision.autoAccept) return null;

  // A row that moved to another owner between the read and this write is not
  // ours to auto-apply: fall through to queueEdit, whose guarded write also
  // matches nothing and answers 404 — instead of reporting an approval for an
  // edit that never landed.
  if (!(await persistAutoAcceptedEdit(id, userId, row, patch))) return null;
  return NextResponse.json({ status: "auto_approved" });
}

type QueuedEditRow = Pick<
  SubmittedPet,
  | "pendingDisplayName"
  | "pendingDescription"
  | "pendingTags"
  | "pendingSubmittedAt"
>;

async function queueEdit(
  id: string,
  userId: string,
  patch: PendingPatch,
): Promise<Response> {
  const assetKeys = pendingAssetKeysFromUrls([
    patch.pendingSpritesheetUrl,
    patch.pendingPetJsonUrl,
    patch.pendingZipUrl,
  ]);
  const hasAssetKeys = assetKeys.length > 0;
  const updated = hasAssetKeys
    ? await queueAssetEditWithClaimGuard(id, userId, patch, assetKeys)
    : await queueTextEdit(id, userId, patch);

  if (!updated) {
    if (!hasAssetKeys) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    // The asset-path update has two predicates — `owner_id = userId` and the
    // GC-claim NOT EXISTS — and a miss could be either. Re-read ownership to
    // tell them apart: a row that is gone or reassigned answers 404 like the
    // text path and like `tryAutoAccept`'s comment promises, and only a row we
    // still own falls through to the claim verdict. Reporting the claim's 409
    // for a lost-ownership race told the caller an asset was unavailable when
    // the pet was no longer theirs.
    const stillOwned = await db.query.submittedPets.findFirst({
      where: and(
        eq(schema.submittedPets.id, id),
        eq(schema.submittedPets.ownerId, userId),
      ),
      columns: { id: true },
    });
    if (!stillOwned) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(
      {
        error: "asset_no_longer_available",
        message: "One of the pending assets is no longer available.",
      },
      { status: 409 },
    );
  }

  return NextResponse.json({
    status: "queued",
    pending: {
      displayName: updated.pendingDisplayName,
      description: updated.pendingDescription,
      tags: updated.pendingTags,
      submittedAt: updated.pendingSubmittedAt,
    },
  });
}

async function queueTextEdit(
  id: string,
  ownerId: string,
  patch: PendingPatch,
): Promise<QueuedEditRow | null> {
  const [updated] = await db
    .update(schema.submittedPets)
    .set(patch)
    // Repeat applyPetEdit's ownership read on the write: a claim reassigning
    // the row between the two would otherwise queue an edit on a pet the
    // caller no longer owns. 0 rows back = same 404 as a missing row.
    .where(
      and(
        eq(schema.submittedPets.id, id),
        eq(schema.submittedPets.ownerId, ownerId),
      ),
    )
    .returning({
      pendingDisplayName: schema.submittedPets.pendingDisplayName,
      pendingDescription: schema.submittedPets.pendingDescription,
      pendingTags: schema.submittedPets.pendingTags,
      pendingSubmittedAt: schema.submittedPets.pendingSubmittedAt,
    });
  return updated ?? null;
}

async function queueAssetEditWithClaimGuard(
  id: string,
  ownerId: string,
  patch: PendingPatch,
  assetKeys: string[],
): Promise<QueuedEditRow | null> {
  const keyList = sql.join(
    assetKeys.map((key) => sql`${key}`),
    sql`, `,
  );
  const pendingTags =
    patch.pendingTags === null
      ? sql`NULL::jsonb`
      : sql`${JSON.stringify(patch.pendingTags)}::jsonb`;
  const lockStatement = sql`
    SELECT pg_advisory_xact_lock(${PENDING_ASSET_GC_LOCK_KEY})
  `;
  const updateStatement = sql`
    UPDATE submitted_pets AS pet
    SET pending_display_name = ${patch.pendingDisplayName},
        pending_description = ${patch.pendingDescription},
        pending_tags = ${pendingTags},
        pending_submitted_at = ${patch.pendingSubmittedAt},
        pending_rejection_reason = ${patch.pendingRejectionReason},
        pending_spritesheet_url = ${patch.pendingSpritesheetUrl},
        pending_pet_json_url = ${patch.pendingPetJsonUrl},
        pending_zip_url = ${patch.pendingZipUrl},
        pending_spritesheet_width = ${patch.pendingSpritesheetWidth},
        pending_spritesheet_height = ${patch.pendingSpritesheetHeight},
        pending_sprite_version_number = ${patch.pendingSpriteVersionNumber},
        pending_dhash = ${patch.pendingDhash},
        pending_review_id = ${patch.pendingReviewId}
    WHERE pet.id = ${id}
      AND pet.owner_id = ${ownerId}
      AND NOT EXISTS (
        SELECT 1
        FROM pending_asset_gc_claims AS claim
        WHERE claim.key IN (${keyList})
      )
    RETURNING
      pet.pending_display_name AS "pendingDisplayName",
      pet.pending_description AS "pendingDescription",
      pet.pending_tags AS "pendingTags",
      pet.pending_submitted_at AS "pendingSubmittedAt"
  `;

  const rowsFromResult = (result: unknown): QueuedEditRow[] => {
    if (Array.isArray(result)) return result as QueuedEditRow[];
    if (
      result &&
      typeof result === "object" &&
      Array.isArray((result as { rows?: unknown }).rows)
    ) {
      return (result as { rows: QueuedEditRow[] }).rows;
    }
    return [];
  };

  // Neon HTTP has no callback transaction API, but its batch endpoint runs
  // all statements in one database transaction. The lock is a separate
  // statement so the UPDATE gets a fresh snapshot after the lock waits.
  const batchDb = db as unknown as {
    batch?: (queries: readonly unknown[]) => Promise<readonly unknown[]>;
  };
  if (typeof batchDb.batch === "function") {
    const [, updateResult] = await batchDb.batch.call(db, [
      db.execute(lockStatement),
      db.execute(updateStatement),
    ]);
    return rowsFromResult(updateResult)[0] ?? null;
  }

  const updateResult = await db.transaction(async (tx) => {
    await tx.execute(lockStatement);
    return tx.execute(updateStatement);
  });
  return rowsFromResult(updateResult)[0] ?? null;
}

export async function applyPetEdit(input: {
  id: string;
  userId: string;
  body: PatchBody;
}): Promise<Response> {
  const { id, userId, body } = input;
  const row = await db.query.submittedPets.findFirst({
    where: and(
      eq(schema.submittedPets.id, id),
      eq(schema.submittedPets.ownerId, userId),
    ),
  });
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (row.status !== "approved") {
    return NextResponse.json(
      { error: "only_approved_editable" },
      { status: 400 },
    );
  }

  const lim = await editRatelimit.limit(`${userId}:${id}`);
  if (!lim.success) {
    return NextResponse.json(
      { error: "rate_limited", retryAfter: lim.reset },
      { status: 429 },
    );
  }

  const patch = buildPendingEditPatch(row);
  const flags: EditFlags = { assetTouched: false };
  const textError = applyTextFields(row, body, patch);
  if (textError) return textError;
  const assetError = applyAssetFields(row, body, patch, flags);
  if (assetError) return assetError;
  const contentError = validatePatchContent(patch);
  if (contentError) return contentError;
  if (pendingEditIsNoOp(row, patch)) {
    return NextResponse.json({ error: "nothing_changed" }, { status: 400 });
  }
  const sizeError = await assertPendingAssetsWithinLimit(row, patch);
  if (sizeError) return sizeError;

  patch.pendingSubmittedAt = new Date();
  patch.pendingRejectionReason = null;
  const autoAccepted = await tryAutoAccept(id, userId, row, patch, flags);
  return autoAccepted ?? queueEdit(id, userId, patch);
}
