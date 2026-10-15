import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";

import { runtimeDb as db, schema } from "../src/lib/db/runtime";

process.env.PETDEX_REVIEW_DB = "runtime";

const LIMIT = readNumberFlag("--limit");
const FORCE = process.argv.includes("--force");
const CONCURRENCY = Math.min(
  Math.max(readNumberFlag("--concurrency") ?? 2, 1),
  4,
);
const STALE_RUNNING_MINUTES = 60;

type ReviewError = { slug: string; reason: string };
type ReviewRow = { id: string; slug: string; latestDecision: string | null };

const errors: ReviewError[] = [];

async function main() {
  const { reviewSubmission } = await import("../src/lib/submission-review");
  await buryStaleRunningReviews();

  const latestReviews = db
    .select({
      submittedPetId: schema.submissionReviews.submittedPetId,
      decision: schema.submissionReviews.decision,
      rank: sql<number>`row_number() over (partition by ${schema.submissionReviews.submittedPetId} order by ${schema.submissionReviews.createdAt} desc)`.as(
        "rank",
      ),
    })
    .from(schema.submissionReviews)
    .as("latest_reviews");

  const rows: ReviewRow[] = await db
    .select({
      id: schema.submittedPets.id,
      slug: schema.submittedPets.slug,
      latestDecision: latestReviews.decision,
    })
    .from(schema.submittedPets)
    .leftJoin(
      latestReviews,
      and(
        eq(latestReviews.submittedPetId, schema.submittedPets.id),
        eq(latestReviews.rank, 1),
      ),
    )
    .where(
      and(
        eq(schema.submittedPets.status, "pending"),
        or(
          sql`${latestReviews.decision} IS NULL`,
          inArray(latestReviews.decision, ["hold", "no_decision"]),
        ),
      ),
    )
    .orderBy(desc(schema.submittedPets.createdAt))
    .limit(LIMIT ?? 500);

  const heldCount = rows.filter((row) => row.latestDecision === "hold").length;
  console.log(
    `reviewing ${rows.length} pending/held submissions (${heldCount} held) with concurrency=${CONCURRENCY} force=${FORCE}`,
  );

  let nextIndex = 0;
  let processed = 0;

  async function worker(workerId: number) {
    while (true) {
      const index = nextIndex++;
      if (index >= rows.length) return;
      const row = rows[index];
      try {
        const result = await reviewSubmission(row.id, {
          force: FORCE || row.latestDecision === "hold",
        });
        processed += 1;
        console.log(
          `[${index + 1}/${rows.length}] worker=${workerId} ${row.slug} -> ${result.review.decision} (${result.review.reasonCode ?? "no_reason"}) applied=${result.applied} reused=${Boolean(result.reused)}${result.review.error ? ` error=${result.review.error}` : ""}`,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        errors.push({ slug: row.slug, reason });
        console.log(
          `[${index + 1}/${rows.length}] ${row.slug} -> ERROR ${reason}`,
        );
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(CONCURRENCY, rows.length || 1) },
      (_, index) => worker(index + 1),
    ),
  );

  console.log(`done processed=${processed} errors=${errors.length}`);
  if (errors.length > 0) {
    console.log("errors:");
    for (const error of errors) {
      console.log(`- ${error.slug}: ${error.reason}`);
    }
    // Each row here is decision-mutating (`reviewSubmission` can approve or
    // reject through `applySubmissionAction`), so a partially-failed run left
    // that many submissions unreviewed. A bare exit 0 hides it from any wrapper
    // or operator reading the exit code, which is the same convention
    // `takedown-by-keyword` and the backfill scripts follow.
    console.error(`\nDone with ${errors.length} error(s).`);
    process.exit(1);
  }
}

async function buryStaleRunningReviews() {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MINUTES * 60 * 1000);
  const now = new Date();
  const rows = await db
    .update(schema.submissionReviews)
    .set({
      status: "failed",
      decision: "hold",
      reasonCode: "review_interrupted",
      summary: "Automated review was interrupted and needs manual review.",
      confidence: 0,
      error: "Review worker stopped before completion.",
      reviewedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        lt(schema.submissionReviews.createdAt, cutoff),
        eq(schema.submissionReviews.status, "running"),
      ),
    )
    .returning({ id: schema.submissionReviews.id });
  if (rows.length > 0) {
    console.log(`buried ${rows.length} stale running review(s)`);
  }
}

function readNumberFlag(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const raw = process.argv[index + 1];
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) ? value : undefined;
}

await main();
