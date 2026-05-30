import { petSecurityReason } from "@/lib/pet-security";
import type {
  ReviewChecks,
  ReviewEvidenceMatch,
  SubmissionReviewDecision,
} from "@/lib/submission-review-types";
import {
  SUBMISSION_NEAR_EXACT_VISUAL_THRESHOLD,
  SUBMISSION_NEAR_VISUAL_DUPLICATE_THRESHOLD,
  SUBMISSION_SEMANTIC_HOLD_THRESHOLD,
  SUBMISSION_SIMILARITY_VISUAL_THRESHOLD,
  SUBMISSION_STRONG_SEMANTIC_CORROBORATION_THRESHOLD,
} from "@/lib/submission-similarity";

export type ReviewDecisionResult = {
  decision: SubmissionReviewDecision;
  reasonCode: string;
  summary: string;
  confidence: number;
  canApply: boolean;
  applyReason: string | null;
};

const AUTO_APPROVE_CONFIDENCE = 0.9;

export function decideAutomatedReview(
  checks: ReviewChecks,
): ReviewDecisionResult {
  const security = checks.security;
  if (security?.decision === "fail") {
    return applyDecision({
      decision: "auto_reject",
      reasonCode: "security_malicious_pet_json",
      summary:
        petSecurityReason(security, "fail") ??
        "Pet metadata contains a high-confidence executable payload.",
      confidence: 1,
    });
  }

  const exactMatch = checks.duplicates.exactMatches[0];
  if (exactMatch) {
    return applyDecision({
      decision: "auto_reject",
      reasonCode: "duplicate_exact_asset",
      summary: `Exact asset duplicate of ${exactMatch.displayName}.`,
      confidence: 1,
    });
  }

  const identicalMatch = checks.duplicates.visualMatches.find(
    (match) => match.visualDistance === 0,
  );
  if (identicalMatch) {
    return applyDecision({
      decision: "auto_reject",
      reasonCode: "duplicate_identical_sprite",
      summary: `Identical sprite match with ${identicalMatch.displayName}.`,
      confidence: 0.99,
    });
  }

  const nearExact = checks.duplicates.visualMatches.find(
    (match) =>
      typeof match.visualDistance === "number" &&
      match.visualDistance >= 1 &&
      match.visualDistance <= SUBMISSION_NEAR_EXACT_VISUAL_THRESHOLD &&
      hasStrongCorroboration(match, checks),
  );
  if (nearExact) {
    return applyDecision({
      decision: "auto_reject",
      reasonCode: "duplicate_near_exact_sprite",
      summary: `Near-exact sprite duplicate of ${nearExact.displayName}.`,
      confidence: 0.96,
    });
  }

  const holdReason = firstHoldReason(checks);
  if (holdReason) {
    return {
      decision: "hold",
      reasonCode: holdReason.code,
      summary: holdReason.summary,
      confidence: holdReason.confidence,
      canApply: false,
      applyReason: "held_for_manual_review",
    };
  }

  const confidence = Math.min(
    checks.policy.confidence || 0,
    checks.assets.decision === "pass" ? 1 : 0,
    checks.duplicates.decision === "pass" || !hasHardDuplicateSignal(checks)
      ? 1
      : 0,
  );

  if (confidence >= AUTO_APPROVE_CONFIDENCE) {
    return applyDecision({
      decision: "auto_approve",
      reasonCode: "clean_unique_submission",
      summary: "All automated checks passed with high confidence.",
      confidence,
    });
  }

  return {
    decision: "hold",
    reasonCode: "low_confidence",
    summary: "Automated checks did not reach the confidence needed to approve.",
    confidence,
    canApply: false,
    applyReason: "held_for_manual_review",
  };
}

function applyDecision(
  result: Omit<ReviewDecisionResult, "canApply" | "applyReason">,
): ReviewDecisionResult {
  return { ...result, canApply: true, applyReason: null };
}

function firstHoldReason(
  checks: ReviewChecks,
): { code: string; summary: string; confidence: number } | null {
  if (checks.assets.decision !== "pass") {
    return {
      code: "asset_review_hold",
      summary:
        checks.assets.reasons[0] ?? "Asset checks require manual review.",
      confidence: 0.8,
    };
  }

  if (checks.security?.decision === "hold") {
    return {
      code: "security_review_hold",
      summary:
        checks.security.reasons[0] ?? "Security checks require manual review.",
      confidence: 0.9,
    };
  }

  if (checks.policy.decision !== "pass") {
    return {
      code: "policy_review_hold",
      summary:
        checks.policy.reasons[0] ?? "Policy checks require manual review.",
      confidence: checks.policy.confidence,
    };
  }

  const nearVisual = checks.duplicates.visualMatches.find(
    (match) =>
      typeof match.visualDistance === "number" &&
      match.visualDistance <= SUBMISSION_NEAR_VISUAL_DUPLICATE_THRESHOLD,
  );
  if (nearVisual) {
    return {
      code: "duplicate_visual_hold",
      summary: `Possible visual duplicate of ${nearVisual.displayName}.`,
      confidence: 0.9,
    };
  }

  const combinedVisual = checks.duplicates.visualMatches.find(
    (match) =>
      typeof match.visualDistance === "number" &&
      match.visualDistance <= SUBMISSION_SIMILARITY_VISUAL_THRESHOLD &&
      hasStrongCorroboration(match, checks),
  );
  if (combinedVisual) {
    return {
      code: "duplicate_correlated_hold",
      summary: `Similar sprite and metadata match ${combinedVisual.displayName}.`,
      confidence: 0.82,
    };
  }

  const semantic = checks.duplicates.semanticMatches.find(
    (match) => (match.semanticScore ?? 0) >= SUBMISSION_SEMANTIC_HOLD_THRESHOLD,
  );
  if (semantic) {
    return {
      code: "duplicate_semantic_hold",
      summary: `Text looks similar to ${semantic.displayName}.`,
      confidence: Math.min(semantic.semanticScore ?? 0.88, 0.95),
    };
  }

  if (checks.duplicates.decision !== "pass" && hasHardDuplicateSignal(checks)) {
    return {
      code: "duplicate_review_hold",
      summary:
        checks.duplicates.reasons[0] ?? "Duplicate checks require review.",
      confidence: 0.75,
    };
  }

  return null;
}

function hasStrongCorroboration(
  match: ReviewEvidenceMatch,
  checks: ReviewChecks,
): boolean {
  if ((match.matchedFields?.length ?? 0) > 0) return true;
  return checks.duplicates.semanticMatches.some(
    (semantic) =>
      semantic.id === match.id &&
      (semantic.semanticScore ?? 0) >=
        SUBMISSION_STRONG_SEMANTIC_CORROBORATION_THRESHOLD,
  );
}

function hasHardDuplicateSignal(checks: ReviewChecks): boolean {
  return (
    checks.duplicates.exactMatches.length > 0 ||
    checks.duplicates.visualMatches.length > 0 ||
    checks.duplicates.semanticMatches.some(
      (match) =>
        (match.semanticScore ?? 0) >= SUBMISSION_SEMANTIC_HOLD_THRESHOLD,
    )
  );
}
