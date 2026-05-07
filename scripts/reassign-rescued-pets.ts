// Pets that were rescued by an admin script ended up with owner_id =
// admin's Clerk userId because the admin ran the insert. The credit_url
// still points at the original GitHub author, which means the real
// author can never claim from /my-pets (the claim banner only fires for
// rows whose owner_id != viewer.id AND credit_url matches their GitHub).
//
// This script re-homes those rescues:
//   1. Find pets owned by the admin user but credited to a different
//      GitHub URL.
//   2. For each unique GitHub username, look up a Clerk user via the
//      Backend API. The query is `oauth_github`-by-username if Clerk
//      supports it; we fall back to listing recent users and matching
//      externalAccounts client-side when not.
//   3. If exactly one Clerk user matches, rewrite owner_id and
//      owner_email on every pet credited to that GitHub URL.
//
// Run:  CLERK_SECRET_KEY=$(grep '^CLERK_SECRET_KEY=' .env.production.local | cut -d= -f2) \
//       bun --env-file .env.local scripts/reassign-rescued-pets.ts [--dry] [--admin-id=<userId>]

import { clerkClient } from "@clerk/nextjs/server";
import { neon } from "@neondatabase/serverless";

import { requiredEnv } from "./env";

const dryRun = process.argv.includes("--dry");
const adminArg = process.argv.find((a) => a.startsWith("--admin-id="));
const ADMIN_USER_ID = adminArg
  ? adminArg.split("=")[1]
  : "user_3DA3wOYrJh1UNufe2pgQpcF6GJ7"; // Railly's prod user id

const sql = neon(requiredEnv("DATABASE_URL"));

type Row = {
  id: string;
  slug: string;
  owner_id: string;
  owner_email: string | null;
  credit_url: string;
};

async function main() {
  const rows = (await sql`
    SELECT id, slug, owner_id, owner_email, credit_url
    FROM submitted_pets
    WHERE owner_id = ${ADMIN_USER_ID}
      AND credit_url IS NOT NULL
      AND credit_url ILIKE '%github.com/%'
  `) as Row[];

  // Build a single map of {github_username -> {id, email}} by walking
  // every distinct userId we know about (owners across all four tables
  // that store userIds). This avoids paging the entire Clerk user list
  // and stays scoped to people who already touched Petdex.
  const distinctIds = new Set<string>();
  const otherOwners = (await sql`
    SELECT DISTINCT owner_id FROM submitted_pets WHERE owner_id != ${ADMIN_USER_ID}
  `) as Array<{ owner_id: string }>;
  for (const r of otherOwners) distinctIds.add(r.owner_id);
  const requestUsers = (await sql`
    SELECT DISTINCT requested_by FROM pet_requests WHERE requested_by IS NOT NULL
  `) as Array<{ requested_by: string }>;
  for (const r of requestUsers) distinctIds.add(r.requested_by);
  const feedbackUsers = (await sql`
    SELECT DISTINCT user_id FROM feedback WHERE user_id IS NOT NULL
  `) as Array<{ user_id: string }>;
  for (const r of feedbackUsers) distinctIds.add(r.user_id);
  const profileUsers = (await sql`
    SELECT user_id FROM user_profiles
  `) as Array<{ user_id: string }>;
  for (const r of profileUsers) distinctIds.add(r.user_id);

  console.log(`Hydrating ${distinctIds.size} known Clerk users…`);

  const ghMap = new Map<string, { id: string; email: string | null }>();
  const client = await clerkClient();
  const allIds = [...distinctIds];
  for (let i = 0; i < allIds.length; i += 100) {
    try {
      const list = await client.users.getUserList({
        userId: allIds.slice(i, i + 100),
        limit: 100,
      });
      for (const u of list.data) {
        const externals = (u.externalAccounts ?? []) as Array<{
          provider?: string;
          username?: string;
        }>;
        for (const acc of externals) {
          if (acc.provider !== "oauth_github") continue;
          if (!acc.username) continue;
          const primary = u.emailAddresses.find(
            (e) => e.id === u.primaryEmailAddressId,
          );
          ghMap.set(acc.username.toLowerCase(), {
            id: u.id,
            email: primary?.emailAddress ?? null,
          });
        }
      }
    } catch (err) {
      console.warn("  batch failed:", err);
    }
  }
  console.log(`Indexed ${ghMap.size} GitHub usernames -> Clerk users.`);

  // Bucket by github username (lowercased).
  const byUsername = new Map<string, Row[]>();
  for (const r of rows) {
    let username: string | null = null;
    try {
      const u = new URL(r.credit_url);
      if (u.host !== "github.com") continue;
      username = u.pathname.replace(/^\//, "").split("/")[0]?.toLowerCase();
    } catch {
      continue;
    }
    if (!username) continue;
    // Skip our own profile.
    if (username === "railly") continue;
    const matches = byUsername.get(username) ?? [];
    matches.push(r);
    byUsername.set(username, matches);
  }

  console.log(
    `Candidates: ${rows.length} pets across ${byUsername.size} GitHub authors`,
  );

  let totalReassigned = 0;
  let unresolvedAuthors = 0;

  for (const [username, pets] of byUsername) {
    const matched = ghMap.get(username) ?? null;

    if (!matched) {
      unresolvedAuthors++;
      console.log(
        `  ${username.padEnd(20)}  NO Clerk user — ${pets.length} pet(s) stay on admin: ${pets.map((p) => p.slug).join(", ")}`,
      );
      continue;
    }

    console.log(
      `${dryRun ? "[dry] " : ""}${username.padEnd(20)}  -> ${matched.id} (${matched.email ?? "no email"}) — ${pets.length} pet(s): ${pets.map((p) => p.slug).join(", ")}`,
    );

    if (!dryRun) {
      for (const pet of pets) {
        await sql`
          UPDATE submitted_pets
          SET owner_id = ${matched.id},
              owner_email = COALESCE(${matched.email}, owner_email)
          WHERE id = ${pet.id}
        `;
        totalReassigned++;
      }
    }
  }

  console.log(
    `\nDone. reassigned=${totalReassigned} unresolved-authors=${unresolvedAuthors}`,
  );
}

await main();
