// The voter preview on /requests: the newest `visiblePerRequest` voters for
// each of `requestIds`, requester's own vote excluded so `rn` counts real
// voters.
//
// This lives in its own module (not inside the page) so it can be driven
// against a real Postgres by the test beside it — the per-request cap is
// exactly the sort of property a mock can only restate. The page used to
// select *every* vote row for its 80 listed requests and discard all but
// three in JS, which grows without bound as one popular request collects
// upvotes; the ranking happens in SQL instead.

import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

// Type-only import: erased at runtime, so importing this module never pulls
// in @/lib/db/client (which hard-fails without DATABASE_URL — the test next
// door has its own PGlite connection).
import type { db as dbClient } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";

type Db = typeof dbClient;

export type RequestVotePreview = {
  requestId: string;
  userId: string;
};

export async function fetchVisibleRequestVotes(
  db: Db,
  requestIds: string[],
  visiblePerRequest: number,
): Promise<RequestVotePreview[]> {
  if (requestIds.length === 0) return [];

  const rankedVotes = db.$with("ranked_votes").as(
    db
      .select({
        requestId: schema.petRequestVotes.requestId,
        userId: schema.petRequestVotes.userId,
        rn: sql<number>`ROW_NUMBER() OVER (
          PARTITION BY ${schema.petRequestVotes.requestId}
          ORDER BY ${schema.petRequestVotes.createdAt} DESC
        )`.as("rn"),
      })
      .from(schema.petRequestVotes)
      .innerJoin(
        schema.petRequests,
        eq(schema.petRequests.id, schema.petRequestVotes.requestId),
      )
      .where(
        and(
          inArray(schema.petRequestVotes.requestId, requestIds),
          or(
            isNull(schema.petRequests.requestedBy),
            ne(schema.petRequestVotes.userId, schema.petRequests.requestedBy),
          ),
        ),
      ),
  );

  const rows = await db
    .with(rankedVotes)
    .select({
      requestId: rankedVotes.requestId,
      userId: rankedVotes.userId,
    })
    .from(rankedVotes)
    .where(sql`${rankedVotes.rn} <= ${visiblePerRequest}`)
    .orderBy(sql`request_id, rn`);

  return rows as RequestVotePreview[];
}
