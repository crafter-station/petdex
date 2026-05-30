// Send the desktop_launch broadcast test email to a single address.
// Bypasses the admin UI so we can preview the template before deploying
// the new copy. Reads from email_preferences for the locale + token,
// renders the template, ships via Resend.

import { neon } from "@neondatabase/serverless";
import { Resend } from "resend";

import { renderDesktopLaunchEmail } from "../src/lib/email-templates/desktop-launch";
import { requiredEnv } from "./env";

const TARGET_EMAIL = process.argv[2];
if (!TARGET_EMAIL) {
  console.error("Usage: bun scripts/send-desktop-launch-test.ts <email>");
  process.exit(1);
}

const sql = neon(requiredEnv("DATABASE_URL"));
const resend = new Resend(requiredEnv("RESEND_API_KEY"));
const from = process.env.RESEND_FROM ?? "Petdex <hello@petdex.crafter.run>";

const rows = (await sql`
  SELECT email, locale, unsubscribe_token
  FROM email_preferences
  WHERE email = ${TARGET_EMAIL}
  LIMIT 1
`) as { email: string; locale: string; unsubscribe_token: string }[];
const pref = rows[0];

if (!pref) {
  console.error(`No email_preferences row for ${TARGET_EMAIL}`);
  process.exit(1);
}

console.log(
  `Sending desktop_launch test to ${TARGET_EMAIL} (locale=${pref.locale})…`,
);

const { subject, html, text } = renderDesktopLaunchEmail(
  pref.locale as "en" | "es" | "zh",
  { unsubscribeToken: pref.unsubscribe_token },
);

const res = await resend.emails.send({
  from,
  to: TARGET_EMAIL,
  subject,
  html,
  text,
  headers: {
    "List-Unsubscribe": `<https://petdex.crafter.run/unsubscribe?token=${encodeURIComponent(pref.unsubscribe_token)}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  },
});

if (res.error) {
  console.error("Resend error:", res.error);
  process.exit(1);
}

console.log(`✓ sent (id=${res.data?.id})`);
console.log(`subject: ${subject}`);
