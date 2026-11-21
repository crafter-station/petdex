# Plan 003: Convert /requests, /leaderboard and /download from force-dynamic to static/ISR

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 82ffb6b..HEAD -- "src/app/[locale]/requests" "src/app/[locale]/leaderboard" "src/app/[locale]/download" src/components/requests-view.tsx src/components/leaderboard-view.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (but lands best after 002 so the new static pages can be added to its edge-cache header list)
- **Category**: perf
- **Planned at**: commit `82ffb6b`, 2026-06-10

## Why this matters

Three public pages still declare `export const dynamic = "force-dynamic"`, so every view renders on a Vercel function (invocation + Fluid CPU + origin transfer) and can never be cached by Vercel's CDN or Cloudflare. For each, the dynamic trigger is removable: `/requests` reads `auth()` only to mark which requests the current user voted on; `/leaderboard` reads `searchParams` only to pick the active tab even though it already fetches all five tabs server-side; `/download` reads `searchParams` for pending-install slugs and carries a stale comment about a "latest-release fetch" that does not exist in the code. The repo already solved exactly this problem once: PR #359 made `/collections/[slug]` static by moving per-user "caught" state into a client component fed by `HeaderStateProvider`. This plan applies that proven pattern three more times.

## Current state

- `src/app/[locale]/requests/page.tsx:16` — `export const dynamic = "force-dynamic";`
  - Line 3: `import { auth, clerkClient } from "@clerk/nextjs/server";`
  - Line 40: `const { userId } = await auth();` — used to compute the current user's votes so `RequestsView` can show "you voted".
  - The rest of the page (request rows, vote counts, voter avatars via `clerkClient`) is the same for all users.
- `src/app/[locale]/leaderboard/page.tsx:18` — `export const dynamic = "force-dynamic";`
  - Lines 52-56: reads `searchParams` → `tab`, validated against `METRIC_VALUES` (`pets | likes | installs | rising | collectors`), defaulting to `"pets"`.
  - Lines 68-76: **already fetches all five variants in parallel** (`getLeaderboard("pets") ... getLeaderboard("collectors")`) with the code comment "Fetch every variant in parallel so the tabs feel instant". The only reason the page is dynamic is that the *server* picks the active tab from the URL.
- `src/app/[locale]/download/page.tsx:78-81`:

  ```ts
  // Force-dynamic so the latest-release fetch runs per request —
  // otherwise users see a cached release tag that drifts behind
  // what's actually on GitHub.
  export const dynamic = "force-dynamic";
  ```

  The comment is stale: there is no GitHub release fetch anywhere in this page. The actual dynamic dependency is `searchParams` (lines 83-100): `next` → `pendingInstallSlugs` → activation command string + preview pet via `getPet(previewSlug)`.
- The exemplar pattern (PR #359): `src/app/[locale]/collections/[slug]/page.tsx:22-23` is `force-static` + `revalidate = 86400`, and per-user caught state renders via the client component `src/components/collection-caught-progress.tsx`, which reads `HeaderStateProvider` (mounted globally in `src/app/[locale]/layout.tsx:114`). Model all per-user UI on this.
- `HeaderStateProvider` exposes the signed-in user's `caught` slugs, feedback counters, etc. Check `src/components/header-state-provider.tsx` for the exact context shape before extending it.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Lint | `bun run check` | exit 0 |
| i18n | `bun run i18n:check` | exit 0 |
| Tests | `bun test --env-file=.env.mock` | all pass |
| Build | `TELEMETRY_RATELIMIT_SECRET=mock-telemetry-secret bun --env-file=.env.mock run build` | exit 0; route table shows the three routes as static/ISR (`●`/`○` with revalidate), not `ƒ` |

## Scope

**In scope**:
- `src/app/[locale]/requests/page.tsx`, `src/components/requests-view.tsx`
- `src/app/[locale]/leaderboard/page.tsx`, `src/components/leaderboard-view.tsx`
- `src/app/[locale]/download/page.tsx` + a new small client island for the pending-install command (e.g. `src/components/download-activation-command.tsx`)
- `src/app/api/me/header-state/route.ts` and `src/components/header-state-provider.tsx` ONLY if the requests-votes state needs a new field (see Step 1 escape hatch)
- `next.config.ts` — add the three routes to the `Cloudflare-CDN-Cache-Control` list from plan 002 (only if 002 already landed)

**Out of scope** (do NOT touch):
- `/u/[handle]` (`force-dynamic` at `src/app/[locale]/u/[handle]/page.tsx:36`) — owner-dashboard/public-profile split is a larger refactor the owner explicitly deferred ("Do not quick-patch this route"); leave it.
- Vote mutation endpoints (`/api/*` for request votes) — behavior unchanged.
- `/install/[slug]` route handler (intentionally `force-dynamic` with short cache headers).

## Git workflow

- Branch per page or one branch `advisor/003-static-remaining-pages`; conventional commits, e.g. `perf: render requests page statically`
- Keep PRs small and reviewable (repo operator rule). Three separate commits minimum — one per page.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: /requests — move "my votes" to the client

1. In `src/app/[locale]/requests/page.tsx`: delete the `auth()` call (line 40) and the `import { auth, ... }` (keep `clerkClient` if still used for requester/voter credits). Compute and pass ONLY the user-agnostic data (rows, counts, voter display info).
2. Per-user "already voted" marking moves into `src/components/requests-view.tsx` (already a client component — verify with `head -5`): determine the signed-in user's voted request ids client-side. Check first whether the vote POST/DELETE endpoint or an existing API returns the user's votes; if `HeaderStateProvider` already carries something usable, prefer it. If NO existing client-readable source of "my voted request ids" exists, see STOP conditions — adding a field to header-state is allowed but report the size impact in the commit message (header-state response is currently ~109 bytes; keep the addition compact, e.g. `requestVotes: string[]`).
3. Replace line 16 with `export const dynamic = "force-static"; export const revalidate = 3600;`.

**Verify**: mock build → route table shows `/[locale]/requests` as static/ISR. `bun test --env-file=.env.mock` → pass.

### Step 2: /leaderboard — tab selection client-side

1. The page already fetches all 5 tabs. Remove the `searchParams` read (lines 52-64): pass all five row sets plus `defaultTab: "pets"` to `LeaderboardView`, and let the view manage the active tab in client state, syncing the URL with `history.replaceState` or `useRouter().replace` **without** a server round-trip (use `<Link scroll={false} shallow>`-equivalent or plain state — check how `LeaderboardView` currently handles tab clicks; it likely already navigates with `?tab=`. Change it to local state + `replaceState` so tab switches stop hitting the server entirely — that is an extra request-volume win).
2. Keep deep-linking working: on mount, `LeaderboardView` reads `window.location.search` (or `useSearchParams` inside a `<Suspense>` boundary, which is allowed in static pages) to set the initial tab.
3. Replace line 18 with `export const dynamic = "force-static"; export const revalidate = 3600;`.

**Verify**: mock build → `/[locale]/leaderboard` static/ISR. Local serve: `curl -s "http://localhost:3000/en/leaderboard?tab=likes" | grep -i "likes"` → 200 page renders; manual browser check that visiting `?tab=likes` opens the likes tab.

### Step 3: /download — pending-install island

1. Delete the stale comment and `force-dynamic` (lines 78-81).
2. The `searchParams.next` → activation command logic (lines 83-100) moves to a new client component `src/components/download-activation-command.tsx` that reads `useSearchParams()` inside a `<Suspense>` boundary and renders the `npx petdex init && npx petdex install ...` string; default (no params) renders `npx petdex init`. The preview pet: keep server-side but pin to `DEFAULT_PREVIEW_PET_SLUG` (the per-slug preview for pending installs becomes a client-side enhancement only if cheap — if the preview pet must vary by query param, render the default pet statically and skip the variation; note it in the commit).
3. Add `export const revalidate = 3600;`.

**Verify**: mock build → `/[locale]/download` static/ISR. `curl -s "http://localhost:3000/en/download?next=nukey"` → 200; manual browser check that the activation command shows `npx petdex install nukey`.

### Step 4: Register the new static routes for edge caching (only if plan 002 landed)

Add `/requests`, `/leaderboard`, `/download` (with locale variants) to the `Cloudflare-CDN-Cache-Control` source list in `next.config.ts` introduced by plan 002.

**Verify**: rebuild; `curl -sI http://localhost:3000/en/leaderboard | grep -i cloudflare-cdn-cache-control` → present.

## Test plan

- `requests-view`: test that voted-state marking renders from client-provided vote ids (model after existing component tests, e.g. `src/components/optimistic-actions.test.ts` / `command-line.test.ts` structure).
- `leaderboard-view`: test initial tab from `?tab=likes` and local tab switching without navigation.
- `download-activation-command`: test command string for 0, 1, N slugs (port the existing `parsePendingInstallSlugs` cases if tests exist; search `grep -rn "parsePendingInstallSlugs" src --include="*.test.*"`).
- Full gate: `bun test --env-file=.env.mock` → all pass.

## Done criteria

- [ ] Build route table: `/[locale]/requests`, `/[locale]/leaderboard`, `/[locale]/download` are static/ISR (not `ƒ`)
- [ ] `grep -rn "force-dynamic" "src/app/[locale]/requests" "src/app/[locale]/leaderboard" "src/app/[locale]/download"` → no matches
- [ ] Tab deep-links and pending-install commands still work (manual smoke documented in PR)
- [ ] Signed-in user still sees their voted state on /requests (manual smoke)
- [ ] All commands in the table exit 0
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- There is no existing client-readable source for "my voted request ids" AND adding `requestVotes` to header-state would exceed ~1KB for realistic users (someone who voted on hundreds of requests) — report with a size estimate and an alternative (e.g. a dedicated `/api/me/request-votes` with `private, max-age=300`).
- `LeaderboardView` or `RequestsView` turn out to be server components with deep server-only dependencies (drift from this plan's assumption).
- The download preview pet genuinely must vary by `?next=` slug per product requirements — report; the client-island-fetches-preview design needs an owner decision.
- Any verification fails twice after a reasonable fix attempt.

## Maintenance notes

- These three pages join the "static public shell + per-user client islands" pattern (PR #358/#359 lineage). Reviewers of future PRs touching them should reject any reintroduction of `auth()`/`searchParams` reads in the server shell.
- `/u/[handle]` remains the last force-dynamic public page; it needs the public-profile vs owner-dashboard split (deferred by owner decision — revisit only when route-cost buckets prove it hot).
- After this lands, plan 004's Clerk-gating step has one fewer `auth()` caller to worry about.
