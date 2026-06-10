import { eq } from "drizzle-orm";
import { Resend } from "resend";

import {
  AGGREGATE_KEYS,
  invalidateAggregates,
  invalidatePetCaches,
} from "@/lib/db/cached-aggregates";
import type { SubmittedPet } from "@/lib/db/schema";
import * as schema from "@/lib/db/schema";
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
    },
    where: eq(schema.submittedPets.id, id),
  });
  if (!current) {
    return { ok: false, status: 404, body: { error: "not_found" } };
  }

  const [updated] = await db
    .update(schema.submittedPets)
    .set(update)
    .where(eq(schema.submittedPets.id, id))
    .returning();

  if (!updated) {
    return { ok: false, status: 404, body: { error: "not_found" } };
  }

  let row = updated;
  if (body.action === "approve" && !options.skipSideEffects) {
    row = await runPostApprovalEffects(row, actor, db);
  }
  if (
    body.action === "edit" &&
    current.status === "approved" &&
    row.status === "approved" &&
    current.slug !== row.slug &&
    !options.skipSideEffects
  ) {
    await publishApprovedPublicArtifacts(row, actor);
  }
  if (
    current.status === "approved" &&
    (row.status !== "approved" || current.slug !== row.slug) &&
    !options.skipSideEffects
  ) {
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
    href: row.status === "approved" ? `/pets/${row.slug}` : "/my-pets",
  }).catch(() => {});

  if (!row.ownerEmail || !process.env.RESEND_API_KEY) return;

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from =
      process.env.RESEND_FROM ?? "Petdex <petdex@updates.railly.dev>";
    const { getPreferredLocaleForUser } = await import("@/lib/user-locale");
    const locale = await getPreferredLocaleForUser(row.ownerId);

    if (row.status === "approved") {
      const email = renderSubmissionApprovedEmail(locale, {
        petName: row.displayName,
        petSlug: row.slug,
      });
      await resend.emails.send({
        from,
        to: row.ownerEmail,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
    } else if (row.status === "rejected") {
      const email = renderSubmissionRejectedEmail(locale, {
        petName: row.displayName,
        reason: row.rejectionReason,
      });
      await resend.emails.send({
        from,
        to: row.ownerEmail,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
    }
  } catch {
    /* silent */
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
