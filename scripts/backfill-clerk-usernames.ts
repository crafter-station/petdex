// One-shot backfill: for every user_profiles row with a non-null
// handle, update Clerk's username field to match. Avoids the divergence
// that broke Thib's avatar dropdown (DB handle "thibgl" but Clerk
// username null → AuthBadge fallback to /u/<id-slice> → 404).
//
// Run:
//   bun --env-file .env.local --env-file .env.production.local \
//     scripts/backfill-clerk-usernames.ts [--dry] [--limit=N]

import { clerkClient } from "@clerk/nextjs/server";
import { neon } from "@neondatabase/serverless";

import { requiredEnv } from "./env";

const sql = neon(requiredEnv("DATABASE_URL"));
const dryRun = process.argv.includes("--dry");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;

type Row = { user_id: string; handle: string };

const rows = (await sql`
  SELECT user_id, handle
  FROM user_profiles
  WHERE handle IS NOT NULL AND length(handle) > 0
  ORDER BY updated_at DESC
`) as Row[];

// Skip auto-generated fallback handles (last 8 chars of the user id,
// lowercased). Those weren't picked by the user — they're the
// "anonymous" placeholder from the AuthBadge fallback path. Pushing
// them into Clerk would pollute Clerk usernames with id slices.
const todoAll = rows.filter((r) => {
  const idTail = r.user_id.slice(-8).toLowerCase();
  return r.handle.toLowerCase() !== idTail;
});

console.log(
  `Found ${rows.length} profiles with a handle, ${todoAll.length} are user-picked (not id-slice).`,
);
const todo = todoAll.slice(0, limit);

let synced = 0;
let alreadyMatched = 0;
let failed = 0;

const cc = await clerkClient();

for (const row of todo) {
  let user: Awaited<ReturnType<typeof cc.users.getUser>> | undefined;
  try {
    user = await cc.users.getUser(row.user_id);
  } catch (err) {
    console.warn(`  miss ${row.user_id}: ${(err as Error).message}`);
    failed++;
    continue;
  }

  const current = user.username ?? null;
  if (current === row.handle) {
    alreadyMatched++;
    continue;
  }

  console.log(
    `  ${row.user_id.slice(-12)} | clerk=${current ?? "null"} → db=${row.handle}`,
  );

  if (dryRun) continue;

  try {
    await cc.users.updateUser(row.user_id, { username: row.handle });
    synced++;
  } catch (err) {
    const msg = (err as Error).message;
    console.warn(`    failed: ${msg}`);
    failed++;
  }
}

console.log(
  `\ndone (mode=${dryRun ? "DRY" : "APPLY"}). synced=${synced} | already-matched=${alreadyMatched} | failed=${failed}`,
);
