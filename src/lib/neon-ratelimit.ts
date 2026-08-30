import {
  type Duration,
  fixedWindow,
  Limiter,
  type RateLimitResult,
} from "@crafter/limit";
import { neonHttp } from "@crafter/limit/neon";
import { neon } from "@neondatabase/serverless";

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

let storage: ReturnType<typeof neonHttp> | null = null;

function getStorage(): ReturnType<typeof neonHttp> {
  if (storage) return storage;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }
  storage = neonHttp({
    client: neon(process.env.DATABASE_URL),
    failureMode: "open",
    onError: (error) => console.error("Neon rate limit failed", error),
  });
  return storage;
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
        limiter ??= new Limiter({
          storage: getStorage(),
          limit: fixedWindow(options.requests, options.window),
          prefix: options.prefix,
        });
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
