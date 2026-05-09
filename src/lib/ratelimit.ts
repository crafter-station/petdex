import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

import { IS_MOCK } from "./mock";

const redis = Redis.fromEnv();

type RatelimitConfig = ConstructorParameters<typeof Ratelimit>[0];

function createRatelimit(config: RatelimitConfig): Ratelimit {
  if (IS_MOCK) {
    return {
      limit: async () => ({
        success: true,
        limit: Number.POSITIVE_INFINITY,
        remaining: Number.POSITIVE_INFINITY,
        reset: 0,
        pending: Promise.resolve(),
      }),
    } as unknown as Ratelimit;
  }
  return new Ratelimit(config);
}

export const submitRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "24 h"),
  prefix: "petdex:submit",
  analytics: true,
});

// Withdrawals from /my-pets — generous so retries don't lock you out, but
// stops a malicious automated loop.
export const withdrawRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, "10 m"),
  prefix: "petdex:withdraw",
});

// Claim attempts — anti-bruteforce for the cross-account flow even though
// the verified-email check already blocks the actual data move.
export const claimRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, "1 h"),
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

// Likes — generous so legit users browsing the gallery never hit the cap,
// but stops a 100-account brigade from inflating one pet to the top.
export const likeRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(60, "1 h"),
  prefix: "petdex:like",
});

// Pet requests + upvotes share a generous bucket — one user can shape the
// roadmap up to 30 actions / 10 min before we slow them down.
export const petRequestRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, "10 m"),
  prefix: "petdex:requests",
});

// R2 presign requests. Without this, a logged-in attacker can request
// thousands of presigned PUT URLs in a loop and waste R2 storage cost
// even if they never call /api/submit/register afterwards.
export const presignRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, "1 h"),
  prefix: "petdex:presign",
});

export const adCampaignRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "1 h"),
  prefix: "petdex:ad-campaign",
});

export const adCampaignEditRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "24 h"),
  prefix: "petdex:ad-campaign-edit",
});

export const adCheckoutRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, "1 h"),
  prefix: "petdex:ad-checkout",
});

export const adImpressionRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(240, "1 h"),
  prefix: "petdex:ad-impression",
});

export const adEventRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(600, "1 h"),
  prefix: "petdex:ad-event",
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
export const editRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "24 h"),
  prefix: "petdex:edit",
});

// User profile identity edits (display name, handle, bio, locale).
// Self-expression, no admin review, so we only need to stop spam loops.
// Keyed by userId.
export const profileEditRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "24 h"),
  prefix: "petdex:profile-edit",
});

// Pin and pinned-order edits can happen repeatedly while curating a
// profile. Keep the abuse cap, but make it generous enough for drag
// auto-save and one-click pin/unpin flows.
export const profilePinRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(60, "24 h"),
  prefix: "petdex:profile-pin",
});

// /api/manifest/full pulls the full pet catalog with descriptions,
// tags, install commands, page URLs, and asset paths. It's auth-gated
// so it only fires for signed-in users, but the response is bigger
// than slim and re-runs a full DB scan on every hit. 120 reqs/hour
// per user covers any reasonable CLI / dashboard / scripting workflow
// (CLI does 1 per `petdex install`, ~50/h is the realistic ceiling)
// while shutting down a loop. Keyed by userId.
export const manifestFullRatelimit = createRatelimit({
  redis,
  limiter: Ratelimit.slidingWindow(120, "1 h"),
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
