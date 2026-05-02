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
PETDEX_TOKEN=... bun run upload-characters
```

The CLI auto-detects folders that contain `pet.json` and `spritesheet.webp`,
shows a numbered selection, builds a ZIP for each selected character, and sends
it to `/api/cli/submit`. The server must have `PETDEX_CLI_TOKEN` configured;
set `PETDEX_CLI_OWNER_ID` or `PETDEX_CLI_OWNER_EMAIL` to customize how CLI
submissions are attributed.

## Production

```bash
bun run build
```

Pet packages live under `public/pets`, and downloadable archives are generated under `public/packs`.
