# Plan 002: Make anonymous public HTML cacheable by Cloudflare (kill the per-view Vercel hit)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 82ffb6b..HEAD -- src/proxy.ts next.config.ts src/components/locale-switcher.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (locale detection trade-off + signed-in bypass must be correct)
- **Depends on**: none (001 recommended first but independent)
- **Category**: perf
- **Planned at**: commit `82ffb6b`, 2026-06-10

## Why this matters

Public HTML on `petdex.dev` is never cached by Cloudflare. Verified live 2026-06-10: `curl -sI https://petdex.dev/en` returns `cf-cache-status: BYPASS` with `set-cookie: NEXT_LOCALE=en; Path=/; SameSite=lax`. **Cloudflare never caches a response carrying Set-Cookie** — the next-intl middleware emits the `NEXT_LOCALE` cookie on every response, so even a "Cache Everything" rule would not help. Additionally, pages emit `cache-control: public, max-age=0, must-revalidate` and no `Cloudflare-CDN-Cache-Control`, so Cloudflare has no TTL to work with anyway. Result: all ~1.9M edge requests/day and ~16.6 GB/day of Fast Origin Transfer land on Vercel (June 4 billing: those two lines alone were ~$7.6/day of a $13.5/day bill). The pages in question are `force-static`/ISR — identical HTML for every visitor, with auth state hydrated client-side — so they are safe to cache for anonymous traffic. After this plan, warm anonymous page views are served entirely from Cloudflare's edge and cost $0 on Vercel.

## Current state

- `src/proxy.ts:62-66` — next-intl middleware, no cookie config (defaults emit `NEXT_LOCALE` Set-Cookie):

  ```ts
  const handleI18nRouting = createMiddleware({
    locales,
    defaultLocale,
    localePrefix: "as-needed",
  });
  ```

  `localePrefix: "as-needed"` means: `en` (default) serves at `/`, `es` at `/es/...`, `zh` at `/zh/...`.

- `next.config.ts:157-167` — `headers()` only sets `/version.json` cache headers and a global `securityHeaders` block. No cache headers for HTML routes:

  ```ts
  async headers() {
    return [
      { source: "/version.json", headers: versionJsonHeaders },
      { source: "/:path*", headers: securityHeaders },
    ];
  },
  ```

- Public pages are already static/ISR at the framework level: `src/app/[locale]/page.tsx:48-49` (`force-static`, `revalidate = 86400`), `pets/[slug]/page.tsx:49-54`, `collections/[slug]/page.tsx:22-23`, `collections/page.tsx:22`, `kind/[kind]/page.tsx:20`, `vibe/[vibe]/page.tsx:20`, `about`, `brand`, `built-with`, `community`, `docs`. Vercel serves them with `x-vercel-cache: HIT/PRERENDER` — Vercel's CDN caches them, but bills every request; Cloudflare in front sees `max-age=0` + Set-Cookie and forwards everything.

- Clerk session cookies are `__session` and `__client_uat` (plus `__clerk_*` variants). Signed-in users carry them; anonymous users don't. The HTML shell is the same either way (Clerk hydrates client-side), but bypassing cache for cookie-carrying requests is the conservative correctness choice (some pages may render differently in future).

- `src/components/locale-switcher.tsx` — client component that switches locale (currently relies on next-intl navigation which works path-based; the middleware cookie made the choice sticky for bare-`/` visits).

- next-intl v4 (`next-intl@^4.11.0` in package.json). Its `createMiddleware` accepts `localeCookie: false` (disables the Set-Cookie entirely) and `localeDetection: false` (disables Accept-Language redirect). Docs: `node_modules/next-intl/dist/...` or https://next-intl.dev/docs/routing/middleware#locale-cookie.

## The locale trade-off (decided — read before executing)

With the cookie gone and detection off, a first-time visitor to bare `/` always gets English; `es`/`zh` users reach their locale via prefixed URLs (all internal links, hreflang alternates via `buildLocaleAlternates`, and shared links are locale-prefixed). Locale stickiness for bare-`/` revisits is lost for non-en users **unless** they use the locale switcher, which we make set the cookie client-side (the middleware still *reads* `NEXT_LOCALE` for routing on `/` — next-intl reads the cookie even when it doesn't write it... ONLY if `localeDetection` is not fully disabled; see Step 1 note). Requests that carry a `NEXT_LOCALE` cookie will be bypassed from cache by the Cloudflare rule (Step 4), so cookie-carrying users still get correct dynamic locale routing. Anonymous cookie-less traffic — the overwhelming majority and 100% of the viral/China load, which arrives on `/zh/...` links — is cacheable.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Lint | `bun run check` | exit 0 |
| i18n | `bun run i18n:check` | exit 0 |
| Tests | `bun test --env-file=.env.mock` | all pass |
| Build | `TELEMETRY_RATELIMIT_SECRET=mock-telemetry-secret bun --env-file=.env.mock run build` | exit 0 |
| Local serve | `TELEMETRY_RATELIMIT_SECRET=mock-telemetry-secret bun --env-file=.env.mock run start` | serves on :3000 |

## Scope

**In scope**:
- `src/proxy.ts` (middleware i18n config only)
- `next.config.ts` (`headers()` block only)
- `src/components/locale-switcher.tsx` (client-side cookie write)
- Cloudflare zone `petdex.dev` (one Cache Rule) — ops step
- New test file for the locale switcher cookie behavior if a pattern exists

**Out of scope** (do NOT touch):
- Route segment configs of any page (`force-static` / `revalidate` values stay as-is)
- `src/i18n/*` message files and `pickClientMessages`
- Clerk configuration, `securityHeaders`, CSP
- The admin app, `/api/*` cache headers (separate concerns)

## Git workflow

- Branch: `advisor/002-html-edge-cache`
- Conventional commits (e.g. `perf: stop emitting NEXT_LOCALE cookie on every response`)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Stop the unconditional NEXT_LOCALE Set-Cookie

In `src/proxy.ts:62-66`, change to:

```ts
const handleI18nRouting = createMiddleware({
  locales,
  defaultLocale,
  localePrefix: "as-needed",
  localeDetection: false,
  localeCookie: false,
});
```

Note: with `localeCookie: false`, next-intl will not WRITE the cookie. Check the installed next-intl version's behavior for cookie READS when `localeDetection: false` (read `node_modules/next-intl` middleware source): if disabling detection also disables cookie reads, bare `/` always routes to `en` — that is acceptable per the trade-off section, but then Step 3's switcher cookie is purely advisory and you should skip writing it (and note that in the PR description).

**Verify**: `TELEMETRY_RATELIMIT_SECRET=mock-telemetry-secret bun --env-file=.env.mock run build && TELEMETRY_RATELIMIT_SECRET=mock-telemetry-secret bun --env-file=.env.mock run start &` then:
`curl -sI http://localhost:3000/en | grep -i set-cookie` → **no `NEXT_LOCALE` cookie** (no output, or only unrelated cookies). `curl -sI http://localhost:3000/zh | grep -i "set-cookie\|200"` → 200, no NEXT_LOCALE. Kill the server.

### Step 2: Emit Cloudflare-CDN-Cache-Control for public HTML routes

In `next.config.ts` `headers()`, add entries BEFORE the catch-all security block. Use `Cloudflare-CDN-Cache-Control` (consumed by Cloudflare only; Vercel ignores it and keeps its own ISR behavior — do NOT use plain `CDN-Cache-Control`, which Vercel's CDN consumes itself):

```ts
const publicHtmlCacheHeaders = [
  {
    key: "Cloudflare-CDN-Cache-Control",
    value: "public, max-age=300, stale-while-revalidate=86400, stale-if-error=86400",
  },
];
```

Apply to these sources (one entry each, or a combined regex if Next's `source` syntax allows):
- `/` and `/:locale(en|es|zh)`
- `/:locale(en|es|zh)?/pets/:slug`
- `/:locale(en|es|zh)?/collections`
- `/:locale(en|es|zh)?/collections/:slug`
- `/:locale(en|es|zh)?/kind/:kind`
- `/:locale(en|es|zh)?/vibe/:vibe`
- `/:locale(en|es|zh)?/(about|docs|brand|built-with|community|download|advertise)`

Do NOT add it to `/u/:handle`, `/submit`, `/my-feedback`, `/requests`, `/leaderboard`, or any `/api/*` path (dynamic or auth-aware today; 005 handles requests/leaderboard and can extend this list when they go static).

Note on the 300s TTL: pet approvals/edits must show up reasonably fast on home/detail pages. 5 minutes of staleness at Cloudflare on top of ISR was judged acceptable; raise later if measured safe.

**Verify**: rebuild + `curl -sI http://localhost:3000/en | grep -i cloudflare-cdn-cache-control` → header present. `curl -sI http://localhost:3000/en/pets/nukey 2>/dev/null | grep -i cloudflare-cdn-cache-control` → present (any slug that exists in mock data; check mock seed or use `/en/collections`). `curl -sI http://localhost:3000/api/manifest | grep -i cloudflare-cdn-cache-control` → **absent**.

### Step 3: Locale switcher sets the cookie client-side (conditional — see Step 1 note)

If cookie reads still work with detection off: in `src/components/locale-switcher.tsx`, when the user picks a locale, set `document.cookie = "NEXT_LOCALE=" + locale + "; path=/; max-age=31536000; samesite=lax"` before/alongside the navigation it already does. Users who explicitly picked a locale then carry the cookie → the Cloudflare rule (Step 4) bypasses cache for them → middleware routes them correctly on bare `/`.

If Step 1 determined cookie reads are dead, skip this step and remove any stale `NEXT_LOCALE` references.

**Verify**: `bun test --env-file=.env.mock` → all pass. `bun run check` → exit 0.

### Step 4 (ops, after deploy): Cloudflare Cache Rule for petdex.dev HTML

After the code above is deployed to production, create on zone `petdex.dev`:

Cache Rule "petdex-html-anon":
- **Expression**: `(http.host eq "petdex.dev" and not starts_with(http.request.uri.path, "/api/") and not http.cookie contains "__session" and not http.cookie contains "__client_uat" and not http.cookie contains "NEXT_LOCALE")`
- **Action**: Eligible for cache; Edge TTL: **use cache-control header** (the `Cloudflare-CDN-Cache-Control` from Step 2 supplies it; pages without it — `/u/*`, `/submit`, etc. — still say `max-age=0` so they stay uncached even though "eligible")
- Leave Browser TTL: respect origin.

**Verify** (production):
- `curl -sI https://petdex.dev/en | grep -i "cf-cache-status\|set-cookie"` twice → no Set-Cookie; second hit `cf-cache-status: HIT`
- `curl -sI -H "Cookie: __session=fake" https://petdex.dev/en | grep -i cf-cache-status` → `BYPASS` (or `DYNAMIC`)
- `curl -sI https://petdex.dev/en/u/paohai | grep -i cf-cache-status` → NOT `HIT` (dynamic page unaffected)
- `curl -s https://petdex.dev/zh | grep -o "<html[^>]*lang=\"[a-z]*\"" ` → `lang="zh"` (locale routing intact)

### Step 5: Signed-in smoke

In a real browser, sign in on production, navigate home/pets/collections — confirm header shows the signed-in state and no stale anonymous HTML artifacts (the cookie bypass guarantees you got origin HTML; the page itself hydrates auth client-side regardless).

## Test plan

- If Step 3 lands: a test next to `locale-switcher` asserting the cookie write on switch (pattern: see existing component tests like `src/components/command-line.test.ts` for structure).
- Everything else is verified by the curl gates above + the full suite: `bun test --env-file=.env.mock` → all pass.

## Done criteria

- [ ] Production `curl -sI https://petdex.dev/en` shows no `set-cookie: NEXT_LOCALE` and second hit shows `cf-cache-status: HIT`
- [ ] Request with `__session` cookie is not served from cache
- [ ] `/zh` serves `lang="zh"` HTML; `/es` serves Spanish
- [ ] `bun run check`, `bun run i18n:check`, `bun test --env-file=.env.mock`, and the mock build all exit 0
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The installed next-intl version does not accept `localeCookie: false` (API drift) — report the version and available options.
- After Step 1, some other middleware/layer still emits Set-Cookie on anonymous GETs (capture which cookie; Clerk emitting `__client_uat` refreshes on anonymous traffic would need its own analysis — do not attempt to suppress Clerk cookies yourself).
- Next.js `headers()` `source` patterns cannot express the route list (e.g. optional locale groups unsupported) — report; fallback design is setting the header inside the middleware response instead, but that is a design change requiring review.
- Production verification shows `HIT` being served to a signed-in request (cache rule expression wrong — disable the rule immediately, then report).

## Maintenance notes

- **Purge coupling**: with a 300s edge TTL, approvals/takedowns propagate in ≤5min + ISR window. If product later needs instant takedown, wire a Cloudflare purge-by-URL into the moderation path (deferred; depends on plan 001's note too).
- Any NEW public page must be added to the `headers()` source list to get edge caching — reviewers should check this on new-page PRs.
- If plan 004 (public shell) later changes what's in the HTML per auth state, the cookie-bypass rule is what keeps this safe — never weaken it without re-reviewing.
- Watch for: Cloudflare Analytics cache hit ratio on petdex.dev HTML content type; Vercel Edge Requests + FOT lines should drop within 48h. Capture before/after for the cost log.
