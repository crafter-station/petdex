// Process the pending pet_collection_requests after the May 2026
// reorg. Three outcomes per request:
//
//   APPROVE  — pet not yet in any collection AND target collection
//              still exists. Insert into pet_collection_items.
//   REJECT   — pet already in another collection (1-pet-1-collection
//              rule from the reorg) OR target collection was deleted.
//              We surface a useful rejection_reason so the owner sees
//              what happened.
//
// Usage:
//   bun --env-file .env.local scripts/process-pending-collection-requests.ts --dry
//   bun --env-file .env.local scripts/process-pending-collection-requests.ts

import { neon } from "@neondatabase/serverless";

import { requiredEnv } from "./env";

const sql = neon(requiredEnv("DATABASE_URL"));
const dryRun = process.argv.includes("--dry");

type PendingRow = {
  id: string;
  collection_id: string;
  pet_slug: string;
  collection_slug: string | null;
  collection_title: string | null;
  current_collection_slug: string | null;
};

const rows = (await sql`
  SELECT
    pcr.id,
    pcr.collection_id,
    pcr.pet_slug,
    pc.slug AS collection_slug,
    pc.title AS collection_title,
    (
      SELECT pc2.slug FROM pet_collection_items pi
      JOIN pet_collections pc2 ON pc2.id = pi.collection_id
      WHERE pi.pet_slug = pcr.pet_slug
      LIMIT 1
    ) AS current_collection_slug
  FROM pet_collection_requests pcr
  LEFT JOIN pet_collections pc ON pc.id = pcr.collection_id
  WHERE pcr.status = 'pending'
  ORDER BY pcr.created_at DESC
`) as PendingRow[];

console.log(
  `\nProcessing ${rows.length} pending requests (mode=${dryRun ? "DRY" : "APPLY"})\n`,
);

let approved = 0;
let rejectedDeleted = 0;
let rejectedAlreadyMember = 0;

for (const r of rows) {
  // Case A: target collection no longer exists
  if (!r.collection_slug) {
    rejectedDeleted++;
    const reason = r.current_collection_slug
      ? `Original target collection was removed in the May 2026 reorg. Pet has been auto-assigned to "${r.current_collection_slug}".`
      : "Original target collection was removed in the May 2026 reorg. Pet is not in any collection — submit a new request.";
    console.log(
      `  REJECT (deleted-target): ${r.pet_slug.padEnd(28)} → ${reason.slice(0, 80)}…`,
    );
    if (!dryRun) {
      await sql`
        UPDATE pet_collection_requests
        SET status = 'rejected',
            decided_at = now(),
            decided_by = 'system:may-2026-reorg',
            rejection_reason = ${reason}
        WHERE id = ${r.id}
      `;
    }
    continue;
  }

  // Case B: pet already in some other collection (1-pet-1-collection)
  if (
    r.current_collection_slug &&
    r.current_collection_slug !== r.collection_slug
  ) {
    rejectedAlreadyMember++;
    const reason = `Pet is already in "${r.current_collection_slug}". Petdex now keeps each pet in a single canonical collection.`;
    console.log(
      `  REJECT (in ${r.current_collection_slug}): ${r.pet_slug.padEnd(28)} → wanted ${r.collection_slug}`,
    );
    if (!dryRun) {
      await sql`
        UPDATE pet_collection_requests
        SET status = 'rejected',
            decided_at = now(),
            decided_by = 'system:may-2026-reorg',
            rejection_reason = ${reason}
        WHERE id = ${r.id}
      `;
    }
    continue;
  }

  // Case C: pet not in any collection AND target exists → approve
  approved++;
  console.log(`  APPROVE: ${r.pet_slug.padEnd(28)} → ${r.collection_slug}`);
  if (!dryRun) {
    // Add to collection
    await sql`
      INSERT INTO pet_collection_items (collection_id, pet_slug, position)
      VALUES (${r.collection_id}, ${r.pet_slug},
        coalesce(
          (SELECT max(position) + 1 FROM pet_collection_items WHERE collection_id = ${r.collection_id}),
          0
        )
      )
      ON CONFLICT (collection_id, pet_slug) DO NOTHING
    `;
    await sql`
      UPDATE pet_collection_requests
      SET status = 'approved',
          decided_at = now(),
          decided_by = 'system:may-2026-reorg'
      WHERE id = ${r.id}
    `;
  }
}

console.log(
  `\nApproved: ${approved}` +
    ` | Rejected (deleted target): ${rejectedDeleted}` +
    ` | Rejected (already member): ${rejectedAlreadyMember}`,
);
