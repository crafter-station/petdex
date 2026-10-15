// The success path declares `public, s-maxage=86400`, so the edge caches this
// URL per slug for 24h. The miss branches — a not-yet-approved pet (404) and a
// pet whose colour extraction has not landed (422) — are both transient, so
// they must not be cached as if they were the answer. The sibling
// thumb/wastickers/variants routes carry `no-store` on their miss branches for
// exactly this reason; this suite keeps codex-theme from drifting off that rule.
import { describe, expect, it, mock } from "bun:test";

import * as realSchema from "@/lib/db/schema";

type Row = {
  slug: string;
  displayName: string;
  dominantColor: string | null;
  status: string;
};

let row: Row | undefined;

mock.module("server-only", () => ({}));
mock.module("@/lib/db/client", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => (row ? [row] : []),
  };
  return {
    db: { select: () => chain },
    schema: realSchema,
    executeAtomicReturning: async () => [],
    rowsOf: () => [],
  };
});

const { GET } = await import("@/app/api/pets/[slug]/codex-theme/route");

function get(slug: string): Promise<Response> {
  return GET(new Request(`https://petdex.dev/api/pets/${slug}/codex-theme`), {
    params: Promise.resolve({ slug }),
  });
}

describe("GET /api/pets/[slug]/codex-theme cache headers", () => {
  it("marks the not-found branch no-store", async () => {
    row = undefined;
    const res = await get("ghost");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("marks a pet still pending review no-store", async () => {
    row = {
      slug: "boba",
      displayName: "Boba",
      dominantColor: "#8b5cf6",
      status: "pending",
    };
    const res = await get("boba");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("marks the missing-colour branch no-store", async () => {
    row = {
      slug: "boba",
      displayName: "Boba",
      dominantColor: null,
      status: "approved",
    };
    const res = await get("boba");
    expect(res.status).toBe(422);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps the long-lived public cache on the success branch", async () => {
    row = {
      slug: "boba",
      displayName: "Boba",
      dominantColor: "#8b5cf6",
      status: "approved",
    };
    const res = await get("boba");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "public, s-maxage=86400, stale-while-revalidate=3600",
    );
  });
});

describe("codex-theme malformed color fallback", () => {
  it("answers the neutral theme for a hand-edited non-hex color", async () => {
    // parseHex used to accept any 6-char string ("GGHHII") and let
    // parseInt's NaN reach toHex, which serialized "#NaNNaNNaN". A row
    // color is normally Vibrant's `#rrggbb` output, so this guards the
    // hand-edited row, not the pipeline.
    row = {
      slug: "boba",
      displayName: "Boba",
      dominantColor: "GGHHII",
      status: "approved",
    };
    const res = await get("boba");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { light?: { background?: string } };
    expect(JSON.stringify(body)).not.toContain("NaN");
  });
});
