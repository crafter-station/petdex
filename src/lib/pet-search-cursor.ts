/**
 * Paging bounds shared by the gallery search.
 *
 * Kept out of `pet-search.ts` on purpose: that module opens a database client
 * at import time, so anything living there can only be tested with a database
 * configured. This is arithmetic, and it is the part that decides whether a
 * hostile `cursor` reaches the SQL as an out-of-range `OFFSET`.
 */

export const DEFAULT_LIMIT = 24;
export const MAX_LIMIT = 60;

/**
 * Highest offset a caller may page to.
 *
 * `cursor` becomes the SQL `OFFSET`, so it has to stay inside what Postgres
 * will accept. Two limits bite before that: values above
 * `Number.MAX_SAFE_INTEGER` arrive already rounded (`parseInt("99999999999999999999")`
 * is `1e20`), and Postgres rejects anything past `bigint` with
 * `22003 bigint out of range` — a 500 with the whole statement echoed into the
 * logs, for a request that only asked to page too far.
 *
 * An offset past the end of the data already means "empty page", so capping
 * the value preserves that answer for every real dataset while keeping the
 * arithmetic exact: this bound plus a limit stays well inside the range where
 * integers are represented exactly.
 */
export const MAX_CURSOR = 1_000_000_000;

export function clampCursor(raw: number | undefined): number {
  const value = raw ?? 0;
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.trunc(value)), MAX_CURSOR);
}

export const SEARCH_LIMITS = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_CURSOR,
} as const;
