import { describe, expect, it } from "bun:test";

// Reproduces the production failure at the factory boundary: a limiter whose
// underlying call throws must still answer with an allow verdict, so no route
// turns a limiter outage into a 500.
describe("fail-open limiter factory", () => {
  it("allows the request when .limit() throws the Upstash blocked-database TypeError", async () => {
    const { failOpenForTest } = await import("@/lib/ratelimit");
    const limiter = failOpenForTest({
      limit: async () => {
        throw new TypeError("r.map is not a function");
      },
    });
    const result = await limiter.limit("1.2.3.4");
    expect(result.success).toBe(true);
  });

  it("preserves a real deny verdict", async () => {
    const { failOpenForTest } = await import("@/lib/ratelimit");
    const limiter = failOpenForTest({
      limit: async () => ({ success: false, reset: 42 }),
    });
    const result = await limiter.limit("1.2.3.4");
    expect(result.success).toBe(false);
    expect(result.reset).toBe(42);
  });
});
