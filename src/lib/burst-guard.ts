// In-process burst guard.
//
// The burst limit used to be an Upstash sliding window, which meant every
// guarded request paid a Redis round trip for the burst check and a second
// one for its per-rule limit. That doubled the command bill on the hot path
// to catch a case a local counter catches just as well: a single client
// hammering a single instance within one minute.
//
// This trades exactness for cost. Each serverless instance keeps its own
// window, so a client spread across N instances gets up to N times the
// ceiling before the per-rule limiter (still backed by Redis) stops it. That
// is an acceptable ceiling for a burst guard whose job is absorbing spikes,
// not enforcing a quota.

const WINDOW_MS = 60_000;
const MAX_HITS_PER_WINDOW = 120;
// Bounds memory on an instance that sees many distinct IPs. Old entries are
// evicted oldest-first, which at worst forgives a client mid-window.
const MAX_TRACKED_KEYS = 10_000;

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

export type BurstVerdict = { success: boolean; reset: number };

export function checkBurst(key: string, now = Date.now()): BurstVerdict {
  const existing = windows.get(key);

  if (!existing || now >= existing.resetAt) {
    const resetAt = now + WINDOW_MS;
    // Re-inserting moves the key to the end of the Map's insertion order, so
    // the eviction below stays oldest-first.
    windows.delete(key);
    windows.set(key, { count: 1, resetAt });
    if (windows.size > MAX_TRACKED_KEYS) {
      const oldest = windows.keys().next();
      if (!oldest.done) windows.delete(oldest.value);
    }
    return { success: true, reset: resetAt };
  }

  existing.count += 1;
  return {
    success: existing.count <= MAX_HITS_PER_WINDOW,
    reset: existing.resetAt,
  };
}

export function resetBurstGuardForTest(): void {
  windows.clear();
}
