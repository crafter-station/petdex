// Sweep takedown for pets, pet_requests, pet_collection_requests, and
// pet_collections that match the keyword blocklist (src/lib/keyword-blocklist.ts).
//
// Usage:
//   bun scripts/takedown-by-keyword.ts                  # dry-run, prints plan
//   bun scripts/takedown-by-keyword.ts --apply          # execute everything
//   bun scripts/takedown-by-keyword.ts --apply --pets-only
//   bun scripts/takedown-by-keyword.ts --apply --requests-only
//
// Pets are swept by the inline cleanup below, NOT via takedownPet() — that
// helper takes slug-scoped advisory locks and gates every child write on the
// pet row it locked. This script reimplements the same cross-table deletions
// (likes, metrics, collection items, collection requests), drops R2 assets, and
// emails the owner with the supplied reason, so its takedowns do not take those
// locks. Keep the two in step when the reference lists change.
// Pet requests are marked dismissed and have their pending image rejected so
// they fall off the public board.
//
// Loads .env.local automatically.

import { eq, or, sql } from "drizzle-orm";
import { Resend } from "resend";

import { db, executeAtomicReturning, schema } from "@/lib/db/client";
import { renderSubmissionTakedownEmail } from "@/lib/email-templates/submission-takedown";
import {
  BLOCKED_CHINESE_PHRASES,
  BLOCKED_KEYWORD_REASON,
  BLOCKED_LATIN_TOKENS,
  findBlockedKeyword,
} from "@/lib/keyword-blocklist";
import { createNotification } from "@/lib/notifications";
import { petPublicArtifactKeys } from "@/lib/pet-public-artifact-keys";
import { deleteR2Objects, keyFromR2Url } from "@/lib/r2";
import { getPreferredLocaleForUser } from "@/lib/user-locale";

import { emailEnv, sendEmail } from "../src/lib/email-send";

type Pet = typeof schema.submittedPets.$inferSelect;

type Args = {
  apply: boolean;
  petsOnly: boolean;
  requestsOnly: boolean;
  collectionsOnly: boolean;
  reason: string;
  actorId: string;
};

function parseArgs(): Args {
  const out: Args = {
    apply: false,
    petsOnly: false,
    requestsOnly: false,
    collectionsOnly: false,
    reason: BLOCKED_KEYWORD_REASON,
    actorId: "script:takedown-by-keyword",
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--pets-only") out.petsOnly = true;
    else if (a === "--requests-only") out.requestsOnly = true;
    else if (a === "--collections-only") out.collectionsOnly = true;
    else if (a === "--reason") out.reason = argv[++i] ?? out.reason;
    else if (a === "--actor") out.actorId = argv[++i] ?? out.actorId;
  }
  return out;
}

function buildIlikeOr(
  column: ReturnType<typeof sql>,
  patterns: string[],
): ReturnType<typeof or> | undefined {
  if (patterns.length === 0) return undefined;
  const exprs = patterns.map(
    (p) => sql`${column} ILIKE ${`%${p.replace(/[%_]/g, (m) => `\\${m}`)}%`}`,
  );
  // drizzle's or() needs at least 2 args to avoid type narrowing weirdness.
  // The cast to `never[]` (not `never`) preserves the array shape so the
  // spread is iterable; or() returns `SQL | undefined` which is exactly
  // what we want to bubble up.
  return exprs.length === 1 ? exprs[0] : or(...(exprs as never[]));
}

async function findMatchingPets() {
  const patterns = [...BLOCKED_LATIN_TOKENS, ...BLOCKED_CHINESE_PHRASES];
  // `tags` is a jsonb array; cast to text so ILIKE can see it. Tags are an
  // AI-written field — the classifier reads creator text and can be steered
  // by a prompt-injection into emitting a blocklisted token — and they are
  // rendered on the pet page and indexed for search, so a keyword sweep that
  // skipped them left such a word live with nothing to catch it.
  const tagsText = sql`${schema.submittedPets.tags}::text`;
  const condition = or(
    buildIlikeOr(sql`${schema.submittedPets.displayName}`, patterns) as never,
    buildIlikeOr(sql`${schema.submittedPets.description}`, patterns) as never,
    buildIlikeOr(sql`${schema.submittedPets.slug}`, patterns) as never,
    buildIlikeOr(tagsText, patterns) as never,
  );
  if (!condition) return [];
  const rows = await db.select().from(schema.submittedPets).where(condition);
  // Final filter via the same matcher the runtime uses, in case a SQL
  // ILIKE picked something up that the latin word-boundary rule would
  // not actually trigger (e.g., "skunk").
  return rows.filter(
    (r) =>
      findBlockedKeyword(
        r.displayName,
        r.description,
        r.slug,
        ...((r.tags as string[] | null) ?? []),
      ) !== null,
  );
}

async function findMatchingRequests() {
  const patterns = [...BLOCKED_LATIN_TOKENS, ...BLOCKED_CHINESE_PHRASES];
  const condition = or(
    buildIlikeOr(sql`${schema.petRequests.query}`, patterns) as never,
    buildIlikeOr(sql`${schema.petRequests.normalized}`, patterns) as never,
  );
  if (!condition) return [];
  const rows = await db.select().from(schema.petRequests).where(condition);
  return rows.filter((r) => findBlockedKeyword(r.query, r.normalized) !== null);
}

async function findMatchingCollections() {
  const patterns = [...BLOCKED_LATIN_TOKENS, ...BLOCKED_CHINESE_PHRASES];
  const condition = or(
    buildIlikeOr(sql`${schema.petCollections.title}`, patterns) as never,
    buildIlikeOr(sql`${schema.petCollections.description}`, patterns) as never,
    buildIlikeOr(sql`${schema.petCollections.slug}`, patterns) as never,
  );
  if (!condition) return [];
  const rows = await db.select().from(schema.petCollections).where(condition);
  return rows.filter(
    (r) => findBlockedKeyword(r.title, r.description, r.slug) !== null,
  );
}

async function takedownOne(pet: Pet, reason: string) {
  const slug = pet.slug;

  // Every cleanup below is keyed off the pet row, so a mid-sequence failure
  // used to leave the pet half-removed — likes gone, candidates deleted, but
  // the pet row still live. One transaction makes it all-or-nothing. This list
  // mirrors `takedownPet` in scripts/takedown-pet.ts; the statements stay
  // separate for the reason `runAtomicReturning` documents (a single CTE would
  // share one snapshot and could not see the row it just wrote).
  await executeAtomicReturning([
    db
      .delete(schema.petLikes)
      .where(eq(schema.petLikes.petSlug, slug))
      .getSQL(),
    db
      .delete(schema.petMetrics)
      .where(eq(schema.petMetrics.petSlug, slug))
      .getSQL(),
    db
      .delete(schema.petCollectionItems)
      .where(eq(schema.petCollectionItems.petSlug, slug))
      .getSQL(),
    db
      .delete(schema.petCollectionRequests)
      .where(eq(schema.petCollectionRequests.petSlug, slug))
      .getSQL(),
    // Keyed by pet_id, not slug, and no FK cascades it — see takedown.ts.
    db
      .delete(schema.petRequestCandidates)
      .where(eq(schema.petRequestCandidates.petId, pet.id))
      .getSQL(),
    // Reviews hang off the pet by id as well, and the FK that would cascade
    // them is absent from push-built databases (see the schema declaration),
    // so nothing may delete a pet without taking the reviews.
    db
      .delete(schema.submissionReviews)
      .where(eq(schema.submissionReviews.submittedPetId, pet.id))
      .getSQL(),
    db
      .update(schema.petCollections)
      .set({ coverPetSlug: null })
      .where(eq(schema.petCollections.coverPetSlug, slug))
      .getSQL(),
    db
      .update(schema.petRequests)
      .set({ fulfilledPetSlug: null, status: "open" })
      .where(eq(schema.petRequests.fulfilledPetSlug, slug))
      .getSQL(),
    sql`
      UPDATE user_profiles
      SET featured_pet_slugs = (
        SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
        FROM jsonb_array_elements(featured_pet_slugs) AS elem
        WHERE elem <> to_jsonb(${slug}::text)
      )
      WHERE featured_pet_slugs @> to_jsonb(${slug}::text)
    `,
    db
      .delete(schema.submittedPets)
      .where(eq(schema.submittedPets.id, pet.id))
      .getSQL(),
  ]);

  const keys = [
    keyFromR2Url(pet.spritesheetUrl),
    keyFromR2Url(pet.petJsonUrl),
    keyFromR2Url(pet.zipUrl),
    keyFromR2Url(pet.soundUrl),
    ...petPublicArtifactKeys(slug),
  ].filter((k): k is string => Boolean(k));
  // Recorded, not thrown here: the owner still has to be told, and throwing
  // mid-function would skip the notification and email below. The caller
  // counts it as a failure and exits non-zero — swallowing it entirely meant
  // the DB row came down while the public assets stayed in the bucket, and
  // the run still reported success.
  let r2Error: unknown = null;
  try {
    await deleteR2Objects(keys);
  } catch (err) {
    r2Error = err;
  }

  await createNotification({
    userId: pet.ownerId,
    kind: "pet_rejected",
    payload: {
      petSlug: slug,
      petName: pet.displayName,
      reason,
      takedown: true,
    },
    href: "/my-pets",
  }).catch((e) => console.warn(`    notification failed for ${slug}:`, e));

  if (pet.ownerEmail && process.env.RESEND_API_KEY) {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const from = emailEnv(
        "RESEND_FROM",
        "Petdex <petdex@updates.railly.dev>",
      );
      const locale = await getPreferredLocaleForUser(pet.ownerId);
      const email = renderSubmissionTakedownEmail(locale, {
        petName: pet.displayName,
        reason,
      });
      // Resend resolves 4xx/5xx with an `error` rather than throwing, so the
      // bare call here dropped the failure silently; sendEmail logs it.
      await sendEmail(
        resend,
        {
          from,
          to: pet.ownerEmail,
          subject: email.subject,
          html: email.html,
          text: email.text,
        },
        `takedown ${slug}`,
      );
    } catch (e) {
      console.warn(`    email failed for ${slug}:`, e);
    }
  }

  if (r2Error) throw r2Error;
}

async function main() {
  const args = parseArgs();

  const doPets = !args.requestsOnly && !args.collectionsOnly;
  const doRequests = !args.petsOnly && !args.collectionsOnly;
  const doCollections = !args.petsOnly && !args.requestsOnly;

  const [pets, requests, collections] = await Promise.all([
    doPets ? findMatchingPets() : Promise.resolve([]),
    doRequests ? findMatchingRequests() : Promise.resolve([]),
    doCollections ? findMatchingCollections() : Promise.resolve([]),
  ]);

  console.log("Keyword blocklist takedown plan");
  console.log("───────────────────────────────");
  console.log(`reason : ${args.reason}`);
  console.log(`actor  : ${args.actorId}`);
  console.log(`apply  : ${args.apply ? "YES" : "no (dry-run)"}`);
  console.log("");

  console.log(`pets matched: ${pets.length}`);
  for (const p of pets) {
    const hit = findBlockedKeyword(p.displayName, p.description, p.slug);
    console.log(
      `  - ${p.slug}  [${p.status}]  owner=${p.ownerEmail ?? p.ownerId}  hit=${hit?.keyword}`,
    );
  }

  console.log(`\npet_requests matched: ${requests.length}`);
  for (const r of requests) {
    const hit = findBlockedKeyword(r.query, r.normalized);
    console.log(
      `  - ${r.id}  status=${r.status}  votes=${r.upvoteCount}  query="${r.query}"  hit=${hit?.keyword}`,
    );
  }

  console.log(`\npet_collections matched: ${collections.length}`);
  for (const c of collections) {
    const hit = findBlockedKeyword(c.title, c.description, c.slug);
    console.log(
      `  - ${c.slug}  title="${c.title}"  featured=${c.featured}  hit=${hit?.keyword}`,
    );
  }

  if (!args.apply) {
    console.log("\n(dry-run — pass --apply to execute)");
    return;
  }

  console.log("\nExecuting takedowns…");

  // A per-item failure used to only warn, so a run where every removal
  // failed still printed "Done." and exited 0 — a takedown that reported
  // success while nothing came down. Count them and fail the process.
  let failures = 0;

  // 1. Pets — inline takedown (mirrors src/lib/takedown.ts but avoids
  //    the `import "server-only"` boundary so this runs as a CLI).
  for (const p of pets) {
    try {
      await takedownOne(p, args.reason);
      console.log(`  pet ${p.slug}: removed`);
    } catch (err) {
      failures++;
      console.warn(`  pet ${p.slug}: FAILED`, err);
    }
  }

  // 2. Pet requests — dismiss + reject any pending image so the public
  //    board stops surfacing it. We do not delete the row so audit
  //    trail (votes, requestedBy) survives.
  for (const r of requests) {
    try {
      await db
        .update(schema.petRequests)
        .set({
          status: "dismissed",
          imageReviewStatus: r.imageUrl ? "rejected" : r.imageReviewStatus,
          imageRejectionReason: r.imageUrl
            ? args.reason
            : r.imageRejectionReason,
          updatedAt: new Date(),
        })
        .where(eq(schema.petRequests.id, r.id));
      console.log(`  request ${r.id}: dismissed`);
    } catch (err) {
      failures++;
      console.warn(`  request ${r.id}: FAILED`, err);
    }
  }

  // 3. Collections — drop the row. ON DELETE CASCADE on
  //    pet_collection_items + pet_collection_requests cleans the
  //    children automatically.
  for (const c of collections) {
    try {
      await db
        .delete(schema.petCollections)
        .where(eq(schema.petCollections.id, c.id));
      console.log(`  collection ${c.slug}: deleted`);
    } catch (err) {
      failures++;
      console.warn(`  collection ${c.slug}: FAILED`, err);
    }
  }

  if (failures > 0) {
    console.error(`\nDone with ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
