// Shared core for all submission paths (web /api/submit, CLI /api/cli/submit).
//
// Inputs that determine identity (userId, ownerEmail, creditName/Url/Image)
// MUST come from a verified caller (Clerk session for web, OAuth bearer for
// CLI) — never from request body — so this module accepts them as `principal`.

import "server-only";

import { eq } from "drizzle-orm";
import { Resend } from "resend";

import { db, schema } from "@/lib/db/client";
import type { SubmissionReview, SubmittedPet } from "@/lib/db/schema";
import { renderNewSubmissionEmail } from "@/lib/email-templates/new-submission";
import { fallbackHandle, handleForUser } from "@/lib/handles";
import {
  deriveSlug,
  type SubmissionInput,
  slugify as slugifySubmission,
} from "@/lib/submissions-validation";
import { getPreferredLocaleForUser } from "@/lib/user-locale";

export type { SubmissionInput } from "@/lib/submissions-validation";
export {
  deriveSlug,
  MIN_SPRITE_DIM,
  REQUIRED_FIELDS,
  validateSubmission,
} from "@/lib/submissions-validation";

const SUBMISSION_REVIEW_TIMEOUT_MS = 30_000;

export const slugify = slugifySubmission;

export type SubmissionPrincipal = {
  userId: string;
  email: string | null;
  username: string | null;
  imageUrl: string | null;
  firstName: string | null;
  lastName: string | null;
  /** Pre-computed external profile URL (X or GitHub) when available. */
  url?: string | null;
};

export type SubmissionReviewOutcome = {
  decision: "approved" | "rejected" | "hold";
  applied: boolean;
  reasonCode: string | null;
  summary: string | null;
};

export type SubmissionResult =
  | {
      ok: true;
      id: string;
      slug: string;
      status: SubmittedPet["status"];
      profileHandle: string;
      profileUrl: string;
      review: SubmissionReviewOutcome;
    }
  | {
      ok: false;
      status: number;
      error: string;
      message?: string;
      field?: string;
      got?: unknown;
    };

/** Persist a submission. Caller is responsible for authn/ratelimit.
 *  Slug collisions get suffixed (boba -> boba-2) by resolveUniqueSlug.
 *  Re-claiming pets from a deleted account uses an opt-in flow at
 *  /my-pets, not silent transfer at submit time. */
export async function persistSubmission(
  body: SubmissionInput,
  principal: SubmissionPrincipal,
): Promise<SubmissionResult> {
  const requestedSlug = deriveSlug(body.petId, body.displayName);
  if (!requestedSlug) {
    return { ok: false, status: 400, error: "invalid_slug" };
  }

  const slug = await resolveUniqueSlug(requestedSlug);
  const profileHandlePromise = handleForUser(principal.userId).catch(() =>
    fallbackHandle(principal.userId),
  );

  const id = `pet_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
  const credit = creditFromPrincipal(principal);

  await db.insert(schema.submittedPets).values({
    id,
    slug,
    displayName: body.displayName.trim().slice(0, 60),
    description: body.description.trim().slice(0, 280),
    spritesheetUrl: body.spritesheetUrl,
    petJsonUrl: body.petJsonUrl,
    zipUrl: body.zipUrl,
    kind: "creature",
    vibes: [],
    tags: [],
    status: "pending",
    ownerId: principal.userId,
    ownerEmail: principal.email,
    creditName: credit.name,
    creditUrl: credit.url,
    creditImage: credit.imageUrl,
  });

  // Fire-and-forget admin notification.
  const resendKey = process.env.RESEND_API_KEY;
  const ownerNotify = process.env.PETDEX_OWNER_EMAIL;
  if (resendKey && ownerNotify) {
    // SMTP header injection defense — strip control chars from anything
    // that could end up in a header. The Resend SDK probably escapes, but
    // we don't trust user-controlled fields anywhere near a header.
    const safeName = body.displayName.replace(/[\r\n\t]+/g, " ").slice(0, 80);
    void (async () => {
      try {
        const resend = new Resend(resendKey);
        const locale = await getPreferredLocaleForUser(null);
        const email = renderNewSubmissionEmail(locale, {
          displayName: body.displayName,
          slug,
          from: principal.email ?? principal.userId,
          description: body.description,
          spritesheetUrl: body.spritesheetUrl,
          zipUrl: body.zipUrl,
        });
        await resend.emails.send({
          from: "Petdex <petdex@notifications.crafter.run>",
          to: ownerNotify,
          subject: email.subject.replace(body.displayName, safeName),
          html: email.html,
          text: email.text,
        });
      } catch {
        /* silent */
      }
    })();
  }

  const review = await reviewNewSubmission(id);
  const current = await db.query.submittedPets.findFirst({
    where: eq(schema.submittedPets.id, id),
  });
  const status = current?.status ?? "pending";
  const profileHandle = await profileHandlePromise;

  return {
    ok: true,
    id,
    slug,
    status,
    profileHandle,
    profileUrl: `/u/${encodeURIComponent(profileHandle)}`,
    review: alignReviewWithStatus(review, status),
  };
}

export function creditFromPrincipal(p: SubmissionPrincipal): {
  name: string | null;
  url: string | null;
  imageUrl: string | null;
} {
  const username = p.username?.trim() || null;
  const first = p.firstName?.trim() || null;
  const last = p.lastName?.trim() || null;
  const emailPrefix = p.email?.includes("@") ? p.email.split("@")[0] : null;
  const name =
    username ??
    (first ? `${first}${last ? ` ${last[0]}.` : ""}` : null) ??
    emailPrefix ??
    "anonymous";

  return {
    name,
    url: p.url ?? null,
    imageUrl: p.imageUrl ?? null,
  };
}

export async function resolveUniqueSlug(base: string): Promise<string> {
  const isTaken = async (candidate: string): Promise<boolean> => {
    const row = await db.query.submittedPets.findFirst({
      where: eq(schema.submittedPets.slug, candidate),
    });
    return Boolean(row);
  };

  if (!(await isTaken(base))) return base;

  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}-${i}`.slice(0, 40);
    if (!(await isTaken(candidate))) return candidate;
  }
  return `${base.slice(0, 32)}-${crypto.randomUUID().slice(0, 6)}`;
}

async function reviewNewSubmission(
  id: string,
): Promise<SubmissionReviewOutcome> {
  const reviewModule = await import("@/lib/submission-review");

  const reviewPromise = reviewModule.reviewSubmission(id).catch((error) => {
    console.warn(
      "[submission] automated review failed:",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  });

  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), SUBMISSION_REVIEW_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([reviewPromise, timeout]);
    if (result === "timeout") {
      void reviewPromise.catch(() => {});
      const hold = await reviewModule.recordSubmissionReviewHold(id, {
        reasonCode: "review_timeout",
        summary: "Automated review timed out and needs manual review.",
        error: `Timed out after ${SUBMISSION_REVIEW_TIMEOUT_MS}ms`,
      });
      return normalizeReviewOutcome(hold.review, hold.applied);
    }
    return normalizeReviewOutcome(result.review, result.applied);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hold = await reviewModule.recordSubmissionReviewHold(id, {
      reasonCode: "review_error",
      summary: "Automated review failed and needs manual review.",
      error: message,
    });
    return normalizeReviewOutcome(hold.review, hold.applied);
  }
}

function normalizeReviewOutcome(
  review: SubmissionReview,
  applied: boolean,
): SubmissionReviewOutcome {
  const decision =
    review.decision === "auto_approve" && applied
      ? "approved"
      : review.decision === "auto_reject" && applied
        ? "rejected"
        : "hold";
  return {
    decision,
    applied,
    reasonCode: review.reasonCode,
    summary: review.summary,
  };
}

function alignReviewWithStatus(
  review: SubmissionReviewOutcome,
  status: SubmittedPet["status"],
): SubmissionReviewOutcome {
  if (status === "approved") {
    return { ...review, decision: "approved", applied: true };
  }
  if (status === "rejected") {
    return { ...review, decision: "rejected", applied: true };
  }
  return review;
}
