// Cross-check the 26 admin-owned, github-credited pets that the GitHub
// OAuth match couldn't link. Most authors signed up with Google / email
// rather than GitHub, so their Clerk user has no oauth_github.username
// to match — but their Clerk email's local-part often equals the GitHub
// login.
//
// Order of attempts per author:
//   1. clerk users?email_address=<login>@gmail.com  (huge hit-rate)
//   2. clerk users?email_address=<login>@*.com      (limited list)
//   3. clerk users + scan email_addresses where local-part == login
//
// Stop on first match. Pets without any match stay on admin and the
// /my-pets claim banner picks them up later.

import { neon } from "@neondatabase/serverless";
// Direct Clerk Backend API. The clerk CLI 1.0.3 returns empty arrays
// when called from execFileSync/spawnSync for paginated /users endpoints
// (works in shell direct, broken from Bun script). Falling back to
// fetch + CLERK_SECRET_KEY which is what we used in the first relink
// pass anyway.
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";

import * as schema from "../src/lib/db/schema";

const ADMIN_OWNER_ID = "user_3DA3wOYrJh1UNufe2pgQpcF6GJ7";
const CLERK_BASE = "https://api.clerk.com/v1";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const sql = neon(env("DATABASE_URL"));
const db = drizzle(sql, { schema });

async function clerkApi<T>(path: string): Promise<T> {
  const key = env("CLERK_SECRET_KEY");
  const res = await fetch(`${CLERK_BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    throw new Error(`clerk ${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

type ClerkUser = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  primary_email_address_id: string | null;
  email_addresses: Array<{
    id: string;
    email_address: string;
    verification: { status?: string } | null;
  }>;
  external_accounts: Array<{
    provider: string;
    username: string | null;
  }>;
};

function pickPrimaryEmail(user: ClerkUser): string | null {
  const primary =
    user.email_addresses.find((e) => e.id === user.primary_email_address_id) ??
    user.email_addresses[0] ??
    null;
  if (!primary) return null;
  if (primary.verification?.status !== "verified") return null;
  return primary.email_address.toLowerCase();
}

// Download every user once; match locally. Filtering via query string
// (?email_address=, ?username=) doesn't work reliably through the
// clerk CLI in a non-TTY environment, but the unfiltered list does.
let ALL_USERS: ClerkUser[] | null = null;

async function loadAllUsers(): Promise<ClerkUser[]> {
  if (ALL_USERS) return ALL_USERS;
  const acc: ClerkUser[] = [];
  const limit = 100;
  for (let offset = 0; offset < 10_000; offset += limit) {
    let list: ClerkUser[];
    try {
      list = await clerkApi<ClerkUser[]>(
        `/users?limit=${limit}&offset=${offset}`,
      );
    } catch {
      break;
    }
    if (!Array.isArray(list) || list.length === 0) break;
    acc.push(...list);
    if (list.length < limit) break;
  }
  ALL_USERS = acc;
  console.log(`(loaded ${acc.length} clerk users)`);
  return acc;
}

async function findUserForLogin(login: string): Promise<ClerkUser | null> {
  const target = login.toLowerCase();
  const users = await loadAllUsers();
  // 1. GitHub OAuth username exact match
  for (const u of users) {
    for (const a of u.external_accounts ?? []) {
      if (
        a.provider === "oauth_github" &&
        a.username?.toLowerCase().trim() === target
      ) {
        return u;
      }
    }
  }
  // 2. Email local-part match
  for (const u of users) {
    for (const e of u.email_addresses ?? []) {
      const local = e.email_address.split("@")[0]?.toLowerCase().trim();
      if (local === target) return u;
    }
  }
  // 3. Display name match (rare but covers e.g. user "Foo Bar" -> github FooBar).
  for (const u of users) {
    const display = `${u.first_name ?? ""}${u.last_name ?? ""}`
      .toLowerCase()
      .replace(/\s+/g, "");
    if (display && display === target) return u;
  }
  return null;
}

async function main() {
  const rows = (await sql`
    SELECT id, slug, status, credit_name, credit_url, owner_email
    FROM submitted_pets
    WHERE owner_id = ${ADMIN_OWNER_ID}
      AND credit_url LIKE 'https://github.com/%'
    ORDER BY created_at DESC
  `) as Array<{
    id: string;
    slug: string;
    status: string;
    credit_name: string | null;
    credit_url: string;
    owner_email: string | null;
  }>;

  console.log(`scanning ${rows.length} admin-owned, github-credited pets`);

  const cache = new Map<string, ClerkUser | null>();
  let relinked = 0;
  let unmatched = 0;

  for (const row of rows) {
    const ghLogin = row.credit_url
      .replace("https://github.com/", "")
      .replace(/\/.*$/, "")
      .trim();
    if (!ghLogin) continue;

    let user = cache.get(ghLogin);
    if (user === undefined) {
      process.stdout.write(`  ${ghLogin} ... `);
      user = await findUserForLogin(ghLogin);
      cache.set(ghLogin, user);
      console.log(
        user
          ? `→ ${user.id} (${pickPrimaryEmail(user) ?? "no verified email"})`
          : "still no clerk user",
      );
    }

    if (!user) {
      unmatched++;
      continue;
    }

    const email = pickPrimaryEmail(user) ?? row.owner_email;
    await db
      .update(schema.submittedPets)
      .set({ ownerId: user.id, ownerEmail: email })
      .where(eq(schema.submittedPets.id, row.id));
    relinked++;
    console.log(`    relinked ${row.slug} (${row.status})`);
  }

  console.log(`\nrelinked: ${relinked}`);
  console.log(`unmatched: ${unmatched}`);
}

await main();
