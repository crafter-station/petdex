# Kekka Marketing

Kekka Marketing's homepage — hero section, service highlights, and 
footer, built on Next.js and Tailwind CSS.

## What's in this repo

- One route: `src/app/[locale]/page.tsx` — the homepage. No other 
  pages, no admin panel, no CLI.
- Static data: content is hardcoded directly in the codebase 
  (`src/lib/static-pets.ts` and related files) — no external database, 
  no Postgres, no Redis required to run this locally.
- A small set of supporting API routes for header/footer functionality 
  (locale switching, feedback, notifications, OG image generation).

This project was originally adapted from an open-source starting point 
and has since been trimmed and restructured for Kekka Marketing's own 
use.

## Run it

```sh
bun install
```

Mock mode needs a couple of placeholder env vars so nothing crashes 
reaching for external services — `.env.mock` already has them.

Dev server (live reload):

```sh
set -a && source .env.mock && set +a
bunx next dev
```

Production-style build + run:

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

The source code is [MIT](./LICENSE).
