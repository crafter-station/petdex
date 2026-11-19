import { embed } from "ai";

export const PETDEX_EMBEDDING_MODEL = "google/gemini-embedding-2";
export const PETDEX_EMBEDDING_DIMENSIONS = 3072;

const MAX_EMBEDDING_INPUT_CHARS = 8000;
// The policy call already runs under a 15s ceiling; the embedding call sat
// next to it with none, so a hung gateway could pin a serverless instance for
// as long as the provider kept the socket open. Match the policy budget.
const EMBEDDING_TIMEOUT_MS = 15_000;

export async function embedTextValue(value: string): Promise<number[] | null> {
  const input = value.trim().slice(0, MAX_EMBEDDING_INPUT_CHARS);
  if (!input) return null;

  try {
    const result = await embed({
      model: PETDEX_EMBEDDING_MODEL,
      value: input,
      abortSignal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
    });
    if (result.embedding.length !== PETDEX_EMBEDDING_DIMENSIONS) {
      console.warn(
        `[embeddings] ${PETDEX_EMBEDDING_MODEL} returned ${result.embedding.length} dimensions, expected ${PETDEX_EMBEDDING_DIMENSIONS}`,
      );
      return null;
    }
    return result.embedding;
  } catch (err) {
    console.warn(
      "[embeddings] embed failed:",
      (err as Error).message?.slice(0, 200),
    );
    return null;
  }
}

export function buildPetEmbeddingText(args: {
  displayName: string;
  description: string;
  kind: string;
  tags: string[];
  vibes: string[];
}): string {
  return [
    args.displayName,
    args.description,
    args.kind,
    args.tags.join(" "),
    args.vibes.join(" "),
  ]
    .filter(Boolean)
    .join("\n");
}

export function embeddingVectorLiteral(vec: number[]): string {
  return `[${vec.map((n) => (Number.isFinite(n) ? n : 0)).join(",")}]`;
}

export function hasCurrentEmbeddingDimensions(
  value: unknown,
): value is number[] {
  return Array.isArray(value) && value.length === PETDEX_EMBEDDING_DIMENSIONS;
}
