import { eq } from "drizzle-orm";
import { Resend } from "resend";

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
    !options.skipSideEffects &&
    (body.action === "approve" || body.action === "reject")
  ) {
    await notifySubmissionOwner(row);
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
      } catch (e) {
        console.error("color extract failed", e);
      }
    })();
  }

  if (process.env.ELEVENLABS_API_KEY) {
    void (async () => {
      try {
        const { getApprovedPetMissingSoundBySlug, processPetSound } =
          await import("@/lib/pet-sound");
        const pet = await getApprovedPetMissingSoundBySlug(row.slug);
        if (!pet) return;
        await processPetSound(pet, { workerKey: `${actor}-${row.slug}` });
      } catch (e) {
        console.error("sound gen failed", e);
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
