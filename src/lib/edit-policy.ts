// Auto-accept policy for pet edits.
//
// Returns { autoAccept: true } when all 10 criteria pass. Any failure
// produces autoAccept: false with reasons logged for telemetry/debug.
//
// Criteria (locked by Hunter 2026-05-12):
//  1. No asset URL changed (sprite, petJson, zip all unchanged).
//  2. Levenshtein distance on displayName <= 3.
//  3. Tag set delta <= 2 tokens added/removed.
//  4. Description delta <= 200 chars AND new length within +-20% of old.
//  5. Description new length <= 280.
//  6. No URL detected in any text field.
//  7. Keyword blocklist passes.
//  8. gpt-5-mini moderation on diff text passes with confidence >= 0.7.
//  9. editCount in last 24h < 3 (enforced before calling this).
// 10. Pet approved for >= 24h.

import { containsBlockedKeyword } from "@/lib/keyword-blocklist";
import { containsUrl } from "@/lib/url-blocklist";

const EDIT_AI_MODERATION_ENABLED =
  process.env.EDIT_AI_MODERATION_ENABLED !== "false";

export type EditPolicyInput = {
  currentDisplayName: string;
  currentDescription: string;
  currentTags: string[];
  currentSpritesheetUrl: string;
  currentPetJsonUrl: string;
  currentZipUrl: string;
  currentApprovedAt: Date | null;

  pendingDisplayName: string | null;
  pendingDescription: string | null;
  pendingTags: string[] | null;
  pendingSpritesheetUrl: string | null;
  pendingPetJsonUrl: string | null;
  pendingZipUrl: string | null;

  editCountLast24h: number;
};

export type EditPolicyResult = {
  autoAccept: boolean;
  reasons: string[];
};

// Levenshtein distance with early exit at maxDist.
// Returns the actual distance or maxDist+1 if it exceeds the cap.
function levenshtein(a: string, b: string, maxDist = 10): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;

  const aLen = a.length;
  const bLen = b.length;
  let prev = Array.from({ length: bLen + 1 }, (_, i) => i);
  let curr = new Array<number>(bLen + 1);

  for (let i = 1; i <= aLen; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= bLen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[bLen];
}

async function runAiModeration(diffText: string): Promise<boolean> {
  if (!EDIT_AI_MODERATION_ENABLED) return true;
  if (!process.env.OPENAI_API_KEY && !process.env.AI_API_KEY) return true;

  const { buildPolicyPrompt } = await import("@/lib/submission-review-policy");
  const { generateText } = await import("ai");

  const systemPrompt = buildPolicyPrompt({ imageReview: false });
  const userPrompt = [
    "Review the following pending text diff for a user-submitted pet entry.",
    "The diff shows what the owner wants to change.",
    "",
    "--- DIFF ---",
    diffText,
    "--- END DIFF ---",
    "",
    'Return strict JSON. Use {"decision":"pass","confidence":0.9,"summary":"...","flags":[]} if clean.',
  ].join("\n");

  try {
    const { text } = await generateText({
      model: "openai/gpt-5-mini",
      system: systemPrompt,
      messages: [{ role: "user" as const, content: userPrompt }],
      abortSignal: AbortSignal.timeout(5000),
    });

    return textPolicyModerationPasses(text);
  } catch {
    return false;
  }
}

export function textPolicyModerationPasses(
  rawText: string,
  minConfidence = 0.7,
): boolean {
  const raw = rawText.trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return false;
  const parsed = JSON.parse(raw.slice(start, end + 1)) as {
    decision?: unknown;
    confidence?: unknown;
    flags?: unknown;
  };
  if (parsed.decision !== "pass") return false;
  if (parsed.flags !== undefined) {
    if (!Array.isArray(parsed.flags)) return false;
    if (parsed.flags.length > 0) return false;
  }
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? parsed.confidence
      : 0;
  return confidence >= minConfidence;
}

export async function decideAutoAccept(
  input: EditPolicyInput,
): Promise<EditPolicyResult> {
  const reasons: string[] = [];

  // 1. No asset URL changed.
  const assetChanged =
    (input.pendingSpritesheetUrl !== null &&
      input.pendingSpritesheetUrl !== input.currentSpritesheetUrl) ||
    (input.pendingPetJsonUrl !== null &&
      input.pendingPetJsonUrl !== input.currentPetJsonUrl) ||
    (input.pendingZipUrl !== null &&
      input.pendingZipUrl !== input.currentZipUrl);
  if (assetChanged) {
    reasons.push("asset_changed");
    return { autoAccept: false, reasons };
  }

  // 2. Levenshtein distance on displayName <= 3.
  if (input.pendingDisplayName !== null) {
    const dist = levenshtein(
      input.currentDisplayName,
      input.pendingDisplayName,
    );
    if (dist > 3) {
      reasons.push(`display_name_distance_${dist}`);
    }
  }

  // 3. Tag set delta <= 2 tokens added/removed.
  if (input.pendingTags !== null) {
    const currentSet = new Set(input.currentTags);
    const pendingSet = new Set(input.pendingTags);
    const added = input.pendingTags.filter((t) => !currentSet.has(t)).length;
    const removed = input.currentTags.filter((t) => !pendingSet.has(t)).length;
    if (added + removed > 2) {
      reasons.push(`tag_delta_${added + removed}`);
    }
  }

  // 4. Description delta <= 200 chars AND new length within +-20% of old.
  // 5. Description new length <= 280.
  if (input.pendingDescription !== null) {
    const oldLen = input.currentDescription.length;
    const newLen = input.pendingDescription.length;
    const delta = Math.abs(newLen - oldLen);
    if (delta > 200) {
      reasons.push(`description_delta_${delta}`);
    }
    if (oldLen > 0) {
      const ratio = newLen / oldLen;
      if (ratio < 0.8 || ratio > 1.2) {
        reasons.push(`description_length_ratio_${ratio.toFixed(2)}`);
      }
    }
    if (newLen > 280) {
      reasons.push("description_over_280");
    }
  }

  // 6. No URL detected in any text field.
  const urlHit = containsUrl(
    ["displayName", input.pendingDisplayName],
    ["description", input.pendingDescription],
    ...((input.pendingTags ?? []).map((t) => ["tag", t]) as Array<
      [string, string]
    >),
  );
  if (urlHit) {
    reasons.push(`url_in_${urlHit.field}`);
  }

  // 7. Keyword blocklist.
  const keywordHit = containsBlockedKeyword(
    input.pendingDisplayName,
    input.pendingDescription,
    ...(input.pendingTags ?? []),
  );
  if (keywordHit) {
    reasons.push("keyword_blocked");
  }

  // 9. editCount in last 24h < 3.
  if (input.editCountLast24h >= 3) {
    reasons.push(`edit_count_${input.editCountLast24h}`);
  }

  // 10. Pet approved for >= 24h.
  if (input.currentApprovedAt === null) {
    reasons.push("not_approved");
  } else {
    const hoursSinceApproval =
      (Date.now() - input.currentApprovedAt.getTime()) / (1000 * 60 * 60);
    if (hoursSinceApproval < 24) {
      reasons.push(`approved_${Math.floor(hoursSinceApproval)}h_ago`);
    }
  }

  // Short-circuit before expensive AI call if structural checks already failed.
  if (reasons.length > 0) {
    return { autoAccept: false, reasons };
  }

  // 8. AI moderation on diff text.
  const diffLines: string[] = [];
  if (input.pendingDisplayName !== null) {
    diffLines.push(
      `displayName: "${input.currentDisplayName}" -> "${input.pendingDisplayName}"`,
    );
  }
  if (input.pendingDescription !== null) {
    diffLines.push(
      `description: "${input.currentDescription}" -> "${input.pendingDescription}"`,
    );
  }
  if (input.pendingTags !== null) {
    diffLines.push(
      `tags: [${input.currentTags.join(", ")}] -> [${input.pendingTags.join(", ")}]`,
    );
  }

  const aiPass = await runAiModeration(diffLines.join("\n"));
  if (!aiPass) {
    reasons.push("ai_moderation_failed");
    return { autoAccept: false, reasons };
  }

  return { autoAccept: true, reasons };
}
