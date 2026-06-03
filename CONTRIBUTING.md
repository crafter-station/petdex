# Contributing to Petdex

## Supported local dev paths

Pick the one that matches what you want to change.

| Goal | Command | Setup |
|---|---|---|
| Local full stack | `bun run dev:docker` | Docker Desktop or Podman, ~30s |
| Run against real petdex services | `bun run dev` | `.env.local` filled in (maintainers only) |

`dev:docker` is the recommended path for almost everyone. It boots
a real Postgres + Redis + Clerk dev instance so the app behaves the
same way it does in production.

`dev:mock` is deprecated and intentionally exits. Use `dev:docker`, or
`bun dev` if you are a maintainer with complete env vars.

## bun run dev:docker

Real Postgres, real Redis, real Clerk OAuth. Same stack as production
but pointed at a shared OSS dev instance and local containers.

```bash
bun install
bun run dev:docker
```

That single command will:

1. Detect `docker compose` or `podman compose` (works with either)
2. Boot Postgres 16 + Redis 7 + a Redis-over-HTTP shim on `127.0.0.1`
3. Push the drizzle schema with `drizzle-kit push --force`
4. Seed ~20 approved pets so the gallery is not empty
5. Launch `next dev` (turbopack) on <http://localhost:3000>

Sign in with GitHub or Google through Clerk. The publishable key for
the shared "Petdex OSS Dev" Clerk app is committed in `.env.dev` so
contributors don't need their own Clerk account.

When you're done: `bun run docker:down` to stop the containers.
`bun run docker:nuke` if you want to wipe the database too.

### Engine compatibility

`docker-compose.dev.yml` is engine-agnostic. The wrapper script probes
`docker compose` first and falls back to `podman compose`, so:

```bash
docker compose -f docker-compose.dev.yml up -d
podman compose -f docker-compose.dev.yml up -d
```

Both work without editing the file.

### What works in docker mode

- Real Clerk sign-in (GitHub, Google, email magic link)
- Real Postgres planner. Bugs that only repro in production stop
  hiding behind in-memory quirks.
- Rate limits actually rate-limit (Upstash REST + local Redis)
- Real schema migrations via drizzle-kit
- Likes, profile edits, pinned reorder, collections, takedowns

### What does NOT work in docker mode (yet)

- R2 uploads: without R2 credentials, presign returns a non-routable
  host so an accidental upload errors out fast. Set `R2_*` in your own
  `.env.local` if you actually want to test uploads against a bucket.
- Outbound emails: `RESEND_API_KEY` is empty, so notification emails
  are skipped. In-app notifications still fire.
- AI features (auto-tag, vibe search, pet sound): these need
  `OPENAI_API_KEY` / `ELEVENLABS_API_KEY` in your `.env.local`.

### Becoming a dev admin

Some routes (`/admin`, takedown, manual approval) require your Clerk
user id to be in `PETDEX_ADMIN_USER_IDS`. After signing in:

1. Open <http://localhost:3000/u/your-handle> while signed in
2. Open browser devtools → Application → Cookies and find
   `__session`. Your Clerk user id is in the JWT payload, prefixed
   `user_`. Or copy it from the dashboard at <https://dashboard.clerk.com>.
3. Add it to your `.env.local`:
   ```
   PETDEX_ADMIN_USER_IDS=user_xxxxxxxxxxxxxxxxxxxxxxxx
   NEXT_PUBLIC_PETDEX_ADMIN_USER_IDS=user_xxxxxxxxxxxxxxxxxxxxxxxx
   ```
4. Restart `bun run dev:docker`.

## bun run dev (full real services)

For maintainers who have credentials for the production-grade staging
stack. Copy `.env.example` to `.env.local`, fill in the values, run
`bun dev`. No containers, no Clerk dev shim, no seed.

## Conventions

- **Runtime**: Bun (never `npm install`).
- **Lint/format**: `bun run check` / `bun run format` (Biome).
- **Tests**: `bun test`. DB-backed search integration tests are
  explicit: `DATABASE_URL=... bun run test:db`.
- **Commit style**: conventional commits (`feat:`, `fix:`, `docs:`, etc.).

## Where to look

- UI: `src/components/`, `src/app/[locale]/`
- API routes: `src/app/api/`
- DB schema: `src/lib/db/schema.ts`
- i18n strings: `src/i18n/messages/`
- Docker compose: `docker-compose.dev.yml`
- Dev seed: `scripts/seed-dev.ts`
