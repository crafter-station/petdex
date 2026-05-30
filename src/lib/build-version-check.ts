import { createBuildVersionToken } from "@/lib/build-version-token";

export const BUILD_VERSION_PATH = "/version.json";
export const BUILD_VERSION_FETCH_TIMEOUT_MS = 5_000;

const CHUNK_LOAD_FAILURE_PATTERNS = [
  "chunkloaderror",
  "loading chunk",
  "failed to fetch dynamically imported module",
  "importing a module script failed",
];

export function getBuildVersionTokenFromPayload(
  payload: unknown,
): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const version = (payload as { version?: unknown }).version;

  if (typeof version !== "string") {
    return null;
  }

  const builtAt = (payload as { builtAt?: unknown }).builtAt;

  return createBuildVersionToken({
    builtAt: typeof builtAt === "string" ? builtAt : null,
    version,
  });
}

export async function fetchBuildVersion(
  fetcher: typeof fetch = fetch,
  options: { timeoutMs?: number } = {},
): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? BUILD_VERSION_FETCH_TIMEOUT_MS,
  );

  try {
    const response = await fetcher(
      `${BUILD_VERSION_PATH}?t=${Date.now().toString()}`,
      { cache: "no-store", signal: controller.signal },
    );

    if (!response.ok) {
      return null;
    }

    return getBuildVersionTokenFromPayload(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function isChunkLoadFailure(errorLike: unknown): boolean {
  const message = getErrorLikeMessage(errorLike).toLowerCase();

  return CHUNK_LOAD_FAILURE_PATTERNS.some((pattern) =>
    message.includes(pattern),
  );
}

function getErrorLikeMessage(errorLike: unknown): string {
  if (typeof errorLike === "string") {
    return errorLike;
  }

  if (errorLike instanceof Error) {
    return errorLike.message;
  }

  if (!errorLike || typeof errorLike !== "object") {
    return "";
  }

  const maybeMessage = (errorLike as { message?: unknown }).message;
  if (typeof maybeMessage === "string") {
    return maybeMessage;
  }

  const maybeReason = (errorLike as { reason?: unknown }).reason;
  if (maybeReason !== undefined) {
    return getErrorLikeMessage(maybeReason);
  }

  const maybeError = (errorLike as { error?: unknown }).error;
  if (maybeError !== undefined) {
    return getErrorLikeMessage(maybeError);
  }

  return "";
}
