import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import { generateText } from "ai";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import JSZip from "jszip";
import sharp from "sharp";

import type { SubmissionReview, SubmittedPet } from "@/lib/db/schema";
import {
  buildPetEmbeddingText,
  embeddingVectorLiteral,
  embedTextValue,
  PETDEX_EMBEDDING_MODEL,
} from "@/lib/embeddings";
import {
  petSecurityPathSegment,
  scanPetManifestsSecurity,
  scanPetSecurity,
} from "@/lib/pet-security";
import { decideAutomatedReview } from "@/lib/submission-review-decision";
import { preparePolicyReviewImage } from "@/lib/submission-review-image";
import {
  buildPolicyPrompt,
  REVIEW_POLICY_CATEGORIES,
} from "@/lib/submission-review-policy";
import type {
  PolicyFlag,
  ReviewCheckDecision,
  ReviewChecks,
  ReviewEvidenceMatch,
  SubmissionReviewDecision,
} from "@/lib/submission-review-types";
import {
  SUBMISSION_DUPLICATE_REVIEW_SEMANTIC_HOLD_THRESHOLD,
  SUBMISSION_NEAR_EXACT_VISUAL_THRESHOLD,
  SUBMISSION_SIMILARITY_MAX_RESULTS,
  SUBMISSION_SIMILARITY_SEMANTIC_THRESHOLD,
  SUBMISSION_SIMILARITY_VISUAL_THRESHOLD,
  SUBMISSION_STRONG_SEMANTIC_CORROBORATION_THRESHOLD,
} from "@/lib/submission-similarity";
import { isAllowedAssetUrl } from "@/lib/url-allowlist";

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 80;
const MAX_ZIP_PET_JSON_SCAN_ENTRIES = 16;
const MAX_ZIP_PET_JSON_TOTAL_BYTES = MAX_ASSET_BYTES;
const MIN_SPRITE_DIM = 256;
const FRAME_W = 192;
const FRAME_H = 208;
const REVIEW_MODEL = "openai/gpt-5-mini";
const VISUAL_MATCH_CHUNK_SIZE = 250;
const VISUAL_MATCH_SCAN_LIMIT = 2000;
const REVIEW_FETCH_TIMEOUT_MS = 10_000;
const POLICY_MODEL_TIMEOUT_MS = 15_000;
const POLICY_PET_JSON_TEXT_LIMIT = 240;
const POLICY_PET_JSON_LIST_LIMIT = 16;
const POLICY_PET_JSON_STATE_LIMIT = 12;

type DbModule = typeof import("@/lib/db/client");

export type ReviewSubmissionOptions = {
  force?: boolean;
};

export type ReviewSubmissionResult = {
  review: SubmissionReview;
  applied: boolean;
  reused?: boolean;
};

type AssetAnalysis = {
  check: ReviewChecks["assets"];
  security: NonNullable<ReviewChecks["security"]>;
  spriteBuffer: Buffer | null;
  petJson: unknown;
  dhash: string | null;
};

type ZipPetJson = {
  name: string;
  petJson: unknown;
};

type VisualMatchScan = {
  matches: ReviewEvidenceMatch[];
  complete: boolean;
  scanned: number;
};

async function getDbModule(): Promise<DbModule> {
  if (process.env.PETDEX_REVIEW_DB === "runtime") {
    const runtime = await import("@/lib/db/runtime");
    return { db: runtime.runtimeDb, schema: runtime.schema } as DbModule;
  }
  return await import("@/lib/db/client");
}

export function triggerSubmissionReview(submissionId: string): void {
  void reviewSubmission(submissionId).catch((err) => {
    console.warn(
      "[submission-review] review trigger failed:",
      (err as Error).message,
    );
  });
}

export async function reviewSubmission(
  submissionId: string,
  options: ReviewSubmissionOptions = {},
): Promise<ReviewSubmissionResult> {
  const { db, schema } = await getDbModule();
  if (!options.force) {
    const latestReview = await db.query.submissionReviews.findFirst({
      where: eq(schema.submissionReviews.submittedPetId, submissionId),
      orderBy: desc(schema.submissionReviews.createdAt),
    });
    if (latestReview) {
      return {
        review: latestReview,
        applied: reviewWasApplied(latestReview),
        reused: true,
      };
    }
  }

  const reviewId = `review_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
  let checks = emptyChecks(false);

  await db.insert(schema.submissionReviews).values({
    id: reviewId,
    submittedPetId: submissionId,
    status: "running",
    decision: "no_decision",
    reasonCode: "running",
    summary: "Automated review is running.",
    checks,
    dryRun: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  try {
    const row = await db.query.submittedPets.findFirst({
      where: eq(schema.submittedPets.id, submissionId),
    });
    if (!row) {
      return await finishReview(reviewId, {
        checks,
        decision: "hold",
        reasonCode: "submission_not_found",
        summary: "Submission no longer exists.",
        confidence: 0,
        status: "failed",
        error: "not_found",
        applied: false,
      });
    }

    const assets = await analyzeAssets(row);
    await persistAssetSignals(row.id, assets);

    let policy: ReviewChecks["policy"] = {
      decision: "hold",
      confidence: 0,
      reasons: ["Skipped because security review failed."],
      flags: [],
    };
    let duplicates: ReviewChecks["duplicates"] = {
      decision: "hold",
      reasons: ["Skipped because security review failed."],
      exactMatches: [],
      visualMatches: [],
      semanticMatches: [],
      metadataMatches: [],
    };
    if (assets.security?.decision !== "fail") {
      [policy, duplicates] = await Promise.all([
        analyzePolicy(row, assets),
        analyzeDuplicates(row, assets),
      ]);
    }

    checks = {
      security: assets.security,
      assets: assets.check,
      policy,
      duplicates,
      autopilot: { applied: false, dryRun: false, reason: null },
    };

    const decision = decideAutomatedReview(checks);
    checks.autopilot.reason = decision.applyReason;

    let applied = false;
    if (decision.canApply && row.status === "pending") {
      const latestReview = await db.query.submissionReviews.findFirst({
        where: eq(schema.submissionReviews.submittedPetId, row.id),
        orderBy: desc(schema.submissionReviews.createdAt),
      });
      if (latestReview?.id !== reviewId) {
        checks.autopilot.reason = "review_superseded";
      } else {
        const { applySubmissionAction } = await import(
          "@/lib/submission-decisions"
        );
        const actionResult = await applySubmissionAction(
          row.id,
          decision.decision === "auto_approve"
            ? { action: "approve" }
            : {
                action: "reject",
                reason: rejectionReasonForDecision(decision),
              },
          {
            actor: "auto-review",
            db,
            skipSideEffects: process.env.PETDEX_REVIEW_DB === "runtime",
            skipNotifications: process.env.PETDEX_REVIEW_DB === "runtime",
          },
        );
        applied = actionResult.ok;
        checks.autopilot.applied = applied;
        if (!actionResult.ok) {
          checks.autopilot.reason = actionResult.body.error;
        }
      }
    } else if (decision.canApply && row.status !== "pending") {
      checks.autopilot.reason = "submission_not_pending";
    }

    return await finishReview(reviewId, {
      checks,
      decision: decision.decision,
      reasonCode: decision.reasonCode,
      summary: decision.summary,
      confidence: decision.confidence,
      status: "completed",
      error: null,
      applied,
    });
  } catch (err) {
    const message =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    checks.autopilot.reason = "review_failed";
    return await finishReview(reviewId, {
      checks,
      decision: "hold",
      reasonCode: "review_failed",
      summary: "Automated review failed and needs manual review.",
      confidence: 0,
      status: "failed",
      error: message.slice(0, 1000),
      applied: false,
    });
  }
}

export async function recordSubmissionReviewHold(
  submittedPetId: string,
  args: {
    reasonCode: string;
    summary: string;
    error?: string | null;
    status?: "completed" | "failed";
  },
): Promise<ReviewSubmissionResult> {
  const { db, schema } = await getDbModule();
  const now = new Date();
  const checks = emptyChecks(false);
  checks.autopilot.reason = args.reasonCode;
  const [review] = await db
    .insert(schema.submissionReviews)
    .values({
      id: `review_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`,
      submittedPetId,
      status: args.status ?? "failed",
      decision: "hold",
      reasonCode: args.reasonCode,
      summary: args.summary,
      confidence: 0,
      checks,
      model: REVIEW_MODEL,
      dryRun: false,
      error: args.error?.slice(0, 1000) ?? null,
      reviewedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!review) {
    throw new Error("failed to record automated review hold");
  }
  return { review, applied: false };
}

export async function getLatestSubmissionReview(
  submittedPetId: string,
): Promise<SubmissionReview | null> {
  const { db, schema } = await getDbModule();
  const row = await db.query.submissionReviews.findFirst({
    where: eq(schema.submissionReviews.submittedPetId, submittedPetId),
    orderBy: desc(schema.submissionReviews.createdAt),
  });
  return row ?? null;
}

function reviewWasApplied(review: SubmissionReview): boolean {
  return Boolean(review.checks?.autopilot?.applied);
}

async function finishReview(
  reviewId: string,
  args: {
    checks: ReviewChecks;
    decision: SubmissionReviewDecision;
    reasonCode: string;
    summary: string;
    confidence: number;
    status: "completed" | "failed";
    error: string | null;
    applied: boolean;
  },
): Promise<ReviewSubmissionResult> {
  const { db, schema } = await getDbModule();
  const [review] = await db
    .update(schema.submissionReviews)
    .set({
      status: args.status,
      decision: args.decision,
      reasonCode: args.reasonCode,
      summary: args.summary,
      confidence: Math.round(Math.max(0, Math.min(1, args.confidence)) * 100),
      checks: args.checks,
      model: REVIEW_MODEL,
      error: args.error,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.submissionReviews.id, reviewId))
    .returning();

  if (!review) {
    throw new Error(`review ${reviewId} disappeared before completion`);
  }
  return { review, applied: args.applied };
}

function rejectionReasonForDecision(decision: {
  reasonCode: string;
  summary: string;
}): string {
  if (decision.reasonCode.startsWith("security_")) return decision.summary;
  return "This submission appears to duplicate an existing pet pack. If you believe this is incorrect, contact support with the submission ID.";
}

async function analyzeAssets(row: SubmittedPet): Promise<AssetAnalysis> {
  const reasons: string[] = [];
  const [sprite, petJson, zip] = await Promise.all([
    fetchAllowedBuffer(row.spritesheetUrl, MAX_ASSET_BYTES, "sprite"),
    fetchAllowedBuffer(row.petJsonUrl, MAX_ASSET_BYTES, "pet.json"),
    fetchAllowedBuffer(row.zipUrl, MAX_ASSET_BYTES, "zip"),
  ]);

  for (const result of [sprite, petJson, zip]) {
    if (!result.ok) reasons.push(result.reason);
  }

  let parsedJson: unknown = null;
  if (petJson.ok) {
    try {
      parsedJson = JSON.parse(petJson.buffer.toString("utf8"));
    } catch {
      reasons.push("pet.json could not be parsed as JSON.");
    }
  }

  const zipPetJsons: ZipPetJson[] = [];
  if (zip.ok) {
    try {
      const archive = await JSZip.loadAsync(zip.buffer);
      const names = Object.keys(archive.files);
      if (names.length > MAX_ZIP_ENTRIES) {
        reasons.push(`zip contains too many entries (${names.length}).`);
      }
      if (names.some(hasUnsafeZipPath)) {
        reasons.push("zip contains unsafe paths.");
      }
      const petJsonNames = names.filter((name) => {
        const file = archive.files[name];
        return !file?.dir && name.split("/").pop() === "pet.json";
      });
      if (petJsonNames.length === 0) {
        reasons.push("zip does not contain pet.json.");
      } else {
        if (petJsonNames.length > 1) {
          reasons.push("zip contains multiple pet.json files.");
        }
        let zipPetJsonTotalBytes = 0;
        for (const name of petJsonNames) {
          if (zipPetJsons.length >= MAX_ZIP_PET_JSON_SCAN_ENTRIES) {
            reasons.push("zip pet.json scan entry limit reached.");
            break;
          }
          const entry = archive.files[name];
          const size = zipEntryUncompressedSize(entry);
          if (
            size !== null &&
            zipPetJsonTotalBytes + size > MAX_ZIP_PET_JSON_TOTAL_BYTES
          ) {
            reasons.push("zip pet.json total size exceeds the scan limit.");
            break;
          }
          const zipped = await readZipPetJson(entry, MAX_ASSET_BYTES);
          if (zipped.ok) {
            zipPetJsons.push({ name, petJson: zipped.petJson });
            zipPetJsonTotalBytes += size ?? 0;
          } else {
            reasons.push(`zip ${name}: ${zipped.reason}`);
          }
        }
      }
      const basenames = new Set(names.map((name) => name.split("/").pop()));
      if (
        !basenames.has("spritesheet.webp") &&
        !basenames.has("spritesheet.png")
      ) {
        reasons.push(
          "zip does not contain spritesheet.webp or spritesheet.png.",
        );
      }
    } catch {
      reasons.push("zip could not be read.");
    }
  }

  let dhash: string | null = null;
  if (sprite.ok) {
    try {
      const metadata = await sharp(sprite.buffer).metadata();
      if (
        !metadata.width ||
        !metadata.height ||
        metadata.width < MIN_SPRITE_DIM ||
        metadata.height < MIN_SPRITE_DIM
      ) {
        reasons.push("spritesheet dimensions are below the minimum size.");
      }
      dhash = await dhashFromSpriteBuffer(sprite.buffer);
      if (!dhash)
        reasons.push("spritesheet perceptual hash could not be computed.");
    } catch {
      reasons.push("spritesheet could not be decoded.");
    }
  }

  const hashes = {
    spriteSha256: sprite.ok ? sha256(sprite.buffer) : null,
    petJsonSha256: petJson.ok ? sha256(petJson.buffer) : null,
    zipSha256: zip.ok ? sha256(zip.buffer) : null,
  };
  const security = scanPetManifestsSecurity({
    petJson: parsedJson,
    zipPetJson: zipPetJsons[0]?.petJson,
    displayName: row.displayName,
    description: row.description,
  });
  for (const entry of zipPetJsons.slice(1)) {
    appendZipPetJsonSecurity(security, entry);
  }

  return {
    check: {
      decision: reasons.length === 0 ? "pass" : "hold",
      reasons,
      hashes,
    },
    security,
    spriteBuffer: sprite.ok ? sprite.buffer : null,
    petJson: parsedJson,
    dhash,
  };
}

function appendZipPetJsonSecurity(
  security: NonNullable<ReviewChecks["security"]>,
  entry: ZipPetJson,
) {
  const entryScan = scanPetSecurity({ petJson: entry.petJson });
  const entryName = petSecurityPathSegment(entry.name);
  security.findings.push(
    ...entryScan.findings.map((finding) => ({
      ...finding,
      path: `zip.petJson[${JSON.stringify(entryName)}]${finding.path === "$" ? "" : finding.path.startsWith("$") ? finding.path.slice(1) : `.${finding.path}`}`,
    })),
  );
  security.reasons.push(
    ...entryScan.findings.map(
      (finding) => `zip ${entryName}: ${finding.code}: ${finding.evidence}`,
    ),
  );
  if (entryScan.decision === "fail") security.decision = "fail";
  if (security.decision === "pass" && entryScan.decision === "hold") {
    security.decision = "hold";
  }
}

async function analyzePolicy(
  row: SubmittedPet,
  assets: AssetAnalysis,
): Promise<ReviewChecks["policy"]> {
  if (!assets.spriteBuffer) {
    return {
      decision: "hold",
      confidence: 0,
      reasons: ["Sprite image was unavailable for policy review."],
      flags: [],
    };
  }

  const image = await preparePolicyReviewImage(assets.spriteBuffer);
  if (!image.ok) {
    return {
      decision: "hold",
      confidence: 0,
      reasons: [image.reason],
      flags: [],
    };
  }

  try {
    const result = await generateText({
      model: REVIEW_MODEL,
      system: buildPolicyPrompt(),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildPolicyUserPrompt(row, assets.petJson) },
            { type: "image", image: image.dataUrl },
          ],
        },
      ],
      abortSignal: AbortSignal.timeout(POLICY_MODEL_TIMEOUT_MS),
    });
    return validatePolicyResponse(result.text);
  } catch (err) {
    return {
      decision: "hold",
      confidence: 0,
      reasons: [
        `Policy classifier failed: ${(err as Error).message.slice(0, 160)}`,
      ],
      flags: [],
    };
  }
}

async function analyzeDuplicates(
  row: SubmittedPet,
  assets: AssetAnalysis,
): Promise<ReviewChecks["duplicates"]> {
  const reasons: string[] = [];
  const hashValues = assets.check.hashes;
  const exactMatchResult = hashValues
    ? await findExactHashMatches(row, hashValues)
    : [];
  const exactMatches = exactMatchResult ?? [];
  if (exactMatchResult === null) {
    reasons.push("Exact hash duplicate check did not complete.");
  }

  const [visualScan, metadataMatches] = await Promise.all([
    assets.dhash
      ? findVisualMatches(row, assets.dhash)
      : Promise.resolve({ matches: [], complete: true, scanned: 0 }),
    findMetadataMatches(row),
  ]);
  const visualMatches = visualScan.matches;
  if (!visualScan.complete) {
    reasons.push(
      `Visual duplicate check scanned ${visualScan.scanned} candidates and needs manual review.`,
    );
  }

  const embedding = await embedTextValue(
    buildPetEmbeddingText({
      displayName: row.displayName,
      description: row.description,
      kind: row.kind,
      tags: (row.tags as string[]) ?? [],
      vibes: (row.vibes as string[]) ?? [],
    }),
  );
  if (embedding) {
    await persistPetEmbedding(row.id, embedding).catch(() => {
      reasons.push("Semantic embedding could not be persisted.");
    });
  }

  const semanticMatches = embedding
    ? await findSemanticMatches(row.id).catch(() => {
        reasons.push("Semantic duplicate check failed.");
        return [] as ReviewEvidenceMatch[];
      })
    : [];
  if (!embedding) {
    reasons.push("Semantic duplicate check did not complete.");
  }

  const metadataById = new Map(
    metadataMatches.map((match) => [match.id, match]),
  );
  for (const match of visualMatches) {
    const metadata = metadataById.get(match.id);
    if (metadata?.matchedFields?.length) {
      match.matchedFields = metadata.matchedFields;
    }
  }

  const duplicateDecision = duplicateCheckDecision({
    reasons,
    exactMatches,
    visualMatches,
    semanticMatches,
    metadataMatches,
  });

  return {
    decision: duplicateDecision,
    reasons,
    exactMatches,
    visualMatches,
    semanticMatches,
    metadataMatches,
  };
}

async function persistAssetSignals(
  petId: string,
  assets: AssetAnalysis,
): Promise<void> {
  const { db, schema } = await getDbModule();
  await db
    .update(schema.submittedPets)
    .set({
      dhash: assets.dhash,
    })
    .where(eq(schema.submittedPets.id, petId));

  if (!process.env.DATABASE_URL || !assets.check.hashes) return;
  try {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(process.env.DATABASE_URL);
    await sql`
      UPDATE submitted_pets
      SET sprite_sha256 = ${assets.check.hashes.spriteSha256},
          pet_json_sha256 = ${assets.check.hashes.petJsonSha256},
          zip_sha256 = ${assets.check.hashes.zipSha256}
      WHERE id = ${petId}
    `;
  } catch {
    // Hash columns are deployed by migration. Until then, review still works
    // with dHash + metadata + policy and holds instead of auto-approving.
  }
}

async function findExactHashMatches(
  row: SubmittedPet,
  hashes: NonNullable<ReviewChecks["assets"]["hashes"]>,
): Promise<ReviewEvidenceMatch[] | null> {
  if (
    !process.env.DATABASE_URL ||
    (!hashes.spriteSha256 && !hashes.petJsonSha256 && !hashes.zipSha256)
  ) {
    return null;
  }

  try {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(process.env.DATABASE_URL);
    const rows = (await sql`
      SELECT id, slug, display_name, status, featured, spritesheet_url,
             sprite_sha256, pet_json_sha256, zip_sha256
      FROM submitted_pets
      WHERE id <> ${row.id}
        AND status = 'approved'
        AND (
          (${hashes.spriteSha256}::text IS NOT NULL AND sprite_sha256 = ${hashes.spriteSha256}) OR
          (${hashes.petJsonSha256}::text IS NOT NULL AND pet_json_sha256 = ${hashes.petJsonSha256}) OR
          (${hashes.zipSha256}::text IS NOT NULL AND zip_sha256 = ${hashes.zipSha256})
        )
    `) as Array<{
      id: string;
      slug: string;
      display_name: string;
      status: string;
      featured: boolean;
      spritesheet_url: string | null;
      sprite_sha256: string | null;
      pet_json_sha256: string | null;
      zip_sha256: string | null;
    }>;

    return rows.map((match) => ({
      id: match.id,
      slug: match.slug,
      displayName: match.display_name,
      status: match.status,
      featured: match.featured,
      spritesheetUrl: match.spritesheet_url,
      reason: "Exact asset hash match.",
      matchedFields: [
        hashes.spriteSha256 && match.sprite_sha256 === hashes.spriteSha256
          ? "spriteSha256"
          : null,
        hashes.petJsonSha256 && match.pet_json_sha256 === hashes.petJsonSha256
          ? "petJsonSha256"
          : null,
        hashes.zipSha256 && match.zip_sha256 === hashes.zipSha256
          ? "zipSha256"
          : null,
      ].filter((field): field is string => Boolean(field)),
    }));
  } catch {
    return null;
  }
}

async function findVisualMatches(
  row: SubmittedPet,
  dhash: string,
): Promise<VisualMatchScan> {
  const { db, schema } = await getDbModule();
  const matches: ReviewEvidenceMatch[] = [];
  let scanned = 0;
  let complete = false;

  for (
    let offset = 0;
    offset < VISUAL_MATCH_SCAN_LIMIT;
    offset += VISUAL_MATCH_CHUNK_SIZE
  ) {
    const rows = await db
      .select({
        id: schema.submittedPets.id,
        slug: schema.submittedPets.slug,
        displayName: schema.submittedPets.displayName,
        status: schema.submittedPets.status,
        featured: schema.submittedPets.featured,
        spritesheetUrl: schema.submittedPets.spritesheetUrl,
        dhash: schema.submittedPets.dhash,
      })
      .from(schema.submittedPets)
      .where(
        and(
          ne(schema.submittedPets.id, row.id),
          eq(schema.submittedPets.status, "approved"),
          isNotNull(schema.submittedPets.dhash),
        ),
      )
      .orderBy(desc(schema.submittedPets.createdAt))
      .limit(VISUAL_MATCH_CHUNK_SIZE)
      .offset(offset);

    scanned += rows.length;
    for (const match of rows) {
      const visualDistance = hammingDistanceHex(dhash, match.dhash ?? "0");
      if (visualDistance <= SUBMISSION_SIMILARITY_VISUAL_THRESHOLD) {
        matches.push({
          id: match.id,
          slug: match.slug,
          displayName: match.displayName,
          status: match.status,
          featured: match.featured,
          spritesheetUrl: match.spritesheetUrl,
          visualDistance,
        });
      }
    }

    if (rows.length < VISUAL_MATCH_CHUNK_SIZE) {
      complete = true;
      break;
    }
    if (matches.length >= SUBMISSION_SIMILARITY_MAX_RESULTS) break;
  }

  matches.sort((a, b) => (a.visualDistance ?? 65) - (b.visualDistance ?? 65));
  return {
    matches: matches.slice(0, SUBMISSION_SIMILARITY_MAX_RESULTS),
    complete,
    scanned,
  };
}

async function findMetadataMatches(
  row: SubmittedPet,
): Promise<ReviewEvidenceMatch[]> {
  const { db, schema } = await getDbModule();
  const rows = await db
    .select({
      id: schema.submittedPets.id,
      slug: schema.submittedPets.slug,
      displayName: schema.submittedPets.displayName,
      status: schema.submittedPets.status,
      featured: schema.submittedPets.featured,
      spritesheetUrl: schema.submittedPets.spritesheetUrl,
      ownerId: schema.submittedPets.ownerId,
      creditName: schema.submittedPets.creditName,
      creditUrl: schema.submittedPets.creditUrl,
      kind: schema.submittedPets.kind,
    })
    .from(schema.submittedPets)
    .where(
      and(
        ne(schema.submittedPets.id, row.id),
        eq(schema.submittedPets.status, "approved"),
      ),
    );

  const rowName = normalizeText(row.displayName);
  const rowCreditName = normalizeText(row.creditName ?? "");
  const out: ReviewEvidenceMatch[] = [];
  for (const match of rows) {
    const matchedFields: string[] = [];
    if (
      normalizeText(match.displayName) === rowName &&
      match.kind === row.kind
    ) {
      matchedFields.push("displayName", "kind");
    }
    if (
      match.ownerId === row.ownerId &&
      normalizeText(match.displayName) === rowName
    ) {
      matchedFields.push("ownerId");
    }
    if (row.creditUrl && match.creditUrl === row.creditUrl) {
      matchedFields.push("creditUrl");
    }
    if (
      rowCreditName &&
      normalizeText(match.creditName ?? "") === rowCreditName
    ) {
      matchedFields.push("creditName");
    }
    if (matchedFields.length > 0) {
      out.push({
        id: match.id,
        slug: match.slug,
        displayName: match.displayName,
        status: match.status,
        featured: match.featured,
        spritesheetUrl: match.spritesheetUrl,
        reason: `Metadata overlaps on ${[...new Set(matchedFields)].join(", ")}.`,
        matchedFields: [...new Set(matchedFields)],
      });
    }
  }
  return out;
}

async function findSemanticMatches(
  petId: string,
): Promise<ReviewEvidenceMatch[]> {
  if (!process.env.DATABASE_URL) return [];
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);
  const rows = (await sql`
    SELECT id, slug, display_name, status, featured, spritesheet_url,
           1 - (embedding <=> (SELECT embedding FROM submitted_pets WHERE id = ${petId} AND embedding_model = ${PETDEX_EMBEDDING_MODEL})) AS similarity
    FROM submitted_pets
    WHERE embedding IS NOT NULL
      AND embedding_model = ${PETDEX_EMBEDDING_MODEL}
      AND id <> ${petId}
      AND status = 'approved'
    ORDER BY similarity DESC
    LIMIT 30
  `) as Array<{
    id: string;
    slug: string;
    display_name: string;
    status: string;
    featured: boolean;
    spritesheet_url: string | null;
    similarity: number;
  }>;
  return rows
    .filter(
      (match) => match.similarity >= SUBMISSION_SIMILARITY_SEMANTIC_THRESHOLD,
    )
    .map((match) => ({
      id: match.id,
      slug: match.slug,
      displayName: match.display_name,
      status: match.status,
      featured: match.featured,
      spritesheetUrl: match.spritesheet_url,
      semanticScore: Number(match.similarity),
    }));
}

function duplicateCheckDecision(args: {
  reasons: string[];
  exactMatches: ReviewEvidenceMatch[];
  visualMatches: ReviewEvidenceMatch[];
  semanticMatches: ReviewEvidenceMatch[];
  metadataMatches: ReviewEvidenceMatch[];
}): ReviewCheckDecision {
  const exactMatch = args.exactMatches.length > 0;
  const identicalMatch = args.visualMatches.some(
    (match) => match.visualDistance === 0,
  );
  const nearExact = args.visualMatches.some(
    (match) =>
      typeof match.visualDistance === "number" &&
      match.visualDistance <= SUBMISSION_NEAR_EXACT_VISUAL_THRESHOLD &&
      (match.matchedFields?.length ||
        args.semanticMatches.some(
          (semantic) =>
            semantic.id === match.id &&
            (semantic.semanticScore ?? 0) >=
              SUBMISSION_STRONG_SEMANTIC_CORROBORATION_THRESHOLD,
        )),
  );
  if (exactMatch || identicalMatch || nearExact) return "fail";
  if (
    args.exactMatches.length > 0 ||
    args.visualMatches.length > 0 ||
    args.metadataMatches.length > 0 ||
    args.semanticMatches.some(
      (match) =>
        (match.semanticScore ?? 0) >=
        SUBMISSION_DUPLICATE_REVIEW_SEMANTIC_HOLD_THRESHOLD,
    ) ||
    args.reasons.length > 0
  ) {
    return "hold";
  }
  return "pass";
}

type FetchBufferResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; reason: string };

async function fetchAllowedBuffer(
  url: string,
  maxBytes: number,
  label: string,
): Promise<FetchBufferResult> {
  if (!isAllowedAssetUrl(url)) {
    return { ok: false, reason: `${label} URL is not on the asset allowlist.` };
  }
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(REVIEW_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: `${label} could not be fetched (${res.status}).`,
      };
    }
    const contentLength = Number(res.headers.get("content-length") ?? 0);
    if (contentLength > maxBytes) {
      return {
        ok: false,
        reason: `${label} exceeds the maximum allowed size.`,
      };
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      return {
        ok: false,
        reason: `${label} exceeds the maximum allowed size.`,
      };
    }
    return { ok: true, buffer };
  } catch {
    return { ok: false, reason: `${label} could not be fetched.` };
  }
}

export function validatePolicyResponse(raw: string): ReviewChecks["policy"] {
  try {
    const parsed = parsePolicyJson(raw) as {
      decision?: unknown;
      confidence?: unknown;
      summary?: unknown;
      flags?: unknown;
      visualText?: unknown;
      visualSignals?: unknown;
    };
    const flags = normalizePolicyFlags(parsed.flags);
    const holdFlags = flags.filter(shouldHoldForPolicyFlag);
    const malformedFlagCount =
      parsed.flags === undefined
        ? 0
        : Array.isArray(parsed.flags)
          ? Math.max(0, parsed.flags.length - flags.length)
          : 1;
    const confidence = clamp01(Number(parsed.confidence ?? 0));
    const summary =
      typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    const visualText = normalizeStringList(parsed.visualText, 12, 120);
    const visualSignals = normalizeStringList(parsed.visualSignals, 12, 160);
    const reasons = [
      ...holdFlags.map((flag) =>
        `${flag.category}: ${flag.evidence}`.slice(0, 220),
      ),
      ...(malformedFlagCount > 0
        ? ["Policy classifier returned malformed flag evidence."]
        : []),
    ];
    if (
      parsed.decision === "pass" &&
      holdFlags.length === 0 &&
      malformedFlagCount === 0
    ) {
      return {
        decision: "pass",
        confidence,
        reasons: [],
        flags,
        visualText,
        visualSignals,
      };
    }
    return {
      decision: "hold",
      confidence,
      reasons:
        reasons.length > 0
          ? reasons
          : [summary || "Policy model requested review."],
      flags,
      visualText,
      visualSignals,
    };
  } catch {
    return {
      decision: "hold",
      confidence: 0,
      reasons: ["Policy classifier returned invalid JSON."],
      flags: [],
    };
  }
}

function parsePolicyJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) throw new Error("no JSON");
    return JSON.parse(raw.slice(start, end + 1));
  }
}

function normalizeStringList(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.slice(0, maxLength))
    .slice(0, maxItems);
}

function normalizePolicyFlags(flags: unknown): PolicyFlag[] {
  if (!Array.isArray(flags)) return [];
  return flags
    .map((flag) => {
      const item = flag as Record<string, unknown>;
      const category =
        typeof item.category === "string" ? item.category.trim() : "";
      const evidence =
        typeof item.evidence === "string" ? item.evidence.trim() : "";
      const confidence =
        typeof item.confidence === "number" && Number.isFinite(item.confidence)
          ? clamp01(item.confidence)
          : null;
      if (!category || !evidence || confidence === null) return null;
      const severity = String(item.severity ?? "low").trim();
      return {
        category,
        severity:
          severity === "medium" || severity === "high" ? severity : "low",
        confidence,
        evidence: evidence.slice(0, 240),
      } satisfies PolicyFlag;
    })
    .filter((flag): flag is PolicyFlag => flag !== null);
}

function shouldHoldForPolicyFlag(flag: PolicyFlag): boolean {
  const category = REVIEW_POLICY_CATEGORIES.find(
    (item) => item.id === flag.category,
  );
  if (!category) return true;
  return flag.confidence >= category.holdAboveConfidence;
}

export function policyPetJsonExcerpt(
  petJson: unknown,
): Record<string, unknown> {
  if (!isPlainRecord(petJson)) return {};

  const excerpt: Record<string, unknown> = {};
  addTextField(excerpt, petJson, "name");
  addTextField(excerpt, petJson, "displayName");
  addTextField(excerpt, petJson, "description");
  addTextField(excerpt, petJson, "kind");
  addNumberField(excerpt, petJson, "frameWidth");
  addNumberField(excerpt, petJson, "frameHeight");

  const tags = normalizeStringList(
    petJson.tags,
    POLICY_PET_JSON_LIST_LIMIT,
    POLICY_PET_JSON_TEXT_LIMIT,
  );
  if (tags.length > 0) excerpt.tags = tags;

  const vibes = normalizeStringList(
    petJson.vibes,
    POLICY_PET_JSON_LIST_LIMIT,
    POLICY_PET_JSON_TEXT_LIMIT,
  );
  if (vibes.length > 0) excerpt.vibes = vibes;

  const states = summarizePetJsonStates(petJson.states);
  if (Object.keys(states).length > 0) excerpt.states = states;

  const animations = summarizePetJsonStates(petJson.animations);
  if (Object.keys(animations).length > 0) excerpt.animations = animations;

  return excerpt;
}

function addTextField(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = source[key];
  if (typeof value !== "string") return;
  const text = value.trim().slice(0, POLICY_PET_JSON_TEXT_LIMIT);
  if (text) target[key] = text;
}

function addNumberField(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    target[key] = value;
  }
}

function summarizePetJsonStates(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) return {};

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, POLICY_PET_JSON_STATE_LIMIT)
      .map(([state, metadata]) => [
        state.slice(0, 48),
        summarizeState(metadata),
      ])
      .filter((entry): entry is [string, Record<string, unknown>] => {
        const [, metadata] = entry;
        return Object.keys(metadata).length > 0;
      }),
  );
}

function summarizeState(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) return {};

  const state: Record<string, unknown> = {};
  addTextField(state, value, "label");
  addTextField(state, value, "purpose");
  addNumberField(state, value, "row");
  addNumberField(state, value, "frames");
  addNumberField(state, value, "frameCount");
  addNumberField(state, value, "durationMs");
  return state;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function buildPolicyUserPrompt(row: SubmittedPet, petJson: unknown): string {
  return [
    "Review this submitted pet pack.",
    "The attached image is a contact sheet sampled from multiple animation states and frames. Check the visible art and OCR any embedded text.",
    `Display name: ${row.displayName}`,
    `Description: ${row.description}`,
    `Kind: ${row.kind}`,
    `Tags: ${JSON.stringify(row.tags ?? [])}`,
    `Vibes: ${JSON.stringify(row.vibes ?? [])}`,
    `Credit name: ${row.creditName ?? ""}`,
    `Credit URL: ${row.creditUrl ?? ""}`,
    `pet.json excerpt: ${JSON.stringify(policyPetJsonExcerpt(petJson))}`,
  ].join("\n");
}

function emptyChecks(dryRun: boolean): ReviewChecks {
  return {
    security: {
      decision: "hold",
      reasons: ["Security review has not run yet."],
      findings: [],
    },
    assets: { decision: "hold", reasons: ["Review has not run yet."] },
    policy: { decision: "hold", confidence: 0, reasons: [], flags: [] },
    duplicates: {
      decision: "hold",
      reasons: [],
      exactMatches: [],
      visualMatches: [],
      semanticMatches: [],
      metadataMatches: [],
    },
    autopilot: { applied: false, dryRun, reason: null },
  };
}

async function dhashFromSpriteBuffer(buf: Buffer): Promise<string | null> {
  try {
    const frame = await sharp(buf)
      .extract({ left: 0, top: 0, width: FRAME_W, height: FRAME_H })
      .resize(9, 8, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer();
    let bits = "";
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const left = frame[row * 9 + col];
        const right = frame[row * 9 + col + 1];
        bits += left < right ? "1" : "0";
      }
    }
    return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
  } catch {
    return null;
  }
}

async function persistPetEmbedding(
  petId: string,
  vec: number[],
): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);
  const literal = embeddingVectorLiteral(vec);
  await sql`
    UPDATE submitted_pets
    SET embedding = ${literal}::vector,
        embedding_model = ${PETDEX_EMBEDDING_MODEL}
    WHERE id = ${petId}
  `;
}

function hammingDistanceHex(a: string, b: string): number {
  const ZERO = BigInt(0);
  const ONE = BigInt(1);
  let xor = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let distance = 0;
  while (xor !== ZERO) {
    distance += Number(xor & ONE);
    xor >>= ONE;
  }
  return distance;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function hasUnsafeZipPath(name: string): boolean {
  return name.startsWith("/") || name.split("/").includes("..");
}

type ZipEntryWithData = JSZip.JSZipObject & {
  _data?: { uncompressedSize?: unknown };
};

async function readZipPetJson(
  entry: JSZip.JSZipObject,
  maxBytes: number,
): Promise<{ ok: true; petJson: unknown } | { ok: false; reason: string }> {
  const size = zipEntryUncompressedSize(entry);
  if (size === null) {
    return { ok: false, reason: "zip pet.json size could not be verified." };
  }
  if (size > maxBytes) {
    return {
      ok: false,
      reason: "zip pet.json exceeds the maximum allowed size.",
    };
  }
  const streamed = await readZipEntryBuffer(
    entry,
    maxBytes,
    "zip pet.json exceeds the maximum allowed size.",
  );
  if (!streamed.ok) return streamed;
  try {
    const bytes = streamed.buffer;
    return { ok: true, petJson: JSON.parse(bytes.toString("utf8")) };
  } catch {
    return { ok: false, reason: "zip pet.json could not be parsed as JSON." };
  }
}

function readZipEntryBuffer(
  entry: JSZip.JSZipObject,
  maxBytes: number,
  sizeReason: string,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const stream = entry.nodeStream("nodebuffer") as Readable;
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (
      result: { ok: true; buffer: Buffer } | { ok: false; reason: string },
    ) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    stream.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        stream.destroy();
        finish({ ok: false, reason: sizeReason });
        return;
      }
      chunks.push(buffer);
    });
    stream.on("error", () => {
      finish({ ok: false, reason: "zip pet.json could not be read." });
    });
    stream.on("end", () => {
      finish({ ok: true, buffer: Buffer.concat(chunks, total) });
    });
  });
}

function zipEntryUncompressedSize(entry: JSZip.JSZipObject): number | null {
  const size = (entry as ZipEntryWithData)._data?.uncompressedSize;
  return typeof size === "number" && Number.isFinite(size) ? size : null;
}

function normalizeText(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, " ");
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
