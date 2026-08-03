import "server-only";

import { NextResponse } from "next/server";

import { and, eq, gte, sql } from "drizzle-orm";

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
import { editRatelimit } from "@/lib/ratelimit";
import { refreshSimilarityFor } from "@/lib/similarity";
import { isAllowedAssetUrl } from "@/lib/url-allowlist";
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

type PendingPatch = {
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

function emptyPendingPatch(): PendingPatch {
  return {
    pendingDisplayName: null,
    pendingDescription: null,
    pendingTags: null,
    pendingSubmittedAt: new Date(),
    pendingRejectionReason: null,
    pendingSpritesheetUrl: null,
    pendingPetJsonUrl: null,
    pendingZipUrl: null,
    pendingSpritesheetWidth: null,
    pendingSpritesheetHeight: null,
  };
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
    if (value !== row.displayName) patch.pendingDisplayName = value;
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
    if (value !== row.description) patch.pendingDescription = value;
  }

  if (body.tags !== undefined) {
    const tags = normalizeTags(body.tags);
    if (tags === null) {
      return NextResponse.json({ error: "invalid_tags" }, { status: 400 });
    }
    const currentTags = row.tags ?? [];
    if (!sameArray(tags, currentTags)) patch.pendingTags = tags;
  }

  return null;
}

function applyAssetFields(
  row: SubmittedPet,
  body: PatchBody,
  patch: PendingPatch,
): Response | null {
  if (typeof body.spritesheetUrl === "string") {
    if (!isAllowedAssetUrl(body.spritesheetUrl)) {
      return NextResponse.json(
        { error: "invalid_asset_url", field: "spritesheetUrl" },
        { status: 400 },
      );
    }
    if (body.spritesheetUrl !== row.spritesheetUrl) {
      patch.pendingSpritesheetUrl = body.spritesheetUrl;
      patch.pendingSpritesheetWidth =
        typeof body.spritesheetWidth === "number"
          ? body.spritesheetWidth
          : null;
      patch.pendingSpritesheetHeight =
        typeof body.spritesheetHeight === "number"
          ? body.spritesheetHeight
          : null;
    }
  }

  if (typeof body.petJsonUrl === "string") {
    if (!isAllowedAssetUrl(body.petJsonUrl)) {
      return NextResponse.json(
        { error: "invalid_asset_url", field: "petJsonUrl" },
        { status: 400 },
      );
    }
    if (body.petJsonUrl !== row.petJsonUrl) {
      patch.pendingPetJsonUrl = body.petJsonUrl;
    }
  }

  if (typeof body.zipUrl === "string") {
    if (!isAllowedAssetUrl(body.zipUrl)) {
      return NextResponse.json(
        { error: "invalid_asset_url", field: "zipUrl" },
        { status: 400 },
      );
    }
    if (body.zipUrl !== row.zipUrl) patch.pendingZipUrl = body.zipUrl;
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

function isNoOp(patch: PendingPatch): boolean {
  return (
    patch.pendingDisplayName === null &&
    patch.pendingDescription === null &&
    patch.pendingTags === null &&
    patch.pendingSpritesheetUrl === null &&
    patch.pendingPetJsonUrl === null &&
    patch.pendingZipUrl === null
  );
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
): Promise<Response | null> {
  if (hasAssetEdit(patch)) return null;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentRows = await db
    .select({ editCount: sql<number>`count(*)` })
    .from(schema.submittedPets)
    .where(
      and(
        eq(schema.submittedPets.id, id),
        gte(schema.submittedPets.lastEditAt, since),
      ),
    );
  const editCountLast24h = Number(recentRows[0]?.editCount ?? 0);

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

async function queueEdit(id: string, patch: PendingPatch): Promise<Response> {
  const [updated] = await db
    .update(schema.submittedPets)
    .set(patch)
    .where(eq(schema.submittedPets.id, id))
    .returning();

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

  const patch = emptyPendingPatch();
  const textError = applyTextFields(row, body, patch);
  if (textError) return textError;
  const assetError = applyAssetFields(row, body, patch);
  if (assetError) return assetError;
  const contentError = validatePatchContent(patch);
  if (contentError) return contentError;
  if (isNoOp(patch)) {
    return NextResponse.json({ error: "nothing_changed" }, { status: 400 });
  }

  const autoAccepted = await tryAutoAccept(id, row, patch);
  return autoAccepted ?? queueEdit(id, patch);
}
