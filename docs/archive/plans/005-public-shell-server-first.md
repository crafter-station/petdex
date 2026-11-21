# Plan 005: Public shell server-first — drop the global Clerk/header-state/feedback client floor on anonymous pages

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 82ffb6b..HEAD -- "src/app/[locale]/layout.tsx" src/components/theme-providers.tsx src/components/header-state-provider.tsx src/components/site-header.tsx src/components/feedback-widget.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2 (highest-value code change, but largest)
- **Effort**: L
- **Risk**: MED-HIGH (touches the auth UX of every page)
- **Depends on**: none hard; best last — 001-004 cut request volume, this cuts bytes/CPU per remaining request
- **Category**: perf
- **Planned at**: commit `82ffb6b`, 2026-06-10

## Why this matters

Every public page — including fully static ones like `/collections`, `/kind/[kind]`, `/docs` — ships a ~146KB gzip first-load JS floor (home: 247KB; measured from the build's client reference manifests at this commit), because the locale layout mounts a client provider stack globally: `NextIntlClientProvider → AppProviders (next-themes + ClerkProvider) → HeaderStateProvider → FeedbackWidget`. Anonymous visitors (the overwhelming majority, all of the viral traffic) pay Clerk's SDK download, hydration of header-state machinery they never use, and the feedback widget — on every page view. This multiplies into Fast Origin Transfer (JS bytes × visits), client parse time (slow devices in the China audience), and a hydration floor no per-page optimization can get under. This is the change the repo's own migration handoff names as "the next high-ROI step": anonymous public pages should render a server-first shell, with auth UI as a lazy client island that only materializes for signed-in users.

## Current state

- `src/app/[locale]/layout.tsx:103-121` (the global provider stack):

  ```tsx
  <body className="min-h-full flex flex-col bg-background text-foreground">
    <NextIntlClientProvider messages={clientMessages}>
      <AppProviders>
        {isZh && <TopPromoStrip />}
        <HeaderStateProvider>
          {isZh ? <ZhLayoutSpacer>{children}</ZhLayoutSpacer> : children}
          <FeedbackWidget />
        </HeaderStateProvider>
      </AppProviders>
    </NextIntlClientProvider>
  </body>
  ```

- `src/components/theme-providers.tsx` — `"use client"`; `AppProviders` = next-themes `ThemeProvider` wrapping `ClerkWithTheme`, which mounts `ClerkProvider` (lines 5-66) with lazy dark-theme and lazy es/zh localization imports. ClerkProvider itself is unconditional.
- `src/components/header-state-provider.tsx` — `"use client"`; context provider that fetches `/api/me/header-state` for signed-in users (signed-out short-circuits, PR #390) and feeds: signed-in header UI, notifications bell, caught-progress components (e.g. `src/components/collection-caught-progress.tsx` from PR #359), like buttons, feedback counters.
- `src/components/site-header.tsx` — header with nav + auth controls; several sub-islands already lazy (mobile menu, user dropdown, notifications panel — PRs #431-434).
- `src/components/feedback-widget.tsx` — already lazy-loaded internally (PR #429) but still mounted globally inside the provider stack.
- Consumers of Clerk hooks/`HeaderStateProvider` context exist across public pages (like buttons, caught progress, owner controls). Inventory command:
  `grep -rln "useHeaderState\|from \"@clerk/nextjs\"" src/components src/app | grep -v server | sort`
- Build measurement baseline (this commit): `/[locale]/collections` ≈ 146KB gzip first-load JS; home ≈ 247KB. Measure via the build output table from `TELEMETRY_RATELIMIT_SECRET=mock-telemetry-secret bun --env-file=.env.mock run build` (Next prints First Load JS per route).

## Target architecture (what must be true after)

1. The locale layout renders a **server-first shell**: html/body, fonts, `NextIntlClientProvider` (messages already pruned via `pickClientMessages`), next-themes ThemeProvider (needed for dark mode on all pages — keep), and the page content. No ClerkProvider, no HeaderStateProvider, no FeedbackWidget at this level.
2. A new client boundary `AuthIsland` (or equivalent) mounts ClerkProvider + HeaderStateProvider **only around the components that need them**: the header's auth corner, and a portal/context bridge for in-page consumers (like buttons, caught progress).
3. Anonymous visitors download zero Clerk SDK bytes until they interact with an auth-requiring control (sign-in click) — Clerk loads lazily via `next/dynamic`/`React.lazy` on interaction or on detected existing session (check `__client_uat` cookie client-side: cheap, no SDK needed — if the cookie is present, load the full auth island immediately).
4. Auth-requiring routes (`/submit`, `/my-feedback/*`) wrap themselves in the full provider boundary via their own layout (e.g. a route group `(auth)` layout) so nothing breaks there.
5. The interactive consumers degrade gracefully when no provider is mounted: like button renders as "sign in to like" CTA; caught-progress renders nothing for anonymous; feedback widget mounts lazily as today but inside the island.

This is a known-hard refactor: the main cost is the long tail of `useHeaderState`/Clerk-hook consumers on public pages. The steps sequence it so the app builds at every step.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Lint | `bun run check` | exit 0 |
| i18n | `bun run i18n:check` | exit 0 |
| Tests | `bun test --env-file=.env.mock` | all pass |
| Build + JS sizes | `TELEMETRY_RATELIMIT_SECRET=mock-telemetry-secret bun --env-file=.env.mock run build` | exit 0; First Load JS table |
| Local serve | `... bun --env-file=.env.mock run start` | :3000 |

## Suggested executor toolkit

- If available, use the `react-best-practices` / `vercel-react-best-practices` skill when designing the lazy boundaries.
- Read `node_modules/next/dist/docs/` for Next 16 conventions (repo note: params are promises; `src/app/layout.tsx` returns children; `[locale]/layout.tsx` owns html/body).
- Mock-auth dev mode: `PETDEX_MOCK=1` paths short-circuit Clerk (see `IS_MOCK_AUTH` in `next.config.ts` / `src/proxy.ts`) — useful for local smoke without real Clerk keys, but final verification needs the real flow via Vercel preview.

## Scope

**In scope**:
- `src/app/[locale]/layout.tsx`
- `src/components/theme-providers.tsx` (split: ThemeProvider stays global; Clerk moves out)
- New files: auth island boundary component(s), optional `(auth)` route-group layout
- `src/components/site-header.tsx` and the auth-corner components it renders
- `src/components/header-state-provider.tsx` (export a safe no-provider default so consumers can render anonymous state)
- The minimal set of consumer components needed to degrade gracefully (like-button, collection-caught-progress, pet-card-footer, notifications-bell, feedback-widget mounting point)

**Out of scope** (do NOT touch):
- `/u/[handle]`, `/submit`, `/my-feedback` page logic beyond wrapping them in the auth layout
- `src/proxy.ts` middleware, API routes, `next.config.ts` CSP
- i18n message files; `pickClientMessages` allowlist (unless a moved component changes which namespaces are client-visible — then update `src/i18n/client-messages.ts` accordingly and say so)
- CI workflows

## Git workflow

- Branch: `advisor/005-public-shell`; conventional commits per step (`perf: ...`). The repo operator prefers small reviewable PRs — if the diff grows past ~600 lines, split into stacked PRs at the step boundaries.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Inventory and classify consumers

Run the inventory grep (Current state). Produce a table in the PR description: component → uses Clerk hooks / useHeaderState / both → rendered on (public pages / auth pages / both) → anonymous fallback behavior. This table drives Steps 3-5 and is a deliverable even if later steps stall.

**Verify**: table exists; every `useHeaderState` and `@clerk/nextjs` (client) import site is classified.

### Step 2: Make HeaderStateProvider consumers provider-optional

Change the `useHeaderState` hook so that when no provider is mounted it returns the signed-out default state (the provider module already has an initial/empty state shape — reuse it) instead of throwing. This single change lets the provider be unmounted globally without breaking any consumer.

**Verify**: `bun test --env-file=.env.mock` → pass (update tests that assert the throw, if any).

### Step 3: Extract the auth island

Create `src/components/auth-island.tsx` (`"use client"`): checks for an existing Clerk session cookie client-side (`document.cookie` contains `__client_uat` with a non-zero value); if present, dynamically imports a `FullAuthProviders` module (ClerkProvider with the existing theme/localization logic from `ClerkWithTheme` + HeaderStateProvider + FeedbackWidget) and wraps its children; if absent, renders children directly with a lightweight sign-in link in the header corner that triggers the dynamic import on click (then redirects into the Clerk sign-in flow once loaded).

`theme-providers.tsx` shrinks to ThemeProvider-only; the Clerk logic moves into the dynamically-imported module so it is code-split out of the shared bundle.

**Verify**: mock build → exit 0; `grep -rn "ClerkProvider" src/components/theme-providers.tsx` → no matches.

### Step 4: Rewire the locale layout

`src/app/[locale]/layout.tsx` becomes: `NextIntlClientProvider → ThemeProvider → [zh chrome] → AuthIsland(children + FeedbackWidget mount point)`. The AuthIsland wraps the header's auth corner and exposes the provider context to the page tree (it can wrap `children` entirely — the point is the heavy modules only load per the Step 3 logic, not that the React tree shape changes).

Wrap `/submit` and `/my-feedback` in a route-group layout that forces the full providers eagerly (auth pages must not flash signed-out UI).

**Verify**: mock build; First Load JS for `/[locale]/collections` and `/[locale]/docs` drops vs the 146KB baseline — record exact numbers. Local serve smoke: home renders, dark-mode toggle works, sprites animate.

### Step 5: Degrade the public interactive islands

Per the Step 1 table: like-button, caught-progress, pet-card-footer, notifications-bell render their anonymous state from the Step 2 default when the island hasn't loaded, and their signed-in state once it has. No layout shift beyond what exists today (the header already lazy-loads its user dropdown).

**Verify**: `bun test --env-file=.env.mock` → pass; manual smoke in mock mode: like button shows sign-in CTA when signed out.

### Step 6: Full verification pass

- Mock build: record First Load JS for home, `/collections`, `/kind/[kind]`, `/docs`, `/pets/[slug]` — compare to baseline (146-247KB). Target: static pages < 90KB, home < 170KB. If the numbers barely move, STOP and report what is still in the shared chunk (`next build` with `ANALYZE` if the repo supports it, or inspect `.next/static/chunks`).
- Real-auth smoke on a Vercel preview: sign in, like a pet, open notifications, submit-page gate, sign out. Signed-out → signed-in transition on home (cookie present → island auto-loads → header shows avatar).

## Test plan

- Step 2: unit test that `useHeaderState` outside a provider returns the signed-out default (new test next to existing header-state tests — `src/lib/header-state.test.ts` shows the data-layer patterns; component tests follow `src/components/*.test.ts(x)` style).
- AuthIsland: test cookie-detection branch logic (extract the cookie check into a pure function `hasClerkSessionCookie(cookieString)` so it's testable without a DOM).
- Full suite green: `bun test --env-file=.env.mock`.

## Done criteria

- [ ] First Load JS, mock build: `/[locale]/collections` and `/[locale]/docs` < 90KB gzip; home < 170KB (record before/after table in PR)
- [ ] `grep -rn "ClerkProvider" "src/app/[locale]/layout.tsx" src/components/theme-providers.tsx` → no matches
- [ ] Anonymous page load in browser devtools: no `clerk` JS chunks fetched, no `/api/me/header-state` request
- [ ] Signed-in preview smoke passes (like, notifications, submit gate, sign-out)
- [ ] `bun run check`, `bun run i18n:check`, `bun test --env-file=.env.mock`, mock build all exit 0
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- ClerkProvider turns out to be load-bearing for SEO/SSR output on public pages (diff the rendered HTML of home before/after Step 4 — if meaningful content disappears, stop).
- The Step 1 inventory reveals >25 consumer components needing individual degradation work — report the table and propose splitting this plan.
- Clerk's SDK cannot be cleanly dynamic-imported in this Next version (e.g. ClerkProvider must wrap at module-eval time) — report the exact constraint; fallback design (keeping ClerkProvider but with `dynamic` import of its internals) needs owner sign-off.
- First Load JS doesn't drop ≥30KB on static pages after Step 4 — something else dominates the floor; report the chunk analysis instead of pushing forward.

## Maintenance notes

- New interactive components on public pages must consume `useHeaderState`'s provider-optional default and live behind the island — reviewers should reject direct `@clerk/nextjs` hook imports in public-page components.
- This plan plus 002 means anonymous HTML is edge-cached AND light; a regression in either multiplies cost again — the build-size table belongs in PR review checklists.
- Follow-ups the migration handoff lists after this (not here): home gallery static-first card grid (Claude B track), pet detail islands (Claude C track).
