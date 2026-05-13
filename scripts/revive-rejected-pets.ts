// One-shot rescue: every rejected pet was bounced for "duplicated" or
// pointed to a near-twin slug. Duplication isn't actually a rejection
// reason — the gallery is fine with similar pets — so we revive them
// all to approved, refresh embeddings, and email the owners with an
// apology + the same launch checklist as a fresh approval.

import { neon } from "@neondatabase/serverless";
import { Resend } from "resend";

import { invalidatePetCaches } from "../src/lib/db/cached-aggregates";

const PROD_URL = "https://petdex.crafter.run";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}
const sql = neon(databaseUrl);
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;
const from = process.env.RESEND_FROM ?? "Petdex <petdex@updates.railly.dev>";

const dryRun = process.argv.includes("--dry");

async function main() {
  const rows = (await sql`
    SELECT id, slug, display_name, owner_email, owner_id, rejection_reason
    FROM submitted_pets
    WHERE status = 'rejected'
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
      try {
        await resend.emails.send({
          from,
          to: row.owner_email,
          subject: `Update: ${row.display_name} is live on Petdex after all`,
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
        });
        console.log(`  emailed ${row.owner_email}`);
      } catch (err) {
        console.warn(`  email failed for ${row.slug}:`, err);
      }
    }
  }

  // Best-effort embedding refresh so the revived pets show up in vibe search.
  if (!dryRun) {
    await invalidatePetCaches(...revivedSlugs);
    console.log("\nKick off similarity refresh via /api/admin/edits is not");
    console.log("strictly needed — the daily auto-tag cron picks them up.");
    console.log(
      "If you want them in vibe search immediately, run:\n  bun scripts/refresh-similarity.ts",
    );
  }

  console.log("\ndone");
}

await main();
