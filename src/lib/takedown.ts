import "server-only";

import { eq, sql } from "drizzle-orm";
import { Resend } from "resend";

import {
  AGGREGATE_KEYS,
  invalidateAggregates,
  invalidateCollectionBacklinks,
  invalidatePetCaches,
} from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";
import { renderSubmissionTakedownEmail } from "@/lib/email-templates/submission-takedown";
import { createNotification } from "@/lib/notifications";
import { deleteR2Objects, keyFromR2Url } from "@/lib/r2";
import { getPreferredLocaleForUser } from "@/lib/user-locale";

// Hard takedown of a pet. Removes the row, every cross-table reference
// keyed by slug (likes, metrics, collection items, collection requests,
// profile pins, fulfilled requests), nulls collection covers, drops
// the R2 assets, and notifies the owner. The slug is freed.
//
// Caller is responsible for authz — this helper trusts whoever invoked
// it. Used by:
//   - DELETE /api/admin/[id]   — admin takedown via UI
//   - DELETE /api/pets/[slug]/owner — owner self-service via card menu
//   - scripts/takedown-pet.ts  — one-shot CLI for ops
type TakedownPetRow = typeof schema.submittedPets.$inferSelect;

export type TakedownContext = {
  pet: TakedownPetRow;
  /** Free-form reason captured from the actor; surfaced in email + log. */
  reason?: string | null;
  /**
   * Who triggered the takedown. Goes to the structured log so the audit
   * trail is searchable. 'admin' for /api/admin/[id], 'owner' for the
   * self-service path, 'script' for ops CLIs.
   */
  source: "admin" | "owner" | "script";
  /** Clerk user id of the actor. Logged. */
  actorId: string;
  /**
   * When true, do not push the in-app notification + email. Owners
   * doing a self-delete know what they did; no need to ping them.
   */
  silent?: boolean;
};

export type TakedownResult = {
  ok: true;
  slug: string;
  removedR2Keys: string[];
};

export async function takedownPet(
  ctx: TakedownContext,
): Promise<TakedownResult> {
  const { pet, reason, source, actorId, silent } = ctx;
  const slug = pet.slug;

  // 1. Cross-table cleanup keyed by slug. None of these have FKs to
  //    submitted_pets so they have to go by hand.
  await db.delete(schema.petLikes).where(eq(schema.petLikes.petSlug, slug));
  await db.delete(schema.petMetrics).where(eq(schema.petMetrics.petSlug, slug));
  await db
    .delete(schema.petCollectionItems)
    .where(eq(schema.petCollectionItems.petSlug, slug));
  await db
    .delete(schema.petCollectionRequests)
    .where(eq(schema.petCollectionRequests.petSlug, slug));

  // 2. Null out collections that used this pet as their cover.
  await db
    .update(schema.petCollections)
    .set({ coverPetSlug: null })
    .where(eq(schema.petCollections.coverPetSlug, slug));

  // 3. Reopen any pet request this submission fulfilled so it goes back
  //    to the queue instead of pointing at a dead slug.
  await db
    .update(schema.petRequests)
    .set({ fulfilledPetSlug: null, status: "open" })
    .where(eq(schema.petRequests.fulfilledPetSlug, slug));

  // 4. Strip the slug from any user_profile featured arrays. We only
  //    touch profiles that actually contain the slug so the jsonb
  //    rewrite stays scoped.
  await db.execute(sql`
    UPDATE user_profiles
    SET featured_pet_slugs = (
      SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
      FROM jsonb_array_elements(featured_pet_slugs) AS elem
      WHERE elem <> to_jsonb(${slug}::text)
    )
    WHERE featured_pet_slugs @> to_jsonb(${slug}::text)
  `);

  // 5. Drop the row itself.
  await db
    .delete(schema.submittedPets)
    .where(eq(schema.submittedPets.id, pet.id));

  // 5b. If this was an approved pet, the cached aggregates (facets,
  //     counts, metrics summary, batches) all just moved.
  if (pet.status === "approved") {
    await invalidateAggregates(
      AGGREGATE_KEYS.facets,
      AGGREGATE_KEYS.approvedCount,
      AGGREGATE_KEYS.metricsSummary,
      AGGREGATE_KEYS.batches,
      AGGREGATE_KEYS.variantIndex,
    );
    await invalidatePetCaches(pet.slug);
    await invalidateCollectionBacklinks(pet.slug);
  }

  // 6. Best-effort R2 cleanup. We derive keys from the URLs the
  //    submission stored; anything off-host (legacy or external credit
  //    image) is skipped. R2 errors are logged but don't fail the
  //    takedown — the DB is already gone.
  const keys = [
    keyFromR2Url(pet.spritesheetUrl),
    keyFromR2Url(pet.petJsonUrl),
    keyFromR2Url(pet.zipUrl),
    keyFromR2Url(pet.soundUrl),
  ].filter((k): k is string => Boolean(k));
  try {
    await deleteR2Objects(keys);
  } catch (err) {
    console.warn("[takedown] r2 cleanup failed", { id: pet.id, slug, err });
  }

  // 7. Notify owner unless silenced. Owner self-deletes are silenced
  //    (they're the actor — they know).
  if (!silent) {
    void createNotification({
      userId: pet.ownerId,
      kind: "pet_rejected",
      payload: {
        petSlug: slug,
        petName: pet.displayName,
        ...(reason ? { reason } : {}),
        takedown: true,
      },
      href: "/",
    }).catch(() => {});

    if (pet.ownerEmail && process.env.RESEND_API_KEY) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const from =
          process.env.RESEND_FROM ?? "Petdex <petdex@updates.railly.dev>";
        const locale = await getPreferredLocaleForUser(pet.ownerId);
        const email = renderSubmissionTakedownEmail(locale, {
          petName: pet.displayName,
          reason: reason ?? null,
        });
        await resend.emails.send({
          from,
          to: pet.ownerEmail,
          subject: email.subject,
          html: email.html,
          text: email.text,
        });
      } catch {
        /* silent */
      }
    }
  }

  console.info("[takedown] pet removed", {
    id: pet.id,
    slug,
    source,
    by: actorId,
    reason,
    keys,
  });

  return { ok: true, slug, removedR2Keys: keys };
}
