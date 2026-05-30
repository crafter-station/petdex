import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";

import sharp from "sharp";

import {
  policyPetJsonExcerpt,
  validatePolicyResponse,
} from "@/lib/submission-review";
import { decideAutomatedReview } from "@/lib/submission-review-decision";
import {
  policyReviewImageDataUrl,
  preparePolicyReviewImage,
} from "@/lib/submission-review-image";
import {
  buildPolicyPrompt,
  REVIEW_POLICY_CATEGORIES,
} from "@/lib/submission-review-policy";
import type { ReviewChecks } from "@/lib/submission-review-types";

function cleanChecks(): ReviewChecks {
  return {
    assets: { decision: "pass", reasons: [] },
    security: { decision: "pass", reasons: [], findings: [] },
    policy: { decision: "pass", confidence: 0.96, reasons: [], flags: [] },
    duplicates: {
      decision: "pass",
      reasons: [],
      exactMatches: [],
      visualMatches: [],
      semanticMatches: [],
      metadataMatches: [],
    },
    autopilot: { applied: false, dryRun: false, reason: null },
  };
}

describe("decideAutomatedReview", () => {
  it("auto-approves only clean high-confidence submissions", () => {
    const result = decideAutomatedReview(cleanChecks());
    expect(result.decision).toBe("auto_approve");
    expect(result.canApply).toBe(true);
  });

  it("holds clean submissions below the approval confidence", () => {
    const checks = cleanChecks();
    checks.policy.confidence = 0.89;
    const result = decideAutomatedReview(checks);
    expect(result.decision).toBe("hold");
    expect(result.reasonCode).toBe("low_confidence");
  });

  it("auto-rejects exact asset duplicates", () => {
    const checks = cleanChecks();
    checks.duplicates.decision = "fail";
    checks.duplicates.exactMatches.push({
      id: "pet_existing",
      slug: "existing",
      displayName: "Existing",
      status: "pending",
      matchedFields: ["spriteSha256"],
    });
    const result = decideAutomatedReview(checks);
    expect(result.decision).toBe("auto_reject");
    expect(result.reasonCode).toBe("duplicate_exact_asset");
  });

  it("auto-rejects high-confidence pet.json security payloads", () => {
    const checks = cleanChecks();
    checks.security = {
      decision: "fail",
      reasons: ["shell_command_substitution: $(touch /tmp/pwned)"],
      findings: [
        {
          code: "shell_command_substitution",
          severity: "fail",
          path: "$.displayName",
          evidence: "$(touch /tmp/pwned)",
        },
      ],
    };

    const result = decideAutomatedReview(checks);
    expect(result.decision).toBe("auto_reject");
    expect(result.reasonCode).toBe("security_malicious_pet_json");
    expect(result.canApply).toBe(true);
  });

  it("uses fail-severity security findings for auto-reject summaries", () => {
    const checks = cleanChecks();
    checks.security = {
      decision: "fail",
      reasons: [
        "external_url_in_pet_json: https://example.com",
        "shell_command_substitution: $(touch /tmp/pwned)",
      ],
      findings: [
        {
          code: "external_url_in_pet_json",
          severity: "hold",
          path: "$.homepage",
          evidence: "https://example.com",
        },
        {
          code: "shell_command_substitution",
          severity: "fail",
          path: "$.displayName",
          evidence: "$(touch /tmp/pwned)",
        },
      ],
    };

    const result = decideAutomatedReview(checks);

    expect(result.decision).toBe("auto_reject");
    expect(result.summary).toBe(
      "shell_command_substitution: $(touch /tmp/pwned)",
    );
  });

  it("holds suspicious pet.json security findings", () => {
    const checks = cleanChecks();
    checks.security = {
      decision: "hold",
      reasons: ["external_url_in_pet_json: https://example.com"],
      findings: [
        {
          code: "external_url_in_pet_json",
          severity: "hold",
          path: "$.homepage",
          evidence: "https://example.com",
        },
      ],
    };

    const result = decideAutomatedReview(checks);
    expect(result.decision).toBe("hold");
    expect(result.reasonCode).toBe("security_review_hold");
    expect(result.canApply).toBe(false);
  });

  it("auto-approves metadata-only overlaps", () => {
    const checks = cleanChecks();
    checks.duplicates.decision = "hold";
    checks.duplicates.metadataMatches.push({
      id: "pet_existing",
      slug: "existing",
      displayName: "Existing",
      status: "approved",
      matchedFields: ["creditName"],
    });
    const result = decideAutomatedReview(checks);
    expect(result.decision).toBe("auto_approve");
    expect(result.reasonCode).toBe("clean_unique_submission");
  });

  it("auto-rejects 100% visual sprite duplicates", () => {
    const checks = cleanChecks();
    checks.duplicates.decision = "fail";
    checks.duplicates.visualMatches.push({
      id: "pet_existing",
      slug: "existing",
      displayName: "Existing",
      status: "pending",
      visualDistance: 0,
    });
    const result = decideAutomatedReview(checks);
    expect(result.decision).toBe("auto_reject");
    expect(result.reasonCode).toBe("duplicate_identical_sprite");
  });

  it("holds near-exact visual matches without corroboration", () => {
    const checks = cleanChecks();
    checks.duplicates.decision = "hold";
    checks.duplicates.visualMatches.push({
      id: "pet_existing",
      slug: "existing",
      displayName: "Existing",
      status: "approved",
      visualDistance: 2,
    });
    const result = decideAutomatedReview(checks);
    expect(result.decision).toBe("hold");
    expect(result.reasonCode).toBe("duplicate_visual_hold");
  });

  it("auto-rejects near-exact visual matches with metadata corroboration", () => {
    const checks = cleanChecks();
    checks.duplicates.decision = "fail";
    checks.duplicates.visualMatches.push({
      id: "pet_existing",
      slug: "existing",
      displayName: "Existing",
      status: "approved",
      visualDistance: 2,
      matchedFields: ["displayName"],
    });
    const result = decideAutomatedReview(checks);
    expect(result.decision).toBe("auto_reject");
    expect(result.reasonCode).toBe("duplicate_near_exact_sprite");
  });

  it("auto-rejects pending near-exact visual matches with metadata corroboration", () => {
    const checks = cleanChecks();
    checks.duplicates.decision = "fail";
    checks.duplicates.visualMatches.push({
      id: "pet_existing",
      slug: "existing",
      displayName: "Existing",
      status: "pending",
      visualDistance: 2,
      matchedFields: ["displayName"],
    });
    const result = decideAutomatedReview(checks);
    expect(result.decision).toBe("auto_reject");
    expect(result.reasonCode).toBe("duplicate_near_exact_sprite");
  });

  it("holds semantic-only duplicate risk", () => {
    const checks = cleanChecks();
    checks.duplicates.decision = "hold";
    checks.duplicates.semanticMatches.push({
      id: "pet_existing",
      slug: "existing",
      displayName: "Existing",
      status: "approved",
      semanticScore: 0.9,
    });
    const result = decideAutomatedReview(checks);
    expect(result.decision).toBe("hold");
    expect(result.reasonCode).toBe("duplicate_semantic_hold");
  });

  it("holds policy flags instead of auto-rejecting", () => {
    const checks = cleanChecks();
    checks.policy = {
      decision: "hold",
      confidence: 0.91,
      reasons: ["hate_harassment: slur in description"],
      flags: [
        {
          category: "hate_harassment",
          severity: "high",
          confidence: 0.91,
          evidence: "slur in description",
        },
      ],
    };
    const result = decideAutomatedReview(checks);
    expect(result.decision).toBe("hold");
    expect(result.reasonCode).toBe("policy_review_hold");
  });

  it("holds visual OCR and likeness policy risks for manual review", () => {
    const checks = cleanChecks();
    checks.policy = {
      decision: "hold",
      confidence: 0.86,
      reasons: ["embedded_text_sensitive_symbol: visible slogan in sprite"],
      visualText: ["visible slogan"],
      visualSignals: ["uniform logo"],
      flags: [
        {
          category: "embedded_text_sensitive_symbol",
          severity: "medium",
          confidence: 0.86,
          evidence: "visible slogan in sprite",
        },
        {
          category: "portrait_likeness_rights",
          severity: "medium",
          confidence: 0.63,
          evidence: "resembles a contemporary celebrity",
        },
      ],
    };
    const result = decideAutomatedReview(checks);
    expect(result.decision).toBe("hold");
    expect(result.reasonCode).toBe("policy_review_hold");
  });
});

describe("submission policy prompt", () => {
  it("requires OCR review across sampled animation frames", () => {
    const prompt = buildPolicyPrompt();
    expect(prompt).toContain("Perform OCR");
    expect(prompt).toContain("sampled animation frames");
    expect(prompt).toContain("visualText");
    expect(prompt).toContain("visualSignals");
  });

  it("supports text-only moderation without visual OCR instructions", () => {
    const prompt = buildPolicyPrompt({ imageReview: false });
    expect(prompt).toContain("No image is attached");
    expect(prompt).toContain("submitted text diff");
    expect(prompt).not.toContain("Perform OCR");
    expect(prompt).not.toContain("sampled animation frames");
  });

  it("covers legal and cultural visual risk categories", () => {
    const ids = REVIEW_POLICY_CATEGORIES.map((category) => category.id);
    expect(ids).toContain("portrait_likeness_rights");
    expect(ids).toContain("historical_religious_figure");
    expect(ids).toContain("embedded_text_sensitive_symbol");
  });

  it("redacts arbitrary pet.json metadata before policy review", () => {
    const excerpt = policyPetJsonExcerpt({
      name: "merchant",
      displayName: "Merchant Pet",
      description: "A shopkeeper with readable signage",
      kind: "cat",
      tags: ["shop", "pixel", "x".repeat(300)],
      vibes: ["cozy"],
      apiKey: "sk_live_secret",
      notes: "private notes".repeat(100),
      nested: {
        token: "secret",
      },
      states: {
        idle: {
          row: 0,
          frames: 6,
          durationMs: 900,
          purpose: "standing near the shop sign",
          secret: "do-not-send",
        },
      },
    });

    expect(JSON.stringify(excerpt)).not.toContain("sk_live_secret");
    expect(JSON.stringify(excerpt)).not.toContain("private notes");
    expect(JSON.stringify(excerpt)).not.toContain("do-not-send");
    expect(excerpt).toMatchObject({
      name: "merchant",
      displayName: "Merchant Pet",
      description: "A shopkeeper with readable signage",
      kind: "cat",
      tags: ["shop", "pixel", "x".repeat(240)],
      vibes: ["cozy"],
      states: {
        idle: {
          row: 0,
          frames: 6,
          durationMs: 900,
          purpose: "standing near the shop sign",
        },
      },
    });
  });

  it("caps pet.json state and list metadata sent to the policy model", () => {
    const excerpt = policyPetJsonExcerpt({
      tags: Array.from({ length: 20 }, (_, index) => `tag-${index}`),
      states: Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [
          `state-${index}`,
          { row: index, frames: 8 },
        ]),
      ),
    });

    expect(excerpt.tags).toHaveLength(16);
    expect(Object.keys(excerpt.states as Record<string, unknown>)).toHaveLength(
      12,
    );
  });
});

describe("submission policy response", () => {
  it("accepts a valid policy JSON object wrapped in model prose", () => {
    const result = validatePolicyResponse(
      [
        "Here is the review:",
        JSON.stringify({
          decision: "pass",
          confidence: 0.93,
          flags: [],
          visualText: [],
          visualSignals: [],
        }),
      ].join("\n"),
    );

    expect(result).toMatchObject({
      decision: "pass",
      confidence: 0.93,
      reasons: [],
      flags: [],
    });
  });

  it("normalizes OCR evidence without leaking malformed model values", () => {
    const result = validatePolicyResponse(
      JSON.stringify({
        decision: "hold",
        confidence: 0.7,
        summary: "manual review",
        visualText: ["  KIMI  ", { text: "bad" }, "", "x".repeat(140)],
        visualSignals: ["  badge  ", 123, null, "y".repeat(180)],
        flags: [
          {
            category: "embedded_text_sensitive_symbol",
            severity: "medium",
            confidence: 0.7,
            evidence: "visible slogan",
          },
        ],
      }),
    );

    expect(result.visualText).toEqual(["KIMI", "x".repeat(120)]);
    expect(result.visualSignals).toEqual(["badge", "y".repeat(160)]);
    expect(result.reasons).toEqual([
      "embedded_text_sensitive_symbol: visible slogan",
    ]);
  });

  it("holds malformed policy flags instead of silently dropping risk", () => {
    const result = validatePolicyResponse(
      JSON.stringify({
        decision: "pass",
        confidence: 0.92,
        flags: [
          {
            category: "embedded_text_sensitive_symbol",
            confidence: 0.9,
          },
        ],
      }),
    );

    expect(result.decision).toBe("hold");
    expect(result.reasons).toEqual([
      "Policy classifier returned malformed flag evidence.",
    ]);
  });

  it("holds flags with missing confidence instead of defaulting to zero", () => {
    const result = validatePolicyResponse(
      JSON.stringify({
        decision: "pass",
        confidence: 0.96,
        flags: [
          {
            category: "sexual_minors",
            evidence: "childlike sexualized text",
          },
        ],
      }),
    );

    expect(result.decision).toBe("hold");
    expect(result.reasons).toEqual([
      "Policy classifier returned malformed flag evidence.",
    ]);
  });

  it("holds unknown policy categories instead of assuming they are safe", () => {
    const result = validatePolicyResponse(
      JSON.stringify({
        decision: "pass",
        confidence: 0.97,
        flags: [
          {
            category: "new_policy_risk",
            severity: "medium",
            confidence: 0.91,
            evidence: "model detected a risk category the app does not know",
          },
        ],
      }),
    );

    expect(result.decision).toBe("hold");
    expect(result.reasons).toEqual([
      "new_policy_risk: model detected a risk category the app does not know",
    ]);
  });

  it("holds non-array policy flags instead of treating them as absent", () => {
    const result = validatePolicyResponse(
      JSON.stringify({
        decision: "pass",
        confidence: 0.99,
        flags: {
          category: "sexual_minors",
          confidence: 0.99,
          evidence: "risky visible content",
        },
      }),
    );

    expect(result.decision).toBe("hold");
    expect(result.reasons).toEqual([
      "Policy classifier returned malformed flag evidence.",
    ]);
  });
});

describe("submission policy contact sheet", () => {
  it("includes visible sprite frames on a neutral background", async () => {
    const sprite = await sharp({
      create: {
        width: 8 * 192,
        height: 9 * 208,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 192,
              height: 208,
              channels: 4,
              background: { r: 210, g: 20, b: 30, alpha: 1 },
            },
          })
            .png()
            .toBuffer(),
          left: 5 * 192,
          top: 0,
        },
        {
          input: await sharp({
            create: {
              width: 192,
              height: 208,
              channels: 4,
              background: { r: 20, g: 30, b: 220, alpha: 1 },
            },
          })
            .png()
            .toBuffer(),
          left: 7 * 192,
          top: 0,
        },
      ])
      .png()
      .toBuffer();

    const dataUrl = await policyReviewImageDataUrl(sprite);
    expect(dataUrl?.startsWith("data:image/png;base64,")).toBe(true);

    const image = Buffer.from(dataUrl?.split(",")[1] ?? "", "base64");
    const metadata = await sharp(image).metadata();
    expect(metadata.width).toBe(8 * 192);
    expect(metadata.height).toBe(9 * 208);

    const { data } = await sharp(image)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(Array.from(data.slice(0, 4))).toEqual([120, 120, 120, 255]);

    const visibleOffset = (104 * 8 * 192 + 5 * 192 + 96) * 4;
    expect(Array.from(data.slice(visibleOffset, visibleOffset + 4))).toEqual([
      210, 20, 30, 255,
    ]);

    const unusedOffset = (104 * 8 * 192 + 7 * 192 + 96) * 4;
    expect(Array.from(data.slice(unusedOffset, unusedOffset + 4))).toEqual([
      120, 120, 120, 255,
    ]);
  });

  it("rejects oversized sources before extracting review frames", async () => {
    const sprite = await sharp({
      create: {
        width: 4097,
        height: 90,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();

    await expect(policyReviewImageDataUrl(sprite)).resolves.toBeNull();
  });

  it("holds non-ideal spritesheet dimensions with a specific OCR reason", async () => {
    const sprite = await sharp({
      create: {
        width: 2048,
        height: 2048,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();

    await expect(preparePolicyReviewImage(sprite)).resolves.toEqual({
      ok: false,
      reason: "Spritesheet must be 1536x1872 for policy OCR review.",
    });
  });

  it("holds contact sheets that exceed the model payload budget with a specific reason", async () => {
    const width = 8 * 192;
    const height = 9 * 208;
    const sprite = await sharp(randomBytes(width * height * 3), {
      raw: { width, height, channels: 3 },
    })
      .png()
      .toBuffer();

    await expect(preparePolicyReviewImage(sprite)).resolves.toEqual({
      ok: false,
      reason: "Policy review contact sheet exceeds model payload budget.",
    });
  });
});
