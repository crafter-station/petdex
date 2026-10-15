import * as BunTest from "bun:test";
import { beforeEach, describe, expect, it } from "bun:test";

import * as realRatelimit from "@/lib/ratelimit";

const testMock = (
  BunTest as typeof BunTest & {
    mock: { module: (specifier: string, factory: () => object) => void };
  }
).mock;

const applied: Array<{
  id: string;
  userId: string;
  body: Record<string, unknown>;
}> = [];

testMock.module("@/lib/cli-auth", () => ({
  verifyCliBearer: async (header: string | null) =>
    header === "Bearer valid"
      ? {
          userId: "user_owner",
          email: null,
          username: null,
          imageUrl: null,
          firstName: null,
          lastName: null,
        }
      : null,
}));

testMock.module("@/lib/ratelimit", () => ({
  // Spread the real module. Bun links every file that imports a mocked
  // specifier against the mock's exports, so a partial mock is a
  // SyntaxError in any suite that imports an export it omits.
  ...realRatelimit,
  cliVerifyRatelimit: { limit: async () => ({ success: true }) },
}));

// This suite pins the ROUTE's contract: it verifies the bearer, takes the
// identity from that principal (never the body), strips `petId` out of the
// edit body, and forwards the rest. The ownership enforcement itself lives in
// applyPetEdit and is covered at that layer (pet-edit-asset-size.test.ts).
// The stub returns the real shape applyPetEdit produces — a 200 with a
// `queued` body — not an invented 202, so the status assertion means
// something.
testMock.module("@/lib/pet-edit", () => ({
  applyPetEdit: async (input: {
    id: string;
    userId: string;
    body: Record<string, unknown>;
  }) => {
    applied.push(input);
    return Response.json({ status: "queued" });
  },
}));

async function patch(body: Record<string, unknown>, authorization: string) {
  const { PATCH } = await import("./route");
  return PATCH(
    new Request("https://petdex.local/api/cli/edit", {
      method: "PATCH",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("PATCH /api/cli/edit", () => {
  beforeEach(() => {
    applied.length = 0;
  });

  it("authenticates the owner from the CLI bearer token", async () => {
    const response = await patch(
      {
        petId: "pet_owned",
        description: "Updated from the CLI.",
        userId: "user_attacker",
      },
      "Bearer valid",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "queued" });
    expect(applied[0]?.id).toBe("pet_owned");
    // The body tried to claim `user_attacker`; the identity comes from the
    // verified token.
    expect(applied[0]?.userId).toBe("user_owner");
    expect(applied[0]?.body.description).toBe("Updated from the CLI.");
    // `petId` is the route's own field, not part of the edit body.
    expect(applied[0]?.body).not.toHaveProperty("petId");
  });

  it("rejects missing or invalid bearer credentials before editing", async () => {
    const response = await patch(
      { petId: "pet_owned", description: "Updated from the CLI." },
      "Bearer invalid",
    );

    expect(response.status).toBe(401);
    expect(applied).toHaveLength(0);
  });

  it("requires a target pet id after bearer authentication", async () => {
    const response = await patch(
      { description: "Updated from the CLI." },
      "Bearer valid",
    );

    expect(response.status).toBe(400);
    expect(applied).toHaveLength(0);
  });
});
