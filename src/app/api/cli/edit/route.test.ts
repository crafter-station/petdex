import * as BunTest from "bun:test";
import { beforeEach, describe, expect, it } from "bun:test";

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
  cliVerifyRatelimit: { limit: async () => ({ success: true }) },
}));

testMock.module("@/lib/pet-edit", () => ({
  applyPetEdit: async (input: {
    id: string;
    userId: string;
    body: Record<string, unknown>;
  }) => {
    applied.push(input);
    return { status: 202, body: { status: "queued" } };
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

    expect(response.status).toBe(202);
    expect(applied[0]?.id).toBe("pet_owned");
    expect(applied[0]?.userId).toBe("user_owner");
    expect(applied[0]?.body.description).toBe("Updated from the CLI.");
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
