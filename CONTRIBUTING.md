# Contributing to Petdex

## Quick start (no credentials needed)

```bash
bun install
bun run dev:mock
```

Open <http://localhost:3000>. You'll be auto-signed-in as a mock user
(`contributor@petdex.local`) and the gallery is seeded with ~12 pets so
the home page, pet detail pages, search, and `/my-pets` all render.

This is the recommended path for UI, copy, accessibility, i18n, and
front-end interaction work. No `.env.local` required, no real Clerk /
Postgres / R2 / Redis / Resend / OpenAI / ElevenLabs credentials.

### What works in mock mode

- Home page, gallery, pet detail pages
- Search, profile pages, `/my-pets`
- Sign-in flows are bypassed (you're always the mock user)
- Rate-limited routes always succeed
- Database is in-memory PGlite, seeded from `pets/ideas.json`

### What does NOT work in mock mode

- Real OAuth (no Clerk dashboard)
- Real R2 uploads (presigned URLs return placeholders)
- Outbound emails (Resend calls are skipped)
- AI features (auto-tag, pet sound) — these require live API keys
- Background jobs that hit OpenAI / ElevenLabs

If your change depends on one of those, see "Full local dev" below.

### How the mock mode works

| Service | Mock |
|---|---|
| Postgres | `@electric-sql/pglite` in-memory, schema migrated from `drizzle/`, seeded from `pets/ideas.json` |
| Clerk | webpack alias swaps `@clerk/nextjs[/server]` for stubs in `src/lib/mock/` returning a fixed signed-in user |
| Upstash Redis | `Ratelimit#limit` is patched to always return `success: true` |
| OpenAI / ElevenLabs / Resend | not invoked — these features are admin-triggered and skipped in mock mode |

Source: `src/lib/mock/`. To extend coverage (e.g. mock R2 uploads), add a
shim there and gate it behind `IS_MOCK` from `src/lib/mock/index.ts`.

## Full local dev (with real services)

If you have access to a Petdex staging environment, copy `.env.example`
to `.env.local`, fill in real values, and run `bun dev` (no `:mock`).
This path is for maintainers and trusted collaborators.

## Conventions

- **Runtime**: Bun (never `npm install`).
- **Lint/format**: `bun run check` / `bun run format` (Biome).
- **Tests**: `bun test`. DB-backed search integration tests are explicit:
  `DATABASE_URL=... bun run test:db`.
- **Commit style**: conventional commits (`feat:`, `fix:`, `docs:`, etc.).

## Where to look

- UI: `src/components/`, `src/app/[locale]/`
- API routes: `src/app/api/`
- DB schema: `src/lib/db/schema.ts`
- i18n strings: `src/i18n/messages/`
