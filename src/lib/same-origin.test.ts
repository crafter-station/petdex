import { afterEach, describe, expect, test } from "bun:test";

import { isSameOrigin } from "./same-origin";

// The Origin check is the CSRF boundary for every state-changing endpoint
// (`requireSameOrigin` guards likes, submissions, collections, gallery order,
// and more). A cross-site POST carries the visitor's Clerk cookie, so the
// check has to refuse any origin the app does not actually serve from.
//
// It used to accept `host.endsWith(".vercel.app")`. `vercel.app` is a public
// suffix — anyone can deploy there — so `https://evil.vercel.app` passed and
// could write to the DB as the victim. The deployment's real host is in
// `VERCEL_URL` (and its siblings), so an exact match is enough.

const VERCEL_VARS = [
  "VERCEL_URL",
  "VERCEL_BRANCH_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
] as const;

afterEach(() => {
  for (const name of VERCEL_VARS) delete process.env[name];
  delete process.env.PETDEX_URL;
});

function post(origin: string): Request {
  return new Request("https://petdex.dev/api/pets/boba/like", {
    method: "POST",
    headers: { origin },
  });
}

describe("isSameOrigin", () => {
  test("accepts the canonical site", () => {
    expect(isSameOrigin(post("https://petdex.dev"))).toBe(true);
  });

  test("accepts the deployment's own vercel host", () => {
    process.env.VERCEL_URL = "petdex-git-main-acme.vercel.app";
    expect(isSameOrigin(post("https://petdex-git-main-acme.vercel.app"))).toBe(
      true,
    );
  });

  test("accepts a branch and production vercel host", () => {
    process.env.VERCEL_BRANCH_URL = "petdex-git-feature.vercel.app";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "petdex.vercel.app";
    expect(isSameOrigin(post("https://petdex-git-feature.vercel.app"))).toBe(
      true,
    );
    expect(isSameOrigin(post("https://petdex.vercel.app"))).toBe(true);
  });

  test("mangled origins follow URL normalization, not string matching", () => {
    // The suffix-match regression came from trusting string shapes; pin the
    // mangled forms so a future refactor back toward string comparison turns
    // these red. URL parsing lowercases the host, strips a default port, and
    // resolves userinfo into the host — all of these lean on that behavior.
    expect(isSameOrigin(post("https://PETDEX.DEV"))).toBe(true);
    expect(isSameOrigin(post("https://petdex.dev:443"))).toBe(true);
    expect(isSameOrigin(post("https://petdex.dev:8443"))).toBe(false);
    expect(isSameOrigin(post("https://petdex.dev@evil.com"))).toBe(false);
    expect(isSameOrigin(post("https://xn--ptdex-9ua.dev"))).toBe(false);
  });

  test("rejects an attacker's vercel.app deployment", () => {
    // The regression: a bare suffix match trusted any *.vercel.app origin.
    process.env.VERCEL_URL = "petdex-git-main-acme.vercel.app";
    expect(isSameOrigin(post("https://evil.vercel.app"))).toBe(false);
    expect(isSameOrigin(post("https://petdex.vercel.app.attacker.com"))).toBe(
      false,
    );
  });

  test("the vercel branch compares the scheme too", () => {
    // `VERCEL_URL` names an https host, so the plaintext twin of the
    // deployment's own origin is not an origin this app serves — the same
    // reason `http://petdex.dev` is refused above. The host-only comparison
    // this used to do admitted it.
    process.env.VERCEL_URL = "petdex-git-main-acme.vercel.app";
    expect(isSameOrigin(post("http://petdex-git-main-acme.vercel.app"))).toBe(
      false,
    );
    expect(isSameOrigin(post("https://petdex-git-main-acme.vercel.app"))).toBe(
      true,
    );
  });

  test("a scheme-less VERCEL_URL still admits its https origin", () => {
    // The env var is a bare host on Vercel today; the bare value must keep
    // working, not silently drop out of the allowlist.
    process.env.VERCEL_URL = "petdex-git-main-acme.vercel.app";
    expect(isSameOrigin(post("https://petdex-git-main-acme.vercel.app"))).toBe(
      true,
    );
  });

  test("rejects an unrelated origin", () => {
    expect(isSameOrigin(post("https://attacker.example.com"))).toBe(false);
  });

  test("rejects the plain-http origin of the site's own host", () => {
    // The site is https-only (Cloudflare 308s http and HSTS pins it), so no
    // legitimate page runs at `http://petdex.dev` and no request carries that
    // Origin. The host-only check used to admit it.
    expect(isSameOrigin(post("http://petdex.dev"))).toBe(false);
    expect(isSameOrigin(post("https://petdex.dev"))).toBe(true);
  });

  test("rejects a malformed Origin", () => {
    expect(isSameOrigin(post("not a url"))).toBe(false);
  });

  test("accepts localhost for local development", () => {
    expect(isSameOrigin(post("http://localhost:3000"))).toBe(true);
    expect(isSameOrigin(post("http://localhost"))).toBe(true);
  });

  test("accepts the origin this deployment is configured to serve", () => {
    // Self-hosted deployments do not answer on petdex.dev or a *.vercel.app
    // host, so without this the app rejects its own browser origin: a
    // same-origin `fetch()` POST carries `Origin: <the deploy origin>` and
    // `requireSameOrigin` 403s it. `PETDEX_URL` is already the configured
    // public origin the proxy and `/api/pets/random` read.
    process.env.PETDEX_URL = "http://127.0.0.1:3100";
    expect(isSameOrigin(post("http://127.0.0.1:3100"))).toBe(true);
  });

  test("a malformed PETDEX_URL does not widen the allowlist", () => {
    process.env.PETDEX_URL = "not a url";
    expect(isSameOrigin(post("https://attacker.example.com"))).toBe(false);
    // The hardcoded hosts still work.
    expect(isSameOrigin(post("https://petdex.dev"))).toBe(true);
  });

  test("PETDEX_URL does not admit a different origin", () => {
    process.env.PETDEX_URL = "https://petdex.dev";
    expect(isSameOrigin(post("https://evil.vercel.app"))).toBe(false);
    expect(isSameOrigin(post("http://127.0.0.1:3100"))).toBe(false);
  });

  test("the loopback names are interchangeable at the configured port", () => {
    // The compose stack sets `PETDEX_URL: http://127.0.0.1:3100` and prints
    // that URL, but a browser reaching it as `localhost` or `[::1]` — which is
    // what it autocompletes to — sent that name, and every write 403'd. The
    // host-only comparison missed them, and `public-origin.ts` already treats
    // the three as one server.
    process.env.PETDEX_URL = "http://127.0.0.1:3100";
    expect(isSameOrigin(post("http://localhost:3100"))).toBe(true);
    expect(isSameOrigin(post("http://[::1]:3100"))).toBe(true);
  });

  test("the loopback alias does not admit another port", () => {
    // The aliases exist for one server, not for whatever else is listening on
    // the machine. Admitting every port would make this an allowlist for the
    // whole loopback interface. (`localhost` with no port is already allowed
    // outright by SITE_ORIGINS for local dev, so the probe uses a port.)
    process.env.PETDEX_URL = "http://127.0.0.1:3100";
    expect(isSameOrigin(post("http://localhost:4000"))).toBe(false);
    expect(isSameOrigin(post("http://127.0.0.1:4000"))).toBe(false);
  });

  test("the scheme has to match the configured one", () => {
    // Host-only comparison admitted `https://petdex.dev` on an http-only
    // deployment: an origin the deployment does not serve. Comparing the
    // parsed origin closes that, and it is why this compares `origin` rather
    // than `host`.
    process.env.PETDEX_URL = "http://127.0.0.1:3100";
    expect(isSameOrigin(post("https://127.0.0.1:3100"))).toBe(false);
    expect(isSameOrigin(post("https://petdex.dev"))).toBe(true); // SITE_ORIGINS
  });

  test("a non-loopback PETDEX_URL gets no aliases", () => {
    // Aliases are only for the loopback names; a real host does not get them.
    // Probed with a port so SITE_ORIGINS' bare `localhost` entry does not answer
    // for the alias path being tested.
    process.env.PETDEX_URL = "https://petdex.example.com";
    expect(isSameOrigin(post("http://localhost:3100"))).toBe(false);
    expect(isSameOrigin(post("https://petdex.example.com"))).toBe(true);
  });

  test("falls back to Sec-Fetch-Site when Origin is absent", () => {
    const sameSite = new Request("https://petdex.dev/api/pets/boba/like", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(isSameOrigin(sameSite)).toBe(true);

    const crossSite = new Request("https://petdex.dev/api/pets/boba/like", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(isSameOrigin(crossSite)).toBe(false);
  });

  test("Sec-Fetch-Site same-site is not this origin", () => {
    // `same-site` includes sibling subdomains, which this app does not serve
    // and which are not part of its origin. Browsers that send Sec-Fetch-Site
    // also send Origin on state-changing requests, so nothing legitimate
    // reaches this fallback with `same-site`.
    const sibling = new Request("https://petdex.dev/api/pets/boba/like", {
      method: "POST",
      headers: { "sec-fetch-site": "same-site" },
    });
    expect(isSameOrigin(sibling)).toBe(false);
  });
});
