import "server-only";

import { sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Resend } from "resend";

import { collectionLocksForPetSlugQuery } from "@/lib/collection-access";
import {
  AGGREGATE_KEYS,
  invalidateAggregates,
  invalidateCollectionBacklinks,
  invalidateMetricCaches,
  invalidatePetCaches,
  revalidateCollectionTags,
} from "@/lib/db/cached-aggregates";
import { db, type schema } from "@/lib/db/client";
import { renderSubmissionTakedownEmail } from "@/lib/email-templates/submission-takedown";
import { createNotification } from "@/lib/notifications";
import { petPublicArtifactKeys } from "@/lib/pet-public-artifact-keys";
import { deleteR2Objects, keyFromR2Url } from "@/lib/r2";
import { getPreferredLocaleForUser } from "@/lib/user-locale";

// Hard takedown of a pet. Removes the row, every cross-table reference
// keyed by slug (likes, metrics, collection items, collection requests,
// profile pins, fulfilled requests), nulls collection covers, drops
// the R2 assets, and notifies the owner. The slug is freed.
//
// Caller is responsible for authz — this helper trusts whoever invoked it.
// The only caller in this repository is DELETE /api/pets/[slug]/owner (owner
// self-service via the card menu); the admin surfaces moved to a separate app
// in #380. The ops scripts (scripts/takedown-pet.ts, takedown-by-keyword.ts)
// reimplement the cleanup inline and do NOT come through here, so they also
// do not take the advisory locks this helper relies on — worth knowing before
// trusting the lock story for an ops takedown.
type TakedownPetRow = typeof schema.submittedPets.$inferSelect;

type TakedownBatchRunner = {
  batch: (queries: readonly BatchItem<"pg">[]) => Promise<readonly unknown[]>;
};

export type TakedownContext = {
  pet: TakedownPetRow;
  /** Free-form reason captured from the actor; surfaced in email + log. */
  reason?: string | null;
  /**
   * Who triggered the takedown. Goes to the structured log so the audit
   * trail is searchable. 'admin' or 'moderator' for /api/admin/[id],
   * 'owner' for the self-service path, 'script' for ops CLIs.
   */
  source: "admin" | "moderator" | "owner" | "script";
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

  // 1-5. Hold a slug-scoped transaction lock and the exact pet row lock
  // before cleaning references. Each cleanup is gated by the old pet id, so
  // a stale/repeated takedown cannot touch a newer pet reusing the slug.
  const slugLock = sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${slug}, 0))
  `;
  const collectionLocks = collectionLocksForPetSlugQuery(slug);
  const affectedCollectionSlugs = sql`
    SELECT DISTINCT "slug"
    FROM "pet_collections"
    WHERE "id" IN (
      SELECT "collection_id"
      FROM "pet_collection_items"
      WHERE "pet_slug" = ${slug}
      UNION
      SELECT "id"
      FROM "pet_collections"
      WHERE "cover_pet_slug" = ${slug}
    )
    ORDER BY "slug"
  `;
  const petRowLock = sql`
    SELECT "id"
    FROM "submitted_pets"
    WHERE "id" = ${pet.id}
      AND "slug" = ${slug}
    FOR UPDATE
  `;
  const oldPetExists = takedownRowStillMatches(pet.id, slug);
  const cleanupQueries = [
    sql`
      DELETE FROM "pet_likes"
      WHERE "pet_slug" = ${slug}
        AND ${oldPetExists}
    `,
    sql`
      DELETE FROM "pet_metrics"
      WHERE "pet_slug" = ${slug}
        AND ${oldPetExists}
    `,
    sql`
      DELETE FROM "pet_collection_items"
      WHERE "pet_slug" = ${slug}
        AND ${oldPetExists}
    `,
    sql`
      DELETE FROM "pet_collection_requests"
      WHERE "pet_slug" = ${slug}
        AND ${oldPetExists}
    `,
    sql`
      UPDATE "pet_collections"
      SET "cover_pet_slug" = NULL
      WHERE "cover_pet_slug" = ${slug}
        AND ${oldPetExists}
    `,
    sql`
      UPDATE "pet_requests"
      SET "fulfilled_pet_slug" = NULL,
          "status" = 'open'
      WHERE "fulfilled_pet_slug" = ${slug}
        AND ${oldPetExists}
    `,
    sql`
      UPDATE "user_profiles" AS profiles
      SET "featured_pet_slugs" = (
        SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
        FROM jsonb_array_elements(profiles."featured_pet_slugs") AS elem
        WHERE elem <> to_jsonb(${slug}::text)
      )
      WHERE profiles."featured_pet_slugs" @> to_jsonb(${slug}::text)
        AND ${oldPetExists}
    `,
  ];
  const deletePet = sql`
    DELETE FROM "submitted_pets"
    WHERE "id" = ${pet.id}
      AND "slug" = ${slug}
    RETURNING "id"
  `;
  const batch = getTakedownBatchRunner();
  let deleted = false;
  let collectionSlugs: string[] = [];
  if (batch) {
    const results = await batch.batch([
      db.execute(slugLock),
      db.execute(collectionLocks),
      db.execute(affectedCollectionSlugs),
      db.execute(petRowLock),
      ...cleanupQueries.map((query) => db.execute(query)),
      db.execute(deletePet),
    ]);
    collectionSlugs = readCollectionSlugs(results[2]);
    deleted = hasTakedownMutationRow(results[results.length - 1]);
  } else {
    deleted = await db.transaction(async (tx) => {
      await tx.execute(slugLock);
      await tx.execute(collectionLocks);
      const affectedRows = await tx.execute(affectedCollectionSlugs);
      collectionSlugs = readCollectionSlugs(affectedRows);
      await tx.execute(petRowLock);
      for (const query of cleanupQueries) await tx.execute(query);
      return hasTakedownMutationRow(await tx.execute(deletePet));
    });
  }

  if (!deleted) return { ok: true, slug, removedR2Keys: [] };

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
  await revalidateCollectionTags(...collectionSlugs);
  await invalidateAggregates(AGGREGATE_KEYS.metricsIndex);
  await invalidateMetricCaches(pet.slug);

  // 6. Best-effort R2 cleanup. Stored source URLs and deterministic
  //    public derivatives are removed together. Anything off-host is
  //    skipped. R2 errors are logged but don't fail the takedown.
  const keys = [
    keyFromR2Url(pet.spritesheetUrl),
    keyFromR2Url(pet.petJsonUrl),
    keyFromR2Url(pet.zipUrl),
    keyFromR2Url(pet.soundUrl),
    ...petPublicArtifactKeys(slug),
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

/**
 * The gate every cleanup statement carries: the row this takedown was handed
 * must still be the row at this slug. A repeated takedown, or one racing a
 * slug that has since been reused by a newer pet, then touches nothing instead
 * of deleting references that belong to the new pet.
 *
 * Exported so the gate can be executed against a real database in
 * takedown-cleanup.test.ts — an assertion on the statement text would keep
 * passing if the condition were dropped from the statements that use it.
 */
export function takedownRowStillMatches(petId: string, slug: string) {
  return sql`
    EXISTS (
      SELECT 1
      FROM "submitted_pets"
      WHERE "id" = ${petId}
        AND "slug" = ${slug}
    )
  `;
}

function getTakedownBatchRunner(): TakedownBatchRunner | null {
  const candidate = db as unknown as Partial<TakedownBatchRunner>;
  if (typeof candidate.batch !== "function") return null;
  return { batch: candidate.batch.bind(db) };
}

function hasTakedownMutationRow(result: unknown): boolean {
  const rows = Array.isArray(result)
    ? result
    : result !== null && typeof result === "object"
      ? (result as { rows?: unknown }).rows
      : null;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  return Boolean(
    row && typeof row === "object" && !Array.isArray(row) && "id" in row,
  );
}

function readCollectionSlugs(result: unknown): string[] {
  const rows = Array.isArray(result)
    ? result
    : result !== null && typeof result === "object"
      ? (result as { rows?: unknown }).rows
      : null;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      return [];
    }
    const slug = (row as { slug?: unknown }).slug;
    return typeof slug === "string" && slug ? [slug] : [];
  });
}
