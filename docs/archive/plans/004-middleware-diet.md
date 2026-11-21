# Plan 004: Middleware diet — stop paying Upstash + Clerk + redirects on every public request

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 82ffb6b..HEAD -- src/proxy.ts src/lib/public-traffic-guard.ts src/lib/ratelimit.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: 002 (volume context), 003 (removes an `auth()` caller). Steps 1-2 have no dependencies.
- **Category**: perf
- **Planned at**: commit `82ffb6b`, 2026-06-10

## Why this matters

The middleware chain in `src/proxy.ts` runs on every HTML page and `/api/*` request that reaches Vercel, and for every public page view it makes **two sequential Upstash Redis round-trips** (a burst limiter plus a per-category limiter) before the page can render. That is: latency on the critical path of every anonymous page view, an Upstash bill proportional to total traffic, and Fluid CPU while the middleware awaits Redis. On top of that, a hardcoded IP/UA blocklist and the legacy-host redirect spend a full Vercel invocation to reject/redirect traffic that Cloudflare could handle for free before it ever reaches Vercel. After plans 001/002 push most read traffic to Cloudflare's edge, this plan makes the residual origin traffic cheap too. (Clerk's middleware wrapping is intentionally left mostly alone — see Step 4.)

## Current state

- `src/proxy.ts:85-105` — production middleware is `clerkMiddleware(...)` wrapping: legacy host redirect → admin surface response → route-cost sampling → `guardPublicTraffic` → `auth.protect()` for protected routes → i18n routing.
- `src/proxy.ts:120-155` — `guardPublicTraffic`:

  ```ts
  const burst = await publicTrafficBurstRatelimit.limit(key);   // Upstash call 1
  if (!burst.success) return rateLimitedResponse(burst.reset);
  const limit = rule === "sticker" ? await stickerAssetRatelimit.limit(key)
    : ... : rule === "page" ? await publicPageRatelimit.limit(key)
    : await publicCatalogRatelimit.limit(key);                  // Upstash call 2
  ```

- `src/lib/public-traffic-guard.ts:16-57` — `publicTrafficGuardRule` maps paths to rules; `isPublicPagePath(pathname)` → `"page"` means **every public HTML page view** triggers both Upstash calls. API categories: sticker/pack/metadata/state/catalog.
- `src/lib/public-traffic-guard.ts:5-6` — static blocklist:

  ```ts
  const BLOCKED_IPS = new Set(["133.106.50.116"]);
  const BLOCKED_USER_AGENTS = ["petoverlaycompose-pixelartclassifier"];
  ```

- `src/proxy.ts:44-47` — `LEGACY_REDIRECT_HOSTS = new Set(["petdex.crafter.run", "www.petdex.crafter.run"])` handled in middleware (`legacyHostRedirect`).
- `src/lib/ratelimit.ts` — ~20 sliding-window limiters; the public-traffic ones include `publicTrafficBurstRatelimit` (120/min) and `publicPageRatelimit` (600/h) among others.
- Cloudflare proxies `petdex.dev` (zone exists; plans 001/002 add rules there). `petdex.crafter.run` lives on the `crafter.run` zone — confirm it is on the same Cloudflare account before Step 2.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Lint | `bun run check` | exit 0 |
| Tests | `bun test --env-file=.env.mock` | all pass |
| Build | `TELEMETRY_RATELIMIT_SECRET=mock-telemetry-secret bun --env-file=.env.mock run build` | exit 0 |
| Focused tests | `bun test --env-file=.env.mock src/lib/security.test.ts` | pass |

## Scope

**In scope**:
- `src/proxy.ts`, `src/lib/public-traffic-guard.ts` (+ its tests), `src/lib/ratelimit.ts` (deletions only)
- Cloudflare zone `petdex.dev`: one rate-limiting rule, one WAF custom rule (ops)
- Cloudflare zone `crafter.run`: redirect rule (ops, conditional)

**Out of scope** (do NOT touch):
- Auth-sensitive limiters in `src/lib/ratelimit.ts` (submission, feedback, telemetry, etc. — anything not named in the steps)
- `clerkMiddleware` removal (Step 4 is measurement + narrow change only)
- Route-cost sampling (`scheduleRouteCostSample`) — measured at ~55 invocations/day at the 0.001 rate; not worth touching
- The admin-surface logic in proxy.ts

## Git workflow

- Branch: `advisor/004-middleware-diet`; conventional commits, one commit per step
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1 (ops): Recreate the static blocklist as a Cloudflare WAF rule

On zone `petdex.dev`, WAF custom rule "petdex-known-abusers", action Block:
`(ip.src eq 133.106.50.116) or (http.user_agent contains "petoverlaycompose-pixelartclassifier")`

Keep the code-side check as a fallback (it is cheap once traffic that matters is filtered). Document in the rule description that the source of truth is `src/lib/public-traffic-guard.ts:5-6` and both must be updated together.

**Verify**: `curl -s -o /dev/null -w "%{http_code}" -A "petoverlaycompose-pixelartclassifier" https://petdex.dev/en` → `403` and the response has NO `x-vercel-id` header (`curl -sI -A "..." https://petdex.dev/en | grep -i x-vercel-id` → empty), proving it never reached Vercel.

### Step 2 (ops, conditional): Legacy host redirect at Cloudflare

Check whether `crafter.run` is a zone on the same Cloudflare account. If yes, create a Redirect Rule on that zone: requests where `http.host in {"petdex.crafter.run" "www.petdex.crafter.run"}` → 301 to `concat("https://petdex.dev", http.request.uri.path)` preserving path+query. Keep the middleware fallback code as-is (defense in depth; it stops seeing traffic).

If `crafter.run` is NOT on Cloudflare: skip this step entirely and note it in the index.

**Verify**: `curl -sI https://petdex.crafter.run/en | grep -i "location\|x-vercel-id"` → `location: https://petdex.dev/en`, no `x-vercel-id`.

### Step 3: Drop the per-page-view Upstash calls; replace with a Cloudflare rate limit

Code change in `src/lib/public-traffic-guard.ts`:
- Remove the final `if (isPublicPagePath(pathname)) return "page";` branch from `publicTrafficGuardRule` (line ~52), so plain HTML page views return `null` and `guardPublicTraffic` exits before any Upstash call. The API categories (sticker/pack/metadata/state/catalog) KEEP their Upstash limits — those endpoints are expensive and precision matters there.
- Also restructure `guardPublicTraffic` in `src/proxy.ts` so the **burst limiter only runs when a rule matched** (it already does — the early `if (!rule) return null;` at line 134 precedes the burst call; just confirm this ordering survives your edit).
- Delete `publicPageRatelimit` from `src/lib/ratelimit.ts` and any now-unused exports. Update `src/lib/public-traffic-guard` tests accordingly (find them: `grep -rn "publicTrafficGuardRule" src --include="*.test.ts"`).

Ops change on zone `petdex.dev`: Rate Limiting Rule "petdex-page-flood": expression `(http.host eq "petdex.dev" and not starts_with(http.request.uri.path, "/api/"))`, threshold ~600 requests / 1 minute per IP (generous — this is flood protection, not fairness), action Block for 60s. Cloudflare's free tier includes rate limiting rules; counting happens at the edge, costs nothing per request.

**Verify**: `bun test --env-file=.env.mock` → pass. Mock build → exit 0. After deploy: page browse works normally; `for i in $(seq 1 5); do curl -s -o /dev/null -w "%{http_code} " https://petdex.dev/en; done` → `200 200 200 200 200` (well under threshold). Upstash dashboard daily command count drops sharply within 24h (record before/after numbers in the PR).

### Step 4: Measure-then-decide on Clerk middleware scope (investigation, small change at most)

`clerkMiddleware` wraps all matched traffic (proxy.ts:87). It must keep running wherever `auth()`/`currentUser()` is called in server code or `auth.protect()` matters. Inventory first:
`grep -rln "from \"@clerk/nextjs/server\"" src/app src/lib | sort`
Compare against public GET surfaces. As of this plan's writing, public-page callers include `/u/[handle]` (stays dynamic) and `/requests` (removed by plan 003); most public APIs authenticate via bearer/same-origin checks instead.

If the inventory shows the public catalog APIs (`/api/manifest*`, `/api/pets/search`, `/api/pets/random`, `/api/pets/[slug]/*` GET endpoints, `/api/install-pet/*`) do NOT call Clerk server APIs, narrow Clerk's work for exactly those paths by returning early in the wrapped handler before any `auth.protect()` logic — note that with `clerkMiddleware` the session resolution cost is largely in the wrapper itself, so the honest version of this step may be: **report the inventory and recommend** whether splitting the middleware (e.g. routing asset-ish API paths around Clerk via matcher exclusions) is worth the complexity. A matcher exclusion for the catalog GET endpoints is acceptable if and only if the inventory proves none of them touch Clerk request state.

**Verify**: if a matcher change is made — signed-in browser smoke (sign in, like a pet, open notifications) + `curl -s -o /dev/null -w "%{http_code}" https://petdex.dev/api/pets/search` → 200. If no change — a short findings note in the PR/commit description.

## Test plan

- Update/extend `public-traffic-guard` unit tests: page paths now return `null`; API categories unchanged (cover one path per category: sticker, pack, metadata, state, catalog).
- `bun test --env-file=.env.mock` → all pass.
- Production probes listed per step.

## Done criteria

- [ ] Blocked UA gets `403` with no `x-vercel-id` (edge-blocked)
- [ ] HTML page views trigger zero Upstash commands (verify via Upstash dashboard delta after deploy)
- [ ] API categories still rate-limited (manual: hammer `/api/pets/random` past its limit from one IP → `429`)
- [ ] `bun run check` + `bun test --env-file=.env.mock` + mock build all exit 0
- [ ] Step 4 inventory documented (in PR description or commit message)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- No Cloudflare access with WAF/rate-limiting scopes.
- `crafter.run` zone is not accessible (skip Step 2, note it, continue).
- The Step 4 inventory shows public catalog APIs DO read Clerk state — do not touch the matcher; report.
- Removing `publicPageRatelimit` breaks tests in ways that suggest the page rule is load-bearing elsewhere (grep for other callers first).

## Maintenance notes

- The IP/UA blocklist now lives in two places (WAF + code). When adding an abuser, update both; the WAF rule is the one that saves money.
- If Cloudflare rate limiting produces false positives for NAT'd networks (Chinese campus/corporate IPs!), raise the threshold before weakening anything else — watch the rule's activity log the first week.
- Revisit Step 4 after plan 005 (public shell) lands: with header-state loading only for signed-in users, the anonymous path may become fully Clerk-free, making a clean middleware split easy.
