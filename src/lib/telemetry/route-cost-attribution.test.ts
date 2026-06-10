import { describe, expect, it } from "bun:test";

import { combineRouteCostAttributionRows } from "@/lib/telemetry/route-cost-attribution";

describe("route cost attribution merge", () => {
  it("keeps legacy residuals when source buckets cover only part of a window", () => {
    const rows = combineRouteCostAttributionRows(
      [
        {
          bucketStart: "2026-06-04T10:00:00.000Z",
          estimatedRequests: 10_000,
          method: "GET",
          route: "/pets/[slug]",
          routeKind: "page",
          samples: 10,
        },
      ],
      [
        {
          bucketStart: "2026-06-04T10:00:00.000Z",
          estimatedRequests: 3_000,
          method: "GET",
          referrerSource: "internal",
          route: "/pets/[slug]",
          routeKind: "page",
          samples: 3,
          trafficSource: "browser",
        },
      ],
    );

    expect(rows).toEqual([
      {
        estimatedRequests: 7_000,
        method: "GET",
        referrerSource: "unknown",
        route: "/pets/[slug]",
        routeKind: "page",
        samples: 7,
        trafficSource: "unknown",
      },
      {
        estimatedRequests: 3_000,
        method: "GET",
        referrerSource: "internal",
        route: "/pets/[slug]",
        routeKind: "page",
        samples: 3,
        trafficSource: "browser",
      },
    ]);
  });

  it("does not create negative residuals when source rows meet legacy totals", () => {
    const rows = combineRouteCostAttributionRows(
      [
        {
          bucketStart: "2026-06-04T10:00:00.000Z",
          estimatedRequests: 1_000,
          method: "GET",
          route: "/api/me/header-state",
          routeKind: "api",
          samples: 1,
        },
      ],
      [
        {
          bucketStart: "2026-06-04T10:00:00.000Z",
          estimatedRequests: 1_000,
          method: "GET",
          referrerSource: "internal",
          route: "/api/me/header-state",
          routeKind: "api",
          samples: 1,
          trafficSource: "browser",
        },
      ],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.trafficSource).toBe("browser");
  });

  it("sums the same route and source across buckets into one returned row", () => {
    const rows = combineRouteCostAttributionRows(
      [
        {
          bucketStart: "2026-06-04T10:00:00.000Z",
          estimatedRequests: 1_000,
          method: "GET",
          route: "/pets/[slug]",
          routeKind: "page",
          samples: 1,
        },
        {
          bucketStart: "2026-06-04T10:15:00.000Z",
          estimatedRequests: 2_000,
          method: "GET",
          route: "/pets/[slug]",
          routeKind: "page",
          samples: 2,
        },
      ],
      [
        {
          bucketStart: "2026-06-04T10:00:00.000Z",
          estimatedRequests: 1_000,
          method: "GET",
          referrerSource: "internal",
          route: "/pets/[slug]",
          routeKind: "page",
          samples: 1,
          trafficSource: "browser",
        },
        {
          bucketStart: "2026-06-04T10:15:00.000Z",
          estimatedRequests: 2_000,
          method: "GET",
          referrerSource: "internal",
          route: "/pets/[slug]",
          routeKind: "page",
          samples: 2,
          trafficSource: "browser",
        },
      ],
    );

    expect(rows).toEqual([
      {
        estimatedRequests: 3_000,
        method: "GET",
        referrerSource: "internal",
        route: "/pets/[slug]",
        routeKind: "page",
        samples: 3,
        trafficSource: "browser",
      },
    ]);
  });
});
