import {
  type Duration,
  fixedWindow,
  Limiter,
  type RateLimitResult,
  type Storage,
} from "@crafter/limit";
import { memory } from "@crafter/limit/memory";
import { type NeonHttpStorage, neonHttp } from "@crafter/limit/neon";
import { neon } from "@neondatabase/serverless";

import { isLocalDatabaseUrl } from "./db/url-classification";
import { IS_MOCK } from "./mock";

type NeonRatelimit = {
  limit(key: string): Promise<RateLimitResult>;
};

type NeonRatelimitOptions = {
  requests: number;
  window: Duration;
  prefix: string;
};

const mockResult: RateLimitResult = {
  success: true,
  limit: Number.POSITIVE_INFINITY,
  remaining: Number.POSITIVE_INFINITY,
  reset: 0,
};

let storage: Storage | null = null;
let lastCleanupAt = 0;

// The Neon adapter exposes `clearExpired`, but nothing calls it, so
// `crafter_rate_limits` rows accumulate forever — one per key per window,
// for every route's limiter. Sweep opportunistically from the request path
// (there is no cron in this repo): at most once per hour per instance, and
// fire-and-forget so a slow DELETE never delays a request. Fixed windows
// expire after minutes, so an hourly sweep keeps the table tiny.
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function maybeClearExpired(target: Storage): void {
  if (!("clearExpired" in target)) return;
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  void (target as NeonHttpStorage)
    .clearExpired(now)
    .catch((error) => console.error("rate limit cleanup failed", error));
}

function getStorage(): Storage {
  if (storage) return storage;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  // A plain local Postgres cannot be reached by the Neon HTTP adapter — every
  // call throws `Unable to connect` and the limiter fails open, so rate
  // limiting silently did nothing in the environments contributors actually
  // run (`bun run dev:docker` and the self-contained deploy stack). Those run
  // a single app instance, so an in-process counter is the right storage
  // there; `allowInServerless` only acknowledges the library's guard for the
  // odd host that sets a serverless marker while pointing at a local URL.
  // Production is a Neon URL and keeps the distributed adapter — this branch
  // triggers only for loopback and the compose service name.
  const created: Storage = isLocalDatabaseUrl(url)
    ? memory({ allowInServerless: true })
    : neonHttp({
        client: neon(url),
        failureMode: "open",
        onError: (error) => console.error("Neon rate limit failed", error),
      });
  storage = created;
  return created;
}

export function createNeonRatelimit(
  options: NeonRatelimitOptions,
): NeonRatelimit {
  if (IS_MOCK) {
    return { limit: async () => mockResult };
  }
  let limiter: Limiter | null = null;
  return {
    limit: async (key) => {
      try {
        const target = getStorage();
        limiter ??= new Limiter({
          storage: target,
          limit: fixedWindow(options.requests, options.window),
          prefix: options.prefix,
        });
        maybeClearExpired(target);
        return await limiter.limit(key);
      } catch (error) {
        console.error("Neon rate limit failed", error);
        return {
          success: true,
          limit: options.requests,
          remaining: Math.max(0, options.requests - 1),
          reset: 0,
        };
      }
    },
  };
}
