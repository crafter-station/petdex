import {
  decideAutomatedReview,
  type ReviewDecisionResult,
} from "@/lib/submission-review-decision";
import type {
  PolicyFlag,
  ReviewCheckDecision,
  ReviewChecks,
} from "@/lib/submission-review-types";

export type AssetFetcherPort = {
  fetchBytes(url: string, maxBytes: number): Promise<Uint8Array>;
};

export type PolicyEvaluationInput = {
  displayName: string;
  description?: string | null;
  kind?: string | null;
  tags?: readonly string[];
  imageDataUrl?: string | null;
  petJson?: unknown;
};

export type PolicyEvaluationResult = {
  decision: ReviewCheckDecision;
  flags: PolicyFlag[];
  summary: string;
  model: string;
};

export type PolicyEvaluatorPort = {
  evaluatePolicy(input: PolicyEvaluationInput): Promise<PolicyEvaluationResult>;
};

export type EmbeddingResult = {
  vector: number[];
  model: string;
};

export type EmbeddingPort = {
  embedText(text: string): Promise<EmbeddingResult>;
};

export type SubmissionReviewPorts = {
  assetFetcher: AssetFetcherPort;
  policyEvaluator: PolicyEvaluatorPort;
  embedder: EmbeddingPort;
};

export class AssetSizeLimitError extends Error {
  readonly url: string;
  readonly actualBytes: number;
  readonly maxBytes: number;

  constructor(url: string, actualBytes: number, maxBytes: number) {
    super(
      `Asset at ${url} (${actualBytes} bytes) exceeds maxBytes limit of ${maxBytes}.`,
    );
    this.name = "AssetSizeLimitError";
    this.url = url;
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
  }
}

export class AssetNotFoundError extends Error {
  readonly url: string;

  constructor(url: string) {
    super(`Asset not found in in-memory store: ${url}`);
    this.name = "AssetNotFoundError";
    this.url = url;
  }
}

export function createInMemoryAssetFetcher(
  assets:
    | ReadonlyMap<string, Uint8Array>
    | Readonly<Record<string, Uint8Array>>,
): AssetFetcherPort {
  const store =
    assets instanceof Map ? new Map(assets) : new Map(Object.entries(assets));

  return {
    async fetchBytes(url: string, maxBytes: number): Promise<Uint8Array> {
      const payload = store.get(url);
      if (!payload) {
        throw new AssetNotFoundError(url);
      }
      if (maxBytes < 0 || payload.byteLength > maxBytes) {
        throw new AssetSizeLimitError(url, payload.byteLength, maxBytes);
      }
      return new Uint8Array(payload);
    },
  };
}

const DEFAULT_POLICY_RESULT: PolicyEvaluationResult = {
  decision: "pass",
  flags: [],
  summary: "Stub policy evaluation passed.",
  model: "stub-policy-v1",
};

export type StubPolicyEvaluatorConfig =
  | Partial<PolicyEvaluationResult>
  | ((
      input: PolicyEvaluationInput,
    ) => PolicyEvaluationResult | Promise<PolicyEvaluationResult>);

export function createStubPolicyEvaluator(
  config?: StubPolicyEvaluatorConfig,
): PolicyEvaluatorPort {
  return {
    async evaluatePolicy(
      input: PolicyEvaluationInput,
    ): Promise<PolicyEvaluationResult> {
      if (typeof config === "function") {
        const result = await config(input);
        return {
          ...result,
          flags: result.flags.map((flag) => ({ ...flag })),
        };
      }
      return {
        decision: config?.decision ?? DEFAULT_POLICY_RESULT.decision,
        flags: (config?.flags ?? DEFAULT_POLICY_RESULT.flags).map((flag) => ({
          ...flag,
        })),
        summary: config?.summary ?? DEFAULT_POLICY_RESULT.summary,
        model: config?.model ?? DEFAULT_POLICY_RESULT.model,
      };
    },
  };
}

export type StubEmbedderOptions = {
  dimensions?: number;
  model?: string;
  vectors?: Readonly<Record<string, readonly number[]>>;
};

export function createStubEmbedder(
  options: StubEmbedderOptions = {},
): EmbeddingPort {
  const dimensions = Math.max(1, options.dimensions ?? 8);
  const model = options.model ?? "stub-embed-v1";
  const vectors = options.vectors;

  return {
    async embedText(text: string): Promise<EmbeddingResult> {
      const override = vectors?.[text];
      if (override) {
        return { vector: [...override], model };
      }

      const raw = new Array<number>(dimensions);
      let normSq = 0;
      for (let i = 0; i < dimensions; i += 1) {
        const hash = fnv1a32(`${i}:${text}`);
        const value = ((hash % 2001) - 1000) / 1000;
        raw[i] = value;
        normSq += value * value;
      }

      const norm = Math.sqrt(normSq) || 1;
      return {
        vector: raw.map((v) => Number((v / norm).toFixed(6))),
        model,
      };
    },
  };
}

export function evaluateReviewOutcome(
  checks: ReviewChecks,
): ReviewDecisionResult {
  return decideAutomatedReview(checks);
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
