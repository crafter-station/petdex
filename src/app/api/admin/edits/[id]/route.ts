import { NextResponse } from "next/server";

import { auth, clerkClient } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { Resend } from "resend";

import { canReviewMetadataEdits, isAdmin } from "@/lib/admin";
import {
  AGGREGATE_KEYS,
  invalidateAggregates,
  invalidatePetCaches,
} from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";
import { renderEditApprovedEmail } from "@/lib/email-templates/edit-approved";
import { renderEditRejectedEmail } from "@/lib/email-templates/edit-rejected";
import { createNotification } from "@/lib/notifications";
import { deleteR2Objects, keyFromR2Url } from "@/lib/r2";
import { requireSameOrigin } from "@/lib/same-origin";
import { refreshSimilarityFor } from "@/lib/similarity";
import { getPreferredLocaleForUser } from "@/lib/user-locale";

export const runtime = "nodejs";

type Params = { id: string };

type PatchBody = {
  action: "approve" | "reject";
  reason?: string | null;
};

export async function PATCH(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  const admin = isAdmin(userId);
  if (!canReviewMetadataEdits(userId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (body.action !== "approve" && body.action !== "reject") {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const row = await db.query.submittedPets.findFirst({
    where: eq(schema.submittedPets.id, id),
  });
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!row.pendingSubmittedAt) {
    return NextResponse.json({ error: "no_pending_edit" }, { status: 400 });
  }
  if (!admin && hasPendingAssetEdit(row)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (body.action === "approve") {
    const update: Record<string, unknown> = {
      pendingDisplayName: null,
      pendingDescription: null,
      pendingTags: null,
      pendingSubmittedAt: null,
      pendingRejectionReason: null,
      pendingSpritesheetUrl: null,
      pendingPetJsonUrl: null,
      pendingZipUrl: null,
      pendingSpritesheetWidth: null,
      pendingSpritesheetHeight: null,
      pendingDhash: null,
      pendingReviewId: null,
      editCount: (row.editCount ?? 0) + 1,
      lastEditAt: new Date(),
    };
    if (row.pendingDisplayName) update.displayName = row.pendingDisplayName;
    if (row.pendingDescription) update.description = row.pendingDescription;
    if (row.pendingTags) update.tags = row.pendingTags;

    // Asset edits: swap live URLs and GC old R2 objects.
    const oldSpritesheetKey = row.pendingSpritesheetUrl
      ? keyFromR2Url(row.spritesheetUrl)
      : null;
    const oldPetJsonKey = row.pendingPetJsonUrl
      ? keyFromR2Url(row.petJsonUrl)
      : null;
    const oldZipKey = row.pendingZipUrl ? keyFromR2Url(row.zipUrl) : null;

    if (row.pendingSpritesheetUrl) {
      update.spritesheetUrl = row.pendingSpritesheetUrl;
      if (row.pendingSpritesheetWidth)
        update.spritesheetWidth = row.pendingSpritesheetWidth;
      if (row.pendingSpritesheetHeight)
        update.spritesheetHeight = row.pendingSpritesheetHeight;
    }
    if (row.pendingPetJsonUrl) update.petJsonUrl = row.pendingPetJsonUrl;
    if (row.pendingZipUrl) update.zipUrl = row.pendingZipUrl;
    if (row.pendingDhash) update.dhash = row.pendingDhash;

    const [updated] = await db
      .update(schema.submittedPets)
      .set(update)
      .where(eq(schema.submittedPets.id, id))
      .returning();

    // GC old R2 keys after the DB is updated (best-effort, non-fatal).
    const keysToDelete = [oldSpritesheetKey, oldPetJsonKey, oldZipKey].filter(
      (k): k is string => k !== null,
    );
    if (keysToDelete.length > 0) {
      void deleteR2Objects(keysToDelete).catch(() => {});
    }

    void refreshSimilarityFor(id).catch(() => {});
    await invalidateAggregates(AGGREGATE_KEYS.variantIndex);
    // Flushes both Upstash + Next page tags (pet:${slug}, pet:list)
    // so the public detail page picks up the new copy without
    // waiting on the 24h revalidate ceiling.
    await invalidatePetCaches(updated.slug);

    void createNotification({
      userId: updated.ownerId,
      kind: "edit_approved",
      payload: {
        petSlug: updated.slug,
        petName: updated.displayName,
      },
      href: `/pets/${updated.slug}`,
    }).catch(() => {});

    if (process.env.RESEND_API_KEY && updated.ownerEmail) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const from =
          process.env.RESEND_FROM ?? "Petdex <petdex@updates.railly.dev>";
        const locale = await getPreferredLocaleForUser(updated.ownerId);
        const email = renderEditApprovedEmail(locale, {
          petName: updated.displayName,
          petSlug: updated.slug,
        });
        await resend.emails.send({
          from,
          to: updated.ownerEmail,
          subject: email.subject,
          html: email.html,
          text: email.text,
        });
      } catch {
        /* silent */
      }
    }

    return NextResponse.json({ ok: true });
  }

  // reject
  const reason = body.reason?.trim().slice(0, 500) || null;
  const [updated] = await db
    .update(schema.submittedPets)
    .set({
      pendingDisplayName: null,
      pendingDescription: null,
      pendingTags: null,
      pendingSubmittedAt: null,
      pendingRejectionReason: reason,
      pendingSpritesheetUrl: null,
      pendingPetJsonUrl: null,
      pendingZipUrl: null,
      pendingSpritesheetWidth: null,
      pendingSpritesheetHeight: null,
      pendingDhash: null,
      pendingReviewId: null,
    })
    .where(eq(schema.submittedPets.id, id))
    .returning();

  void createNotification({
    userId: updated.ownerId,
    kind: "edit_rejected",
    payload: {
      petSlug: updated.slug,
      petName: updated.displayName,
      ...(reason ? { reason } : {}),
    },
    href: `/pets/${updated.slug}`,
  }).catch(() => {});

  let toEmail = updated.ownerEmail ?? null;
  if (!toEmail && updated.ownerId) {
    try {
      const client = await clerkClient();
      const u = await client.users.getUser(updated.ownerId);
      const primary = u.emailAddresses.find(
        (e) => e.id === u.primaryEmailAddressId,
      );
      toEmail = primary?.emailAddress ?? null;
    } catch {
      /* ignore */
    }
  }
  if (process.env.RESEND_API_KEY && toEmail) {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const from =
        process.env.RESEND_FROM ?? "Petdex <petdex@updates.railly.dev>";
      const locale = await getPreferredLocaleForUser(updated.ownerId);
      const email = renderEditRejectedEmail(locale, {
        petName: updated.displayName,
        petSlug: updated.slug,
        reason,
      });
      await resend.emails.send({
        from,
        to: toEmail,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
    } catch {
      /* silent */
    }
  }

  return NextResponse.json({ ok: true });
}

function hasPendingAssetEdit(row: typeof schema.submittedPets.$inferSelect) {
  return Boolean(
    row.pendingSpritesheetUrl ||
      row.pendingPetJsonUrl ||
      row.pendingZipUrl ||
      row.pendingDhash,
  );
}
