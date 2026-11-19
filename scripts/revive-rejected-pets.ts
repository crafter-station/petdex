// One-shot rescue: every rejected pet was bounced for "duplicated" or
// pointed to a near-twin slug. Duplication isn't actually a rejection
// reason — the gallery is fine with similar pets — so we revive them
// all to approved, refresh embeddings, and email the owners with an
// apology + the same launch checklist as a fresh approval.
//
// The duplicate reason is the ONLY one this rescue covers, so the query
// filters for it: `rejectionReasonForDecision` writes a fixed sentence for a
// duplicate rejection, while a security rejection stores the review's own
// summary (`security_malicious_pet_json` and friends). Reviving every
// `status = 'rejected'` row indiscriminately would put a submission the
// scanner flagged as malicious back on the gallery and erase the reason.
const DUPLICATE_REASON_PREFIX = "This submission appears to duplicate";

//
// Dry run by default (prints what it would do), like the other maintenance
// scripts: this flips every rejected row to approved and emails real people,
// so the destructive pass has to be asked for explicitly with --apply.

import { neon } from "@neondatabase/serverless";
import { Resend } from "resend";

import { invalidatePetCaches } from "../src/lib/db/cached-aggregates";
import { emailEnv, sendEmail } from "../src/lib/email-send";
import { sanitizeSubject } from "../src/lib/email-templates/shared";

const PROD_URL = "https://petdex.dev";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}
const sql = neon(databaseUrl);
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;
const from = emailEnv("RESEND_FROM", "Petdex <petdex@updates.railly.dev>");

const dryRun = !process.argv.includes("--apply");

async function main() {
  const rows = (await sql`
    SELECT id, slug, display_name, owner_email, owner_id, rejection_reason
    FROM submitted_pets
    WHERE status = 'rejected'
      AND rejection_reason LIKE ${`${DUPLICATE_REASON_PREFIX}%`}
    ORDER BY rejected_at DESC
  `) as Array<{
    id: string;
    slug: string;
    display_name: string;
    owner_email: string | null;
    owner_id: string;
    rejection_reason: string | null;
  }>;

  console.log(`Found ${rows.length} rejected pets to revive.`);
  if (rows.length === 0) return;

  const revivedSlugs: string[] = [];
  for (const row of rows) {
    const installCmd = `curl -sSf ${PROD_URL}/install/${row.slug} | sh`;
    const url = `${PROD_URL}/pets/${row.slug}`;

    console.log(
      `${dryRun ? "[dry] " : ""}revive ${row.slug} (${row.display_name}) -> ${row.owner_email ?? "no email"}`,
    );

    if (dryRun) continue;

    // Flip status to approved, clear rejection metadata, set approvedAt now.
    await sql`
      UPDATE submitted_pets
      SET status = 'approved',
          approved_at = NOW(),
          rejected_at = NULL,
          rejection_reason = NULL
      WHERE id = ${row.id}
    `;
    revivedSlugs.push(row.slug);

    if (resend && row.owner_email) {
      // Resend resolves 4xx/5xx with an `error` rather than throwing, so the
      // bare call here printed "emailed …" even when nothing sent. sendEmail
      // logs the rejection; only claim success when it really went out.
      const sent = await sendEmail(
        resend,
        {
          from,
          to: row.owner_email,
          subject: sanitizeSubject(
            `Update: ${row.display_name} is live on Petdex after all`,
          ),
          text: [
            `Heads up: earlier we declined "${row.display_name}" as a duplicate. That was a bad call. Petdex is happy to host similar pets, especially when they're yours.`,
            "",
            `Your pet is now live:`,
            `Page:    ${url}`,
            "",
            "Install command (anyone):",
            `  ${installCmd}`,
            "",
            "A few things you can do now:",
            "- Tweak the name, description or tags from the pet page",
            "  (any change goes through a quick re-approval)",
            "- Pin it on your public profile so it shows up first:",
            `  ${PROD_URL}/my-pets`,
            "- Share the install command. Every install is tracked",
            "  on your profile.",
            "",
            "Sorry for the back-and-forth, and thanks for shipping a pet,",
            "Petdex",
          ].join("\n"),
        },
        `revive ${row.slug}`,
      );
      if (sent) console.log(`  emailed ${row.owner_email}`);
    }
  }

  // Best-effort embedding refresh so the revived pets show up in vibe search.
  if (!dryRun) {
    await invalidatePetCaches(...revivedSlugs);
    console.log(
      "\nEmbeddings are not recomputed here; the daily auto-tag cron picks",
    );
    console.log(
      "the revived pets up. To refresh them now, run:\n  bun scripts/compute-similarity.ts",
    );
  }

  console.log("\ndone");
}

await main();
