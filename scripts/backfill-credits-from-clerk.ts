// Recompute every submitted_pets row's credit_* columns from the
// CURRENT Clerk profile of its owner. Idempotent — only writes when
// the new value is strictly better than what's there:
//   - credit_url:   write if currently null AND Clerk has GitHub/X
//   - credit_name:  write if better (real name > username > current)
//   - credit_image: write if currently null AND Clerk has imageUrl
//
// Run:  bun --env-file .env.local --env-file .env.production.local \
//       scripts/backfill-credits-from-clerk.ts [--dry]
//
// Note: needs a Clerk SECRET key matching the env where the userIds
// live. For Petdex prod that's sk_live_*; .env.production.local already
// has it, so pass both env files.

import { clerkClient } from "@clerk/nextjs/server";
import { neon } from "@neondatabase/serverless";

import { requiredEnv } from "./env";

const dryRun = process.argv.includes("--dry");
const sql = neon(requiredEnv("DATABASE_URL"));

type Row = {
  id: string;
  slug: string;
  display_name: string;
  owner_id: string;
  owner_email: string | null;
  credit_name: string | null;
  credit_url: string | null;
  credit_image: string | null;
};

function externalUrlFor(
  externalAccounts: Array<{ provider?: string; username?: string }>,
): string | null {
  let github: string | null = null;
  let twitter: string | null = null;
  for (const acc of externalAccounts ?? []) {
    if (!acc.username) continue;
    if (acc.provider === "oauth_github" && !github)
      github = `https://github.com/${acc.username}`;
    if (
      (acc.provider === "oauth_x" || acc.provider === "oauth_twitter") &&
      !twitter
    )
      twitter = `https://x.com/${acc.username}`;
  }
  return github ?? twitter;
}

function bestName(
  current: string | null,
  username: string | null,
  firstName: string | null,
  lastName: string | null,
  email: string | null,
): string | null {
  // Compute the "best" Clerk-derived candidate. Priority matches the
  // original submit flow: username > realName > email-prefix.
  const first = firstName?.trim() || null;
  const last = lastName?.trim() || null;
  let candidate: string | null = null;
  if (username) candidate = username;
  else if (first) candidate = last ? `${first} ${last[0]}.` : first;
  else if (email?.includes("@")) candidate = email.split("@")[0];

  if (!candidate) return null;
  if (current === candidate) return null;

  // Only update when the stored name is the "broken" email-prefix case.
  // Anything else (custom credit_name from old submits, prior usernames,
  // etc.) we leave alone — overwriting would silently change how someone
  // is credited and that surprised users in the dry run.
  if (!current) return candidate;
  const currentIsEmailPrefix =
    !!email && email.includes("@") && current === email.split("@")[0];
  return currentIsEmailPrefix ? candidate : null;
}

async function main() {
  const rows = (await sql`
    SELECT id, slug, display_name, owner_id, owner_email,
           credit_name, credit_url, credit_image
    FROM submitted_pets
    ORDER BY created_at ASC
  `) as Row[];

  console.log(`Found ${rows.length} rows.`);

  const ownerIds = [...new Set(rows.map((r) => r.owner_id))];
  console.log(`Distinct owners: ${ownerIds.length}`);

  const client = await clerkClient();
  const clerkInfo = new Map<
    string,
    {
      username: string | null;
      firstName: string | null;
      lastName: string | null;
      imageUrl: string | null;
      email: string | null;
      externalAccounts: Array<{ provider?: string; username?: string }>;
    }
  >();

  for (let i = 0; i < ownerIds.length; i += 100) {
    const batch = ownerIds.slice(i, i + 100);
    try {
      const list = await client.users.getUserList({
        userId: batch,
        limit: 100,
      });
      for (const u of list.data) {
        const primary = u.emailAddresses.find(
          (e) => e.id === u.primaryEmailAddressId,
        );
        clerkInfo.set(u.id, {
          username: u.username ?? null,
          firstName: u.firstName ?? null,
          lastName: u.lastName ?? null,
          imageUrl: u.imageUrl ?? null,
          email: primary?.emailAddress ?? null,
          externalAccounts: (u.externalAccounts ?? []) as Array<{
            provider?: string;
            username?: string;
          }>,
        });
      }
    } catch (err) {
      console.warn(`  Clerk batch failed (${batch.length} ids):`, err);
    }
  }
  console.log(`Hydrated ${clerkInfo.size}/${ownerIds.length} owners.`);

  let updates = 0;
  let unchanged = 0;
  let missingClerk = 0;

  for (const row of rows) {
    const info = clerkInfo.get(row.owner_id);
    if (!info) {
      missingClerk++;
      continue;
    }

    const newUrl = !row.credit_url
      ? externalUrlFor(info.externalAccounts)
      : null;
    const newName = bestName(
      row.credit_name,
      info.username,
      info.firstName,
      info.lastName,
      info.email ?? row.owner_email,
    );
    const newImage = !row.credit_image && info.imageUrl ? info.imageUrl : null;

    const patch: Record<string, string | null> = {};
    if (newUrl) patch.credit_url = newUrl;
    if (newName) patch.credit_name = newName;
    if (newImage) patch.credit_image = newImage;

    if (Object.keys(patch).length === 0) {
      unchanged++;
      continue;
    }

    console.log(
      `${dryRun ? "[dry] " : ""}${row.slug.padEnd(28)} owner=${row.owner_id.slice(-8)}`,
    );
    if (patch.credit_name) {
      console.log(
        `  name:  ${row.credit_name ?? "<null>"} -> ${patch.credit_name}`,
      );
    }
    if (patch.credit_url) {
      console.log(
        `  url:   ${row.credit_url ?? "<null>"} -> ${patch.credit_url}`,
      );
    }
    if (patch.credit_image) {
      console.log(`  image: <null> -> ${patch.credit_image.slice(0, 60)}…`);
    }

    if (!dryRun) {
      await sql`
        UPDATE submitted_pets
        SET credit_name  = COALESCE(${patch.credit_name ?? null}, credit_name),
            credit_url   = COALESCE(${patch.credit_url ?? null}, credit_url),
            credit_image = COALESCE(${patch.credit_image ?? null}, credit_image)
        WHERE id = ${row.id}
      `;
    }
    updates++;
  }

  console.log(
    `\nDone. updated=${updates} unchanged=${unchanged} missing-from-clerk=${missingClerk}`,
  );
}

await main();
