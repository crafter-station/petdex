import { describe, expect, it } from "bun:test";

import {
  AssetNotFoundError,
  AssetSizeLimitError,
  createInMemoryAssetFetcher,
  createStubEmbedder,
  createStubPolicyEvaluator,
  evaluateReviewOutcome,
  type SubmissionReviewPorts,
} from "@/lib/submission-review-ports";
import type { ReviewChecks } from "@/lib/submission-review-types";

function makeCleanChecks(overrides?: Partial<ReviewChecks>): ReviewChecks {
  return {
    assets: { decision: "pass", reasons: [] },
    security: { decision: "pass", reasons: [], findings: [] },
    policy: {
      decision: "pass",
      confidence: 0.96,
      reasons: [],
      flags: [],
    },
    duplicates: {
      decision: "pass",
      reasons: [],
      exactMatches: [],
      visualMatches: [],
      semanticMatches: [],
      metadataMatches: [],
    },
    autopilot: { applied: false, dryRun: false, reason: null },
    ...overrides,
  };
}

describe("AssetFetcherPort (createInMemoryAssetFetcher)", () => {
  it("returns a copy of the stored asset bytes when within maxBytes", async () => {
    const source = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const fetcher = createInMemoryAssetFetcher({
      "https://cdn.petdex.test/pets/mochi.png": source,
    });

    const bytes = await fetcher.fetchBytes(
      "https://cdn.petdex.test/pets/mochi.png",
      64,
    );

    expect(Array.from(bytes)).toEqual(Array.from(source));
    bytes[0] = 0;
    const secondRead = await fetcher.fetchBytes(
      "https://cdn.petdex.test/pets/mochi.png",
      64,
    );
    expect(secondRead[0]).toBe(137);
  });

  it("throws AssetSizeLimitError when payload exceeds maxBytes", async () => {
    const oversized = new Uint8Array(1024);
    const fetcher = createInMemoryAssetFetcher(
      new Map([["https://cdn.petdex.test/pets/huge.png", oversized]]),
    );

    await expect(
      fetcher.fetchBytes("https://cdn.petdex.test/pets/huge.png", 512),
    ).rejects.toBeInstanceOf(AssetSizeLimitError);
  });

  it("throws AssetNotFoundError when url is absent", async () => {
    const fetcher = createInMemoryAssetFetcher({});

    await expect(
      fetcher.fetchBytes("https://cdn.petdex.test/pets/missing.png", 512),
    ).rejects.toBeInstanceOf(AssetNotFoundError);
  });
});

describe("PolicyEvaluatorPort (createStubPolicyEvaluator)", () => {
  it("returns a default passing policy evaluation", async () => {
    const evaluator = createStubPolicyEvaluator();
    const result = await evaluator.evaluatePolicy({
      displayName: "Mochi Cat",
      description: "A sleepy pixel cat.",
      tags: ["cat", "pixel"],
    });

    expect(result.decision).toBe("pass");
    expect(result.flags).toEqual([]);
    expect(result.model).toBe("stub-policy-v1");
  });

  it("supports custom static and dynamic policy decisions with flags", async () => {
    const evaluator = createStubPolicyEvaluator((input) => ({
      decision: input.displayName.includes("NSFW") ? "fail" : "hold",
      flags: [
        {
          category: "inappropriate_content",
          severity: "high",
          confidence: 0.94,
          evidence: `Flagged name: ${input.displayName}`,
        },
      ],
      summary: "Policy flag raised in stub.",
      model: "stub-policy-strict",
    }));

    const flagged = await evaluator.evaluatePolicy({
      displayName: "NSFW Pet",
    });

    expect(flagged.decision).toBe("fail");
    expect(flagged.flags).toHaveLength(1);
    expect(flagged.flags[0]?.category).toBe("inappropriate_content");
    expect(flagged.model).toBe("stub-policy-strict");
  });
});

describe("EmbeddingPort (createStubEmbedder)", () => {
  it("produces deterministic normalized vectors for identical text", async () => {
    const embedder = createStubEmbedder({ dimensions: 12 });
    const first = await embedder.embedText("sleepy orange tabby cat");
    const second = await embedder.embedText("sleepy orange tabby cat");
    const other = await embedder.embedText("cyberpunk neon dragon");

    expect(first.model).toBe("stub-embed-v1");
    expect(first.vector).toHaveLength(12);
    expect(first.vector).toEqual(second.vector);
    expect(first.vector).not.toEqual(other.vector);
  });

  it("returns configured override vectors when provided", async () => {
    const embedder = createStubEmbedder({
      model: "custom-embed-v1",
      vectors: {
        "pixel frog": [1, 0, 0],
      },
    });

    const result = await embedder.embedText("pixel frog");
    expect(result).toEqual({
      vector: [1, 0, 0],
      model: "custom-embed-v1",
    });
  });
});

describe("SubmissionReviewPorts + evaluateReviewOutcome", () => {
  it("auto-approves a clean submission using in-memory ports", async () => {
    const ports: SubmissionReviewPorts = {
      assetFetcher: createInMemoryAssetFetcher({
        "https://cdn.petdex.test/pets/pika.png": new Uint8Array([1, 2, 3, 4]),
      }),
      policyEvaluator: createStubPolicyEvaluator({ decision: "pass" }),
      embedder: createStubEmbedder({ dimensions: 4 }),
    };

    const bytes = await ports.assetFetcher.fetchBytes(
      "https://cdn.petdex.test/pets/pika.png",
      1024,
    );
    const policy = await ports.policyEvaluator.evaluatePolicy({
      displayName: "Pixel Fox",
    });
    const embedding = await ports.embedder.embedText("Pixel Fox");

    expect(bytes.byteLength).toBe(4);
    expect(embedding.vector).toHaveLength(4);

    const outcome = evaluateReviewOutcome(
      makeCleanChecks({
        policy: {
          decision: policy.decision,
          confidence: 0.95,
          reasons: [],
          flags: policy.flags,
        },
      }),
    );

    expect(outcome.decision).toBe("auto_approve");
    expect(outcome.reasonCode).toBe("clean_unique_submission");
    expect(outcome.canApply).toBe(true);
  });

  it("holds when policy evaluation returns hold or fail", async () => {
    const evaluator = createStubPolicyEvaluator({
      decision: "hold",
      flags: [
        {
          category: "brand_trademark",
          severity: "medium",
          confidence: 0.78,
          evidence: "Possible third-party mascot",
        },
      ],
      summary: "Needs human trademark check.",
    });

    const policy = await evaluator.evaluatePolicy({
      displayName: "Mystery Mascot",
    });

    const outcome = evaluateReviewOutcome(
      makeCleanChecks({
        policy: {
          decision: policy.decision,
          confidence: 0.78,
          reasons: [policy.summary],
          flags: policy.flags,
        },
      }),
    );

    expect(outcome.decision).toBe("hold");
    expect(outcome.reasonCode).toBe("policy_review_hold");
    expect(outcome.canApply).toBe(false);
  });

  it("holds when asset fetch fails due to asset size limit", async () => {
    const fetcher = createInMemoryAssetFetcher({
      "https://cdn.petdex.test/pets/giant.png": new Uint8Array(2048),
    });

    let assetFailureReason: string | null = null;
    try {
      await fetcher.fetchBytes("https://cdn.petdex.test/pets/giant.png", 1024);
    } catch (error) {
      if (error instanceof AssetSizeLimitError) {
        assetFailureReason = error.message;
      }
    }

    expect(assetFailureReason).not.toBeNull();

    const outcome = evaluateReviewOutcome(
      makeCleanChecks({
        assets: {
          decision: "fail",
          reasons: [assetFailureReason ?? "Asset exceeds limit."],
        },
      }),
    );

    expect(outcome.decision).toBe("hold");
    expect(outcome.reasonCode).toBe("asset_review_hold");
    expect(outcome.canApply).toBe(false);
  });

  it("auto-rejects exact duplicate submissions", () => {
    const outcome = evaluateReviewOutcome(
      makeCleanChecks({
        duplicates: {
          decision: "fail",
          reasons: ["Exact sprite SHA-256 match."],
          exactMatches: [
            {
              id: "pet_123",
              slug: "mochi-cat",
              displayName: "Mochi Cat",
              status: "approved",
            },
          ],
          visualMatches: [],
          semanticMatches: [],
          metadataMatches: [],
        },
      }),
    );

    expect(outcome.decision).toBe("auto_reject");
    expect(outcome.reasonCode).toBe("duplicate_exact_asset");
    expect(outcome.canApply).toBe(true);
  });
});
