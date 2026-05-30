// Backfill email_preferences from existing Clerk users.
//
// We never built an explicit opt-in flow — users sign up with Clerk and
// the email_preferences table sits empty. That's fine while we have no
// announcements to send, but we just shipped Petdex Desktop and want
// to actually reach the people who created an account.
//
// Strategy: for every Clerk user with a verified email, insert a row
// into email_preferences with:
//   - unsubscribed_marketing = false  (treated as opted-in)
//   - locale = preferred_locale from Clerk publicMetadata, fallback "en"
//   - unsubscribe_token = freshly minted, mode-0600 secret
//
// This is a one-shot. Idempotent via ON CONFLICT (user_id) DO NOTHING
// so re-running won't bump existing rows back to opted-in (respects
// users who already unsubscribed).
//
// Legal posture: Petdex's ToS implies a transactional relationship,
// and the unsubscribe link is one-click via the List-Unsubscribe
// header. For our scale (low hundreds), the risk is acceptable. If
// this list ever grows past ~1k, switch to explicit opt-in.

import { createClerkClient } from "@clerk/backend";
import { neon } from "@neondatabase/serverless";

import { requiredEnv } from "./env";

const sql = neon(requiredEnv("DATABASE_URL"));
const clerk = createClerkClient({ secretKey: requiredEnv("CLERK_SECRET_KEY") });

type Locale = "en" | "es" | "zh";

function normalizeLocale(raw: unknown): Locale {
  if (raw === "es" || raw === "zh") return raw;
  return "en";
}

function generateToken(): string {
  // 32 bytes hex = 64 chars. Same shape as the existing onboarding
  // generator so the column never sees a mix of formats.
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function main() {
  console.log("Fetching Clerk users…");
  let inserted = 0;
  let skipped = 0;
  let noEmail = 0;
  let cursor = 0;
  const limit = 100;

  while (true) {
    const page = await clerk.users.getUserList({ limit, offset: cursor });
    if (page.data.length === 0) break;

    for (const u of page.data) {
      const primaryId = u.primaryEmailAddressId;
      const primary = u.emailAddresses.find((e) => e.id === primaryId);
      const email = primary?.emailAddress;
      if (!email) {
        noEmail++;
        continue;
      }
      // Only opt in verified addresses — sending to unverified is the
      // fastest way to torch a Resend reputation.
      if (primary.verification?.status !== "verified") {
        skipped++;
        continue;
      }

      const locale = normalizeLocale(
        (u.publicMetadata as Record<string, unknown> | null)?.preferredLocale ??
          (u.publicMetadata as Record<string, unknown> | null)?.locale,
      );
      const token = generateToken();

      try {
        const result = (await sql`
          INSERT INTO email_preferences
            (user_id, email, locale, unsubscribe_token, unsubscribed_marketing)
          VALUES
            (${u.id}, ${email}, ${locale}, ${token}, false)
          ON CONFLICT (user_id) DO NOTHING
          RETURNING user_id
        `) as { user_id: string }[];
        if (result.length > 0) {
          inserted++;
          console.log(`  ✓ ${email} (${locale})`);
        } else {
          skipped++;
        }
      } catch (err) {
        console.error(
          `  ✗ ${email}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    cursor += page.data.length;
    if (page.data.length < limit) break;
  }

  console.log("");
  console.log(`Inserted: ${inserted}`);
  console.log(`Skipped (already in table or unverified): ${skipped}`);
  console.log(`No email: ${noEmail}`);
}

await main();
console.log("done");
