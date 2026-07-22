<div align="center">

<img src="public/brand/petdex-desktop-icon.png" alt="Petdex" width="120" />

<h1>Petdex (homepage-only, mock mode)</h1>

<p>
  A trimmed-down copy of the Petdex homepage — the hero, the pet
  cards, and the footer — running against an in-memory mock database.
  No CLI, no desktop app, no other pages.
</p>

</div>

---

## What's actually in this repo

This is a stripped-down slice of the original [Petdex](https://petdex.dev) project, kept to
just what's needed to build and run the homepage:

- **One route**: `src/app/[locale]/page.tsx`. There's no gallery page, no
  `/pets/<slug>`, no submit flow, no admin, no CLI, no desktop app —
  those all lived elsewhere in the original project and aren't part of
  this copy.
- **Mock data only**: `pets/ideas.json` seeds an in-memory Postgres
  instance ([PGlite](https://pglite.dev/)) at startup via
  `src/lib/mock/db.ts`. There's no real Postgres, Redis, Clerk, or R2
  behind this — every external service is stubbed out when
  `PETDEX_MOCK=1` is set.
- **A handful of supporting API routes** the homepage's header/footer
  actually call (profile locale switching, feedback, notifications,
  OG image, the surprise-pet shuffle button) — everything else was
  removed as dead code.

## Run it

```sh
bun install
```

Mock mode needs a couple of placeholder env vars so nothing crashes
reaching for a real database or API key — `.env.mock` already has
them, along with `PETDEX_MOCK=1`.

**Dev server** (live reload):

```sh
set -a && source .env.mock && set +a
bunx next dev
```

**Production-style build + run**:

```sh
bun --env-file=.env.mock run build
bun --env-file=.env.mock run start
```

Either way, open `http://localhost:3000`.

## Tests

```sh
bun test --env-file=.env.mock
```

## License

The source code is [MIT](./LICENSE). Pet assets in `pets/ideas.json` are
placeholder mock data, not real submissions.
