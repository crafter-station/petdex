import { toCurrentR2PublicUrl } from "@/lib/r2-public-url";
import { readResponseBodyBounded } from "@/lib/response-body";
import { PET_ASSET_MAX_BYTES } from "@/lib/upload-limits";

export const PETDEX_ASSET_REFERER = "https://petdex.dev/";

// Spritesheets run past Next's 2MB data-cache cap (see the per-pet OG route),
// so a whole-sheet fetch is bounded at the upload ceiling the review pipeline
// already uses, with the same read deadline the rest of the pipeline applies.
export const R2_ASSET_FETCH_TIMEOUT_MS = 10_000;
export const R2_ASSET_MAX_BYTES = PET_ASSET_MAX_BYTES;

export function fetchR2Asset(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("Referer")) headers.set("Referer", PETDEX_ASSET_REFERER);
  const target =
    typeof input === "string"
      ? toCurrentR2PublicUrl(input)
      : input instanceof URL
        ? new URL(toCurrentR2PublicUrl(input.toString()))
        : input;
  return fetch(target, { ...init, headers });
}

/**
 * Fetch an R2 asset with a deadline and a byte ceiling, returning the body or
 * `null` when the response is not ok. The bounded read is the point: the
 * source URL originates from a user submission, so an oversized or stalled
 * upstream must not be able to hold a serverless invocation open or buffer an
 * unbounded body. Callers that treat fetch failure as "no asset" use this;
 * callers that throw keep `fetchR2Asset` + `readResponseBodyBounded` directly.
 */
export async function fetchR2AssetBuffer(
  input: RequestInfo | URL,
  options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<Buffer | null> {
  const maxBytes = options.maxBytes ?? R2_ASSET_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? R2_ASSET_FETCH_TIMEOUT_MS;
  const res = await fetchR2Asset(input, {
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  return readResponseBodyBounded(res, maxBytes, timeoutMs);
}
