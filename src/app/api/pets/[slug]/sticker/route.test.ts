import * as BunTest from "bun:test";

import type { StickerArtifactAccess } from "@/lib/sticker-export";

const { beforeEach, describe, expect, it } = BunTest;
const testMock = (
  BunTest as typeof BunTest & {
    mock: { module: (specifier: string, factory: () => object) => void };
  }
).mock;

let accessStatus: StickerArtifactAccess = {
  status: "ok",
  petId: "pet-1",
  slug: "claude-crab",
};
const calls: unknown[][] = [];

testMock.module("@/lib/sticker-export", () => ({
  getStickerArtifactAccess: async (...args: unknown[]) => {
    calls.push(args);
    return accessStatus;
  },
}));

async function request(slug: string, query = ""): Promise<Response> {
  const { GET } = await import("./route");
  return GET(
    new Request(`https://petdex.local/api/pets/${slug}/sticker${query}`),
    { params: Promise.resolve({ slug }) },
  );
}

describe("GET /api/pets/[slug]/sticker", () => {
  beforeEach(() => {
    calls.length = 0;
    accessStatus = {
      status: "ok",
      petId: "pet-1",
      slug: "claude-crab",
    };
  });

  it("rejects invalid input before checking publication access", async () => {
    expect(await request("INVALID")).toHaveProperty("status", 400);
    expect(await request("claude-crab", "?state=unknown")).toHaveProperty(
      "status",
      400,
    );
    expect(
      await request("claude-crab", "?profile=whatsapp&format=png"),
    ).toHaveProperty("status", 400);
    expect(calls).toHaveLength(0);
  });

  it("retires GIF access without checking publication access", async () => {
    const response = await request("claude-crab", "?format=gif");

    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["disabled", 503],
    ["ineligible", 403],
    ["not_found", 404],
    ["missing", 404],
  ] as const)("maps %s access to %i", async (status, expectedStatus) => {
    accessStatus = { status };

    const response = await request("claude-crab");

    expect(response.status).toBe(expectedStatus);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("redirects a compliant WhatsApp artifact", async () => {
    const response = await request(
      "claude-crab",
      "?state=waiting&treatment=outline&profile=whatsapp&format=webp",
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBe(
      "https://assets.petdex.dev/pets/claude-crab/stickers/whatsapp/waiting-outline.webp",
    );
    expect(calls).toEqual([
      ["claude-crab", "waiting", "webp", "outline", "whatsapp"],
    ]);
  });
});
