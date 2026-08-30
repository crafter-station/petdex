import * as BunTest from "bun:test";
import { beforeEach, describe, expect, it } from "bun:test";

const testMock = (
  BunTest as typeof BunTest & {
    mock: { module: (specifier: string, factory: () => object) => void };
  }
).mock;

const requestedUsers: string[] = [];
let limited = false;

testMock.module("@/lib/cli-auth", () => ({
  verifyCliBearer: async (header: string | null) =>
    header === "Bearer valid"
      ? {
          userId: "user_owner",
          email: "owner@petdex.dev",
          username: "owner",
          imageUrl: "https://img.clerk.com/owner.png",
          firstName: "Pet",
          lastName: "Owner",
        }
      : null,
}));

testMock.module("@/lib/desktop-library", () => ({
  getDesktopLibrary: async (userId: string) => {
    requestedUsers.push(userId);
    return {
      owned: [
        {
          id: "pet_1",
          slug: "boba",
          displayName: "Boba",
          status: "approved",
          thumbnailUrl: "https://assets.petdex.dev/pets/boba/thumb.webp",
        },
      ],
      caught: [
        {
          slug: "droid",
          displayName: "Droid",
          status: "caught",
          thumbnailUrl: "https://assets.petdex.dev/pets/droid/thumb.webp",
        },
      ],
    };
  },
}));

testMock.module("@/lib/ratelimit", () => ({
  cliVerifyRatelimit: {
    limit: async () => ({ success: !limited }),
  },
}));

function request(authorization = "Bearer valid") {
  return new Request("https://petdex.dev/api/desktop/library", {
    headers: { authorization },
  });
}

describe("GET /api/desktop/library", () => {
  beforeEach(() => {
    requestedUsers.length = 0;
    limited = false;
  });

  it("returns the authenticated user's cloud library", async () => {
    const { GET } = await import("./route");
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(requestedUsers).toEqual(["user_owner"]);
    expect(body.user.username).toBe("owner");
    expect(body.owned[0].slug).toBe("boba");
    expect(body.owned[0].thumbnailUrl).toContain("boba/thumb.webp");
    expect(body.caught[0].slug).toBe("droid");
  });

  it("rejects invalid bearer credentials", async () => {
    const { GET } = await import("./route");
    const response = await GET(request("Bearer invalid"));

    expect(response.status).toBe(401);
    expect(requestedUsers).toHaveLength(0);
  });

  it("rate limits before verifying the bearer", async () => {
    limited = true;
    const { GET } = await import("./route");
    const response = await GET(request());

    expect(response.status).toBe(429);
    expect(requestedUsers).toHaveLength(0);
  });
});
