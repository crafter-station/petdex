import { eq, getTableColumns, type SQLWrapper, sql } from "drizzle-orm";
import { Resend } from "resend";

import {
  AGGREGATE_KEYS,
  invalidateAggregates,
  invalidatePetCaches,
  LEADERBOARD_CACHE_KEYS,
} from "@/lib/db/cached-aggregates";
import type { SubmittedPet } from "@/lib/db/schema";
import * as schema from "@/lib/db/schema";
import { emailEnv, sendEmail } from "@/lib/email-send";
import { renderSubmissionApprovedEmail } from "@/lib/email-templates/submission-approved";
import { renderSubmissionRejectedEmail } from "@/lib/email-templates/submission-rejected";

export type SubmissionAdminAction = "approve" | "reject" | "edit" | "pending";

export type SubmissionActionInput = {
  action: SubmissionAdminAction;
  reason?: string | null;
  displayName?: string;
  description?: string;
  slug?: string;
};

export type SubmissionActionActor = "admin" | "auto-review";

export type SubmissionActionResult =
  | { ok: true; row: SubmittedPet }
  | {
      ok: false;
      status: number;
      body: { error: string; message?: string };
    };

type SubmissionActionDb = Awaited<typeof import("@/lib/db/client")>["db"];

export function submissionOwnerNotificationHref(input: {
  slug: string;
  status: SubmittedPet["status"];
}): string {
  if (input.status === "approved") return `/pets/${input.slug}`;
  return "/my-pets";
}

/**
 * Whether an admin action leaves the pet's public artifacts (preview,
 * thumb, stickers) stale, and whether the old slug's copies should go.
 *
 * Republishing used to key on a rename alone. Artifacts are derived from
 * the spritesheet, so approving new art under the same slug left the old
 * ones live until the 6-hourly backfill happened to notice, which is long
 * enough for a profile card and its detail page to show different sprites
 * (#590). Deletion still keys on the slug, because that is the only case
 * where the old keys are orphaned.
 */
export function planPublicArtifacts(input: {
  action: SubmissionAdminAction;
  wasApproved: boolean;
  isApproved: boolean;
  slugChanged: boolean;
  spritesheetChanged: boolean;
}): { republish: boolean; deleteOld: boolean } {
  return {
    republish:
      input.action === "edit" &&
      input.wasApproved &&
      input.isApproved &&
      (input.slugChanged || input.spritesheetChanged),
    deleteOld: input.wasApproved && (!input.isApproved || input.slugChanged),
  };
}

export async function applySubmissionAction(
  id: string,
  body: SubmissionActionInput,
  options: {
    actor?: SubmissionActionActor;
    db?: SubmissionActionDb;
    skipSideEffects?: boolean;
    skipNotifications?: boolean;
  } = {},
): Promise<SubmissionActionResult> {
  const actor = options.actor ?? "admin";
  const db = options.db ?? (await import("@/lib/db/client")).db;
  const now = new Date();
  const editPatch: Record<string, unknown> = {};

  if (typeof body.displayName === "string" && body.displayName.trim()) {
    editPatch.displayName = body.displayName.trim().slice(0, 60);
  }
  if (typeof body.description === "string" && body.description.trim()) {
    editPatch.description = body.description.trim().slice(0, 280);
  }
  if (typeof body.slug === "string" && body.slug.trim()) {
    const newSlug = normalizeSlug(body.slug);
    if (newSlug) {
      const existing = await db.query.submittedPets.findFirst({
        where: eq(schema.submittedPets.slug, newSlug),
      });
      if (existing && existing.id !== id) {
        return {
          ok: false,
          status: 409,
          body: {
            error: "slug_taken",
            message: `"${newSlug}" already exists.`,
          },
        };
      }
      editPatch.slug = newSlug;
    }
  }

  const statusPatch =
    body.action === "approve"
      ? {
          status: "approved" as const,
          approvedAt: now,
          rejectedAt: null,
          rejectionReason: null,
        }
      : body.action === "reject"
        ? {
            status: "rejected" as const,
            rejectedAt: now,
            approvedAt: null,
            rejectionReason: body.reason?.trim() || null,
          }
        : body.action === "pending"
          ? {
              status: "pending" as const,
              approvedAt: null,
              rejectedAt: null,
              rejectionReason: null,
            }
          : {};

  const update = { ...editPatch, ...statusPatch };
  if (Object.keys(update).length === 0) {
    return { ok: false, status: 400, body: { error: "nothing_to_update" } };
  }

  const current = await db.query.submittedPets.findFirst({
    columns: {
      slug: true,
      status: true,
      // Read to decide whether public artifacts are stale: a sprite swap
      // that keeps the same slug still invalidates preview, thumb and
      // stickers, and the slug comparison alone would miss it (#590).
      spritesheetUrl: true,
    },
    where: eq(schema.submittedPets.id, id),
  });
  if (!current) {
    return { ok: false, status: 404, body: { error: "not_found" } };
  }

  // A rename must move the main row and every slug-keyed reference in one
  // transaction. Issuing the pets UPDATE as its own statement first (as an
  // earlier revision did) committed the rename before the reference
  // migration ran: a failure past that point left the row renamed while
  // collections/likes/metrics/requests still pointed at the old slug, and a
  // collection holding both the old and the new slug tripped the
  // (collection_id, pet_slug) primary key mid-migration. The main-row
  // UPDATE is therefore the batch's first statement, followed by every
  // table keyed by pet_slug — collection items, covers, likes, metrics,
  // collection requests, fulfilled-request links, featured lists.
  // Separate statements in one batch, per the executeAtomicReturning
  // invariant; the cache revalidations below read the post-rename state.
  const slugChanged =
    Boolean(editPatch.slug) && current.slug !== editPatch.slug;
  const newSlug = slugChanged ? (editPatch.slug as string) : current.slug;
  // Column names must come from the schema's own mapping: the update keys
  // are the TS property names (approvedAt, rejectionReason...), while the
  // database columns are snake_case — sql.identifier("approvedAt") renders
  // a quoted case-sensitive identifier the table does not have.
  const petColumns = getTableColumns(schema.submittedPets);
  const renameStatements: [SQLWrapper, ...SQLWrapper[]] = [
    sql`UPDATE "submitted_pets" SET ${sql.join(
      Object.entries(update).map(
        ([col, value]) =>
          sql`${sql.identifier(petColumns[col as keyof typeof petColumns].name)} = ${value}`,
      ),
      sql`, `,
    )} WHERE "id" = ${id} RETURNING *`,
  ];
  if (slugChanged) {
    const oldSlug = current.slug;
    renameStatements.push(
      sql`UPDATE "pet_collection_items" SET "pet_slug" = ${newSlug} WHERE "pet_slug" = ${oldSlug}`,
      sql`UPDATE "pet_collections" SET "cover_pet_slug" = ${newSlug} WHERE "cover_pet_slug" = ${oldSlug}`,
      sql`UPDATE "pet_likes" SET "pet_slug" = ${newSlug} WHERE "pet_slug" = ${oldSlug}`,
      sql`UPDATE "pet_metrics" SET "pet_slug" = ${newSlug} WHERE "pet_slug" = ${oldSlug}`,
      sql`UPDATE "pet_collection_requests" SET "pet_slug" = ${newSlug} WHERE "pet_slug" = ${oldSlug}`,
      sql`UPDATE "pet_requests" SET "fulfilled_pet_slug" = ${newSlug} WHERE "fulfilled_pet_slug" = ${oldSlug}`,
      sql`UPDATE "user_profiles" SET "featured_pet_slugs" = (
        SELECT COALESCE(jsonb_agg(
          CASE WHEN elem = to_jsonb(${oldSlug}::text) THEN to_jsonb(${newSlug}::text) ELSE elem END
        ), '[]'::jsonb)
        FROM jsonb_array_elements("featured_pet_slugs") AS elem
      ) WHERE "featured_pet_slugs" @> to_jsonb(${oldSlug}::text)`,
    );
  }
  const { executeAtomicReturning } = await import("@/lib/db/client");
  await executeAtomicReturning(renameStatements);
  // Re-read the row after the batch: RETURNING * yields snake_case keys the
  // downstream code (and runPostApprovalEffects) cannot consume, and the
  // batch's rows go unread — existence is decided by this fresh read. It is
  // safe here: the batch has committed, so this snapshot sees the
  // post-rename state.
  const updated = await db.query.submittedPets.findFirst({
    where: eq(schema.submittedPets.id, id),
  });
  if (!updated) {
    return { ok: false, status: 404, body: { error: "not_found" } };
  }
  if (slugChanged) {
    const oldSlug = current.slug;
    const { revalidateCollectionTags } = await import(
      "@/lib/db/cached-aggregates"
    );
    const covered = await db
      .select({ slug: schema.petCollections.slug })
      .from(schema.petCollections)
      .where(eq(schema.petCollections.coverPetSlug, newSlug));
    await revalidateCollectionTags(...covered.map((c) => c.slug));
    await invalidatePetCaches(oldSlug, newSlug);
  }

  let row = updated;
  if (body.action === "approve" && !options.skipSideEffects) {
    row = await runPostApprovalEffects(row, actor, db);
  }
  const artifactPlan = planPublicArtifacts({
    action: body.action,
    wasApproved: current.status === "approved",
    isApproved: row.status === "approved",
    slugChanged: current.slug !== row.slug,
    spritesheetChanged: current.spritesheetUrl !== row.spritesheetUrl,
  });
  if (artifactPlan.republish && !options.skipSideEffects) {
    await publishApprovedPublicArtifacts(row, actor);
  }
  if (artifactPlan.deleteOld && !options.skipSideEffects) {
    await deletePetPublicArtifacts(current.slug, actor);
  }

  const skipNotifications =
    options.skipNotifications ?? options.skipSideEffects ?? false;
  if (
    !skipNotifications &&
    (body.action === "approve" || body.action === "reject")
  ) {
    await notifySubmissionOwner(row);
  }

  // Any status flip changes the set of approved pets, so the cached
  // facets / counts / metrics summary become stale.
  if (
    body.action === "approve" ||
    body.action === "reject" ||
    body.action === "pending"
  ) {
    await invalidateAggregates(
      AGGREGATE_KEYS.facets,
      AGGREGATE_KEYS.approvedCount,
      AGGREGATE_KEYS.metricsSummary,
      AGGREGATE_KEYS.batches,
      AGGREGATE_KEYS.variantIndex,
      // The rank badge on /u/[handle] and the five variants on /leaderboard
      // rank by approved count and metrics, so a status flip makes all of them
      // stale. Missing here meant an approved pet did not appear on the
      // leaderboard (or move its owner's badge) for up to the 5-minute TTL.
      ...LEADERBOARD_CACHE_KEYS,
    );
    await invalidatePetCaches(current.slug, row.slug);
  } else if (current.status === "approved" && body.action === "edit") {
    const aggregateKeys: string[] = [AGGREGATE_KEYS.variantIndex];
    if (current.slug !== row.slug) {
      aggregateKeys.push(AGGREGATE_KEYS.metricsSummary);
    }
    await invalidateAggregates(...aggregateKeys);
    await invalidatePetCaches(current.slug, row.slug);
  }

  return { ok: true, row };
}

async function runPostApprovalEffects(
  row: SubmittedPet,
  actor: SubmissionActionActor,
  db: SubmissionActionDb,
): Promise<SubmittedPet> {
  const needsTagging =
    ((row.tags as string[]) ?? []).length === 0 ||
    ((row.vibes as string[]) ?? []).length === 0;
  if (needsTagging) {
    const { classifyPet } = await import("@/lib/auto-tag");
    const cls = await classifyPet(row.displayName, row.description);
    if (cls) {
      const [tagged] = await db
        .update(schema.submittedPets)
        .set({ kind: cls.kind, vibes: cls.vibes, tags: cls.tags })
        .where(eq(schema.submittedPets.id, row.id))
        .returning();
      if (tagged) row = tagged;
    }
  }

  await publishApprovedPublicArtifacts(row, actor);

  const { refreshSimilarityFor } = await import("@/lib/similarity");
  void refreshSimilarityFor(row.id).catch((err) => {
    console.warn(`[${actor}] similarity refresh failed:`, err);
  });

  if (!row.dominantColor) {
    void (async () => {
      try {
        const { classifyColorFamily, extractDominantColor } = await import(
          "@/lib/color-extract"
        );
        const dominantColor = await extractDominantColor(row.spritesheetUrl);
        if (!dominantColor) return;
        await db
          .update(schema.submittedPets)
          .set({
            dominantColor,
            colorFamily: classifyColorFamily(dominantColor),
          })
          .where(eq(schema.submittedPets.id, row.id));
        await invalidateAggregates(AGGREGATE_KEYS.facets);
        await invalidatePetCaches(row.slug);
      } catch (e) {
        console.error("color extract failed", e);
      }
    })();
  }

  // Suggest matching open requests as candidates for admin review.
  // Background only — never blocks the approve response. Failures
  // are logged and swallowed; the admin can still create candidates
  // manually from /admin/requests if the auto-pass missed something.
  void (async () => {
    try {
      const { autoSuggestCandidates } = await import(
        "@/lib/request-candidates"
      );
      const result = await autoSuggestCandidates(row.id);
      if (result.inserted > 0) {
        console.log(
          `[${actor}] suggested ${result.inserted} request candidate(s) for ${row.slug}`,
        );
      }
    } catch (e) {
      console.error("request candidate suggest failed", e);
    }
  })();

  return row;
}

async function publishApprovedPublicArtifacts(
  row: SubmittedPet,
  actor: SubmissionActionActor,
): Promise<void> {
  try {
    const { publishPetPublicArtifacts } = await import(
      "@/lib/pet-public-artifacts"
    );
    const artifacts = await publishPetPublicArtifacts({
      slug: row.slug,
      spritesheetUrl: row.spritesheetUrl,
    });
    if (!artifacts.ok) {
      console.error(`[${actor}] public artifact publish failed`, {
        slug: row.slug,
        failed: artifacts.failed,
      });
    } else {
      console.log(`[${actor}] public artifacts published`, {
        slug: row.slug,
        published: artifacts.published,
        skipped: artifacts.skipped,
      });
    }
  } catch (e) {
    console.error(`[${actor}] public artifact publish failed`, e);
  }
}

async function deletePetPublicArtifacts(
  slug: string,
  actor: SubmissionActionActor,
): Promise<void> {
  try {
    const [{ petPublicArtifactKeys }, { deleteR2Objects }] = await Promise.all([
      import("@/lib/pet-public-artifact-keys"),
      import("@/lib/r2"),
    ]);
    await deleteR2Objects(petPublicArtifactKeys(slug));
  } catch (e) {
    console.error(`[${actor}] public artifact cleanup failed`, { slug, e });
  }
}

async function notifySubmissionOwner(row: SubmittedPet): Promise<void> {
  const { createNotification } = await import("@/lib/notifications");
  void createNotification({
    userId: row.ownerId,
    kind: row.status === "approved" ? "pet_approved" : "pet_rejected",
    payload: {
      petSlug: row.slug,
      petName: row.displayName,
      ...(row.rejectionReason ? { reason: row.rejectionReason } : {}),
    },
    href: submissionOwnerNotificationHref({
      slug: row.slug,
      status: row.status,
    }),
  }).catch((err) =>
    console.warn("[notify] submission decision notification failed:", err),
  );

  if (!row.ownerEmail || !process.env.RESEND_API_KEY) return;

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from = emailEnv("RESEND_FROM", "Petdex <petdex@updates.railly.dev>");
    const { getPreferredLocaleForUser } = await import("@/lib/user-locale");
    const locale = await getPreferredLocaleForUser(row.ownerId);

    if (row.status === "approved") {
      const email = renderSubmissionApprovedEmail(locale, {
        petName: row.displayName,
        petSlug: row.slug,
      });
      await sendEmail(
        resend,
        {
          from,
          to: row.ownerEmail,
          subject: email.subject,
          html: email.html,
          text: email.text,
        },
        `submission ${row.status} notice`,
      );
    } else if (row.status === "rejected") {
      const email = renderSubmissionRejectedEmail(locale, {
        petName: row.displayName,
        reason: row.rejectionReason,
      });
      await sendEmail(
        resend,
        {
          from,
          to: row.ownerEmail,
          subject: email.subject,
          html: email.html,
          text: email.text,
        },
        "submission rejected notice",
      );
    }
  } catch (error) {
    console.error(
      "[submission-decision] owner notification failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function normalizeSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
