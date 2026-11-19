// `verifyCliBearer` is awaited bare by every `/api/cli/*` and `/api/desktop/*`
// route, and every one of them maps a `null` principal to a 401. The userinfo
// fetch it makes carries a 5s deadline, and a timeout (or any connection
// failure) used to reject out of the function instead of returning null — so a
// merely slow Clerk answered 500 where the caller could have retried with a
// 401. The whole file returns null on every other failure; this pins that the
// fetch failure does too.
import { afterAll, describe, expect, it, mock } from "bun:test";

const realFetch = globalThis.fetch;
let mode: "throw" | "ok" | "non2xx" = "throw";

globalThis.fetch = (async () => {
  if (mode === "throw") {
    // What AbortSignal.timeout produces on expiry.
    throw new DOMException("The operation timed out.", "TimeoutError");
  }
  if (mode === "non2xx") return new Response("nope", { status: 401 });
  return Response.json({ sub: "user_abc" });
}) as typeof fetch;

const { verifyCliBearer } = await import("@/lib/cli-auth");

afterAll(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

describe("verifyCliBearer degrades a failed userinfo call to null", () => {
  it("returns null (not a rejection) when the fetch times out", async () => {
    mode = "throw";
    await expect(verifyCliBearer("Bearer tok")).resolves.toBeNull();
  });

  it("returns null for a non-2xx response", async () => {
    mode = "non2xx";
    await expect(verifyCliBearer("Bearer tok")).resolves.toBeNull();
  });

  it("still returns the principal on success", async () => {
    mode = "ok";
    const principal = await verifyCliBearer("Bearer tok");
    expect(principal?.userId).toBe("user_abc");
  });

  it("returns null for a missing or malformed header without fetching", async () => {
    mode = "throw";
    await expect(verifyCliBearer(null)).resolves.toBeNull();
    await expect(verifyCliBearer("token-without-scheme")).resolves.toBeNull();
  });
});
