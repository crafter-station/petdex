// Server-only batch helpers. Imports the Drizzle client, so it must
// never reach a client bundle. Pair with `dex-batch.ts` which holds
// the pure-JS helpers safe for browsers.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";

export async function getAvailableBatches(): Promise<
  Array<{ key: string; count: number }>
> {
  const result = await db.execute<{ key: string; count: number }>(sql`
    SELECT
      to_char(date_trunc('month', approved_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS key,
      count(*)::int AS count
    FROM submitted_pets
    WHERE status = 'approved' AND source != 'discover'
    GROUP BY 1
    ORDER BY 1 DESC
  `);

  // No `label`: this runs inside a locale-agnostic cached aggregate, so any
  // month name built here would be frozen in one language for every visitor.
  // The client derives the label from `key` with the active locale.
  return (result.rows ?? []).map((row) => ({
    key: row.key,
    count: row.count,
  }));
}
