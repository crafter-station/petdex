# Plan 001: Serve assets.petdex.dev from Cloudflare edge cache (zero origin reads on warm traffic)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 82ffb6b..HEAD -- workers/petdex-assets.ts wrangler.petdex-assets.toml`
> If either file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S (this is mostly Cloudflare dashboard/API operations, almost no code)
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf (infrastructure)
- **Planned at**: commit `82ffb6b`, 2026-06-10

## Why this matters

Every request to `https://assets.petdex.dev` (sprites, manifests, thumbnails, stickers — the bytes every web visitor, CLI install, and desktop app fetches) currently returns `cf-cache-status: DYNAMIC`. Verified live on 2026-06-10: two consecutive `curl -I` hits to `/manifests/petdex-v1.json` and to a sprite `.webp` both returned `DYNAMIC`, never `HIT`, despite the responses carrying `cache-control: public, max-age=31536000, immutable` (sprites) and `s-maxage=300` (manifest). That means Cloudflare edge-caches **nothing** on the asset host, and every asset request in the world pays an origin read (Worker invocation + R2 Class B operation). This is exactly the failure shape that caused the June 5 outage (Error 1027: assets Worker hit the free-plan daily request cap under viral China traffic and Cloudflare cut it off, taking the whole product down). Immutable pet sprites are the most cacheable bytes in the entire system; with edge caching they cost $0 to serve at any scale, and the request-cap outage becomes structurally impossible.

## Current state

- `wrangler.petdex-assets.toml` — Worker config in the repo:

  ```toml
  name = "petdex-assets"
  main = "workers/petdex-assets.ts"
  compatibility_date = "2026-06-04"
  account_id = "62819ee0a8411123c2635cbf37b577c1"
  workers_dev = true

  [[r2_buckets]]
  binding = "PETDEX_PETS"
  bucket_name = "petdex-pets"
  ```

- `workers/petdex-assets.ts` (96 lines) — a referer-gated R2 proxy. Key excerpt (lines 68-71):

  ```ts
  if (!isAllowedReferer(request)) {
    return new Response("forbidden", { status: 403 });
  }
  ```

  `isAllowedReferer` returns **false when the Referer header is absent** (lines 26-31), so this code 403s every CLI/desktop/curl request.

- **Deployed reality does NOT match this code**: a `curl -I https://assets.petdex.dev/manifests/petdex-v1.json` with **no Referer** returned `200` on 2026-06-10. So either (a) `assets.petdex.dev` is an R2 custom domain on bucket `petdex-pets` and the Worker only serves `petdex-assets.raillyhugo.workers.dev`, or (b) an older Worker version without the referer gate is deployed. Step 1 resolves this.

- The repo's own operator rule (vault handoff doc, 2026-06-06): "Keep `assets.petdex.dev` as an R2 custom domain, not a Worker route. Do not route every asset request through a Worker unless there is a specific auth/signing requirement."

- Object key layout in the bucket matches URL paths 1:1 (the Worker maps `url.pathname` directly to the R2 key, lines 47-56), so swapping between Worker and R2 custom domain does not change any URL.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| CF auth check | `bunx wrangler whoami` | shows account `62819ee0...` |
| List R2 custom domains | `bunx wrangler r2 bucket domain list petdex-pets` | lists domains attached to the bucket |
| Worker deployments | `bunx wrangler deployments list --name petdex-assets` | recent deploy list |
| Probe cache | `curl -sI https://assets.petdex.dev/manifests/petdex-v1.json \| grep -i "cf-cache-status\|cache-control"` | see per-step expectations |

Cloudflare zone: `petdex.dev`. Cache Rules and WAF rules live in the dashboard (Caching → Cache Rules, Security → WAF) or via API (`/zones/{zone_id}/rulesets`). If no API token with `Zone.Cache Rules:Edit` + `Zone.Firewall Services:Edit` is available in the environment, STOP and report — the operator must create one.

## Scope

**In scope**:
- Cloudflare zone configuration for `petdex.dev` (Cache Rule + WAF rule on the `assets.petdex.dev` hostname)
- R2 bucket `petdex-pets` custom-domain attachment
- `workers/petdex-assets.ts` + `wrangler.petdex-assets.toml` — only if Step 1 shows the Worker serves the custom domain and we detach it (then mark these files with a comment that they serve workers.dev only, or delete them in a follow-up — do NOT delete in this plan)

**Out of scope** (do NOT touch):
- Any app code under `src/` — the app already points at `assets.petdex.dev` (see `next.config.ts` `CANONICAL_R2_PUBLIC_HOST`); nothing app-side changes.
- The R2 bucket contents — no object writes/deletes.
- `petdex.crafter.run` or `petdex.dev` HTML caching (that is Plan 002/003 territory).

## Git workflow

- Branch: only needed if Step 5's code comment lands: `advisor/001-assets-edge-cache`
- Commit style: conventional commits, lowercase imperative (e.g. `docs: note petdex-assets worker serves workers.dev only`)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Diagnose what serves assets.petdex.dev

Run `bunx wrangler r2 bucket domain list petdex-pets` and `bunx wrangler deployments list --name petdex-assets`. Also check in the Cloudflare dashboard: Workers & Pages → petdex-assets → Settings → Domains & Routes.

Record which of these is true:
- **A**: `assets.petdex.dev` is listed as an R2 custom domain on bucket `petdex-pets` → the Worker is irrelevant to this hostname; proceed to Step 2.
- **B**: `assets.petdex.dev` is a custom domain / route on the `petdex-assets` Worker → the deployed Worker differs from repo code (no referer gate live). Proceed to Step 2a (detach) before Step 2.

**Verify**: you can state A or B with the command output as evidence.

### Step 2a (only if B): Move the hostname from the Worker to the R2 bucket

1. Attach the custom domain to the bucket: `bunx wrangler r2 bucket domain add petdex-pets --domain assets.petdex.dev --zone-id <petdex.dev zone id>` (or dashboard: R2 → petdex-pets → Settings → Custom Domains).
2. Remove the `assets.petdex.dev` route/domain from the `petdex-assets` Worker (dashboard: Worker → Settings → Domains & Routes → remove). Do this AFTER the bucket domain is active to avoid a serving gap; if Cloudflare refuses to attach because the hostname is taken by the Worker, do the swap in the fastest possible sequence (remove → attach) during low traffic.

**Verify**: `curl -sI https://assets.petdex.dev/manifests/petdex-v1.json` → `200` (still serving). `curl -sI https://assets.petdex.dev/pets/nukey/spritesheet.webp` → `200`.

### Step 2: Add a Cache Rule for the asset hostname

Create a Cache Rule on zone `petdex.dev`:
- **Expression**: `(http.host eq "assets.petdex.dev")`
- **Action**: Eligible for cache ("Cache Everything" semantics)
- **Edge TTL**: "Use cache-control header if present, else 1 day" (respect origin — sprites already say `immutable, max-age=31536000`, manifests say `s-maxage=300`)
- **Browser TTL**: respect origin

**Verify**: run twice, ~5s apart:
`curl -sI https://assets.petdex.dev/pets/nukey/spritesheet.webp | grep -i cf-cache-status`
→ first `MISS` (or `EXPIRED`), second **`HIT`**. Then the manifest: second hit within 300s → `HIT`.

### Step 3: Add hotlink protection as a WAF rule (replaces the Worker's referer gate, but correctly)

The Worker's referer logic (had it been live) breaks CLI/desktop clients because they send no Referer. The correct rule blocks only *foreign* referers:

WAF custom rule on zone `petdex.dev`:
- **Expression**: `(http.host eq "assets.petdex.dev" and http.referer ne "" and not http.referer contains "petdex.dev" and not http.referer contains "localhost")`
- **Action**: Block

Empty referer (CLI, desktop, direct, most apps) passes; browser hotlinking from foreign sites is blocked.

**Verify**:
- `curl -s -o /dev/null -w "%{http_code}" https://assets.petdex.dev/manifests/petdex-v1.json` → `200` (no referer passes)
- `curl -s -o /dev/null -w "%{http_code}" -H "Referer: https://evil.example/" https://assets.petdex.dev/manifests/petdex-v1.json` → `403`
- `curl -s -o /dev/null -w "%{http_code}" -H "Referer: https://petdex.dev/en" https://assets.petdex.dev/manifests/petdex-v1.json` → `200`

Note: blocked-by-WAF responses never reach origin and never bill a Worker/R2 read.

### Step 4: Confirm CORS still works for the web app

The Worker added `Access-Control-Allow-Origin` for `https://petdex.dev`. R2 custom domains need bucket CORS config instead. Check current bucket CORS: `bunx wrangler r2 bucket cors list petdex-pets`. If empty and Step 1 was case B, add a CORS policy allowing `GET, HEAD` from `https://petdex.dev` and `http://localhost:3000`:
`bunx wrangler r2 bucket cors set petdex-pets --file <(echo '[{"AllowedOrigins":["https://petdex.dev","http://localhost:3000"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["Range"],"MaxAgeSeconds":86400}]')`

**Verify**: `curl -sI -H "Origin: https://petdex.dev" https://assets.petdex.dev/manifests/petdex-v1.json | grep -i access-control-allow-origin` → `https://petdex.dev` (or `*`). Then load `https://petdex.dev/en` in a browser and confirm pet sprites render (no CORS errors in console).

### Step 5: Record the outcome in the repo

If Step 1 was case B, add a comment block at the top of `workers/petdex-assets.ts`: this Worker no longer serves `assets.petdex.dev` (R2 custom domain + Cache Rule + WAF as of 2026-06; it remains only for `workers.dev` testing). Commit on branch `advisor/001-assets-edge-cache`.

**Verify**: `bun run check` → exit 0.

## Test plan

No unit tests (infrastructure change). The production probes in Steps 2-4 are the test suite. Additionally run the end-to-end smoke: `npx petdex@latest install nukey --dry-run` from a machine if available, or fetch the manifest + one sprite with plain curl (no referer) and confirm 200s.

## Done criteria

- [ ] Second consecutive request to a sprite under `assets.petdex.dev` returns `cf-cache-status: HIT`
- [ ] Second request to `/manifests/petdex-v1.json` within 300s returns `cf-cache-status: HIT`
- [ ] No-referer request returns `200`; foreign-referer request returns `403`; petdex.dev-referer returns `200`
- [ ] Browser smoke on `https://petdex.dev/en`: sprites render, no CORS console errors
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- No Cloudflare credentials with Cache Rules + WAF + R2 edit scopes are available.
- Step 1 shows a topology that is neither A nor B (e.g. a third service or another account owns the hostname).
- After the Cache Rule, sprites still return `DYNAMIC` on the second hit (something upstream marks responses uncacheable — capture full response headers and report).
- The browser smoke shows broken sprites/CORS after the swap — re-attach the previous configuration (Worker route or prior state) and report.

## Maintenance notes

- **Verification gotcha (learned 2026-06-11)**: probe this host with GET (`curl -s -o /dev/null -D -`), never HEAD (`curl -I`). On R2 custom domains Cloudflare reports `cf-cache-status: DYNAMIC` for HEAD requests even when GETs are served `HIT`. A HEAD-based probe falsely reads as "cache not working".

- Purge-on-change: pet sprites are immutable per slug today. If a moderation/takedown flow needs an asset gone faster than TTL, use a Cloudflare cache purge by URL (the takedown path in `src/lib` that deletes R2 objects should be extended to purge — note this as follow-up, do not build it here).
- If a signing/auth requirement ever appears for assets, that is the one case the operator rule allows a Worker back — but then it must use `caches.default` and a Cache Rule so invocations only happen on cache misses.
- Watch Cloudflare analytics for the `assets.petdex.dev` hostname for ~48h: cache hit ratio should be >90%; R2 Class B operations should drop proportionally.
