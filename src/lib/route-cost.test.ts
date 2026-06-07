import { describe, expect, it } from "bun:test";

import {
  buildRouteCostSample,
  classifyRouteCostReferrerSource,
  classifyRouteCostTrafficSource,
  normalizeRouteCostPath,
  routeCostKind,
  routeCostSampleRate,
  routeCostSecret,
} from "@/lib/route-cost";

describe("route cost helpers", () => {
  it("normalizes localized page paths without keeping user slugs", () => {
    expect(normalizeRouteCostPath("/en/pets/byte-bunny")).toBe("/pets/[slug]");
    expect(normalizeRouteCostPath("/zh/u/henryjing96")).toBe("/u/[handle]");
  });

  it("normalizes app dynamic route ids before storing buckets", () => {
    expect(
      normalizeRouteCostPath("/en/advertise/dashboard/ad_abc123def/edit"),
    ).toBe("/advertise/dashboard/[campaignId]/edit");
    expect(normalizeRouteCostPath("/api/my-pets/pet_abc123def/edit")).toBe(
      "/api/my-pets/[id]/edit",
    );
    expect(normalizeRouteCostPath("/api/ads/ad_abc123def")).toBe(
      "/api/ads/[id]",
    );
    expect(normalizeRouteCostPath("/api/feedback/fb_abc123def")).toBe(
      "/api/feedback/[id]",
    );
  });

  it("keeps static API search paths distinct from pet slug routes", () => {
    expect(normalizeRouteCostPath("/api/pets/search")).toBe("/api/pets/search");
    expect(normalizeRouteCostPath("/api/pets/random")).toBe("/api/pets/random");
    expect(normalizeRouteCostPath("/api/pets/byte-bunny/metrics")).toBe(
      "/api/pets/[slug]/metrics",
    );
  });

  it("keeps static API routes ahead of dynamic patterns", () => {
    expect(normalizeRouteCostPath("/en/collections/opengraph-image")).toBe(
      "/collections/opengraph-image",
    );
    expect(normalizeRouteCostPath("/api/ads/checkout")).toBe(
      "/api/ads/checkout",
    );
    expect(normalizeRouteCostPath("/api/ads/event")).toBe("/api/ads/event");
  });

  it("buckets unmatched paths without preserving random segments", () => {
    expect(normalizeRouteCostPath("/x/random-404-path")).toBe("/[unmatched]");
    expect(normalizeRouteCostPath("/api/x/ad_random_123456")).toBe(
      "/api/[unmatched]",
    );
  });

  it("classifies asset-heavy API routes separately", () => {
    expect(routeCostKind("/api/pets/[slug]/thumb")).toBe("asset-api");
    expect(routeCostKind("/api/pets/search")).toBe("api");
    expect(routeCostKind("/pets/[slug]")).toBe("page");
  });

  it("builds weighted samples and skips the ingestion route", () => {
    expect(
      buildRouteCostSample({
        method: "get",
        pathname: "/api/internal/route-cost",
        sampleRate: 0.001,
      }),
    ).toBeNull();
    expect(
      buildRouteCostSample({
        method: "get",
        pathname: "/api/pets/byte-bunny/thumb",
        sampleRate: 0.001,
      }),
    ).toMatchObject({
      method: "GET",
      referrerSource: "direct",
      route: "/api/pets/[slug]/thumb",
      routeKind: "asset-api",
      sampleWeight: 1000,
      trafficSource: "unknown",
    });
  });

  it("classifies sampled browser and prefetch requests without storing raw headers", () => {
    expect(
      classifyRouteCostTrafficSource({
        "next-router-prefetch": "1",
        "user-agent": "Mozilla/5.0",
      }),
    ).toBe("prefetch");
    expect(
      classifyRouteCostTrafficSource({
        "sec-fetch-site": "same-origin",
        "user-agent": "Mozilla/5.0",
      }),
    ).toBe("browser");
    expect(
      classifyRouteCostReferrerSource(
        { referer: "https://petdex.dev/pets/nukey" },
        "https://petdex.dev",
      ),
    ).toBe("internal");
  });

  it("classifies preview, bot, monitor, and external referrers coarsely", () => {
    expect(
      classifyRouteCostTrafficSource({
        "user-agent": "Discordbot/2.0",
      }),
    ).toBe("preview");
    expect(
      classifyRouteCostTrafficSource({
        "user-agent": "Googlebot/2.1",
      }),
    ).toBe("bot");
    expect(
      classifyRouteCostTrafficSource({
        "user-agent": "curl/8.7.1",
      }),
    ).toBe("monitor");
    expect(
      classifyRouteCostReferrerSource(
        { referer: "https://www.google.com/search?q=petdex" },
        "https://petdex.dev",
      ),
    ).toBe("search");
    expect(
      classifyRouteCostReferrerSource(
        { referer: "https://github.com/crafter-station/petdex" },
        "https://petdex.dev",
      ),
    ).toBe("external");
  });

  it("requires explicit route cost env values", () => {
    const previousSecret = process.env.PETDEX_ROUTE_COST_SECRET;
    const previousTelemetrySecret = process.env.TELEMETRY_RATELIMIT_SECRET;
    const previousUpstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const previousRate = process.env.PETDEX_ROUTE_COST_SAMPLE_RATE;

    try {
      process.env.PETDEX_ROUTE_COST_SECRET = "";
      process.env.TELEMETRY_RATELIMIT_SECRET = " telemetry-secret ";
      process.env.UPSTASH_REDIS_REST_TOKEN = "upstash-token";
      process.env.PETDEX_ROUTE_COST_SAMPLE_RATE = "";

      expect(routeCostSecret()).toBeNull();
      expect(routeCostSampleRate()).toBe(0);

      process.env.PETDEX_ROUTE_COST_SECRET = " route-secret ";
      process.env.PETDEX_ROUTE_COST_SAMPLE_RATE = "0.001";
      expect(routeCostSecret()).toBe("route-secret");
      expect(routeCostSampleRate()).toBe(0.001);

      process.env.PETDEX_ROUTE_COST_SAMPLE_RATE = "0.2";
      expect(routeCostSampleRate()).toBe(0.05);

      process.env.PETDEX_ROUTE_COST_SAMPLE_RATE = "0.000000001";
      expect(routeCostSampleRate()).toBe(0.000001);
    } finally {
      restoreEnv("PETDEX_ROUTE_COST_SECRET", previousSecret);
      restoreEnv("TELEMETRY_RATELIMIT_SECRET", previousTelemetrySecret);
      restoreEnv("UPSTASH_REDIS_REST_TOKEN", previousUpstashToken);
      restoreEnv("PETDEX_ROUTE_COST_SAMPLE_RATE", previousRate);
    }
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
