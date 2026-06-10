# Petdex Agent Notes

## Commands
- Use Bun for repo work: `bun install`, not `npm install`. Published CLI docs mention `npm`/`npx` for end users only.
- Recommended local app dev is `bun run dev:docker`; it boots local Postgres and Redis with shared Clerk dev defaults from `.env.dev`.
- Maintainer dev is `bun dev` with `.env.local` copied from `.env.example`; this path expects Clerk, Postgres/Neon, R2, Upstash, Resend, OpenAI, and ElevenLabs credentials.
- `bun run dev:mock` is deprecated and intentionally exits. Keep `.env.mock` only for targeted mock-backed tests or build checks.
- Root checks: `bun run check` for Biome, `bun run format` to write Biome fixes, `bun run build` for the Next app, `bun test` for Bun tests, and `bun run i18n:check` after editing translation messages. There is no root `typecheck` script.
- Focused tests use `bun test path/to/file.test.ts`. Tests that import `src/lib/db/client.ts` directly or indirectly, including `src/lib/pet-search.test.ts` and `src/lib/security.test.ts`, need a usable `DATABASE_URL` or mock env: `bun test --env-file=.env.mock src/lib/security.test.ts`.
- `packages/petdex-cli` and `packages/discord-bot` are independent packages, not root workspaces; run their own `bun install` and package scripts from inside each directory. Root `tsconfig.json` excludes `packages`.
- CLI package verification, run from `packages/petdex-cli`, is `bun run build && bun run typecheck`; the build emits ignored `dist/petdex.js` and prepends the node shebang in `postbuild`.
- Discord bot work stays in `packages/discord-bot`; use `bun run register`, `bun run dev`, or `bun run start` there with env from `packages/discord-bot/.env.example`.

## Architecture
- Main app routes live in `src/app/[locale]`; API routes live in `src/app/api`; shared server/domain code lives in `src/lib`; DB schema is `src/lib/db/schema.ts` with SQL migrations in `drizzle/`.
- This is Next `16.2.4` with newer conventions: `src/proxy.ts` is the middleware/proxy entrypoint, route/layout `params` are promises, and `src/app/layout.tsx` intentionally returns children while `[locale]/layout.tsx` owns `<html>`/`<body>` for locale `lang`. If touching framework APIs, prefer the installed Next docs under `node_modules/next/dist/docs/` over older assumptions.
- i18n locales are `en`, `es`, and `zh`; message files are under `src/i18n/messages/`, and `next-intl` is wired through `src/i18n/request.ts` plus the locale layout.
- Mock DB bootstrap tolerates migration/schema drift via fixups in `src/lib/mock/db.ts`; if schema fields are added and mock pages fail, update those fixups until a real migration lands.
- `drizzle.config.ts` hard-fails without `DATABASE_URL`; there are no root package scripts for migration generation or application, and many `scripts/apply-*` / `backfill-*` files are real-DB one-offs.
- Automated review/tag/sound paths use AI SDK model strings through Vercel AI Gateway (`AI_GATEWAY_API_KEY` in `.env.example`); avoid adding raw OpenAI client wiring to server paths.

## Invariants
- Submission identity and credit data must come from verified Clerk session or CLI bearer token, never from request bodies. Keep this split in `src/lib/submissions.ts`, `/api/submit`, and `/api/cli/submit*`.
- State-changing browser endpoints should use `requireSameOrigin` from `src/lib/same-origin.ts`; CLI/server callers authenticate separately by bearer or service-side checks.
- User-supplied asset/avatar/external URLs are allowlisted in `src/lib/url-allowlist.ts`. Adding a new host usually also needs CSP updates in `next.config.ts` and regression coverage in `src/lib/security.test.ts`.
- CSP is explicit in `next.config.ts`; new Clerk/R2/analytics/media hosts must be added to the matching `script-src`, `connect-src`, `img-src`, `frame-src`, or `media-src` directive.
- Tailwind v4 tokens live in `src/app/globals.css` via `@theme inline` rather than `tailwind.config.*`; components should use semantic tokens such as `bg-surface`, `text-foreground`, and `border-border-base` instead of hardcoded `bg-white dark:*` pairs.
- `bun run generate-assets` rewrites app/public icons and OG images from `public/brand/petdex-mark.svg`, including `src/app/favicon.ico` because Next 16 prefers the app favicon.
