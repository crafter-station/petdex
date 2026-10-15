import { fetchCapped } from "./fetch-capped.js";

// API responses here are JSON payloads or short error bodies: 1 MB is far
// above anything legitimate and stops a misbehaving server from buffering an
// unbounded body. 15 s matches the edit path's own spinner UX — long enough
// for a cold Neon start, short enough that a hang is reported instead of
// freezing the CLI, which is the bug this exists to close.
const API_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type ApiResult = {
  ok: boolean;
  status: number;
  statusText: string;
  /** The body as text — never rejects: parse failures are for the caller. */
  text(): Promise<string>;
  /** The body parsed as JSON. Throws on an invalid payload. */
  json<T>(): Promise<T>;
};

/** Injection points used by tests; callers in the CLI pass neither. */
export type ApiRequestOptions = {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Bounded request against a Petdex API endpoint.
 *
 * Every API call in the CLI used to be a bare `fetch` with no `signal`, so a
 * server that accepted the connection and then stalled froze the command
 * with no spinner message and no exit — `petdex edit`/`submit` could hang
 * forever. This shares `fetchCapped`'s timeout and size cap with the asset
 * downloads that already use it.
 *
 * Throws only for transport failures (timeout, network). HTTP errors come
 * back as `ok: false` for the caller's own handling, exactly like `fetch`.
 */
export async function apiRequest(
  url: string,
  init?: RequestInit,
  options: ApiRequestOptions = {},
): Promise<ApiResult> {
  const result = await fetchCapped(url, {
    init,
    maxBytes: MAX_RESPONSE_BYTES,
    timeoutMs: options.timeoutMs ?? API_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
  });
  const body = result.body.toString("utf8");
  return {
    ok: result.ok,
    status: result.status,
    statusText: result.statusText,
    text: async () => body,
    json: async <T>() => JSON.parse(body) as T,
  };
}
