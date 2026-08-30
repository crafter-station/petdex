import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

import { IS_MOCK } from "./mock";
import { createNeonRatelimit } from "./neon-ratelimit";

const redis = Redis.fromEnv();

type RatelimitConfig = ConstructorParameters<typeof Ratelimit>[0];

const ALLOW_WHEN_LIMITER_IS_DOWN = {
  success: true,
  limit: Number.POSITIVE_INFINITY,
  remaining: Number.POSITIVE_INFINITY,
  reset: 0,
  pending: Promise.resolve(),
};

// A rate limiter protects the site, so it must never be what takes the site
// down. Upstash answers a temporarily-blocked database with HTTP 200 and an
// `{"error": ...}` body; the SDK reads that as a success and calls .map() on
// what it assumed was a pipeline result array, throwing `TypeError: r.map is
// not a function` out of .limit(). Uncaught, that turned every rate-limited
// route into a 500, including routes whose handlers never touch Redis.
//
// Wrapping the factory rather than each of the 27 call sites means a limiter
// added later inherits the same fail-open behaviour without anyone
// remembering to ask for it.
function failOpen(limiter: Ratelimit): Ratelimit {
  const inner = limiter.limit.bind(limiter);
  const wrapped: Ratelimit["limit"] = async (identifier, req) => {
    try {
      return await inner(identifier, req);
    } catch {
      return ALLOW_WHEN_LIMITER_IS_DOWN;
    }
  };
  return new Proxy(limiter, {
    get(target, prop, receiver) {
      if (prop === "limit") return wrapped;
      return Reflect.get(target, prop, receiver);
    },
  });
}

// Exported for tests: exercises the wrapper without a live Upstash client.
export function failOpenForTest(limiter: {
  limit: (identifier: string) => Promise<{ success: boolean; reset?: number }>;
}): Ratelimit {
  return failOpen(limiter as unknown as Ratelimit);
}

function createRatelimit(config: RatelimitConfig): Ratelimit {
  if (IS_MOCK) {
    return {
      limit: async () => ALLOW_WHEN_LIMITER_IS_DOWN,
    } as unknown as Ratelimit;
  }
  return failOpen(new Ratelimit(config));
}

export const submitRatelimit = createNeonRatelimit({
  requests: 10,
  window: "24h",
  prefix: "petdex:submit",
});

// CLI presign requests are separate from persisted submissions. Keeping a
// dedicated bucket prevents abandoned uploads from consuming the submission
// quota while still bounding R2 orphan creation.
export const cliPresignRatelimit = createNeonRatelimit({
  requests: 20,
  window: "1h",
  prefix: "petdex:cli-presign",
});

// Withdrawals from /my-pets — generous so retries don't lock you out, but
// stops a malicious automated loop.
export const withdrawRatelimit = createNeonRatelimit({
  requests: 20,
  window: "10m",
  prefix: "petdex:withdraw",
});

// Claim attempts — anti-bruteforce for the cross-account flow even though
// the verified-email check already blocks the actual data move.
export const claimRatelimit = createNeonRatelimit({
  requests: 20,
  window: "1h",
  prefix: "petdex:claim",
});

// Public install-counter increments. Generous because a real user might
// install dozens of pets, but caps obvious automation. Keyed by IP.
export const installCounterRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(60, "1 h"),
  prefix: "petdex:install-count",
});

// Zip-download tracker. Same shape as install-count.
export const trackZipRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(60, "1 h"),
  prefix: "petdex:track-zip",
});

export const publicCatalogRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(60, "1 h"),
  prefix: "petdex:public-catalog",
});

export const publicStateRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(300, "1 h"),
  prefix: "petdex:public-state",
});

export const publicMetadataRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(120, "1 h"),
  prefix: "petdex:public-metadata",
});

// The burst ceiling now lives in @/lib/burst-guard, in process, so a spike
// costs no Redis commands. Only the sustained limits below reach Upstash.

// Public metrics reads — `/api/pets/[slug]/metrics`. Browser pages hit
// this on every visit, and the CDN caches the response for 60s so the
// hot path is free. The limit only kicks in for direct bot/script
// hammering against an uncached slug. Keyed by IP.
export const metricsReadRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(240, "1 h"),
  prefix: "petdex:metrics-read",
});

// Likes — generous so legit users browsing the gallery never hit the cap,
// but stops a 100-account brigade from inflating one pet to the top.
export const likeRatelimit = createNeonRatelimit({
  requests: 60,
  window: "1h",
  prefix: "petdex:like",
});

// Pet requests + upvotes share a generous bucket — one user can shape the
// roadmap up to 30 actions / 10 min before we slow them down.
export const petRequestRatelimit = createNeonRatelimit({
  requests: 30,
  window: "10m",
  prefix: "petdex:requests",
});

// R2 presign requests. Without this, a logged-in attacker can request
// thousands of presigned PUT URLs in a loop and waste R2 storage cost
// even if they never call /api/submit/register afterwards.
export const presignRatelimit = createNeonRatelimit({
  requests: 20,
  window: "1h",
  prefix: "petdex:presign",
});

// CLI bearer verification by IP — stops blind floods of bogus tokens
// burning Clerk userinfo quota.
export const cliVerifyRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(120, "1 m"),
  prefix: "petdex:cli-verify",
});

// Owner edits to displayName/description/tags. Generous within the day so
// the owner can iterate copy, but caps a malicious loop that floods the
// admin queue with edit churn. Keyed by petId.
export const editRatelimit = createNeonRatelimit({
  requests: 5,
  window: "24h",
  prefix: "petdex:edit",
});

// Asset presigns can be retried without creating a submitted edit. Keep that
// transport budget separate so an upload retry does not consume the actual
// edit quota enforced by applyPetEdit. Key by user because orphan creation is
// global across all pets owned by that user.
export const editPresignRatelimit = createNeonRatelimit({
  requests: 20,
  window: "1h",
  prefix: "petdex:edit-presign",
});

// User profile identity edits (display name, handle, bio, locale).
// Self-expression, no admin review, so we only need to stop spam loops.
// Keyed by userId.
export const profileEditRatelimit = createNeonRatelimit({
  requests: 10,
  window: "24h",
  prefix: "petdex:profile-edit",
});

// Pin and pinned-order edits can happen repeatedly while curating a
// profile. Keep the abuse cap, but make it generous enough for drag
// auto-save and one-click pin/unpin flows.
export const profilePinRatelimit = createNeonRatelimit({
  requests: 60,
  window: "24h",
  prefix: "petdex:profile-pin",
});

// /api/manifest/full pulls the full pet catalog with descriptions,
// tags, install commands, page URLs, and asset paths. It's auth-gated
// so it only fires for signed-in users, but the response is bigger
// than slim and re-runs a full DB scan on every hit. 120 reqs/hour
// per user covers any reasonable CLI / dashboard / scripting workflow
// (CLI does 1 per `petdex install`, ~50/h is the realistic ceiling)
// while shutting down a loop. Keyed by userId.
export const manifestFullRatelimit = createNeonRatelimit({
  requests: 120,
  window: "1h",
  prefix: "petdex:manifest-full",
});

// Telemetry event ingestion. One UUID per device, fire-and-forget. 60/min
// stops a loop from filling the DB but never triggers on normal CLI usage.
// Keyed by IP because install_id can be faked.
export const telemetryRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(60, "1 m"),
  prefix: "petdex:telemetry",
});

export const wechatQrUploadRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "1 h"),
  prefix: "petdex:wechat-qr-upload",
});
