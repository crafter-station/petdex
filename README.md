# Petdex

Petdex is a public gallery for Codex-compatible animated pets.

## Features

- Browse approved pet packs
- Preview every animation state
- Download individual ZIP packages
- Download the full gallery pack
- Validate and submit community pet packages in the browser

## Development

```bash
bun install
bun dev
```

## CLI submissions

The `@petdex/cli` package uploads local Codex characters from
`~/.codex/pets`.

```bash
bun packages/petdex-cli/bin/petdex.js login
bun packages/petdex-cli/bin/petdex.js install boba
bun run upload-characters
```

The CLI auto-detects folders that contain `pet.json` and `spritesheet.webp`,
shows a numbered selection, builds a ZIP for each selected character, and sends
it to `/api/cli/submit`. `petdex login` opens `/cli-auth` in the browser,
reuses the existing Clerk sign-in flow, and stores a user-scoped token locally.
`petdex install <slug>` installs approved Petdex pets into `~/.codex/pets`.
The server must have `PETDEX_CLI_TOKEN_SECRET` or `CLERK_SECRET_KEY` configured
to issue CLI login tokens. `PETDEX_CLI_TOKEN` is still supported for automation.

## Production

```bash
bun run build
```

Pet packages live under `public/pets`, and downloadable archives are generated under `public/packs`.
