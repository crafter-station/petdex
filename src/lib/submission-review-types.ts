export type SubmissionReviewStatus = "running" | "completed" | "failed";

export type SubmissionReviewDecision =
  | "auto_approve"
  | "auto_reject"
  | "hold"
  | "no_decision";

export type ReviewCheckDecision = "pass" | "hold" | "fail";

export type ReviewEvidenceMatch = {
  id: string;
  slug: string;
  displayName: string;
  status: string;
  featured?: boolean | null;
  spritesheetUrl?: string | null;
  reason?: string;
  visualDistance?: number | null;
  semanticScore?: number | null;
  matchedFields?: string[];
};

export type PolicyFlag = {
  category: string;
  severity: "low" | "medium" | "high";
  confidence: number;
  evidence: string;
};

export type SecurityFinding = {
  code: string;
  severity: "fail" | "hold";
  path: string;
  evidence: string;
};

export type ReviewChecks = {
  security?: {
    decision: ReviewCheckDecision;
    reasons: string[];
    findings: SecurityFinding[];
  };
  assets: {
    decision: ReviewCheckDecision;
    reasons: string[];
    hashes?: {
      spriteSha256?: string | null;
      petJsonSha256?: string | null;
      zipSha256?: string | null;
    };
  };
  policy: {
    decision: ReviewCheckDecision;
    confidence: number;
    reasons: string[];
    flags: PolicyFlag[];
    visualText?: string[];
    visualSignals?: string[];
  };
  duplicates: {
    decision: ReviewCheckDecision;
    reasons: string[];
    exactMatches: ReviewEvidenceMatch[];
    visualMatches: ReviewEvidenceMatch[];
    semanticMatches: ReviewEvidenceMatch[];
    metadataMatches: ReviewEvidenceMatch[];
  };
  autopilot: {
    applied: boolean;
    dryRun: boolean;
    reason: string | null;
  };
};
