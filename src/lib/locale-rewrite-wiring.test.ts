import { expect, test } from "bun:test";
import { join } from "node:path";

// The guard above is a pure function, so nothing in its own suite fails if
// `proxy.ts` stops calling it — a mutation that dropped the guard from the
// proxy left all of those cases green. `proxy.ts` imports Clerk and
// next-intl, which a unit test cannot load, so this asserts on its source the
// way `collection-limits-sync.test.ts` does: the call sites have to be there,
// and both of them have to go through the guard.
test("proxy routes i18n through the locale rewrite guard", async () => {
  // Resolved from this file, not the cwd, so the suite reads the same source
  // whether it runs from the repo root or from a subdirectory.
  const source = await Bun.file(join(import.meta.dir, "..", "proxy.ts")).text();
  // Collapsed so the assertion pins the expression rather than the line
  // breaks it happens to be formatted with.
  const flat = source.replace(/\s+/g, " ");

  // The whole ternary, not the pieces: checking only that the two calls appear
  // somewhere leaves the test green when the branches are swapped (the guard
  // would mark the re-entry and stand down on the first pass, which is the loop
  // it exists to break) or when the guard's result is computed and thrown away.
  // Both mutations were tried against the earlier substring form and survived.
  expect(flat).toMatch(
    /isResolvedLocaleRewrite\(\{[^}]*marker: req\.headers\.get\(LOCALE_REWRITE_MARKER\)[^}]*\}\) \? NextResponse\.next\(\) : markLocaleRewrite\(handleI18nRouting\(req\)\)/,
  );

  // Both middlewares reach i18n routing through the same helper; a second
  // `handleI18nRouting(` call would be one that skips the guard.
  const routingCalls = source.match(/handleI18nRouting\(/g) ?? [];
  expect(routingCalls.length).toBe(1);

  const helperCalls =
    source.match(/handleI18nRoutingWithoutLocaleCookie\(/g) ?? [];
  // One definition plus the mock-auth and Clerk call sites.
  expect(helperCalls.length).toBe(3);
});
