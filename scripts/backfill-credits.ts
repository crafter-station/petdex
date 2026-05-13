// Backfill credit_name / credit_url / credit_image for existing approved pets
// by fetching each ownerId from Clerk's production Backend API.
//
// Usage:
//   CLERK_SECRET_KEY=sk_live_... bun scripts/backfill-credits.ts
//   bun scripts/backfill-credits.ts --dry          # preview without writing
//
// Idempotent: only updates rows where credit_name IS NULL by default.
// Pass --force to overwrite all.

import { and, eq, isNull, or } from "drizzle-orm";

import { invalidatePetCaches } from "../src/lib/db/cached-aggregates";
import { db, schema } from "../src/lib/db/client";

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry");
const FORCE = args.has("--force");

const CLERK_SECRET = process.env.CLERK_SECRET_KEY;
if (!CLERK_SECRET) {
  console.error("CLERK_SECRET_KEY not set");
  process.exit(1);
}

type ClerkExternalAccount = {
  provider?: string;
  username?: string;
};

type ClerkEmailAddress = {
  email_address?: string;
};

type ClerkUser = {
  id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  image_url: string | null;
  external_accounts?: ClerkExternalAccount[];
  email_addresses?: ClerkEmailAddress[];
  primary_email_address_id?: string | null;
};

async function fetchClerkUser(userId: string): Promise<ClerkUser | null> {
  const res = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
    headers: { Authorization: `Bearer ${CLERK_SECRET}` },
  });
  if (!res.ok) {
    console.warn(
      `  WARN: Clerk fetch ${userId} failed: ${res.status} ${res.statusText}`,
    );
    return null;
  }
  return (await res.json()) as ClerkUser;
}

function buildCredit(user: ClerkUser): {
  name: string;
  url: string | null;
  imageUrl: string | null;
} {
  const username = user.username?.trim() || null;
  const first = user.first_name?.trim() || null;
  const last = user.last_name?.trim() || null;

  // Email prefix fallback: chefuri2@gmail.com -> "chefuri2"
  let emailPrefix: string | null = null;
  const primary =
    user.email_addresses?.find((e) => Boolean(e))?.email_address ??
    user.email_addresses?.[0]?.email_address;
  if (primary?.includes("@")) {
    emailPrefix = primary.split("@")[0]?.trim() || null;
  }

  const name =
    username ??
    (first ? `${first}${last ? ` ${last[0]}.` : ""}` : null) ??
    emailPrefix ??
    "anonymous";

  let url: string | null = null;
  for (const acc of user.external_accounts ?? []) {
    if (!acc.username) continue;
    if (acc.provider === "oauth_x" || acc.provider === "oauth_twitter") {
      url = `https://x.com/${acc.username}`;
      break; // X wins
    }
    if (acc.provider === "oauth_github" && !url) {
      url = `https://github.com/${acc.username}`;
    }
  }

  return { name, url, imageUrl: user.image_url || null };
}

async function main() {
  // Curated pets carry their own credit baked in by the curated backfill,
  // so we only patch community submissions (featured = false).
  const baseWhere = eq(schema.submittedPets.featured, false);
  const where = FORCE
    ? baseWhere
    : and(
        baseWhere,
        or(
          isNull(schema.submittedPets.creditName),
          eq(schema.submittedPets.creditName, ""),
        ),
      );

  const rows = await db.select().from(schema.submittedPets).where(where);

  console.log(
    `${DRY ? "[DRY] " : ""}Backfilling credits for ${rows.length} pets (force=${FORCE})`,
  );

  // Cache per ownerId — many pets share owners (vl.tansky, serhatandic, etc.)
  const cache = new Map<string, ClerkUser | null>();

  const touchedSlugs: string[] = [];
  for (const row of rows) {
    let user = cache.get(row.ownerId);
    if (user === undefined) {
      user = await fetchClerkUser(row.ownerId);
      cache.set(row.ownerId, user);
    }

    if (!user) {
      console.log(`  ${row.slug.padEnd(22)} -> SKIP (clerk user not found)`);
      continue;
    }

    const credit = buildCredit(user);
    console.log(
      `  ${row.slug.padEnd(22)} -> name="${credit.name}" url=${credit.url ?? "-"}`,
    );

    if (DRY) continue;

    await db
      .update(schema.submittedPets)
      .set({
        creditName: credit.name,
        creditUrl: credit.url,
        creditImage: credit.imageUrl,
      })
      .where(eq(schema.submittedPets.id, row.id));
    touchedSlugs.push(row.slug);
  }

  await invalidatePetCaches(...touchedSlugs);

  console.log("done.");
}

await main();
