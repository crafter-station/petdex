// Shared core for all submission paths (web /api/submit, CLI /api/cli/submit).
//
// Inputs that determine identity (userId, ownerEmail, creditName/Url/Image)
// MUST come from a verified caller (Clerk session for web, OAuth bearer for
// CLI) — never from request body — so this module accepts them as `principal`.

import "server-only";

import { eq } from "drizzle-orm";
import { Resend } from "resend";

import { db, schema } from "@/lib/db/client";
import { renderNewSubmissionEmail } from "@/lib/email-templates/new-submission";
import {
  type SubmissionInput,
  type SubmissionResult,
  slugify,
} from "@/lib/submissions-validation";
import { getPreferredLocaleForUser } from "@/lib/user-locale";

export {
  MIN_SPRITE_DIM,
  REQUIRED_FIELDS,
  type SubmissionInput,
  type SubmissionResult,
  slugify,
  validateSubmission,
} from "@/lib/submissions-validation";

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

/** Persist a submission. Caller is responsible for authn/ratelimit.
 *  Slug collisions get suffixed (boba -> boba-2) by resolveUniqueSlug.
 *  Re-claiming pets from a deleted account uses an opt-in flow at
 *  /my-pets, not silent transfer at submit time. */
export async function persistSubmission(
  body: SubmissionInput,
  principal: SubmissionPrincipal,
): Promise<SubmissionResult> {
  const requestedSlug = slugify(body.petId || body.displayName);
  if (!requestedSlug) {
    return { ok: false, status: 400, error: "invalid_slug" };
  }

  const slug = await resolveUniqueSlug(requestedSlug);

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

  return { ok: true, id, slug };
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
