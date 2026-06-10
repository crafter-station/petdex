// One-shot takedown for an approved pet. Mirrors DELETE /api/admin/[id]
// so we can resolve takedowns from the CLI when the prod admin UI is
// not at hand.
//
// Usage:
//   bun scripts/takedown-pet.ts --slug jane              # preview
//   bun scripts/takedown-pet.ts --slug jane --apply      # do it
//   bun scripts/takedown-pet.ts --id pet_xxx --apply --reason "owner asked to resubmit"
//
// Loads .env.local automatically. Requires DATABASE_URL + R2_* + RESEND_API_KEY
// (RESEND optional — script logs and continues if missing).

import { eq, sql } from "drizzle-orm";
import { Resend } from "resend";

import { db, schema } from "@/lib/db/client";
import { renderSubmissionTakedownEmail } from "@/lib/email-templates/submission-takedown";
import { createNotification } from "@/lib/notifications";
import { petPublicArtifactKeys } from "@/lib/pet-public-artifact-keys";
import { deleteR2Objects, keyFromR2Url } from "@/lib/r2";
import { getPreferredLocaleForUser } from "@/lib/user-locale";

type Args = {
  slug?: string;
  id?: string;
  reason: string | null;
  apply: boolean;
};

function parseArgs(): Args {
  const out: Args = { reason: null, apply: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--slug") out.slug = argv[++i];
    else if (a === "--id") out.id = argv[++i];
    else if (a === "--reason") out.reason = argv[++i] ?? null;
    else if (a === "--apply") out.apply = true;
  }
  if (!out.slug && !out.id) {
    console.error("usage: --slug <slug> | --id <id> [--reason <r>] [--apply]");
    process.exit(2);
  }
  return out;
}

async function main() {
  const args = parseArgs();

  const pet = args.id
    ? await db.query.submittedPets.findFirst({
        where: eq(schema.submittedPets.id, args.id),
      })
    : await db.query.submittedPets.findFirst({
        where: eq(schema.submittedPets.slug, args.slug as string),
      });

  if (!pet) {
    console.error(`pet not found: ${args.slug ?? args.id}`);
    process.exit(1);
  }

  const keys = [
    keyFromR2Url(pet.spritesheetUrl),
    keyFromR2Url(pet.petJsonUrl),
    keyFromR2Url(pet.zipUrl),
    keyFromR2Url(pet.soundUrl),
    ...petPublicArtifactKeys(pet.slug),
  ].filter((k): k is string => Boolean(k));

  console.log("\nTakedown plan");
  console.log("─────────────");
  console.log(`id          : ${pet.id}`);
  console.log(`slug        : ${pet.slug}`);
  console.log(`displayName : ${pet.displayName}`);
  console.log(`status      : ${pet.status}`);
  console.log(`ownerId     : ${pet.ownerId}`);
  console.log(`ownerEmail  : ${pet.ownerEmail ?? "(none)"}`);
  console.log(`reason      : ${args.reason ?? "(none)"}`);
  console.log(`R2 keys (${keys.length}):`);
  for (const k of keys) console.log(`  - ${k}`);

  if (!args.apply) {
    console.log("\n(dry run — pass --apply to execute)");
    return;
  }

  console.log("\nExecuting…");

  const slug = pet.slug;
  const id = pet.id;

  // 1. Cross-table cleanup keyed by slug.
  await db.delete(schema.petLikes).where(eq(schema.petLikes.petSlug, slug));
  await db.delete(schema.petMetrics).where(eq(schema.petMetrics.petSlug, slug));
  await db
    .delete(schema.petCollectionItems)
    .where(eq(schema.petCollectionItems.petSlug, slug));
  await db
    .delete(schema.petCollectionRequests)
    .where(eq(schema.petCollectionRequests.petSlug, slug));

  // 2. Null out collection covers.
  await db
    .update(schema.petCollections)
    .set({ coverPetSlug: null })
    .where(eq(schema.petCollections.coverPetSlug, slug));

  // 3. Reopen any pet request this fulfilled.
  await db
    .update(schema.petRequests)
    .set({ fulfilledPetSlug: null, status: "open" })
    .where(eq(schema.petRequests.fulfilledPetSlug, slug));

  // 4. Strip slug from user_profiles.featured_pet_slugs arrays.
  await db.execute(sql`
    UPDATE user_profiles
    SET featured_pet_slugs = (
      SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
      FROM jsonb_array_elements(featured_pet_slugs) AS elem
      WHERE elem <> to_jsonb(${slug}::text)
    )
    WHERE featured_pet_slugs @> to_jsonb(${slug}::text)
  `);

  // 5. Drop the row.
  await db.delete(schema.submittedPets).where(eq(schema.submittedPets.id, id));

  // 6. R2 cleanup.
  try {
    await deleteR2Objects(keys);
    console.log(`R2: deleted ${keys.length} objects`);
  } catch (err) {
    console.warn("R2 cleanup failed:", err);
  }

  // 7. Notify owner.
  await createNotification({
    userId: pet.ownerId,
    kind: "pet_rejected",
    payload: {
      petSlug: slug,
      petName: pet.displayName,
      ...(args.reason ? { reason: args.reason } : {}),
      takedown: true,
    },
    href: "/my-pets",
  }).catch((e) => console.warn("notification failed:", e));

  if (pet.ownerEmail && process.env.RESEND_API_KEY) {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const from =
        process.env.RESEND_FROM ?? "Petdex <petdex@updates.railly.dev>";
      const locale = await getPreferredLocaleForUser(pet.ownerId);
      const email = renderSubmissionTakedownEmail(locale, {
        petName: pet.displayName,
        reason: args.reason,
      });
      await resend.emails.send({
        from,
        to: pet.ownerEmail,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
      console.log(`email sent to ${pet.ownerEmail}`);
    } catch (e) {
      console.warn("email failed:", e);
    }
  } else if (pet.ownerEmail) {
    console.log("RESEND_API_KEY missing — skipping email");
  }

  console.log("\nDone. Slug is free for resubmit.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
