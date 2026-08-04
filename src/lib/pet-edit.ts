import "server-only";

import { NextResponse } from "next/server";

import { and, eq, sql } from "drizzle-orm";

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
import { containsUrl, URL_BLOCKED_REASON } from "@/lib/url-blocklist";

export type PatchBody = {
  displayName?: string;
  description?: string;
  tags?: string[];
  spritesheetUrl?: string;
  spritesheetWidth?: number;
  spritesheetHeight?: number;
  petJsonUrl?: string;
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
      if (typeof body.spritesheetWidth === "number") {
        patch.pendingSpritesheetWidth = body.spritesheetWidth;
      } else if (previousUrl !== patch.pendingSpritesheetUrl) {
        patch.pendingSpritesheetWidth = null;
      }
      if (typeof body.spritesheetHeight === "number") {
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
    const error = setAsset(
      "petjson",
      body.petJsonUrl,
      row.petJsonUrl,
      "petJsonUrl",
      "pendingPetJsonUrl",
    );
    if (error) return error;
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
    patch.pendingZipUrl !== null
  );
}

async function persistAutoAcceptedEdit(
  id: string,
  row: SubmittedPet,
  patch: PendingPatch,
): Promise<void> {
  const liveUpdate: Record<string, unknown> = {
    pendingDisplayName: null,
    pendingDescription: null,
    pendingTags: null,
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

  await db
    .update(schema.submittedPets)
    .set(liveUpdate)
    .where(eq(schema.submittedPets.id, id));

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
  }).catch(() => {});
}

async function tryAutoAccept(
  id: string,
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

  await persistAutoAcceptedEdit(id, row, patch);
  return NextResponse.json({ status: "auto_approved" });
}

type QueuedEditRow = Pick<
  SubmittedPet,
  | "pendingDisplayName"
  | "pendingDescription"
  | "pendingTags"
  | "pendingSubmittedAt"
>;

async function queueEdit(id: string, patch: PendingPatch): Promise<Response> {
  const assetKeys = pendingAssetKeysFromUrls([
    patch.pendingSpritesheetUrl,
    patch.pendingPetJsonUrl,
    patch.pendingZipUrl,
  ]);
  const hasAssetKeys = assetKeys.length > 0;
  const updated = hasAssetKeys
    ? await queueAssetEditWithClaimGuard(id, patch, assetKeys)
    : await queueTextEdit(id, patch);

  if (!updated) {
    if (!hasAssetKeys) {
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
  patch: PendingPatch,
): Promise<QueuedEditRow | null> {
  const [updated] = await db
    .update(schema.submittedPets)
    .set(patch)
    .where(eq(schema.submittedPets.id, id))
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
  const result = (await db.execute(sql`
    WITH lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(${PENDING_ASSET_GC_LOCK_KEY}) AS acquired
    )
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
        pending_dhash = ${patch.pendingDhash},
        pending_review_id = ${patch.pendingReviewId}
    FROM lock
    WHERE pet.id = ${id}
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
  `)) as unknown as { rows?: QueuedEditRow[] };
  return result.rows?.[0] ?? null;
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

  patch.pendingSubmittedAt = new Date();
  patch.pendingRejectionReason = null;
  const autoAccepted = await tryAutoAccept(id, row, patch, flags);
  return autoAccepted ?? queueEdit(id, patch);
}
