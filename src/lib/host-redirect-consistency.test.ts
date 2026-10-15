import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Two files can redirect a request that arrives on a non-canonical host, and
// they run in different places: `next.config.ts`'s `redirects()` is answered
// before the app boots, and `REDIRECT_HOSTS` in `src/proxy.ts` catches what
// reaches middleware anyway. The `www` alias of the canonical host was in
// neither: `www.petdex.dev` answered 200 with the whole site, while every
// canonical link, hreflang alternate, `og:url`, and sitemap entry is absolute
// on `petdex.dev` — so the page advertised an origin other than the one that
// served it. The `crafter.run` pair had been listed in both files since the
// domain move; the alias was the one host added later and never carried over.
//
// Keeping the two lists in step is the whole point of this test. A host added
// to one and not the other is exactly how `www.petdex.dev` slipped through.

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CONFIG = join(REPO_ROOT, "next.config.ts");
const PROXY = join(REPO_ROOT, "src", "proxy.ts");

const CANONICAL_HOST = "petdex.dev";

/**
 * Undo the escaping the config carries.
 *
 * Next compiles a `has` value as `^…$`, so each entry spells its dots as
 * `\.` and ends with `\.?` to admit the trailing root dot. The proxy compares
 * plain strings, so the two lists only match once the regex form is reduced
 * back to the hostname.
 */
function unescapeHost(value: string): string {
  return value.replace(/\\\.\?$/, "").replace(/\\/g, "");
}

/** Hostnames named in `next.config.ts`'s `has: [{ type: "host" … }]` matchers. */
function configRedirectHosts(): string[] {
  const source = readFileSync(CONFIG, "utf8");
  return [
    ...source.matchAll(/type:\s*"host",\s*value:\s*"((?:[^"\\]|\\.)+)"/g),
  ].map((match) => unescapeHost(match[1]));
}

/** Hostnames in `src/proxy.ts`'s `REDIRECT_HOSTS` set literal. */
function proxyRedirectHosts(): string[] {
  const source = readFileSync(PROXY, "utf8");
  const block = source.match(
    /const REDIRECT_HOSTS = new Set\(\[([\s\S]*?)\]\)/,
  );
  if (!block) return [];
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

describe("non-canonical hosts redirect from every layer that can see them", () => {
  const fromConfig = configRedirectHosts();
  const fromProxy = proxyRedirectHosts();

  test("both host lists were found", () => {
    expect(fromConfig.length).toBeGreaterThan(1);
    expect(fromProxy.length).toBeGreaterThan(1);
  });

  test("the two lists name the same hosts", () => {
    // Order is not meaningful; membership is. A host in one file and not the
    // other is a request that is redirected or not depending on whether it
    // reached the app, which is not a distinction a visitor can predict.
    expect([...fromConfig].sort()).toEqual([...fromProxy].sort());
  });

  test("the www alias of the canonical host is redirected", () => {
    // The specific regression: an alias that answers 200 while every absolute
    // URL it emits points at the apex.
    expect(fromConfig).toContain(`www.${CANONICAL_HOST}`);
    expect(fromProxy).toContain(`www.${CANONICAL_HOST}`);
  });

  test("no host in either list is the canonical host itself", () => {
    // A canonical host in the redirect set would redirect every request to
    // itself — an infinite loop that only shows up in production.
    for (const host of [...fromConfig, ...fromProxy]) {
      expect(host).not.toBe(CANONICAL_HOST);
    }
  });

  test("the config admits the trailing-dot spelling of every host", () => {
    // `www.petdex.dev.` is the same host to DNS — the dot is the root label —
    // but it is a different string, and an exact `has` match let it serve the
    // whole site while every absolute URL on the page named the apex. Each
    // entry has to tolerate the dot, not just the one that was measured.
    const source = readFileSync(CONFIG, "utf8");
    const values = [
      ...source.matchAll(/type:\s*"host",\s*value:\s*"((?:[^"\\]|\\.)+)"/g),
    ].map((match) => match[1]);
    expect(values.length).toBeGreaterThan(1);
    for (const value of values) {
      expect(value, `host matcher ${value} must admit a trailing dot`).toMatch(
        /\\\.\?$/,
      );
    }
  });

  test("the proxy strips the trailing dot before comparing", () => {
    // The proxy side normalizes instead of pattern-matching, so its guard is
    // that the strip is present — without it, `www.petdex.dev.` misses the
    // dotless set and reaches the app.
    const source = readFileSync(PROXY, "utf8");
    const body = source.match(/function normalizeHost[\s\S]*?\n}/)?.[0] ?? "";
    expect(body).toMatch(/replace\(\/\\\.\$\/,\s*""\)/);
  });

  test("the redirect target pins the host instead of resolving the path", () => {
    // `new URL(pathname, CANONICAL_URL)` resolves a protocol-relative path:
    // `new URL("//evil.example/x", "https://petdex.dev")` is
    // `https://evil.example/x`, so a pathname that kept a leading `//` would
    // turn the canonical-host redirect into an open redirect. Next normalizes
    // it today, but that is the framework's behaviour to keep, not this
    // function's — assigning `pathname` onto a URL built from the canonical
    // origin pins the host and cannot escape it.
    const source = readFileSync(PROXY, "utf8");
    const body =
      source.match(/function canonicalHostRedirect[\s\S]*?\n}/)?.[0] ?? "";
    expect(body, "the redirect function was not found").toContain(
      "canonicalHostRedirect",
    );
    expect(body).not.toMatch(/new URL\(\s*req\.nextUrl\.pathname\s*,/);
    expect(body).toMatch(/url\.pathname\s*=\s*req\.nextUrl\.pathname/);
  });
});
