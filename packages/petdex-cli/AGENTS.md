# petdex - Agent Guide

`petdex` is the catalog CLI for [Petdex](https://petdex.dev): browse, install, submit, and edit animated pixel-art pets (mascots) for coding agents, from the terminal. It installs pets into `~/.petdex/pets/` and `~/.codex/pets/`, and submits new pets to the gallery. The floating mascot itself ships as the separate **Petdex Desktop app** (petdex.dev/download), which installs agent hooks from its own Settings window and updates itself; this CLI is the catalog client. Reach for it when a user wants to install a pet, publish a pet they created, or edit one they own.

## Install

```bash
# One-shot via npx (-y skips npx's own install confirmation prompt)
npx -y petdex --help

# Or install globally
npm install -g petdex
```

The published name is plain `petdex` (unscoped, no `@crafter/` prefix). Requires Node.js 20+ (also runs on Bun). Single bundled JS file, no native dependencies.

## Commands

| Command | Description |
|---------|-------------|
| `petdex list` | List approved pets in the gallery |
| `petdex install <slug...>` | Install one or more pets into `~/.petdex/pets/<slug>/` and `~/.codex/pets/<slug>/` |
| `petdex login` | Sign in with Clerk OAuth + PKCE (opens browser, localhost callback; tokens in OS keychain) |
| `petdex logout` | Clear stored credentials |
| `petdex whoami` | Show signed-in user |
| `petdex submit <path> [--force]` | Submit a pet folder, zip, or parent folder of pets (bulk) |
| `petdex edit <slug>` | Edit a pet you own: `--desc "..."`, `--displayName "..."`, `--sprite <file>`, `--meta <pet.json>`, `--zip <file>` |
| `petdex telemetry [on\|off\|status]` | Manage anonymous usage telemetry |
| `petdex version` (or `--version`, `-v`) | Print the CLI version |

Internal commands (invoked by tooling, not by hand): `petdex bubble <pre|post|stop>` is the hot-path hook runner agents call on tool events, and `petdex mcp-server` is the MCP server subprocess for Antigravity. Both bypass help/telemetry output on purpose.

Removed in v1.0.0: `init`, `up`, `down`, `toggle`, `desktop`, `update`, `doctor`, `hooks`, and `install desktop`. Running them prints a pointer to the Petdex Desktop app, which now owns hooks, lifecycle, and updates. `select` is gone too (pick the active mascot in the desktop app's Settings).

## Usage patterns

1. Install pets:
   ```bash
   npx -y petdex install boba
   npx -y petdex install boba doraemon mochi
   ```
2. Submit a pet (requires login, which opens a browser):
   ```bash
   petdex login
   petdex submit ~/.petdex/pets/boba     # single folder
   petdex submit ~/.petdex/pets          # bulk: every subfolder with pet.json
   ```
3. Fix metadata or the sprite of a pet you already submitted:
   ```bash
   petdex edit boba --desc "A tiny otter sipping bubble tea" --sprite ./new.webp
   ```
4. Check identity / sign out:
   ```bash
   petdex whoami
   petdex logout
   ```

## Decision guide

| Task | Use |
|------|-----|
| Browse available pets | `petdex list` |
| Get a pet onto this machine | `petdex install <slug>` (deduped, multiple slugs OK) |
| Publish/share a pet | `petdex login`, then `petdex submit <path>` |
| Update a published pet's text or sprite | `petdex edit <slug> [flags]` |
| Show/hide the mascot, wire agent hooks, diagnose | Not this CLI: use the Petdex Desktop app (petdex.dev/download); its Settings installs hooks per agent |
| Choose the active mascot | Petdex Desktop Settings (hover the pet, Cmd+,) |
| Create a brand-new pet | Not this CLI: type `/pet` in the ChatGPT desktop app, then `petdex submit` the export |

## Common mistakes

- Wrong: `npm install @crafter/petdex` or `npm install petdex-cli`. Correct: `npm install -g petdex` (the package is unscoped `petdex`).
- Wrong: treating the npx confirmation `Need to install the following packages: petdex@x` as a hang. Correct: use `npx -y petdex ...` in scripts and agent runs.
- Wrong: `petdex init` / `petdex doctor` / `petdex hooks install` / `petdex select` from pre-1.0 docs. Those commands were removed in v1.0.0; mascot lifecycle and hooks live in the Petdex Desktop app.
- Wrong: running on Node < 20 (npm engine error). Correct: upgrade Node (`nvm install 20`).
- Wrong: `petdex submit` in a headless/CI session without prior auth. `petdex login` needs a browser for the OAuth callback; sign in interactively first (tokens persist in the OS keychain, service `petdex-cli`).
- Wrong: submitting a folder without `pet.json` + `spritesheet.webp` (or `.png`) at its root, or a sprite that is not an 8x9 grid (1536x1872) or v2 8x11 grid (1536x2288, the ChatGPT export shape), or a clean scale of either. The register step rejects it (`invalid_spritesheet`).
- Note: submissions are rate-limited to 10 per 24h per user. Slugs auto-deduplicate on collision (`boba` -> `boba-2`). Point at non-production deployments with `PETDEX_URL`, and `CLERK_ISSUER` + `CLERK_OAUTH_CLIENT_ID` together.
