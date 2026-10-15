// The full manifest hands the caller an install command and a page URL.
// Those were built from `new URL(req.url).origin`, which in a container is
// the server's bind address — the manifest advertised
// `curl -sSf http://0.0.0.0:3000/install/<slug> | sh`, a host no client can
// reach, so every command it published was broken. `PETDEX_URL` is the
// deployment's configured public origin, and `/api/pets/random` already
// resolves its redirect from it for the same reason.
import { afterEach, describe, expect, it, mock } from "bun:test";

import * as realRatelimit from "@/lib/ratelimit";

mock.module("server-only", () => ({}));
mock.module("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user_test" }),
}));
mock.module("@/lib/pets", () => ({
  getAllApprovedPets: async () => [
    {
      slug: "boba",
      displayName: "Boba",
      description: "A tiny otter.",
      kind: "creature",
      vibes: ["cozy"],
      tags: [],
      featured: false,
      source: "discover",
      submittedBy: null,
      spritesheetPath: "pets/boba/sprite.webp",
    },
  ],
}));
mock.module("@/lib/downloads", () => ({
  getAllPetsPackPath: () => "packs/petdex-approved.zip",
}));
mock.module("@/lib/manifest-telemetry", () => ({
  logManifestFetch: () => {},
}));
// Spread the real module: `mock.module` is process-wide and
// first-registration-wins, so replacing `@/lib/ratelimit` wholesale starves
// whichever limiter another suite in the same process already stubbed.
mock.module("@/lib/ratelimit", () => ({
  ...realRatelimit,
  manifestFullRatelimit: {
    limit: async () => ({ success: true, reset: Date.now() + 60_000 }),
  },
}));

const { GET } = await import("./route");

afterEach(() => {
  delete process.env.PETDEX_URL;
});

function call(): Promise<Response> {
  // What a request arriving at the container actually carries: `req.url` is
  // the bind address, not the public host.
  return GET(new Request("http://0.0.0.0:3000/api/manifest/full"));
}

describe("GET /api/manifest/full", () => {
  it("builds install commands from the configured public origin", async () => {
    process.env.PETDEX_URL = "https://petdex.dev";
    const body = await (await call()).json();
    expect(body.pets[0].installCommand).toBe(
      "curl -sSf https://petdex.dev/install/boba | sh",
    );
    expect(body.pets[0].pageUrl).toBe("https://petdex.dev/pets/boba");
  });

  it("honours a self-hosted origin", async () => {
    process.env.PETDEX_URL = "http://127.0.0.1:3100";
    const body = await (await call()).json();
    expect(body.pets[0].installCommand).toBe(
      "curl -sSf http://127.0.0.1:3100/install/boba | sh",
    );
  });

  it("falls back to the canonical origin when PETDEX_URL is unset", async () => {
    // `0.0.0.0` is the container's bind address, not a host any client can
    // reach, and it is not loopback either — so it must not be published.
    const body = await (await call()).json();
    expect(body.pets[0].pageUrl).toBe("https://petdex.dev/pets/boba");
  });

  it("a malformed PETDEX_URL falls back rather than emitting junk", async () => {
    process.env.PETDEX_URL = "not a url";
    const body = await (await call()).json();
    expect(body.pets[0].pageUrl).toBe("https://petdex.dev/pets/boba");
  });

  it("a hostless PETDEX_URL is ignored", async () => {
    // `new URL("file:///x")` yields origin "null" — a string, not a URL.
    process.env.PETDEX_URL = "file:///tmp/x";
    const body = await (await call()).json();
    expect(body.pets[0].pageUrl).toBe("https://petdex.dev/pets/boba");
  });
});
