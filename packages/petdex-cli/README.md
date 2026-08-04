# petdex

The Petdex CLI: browse, install, and submit animated pets for your coding agents from your terminal.

The pets themselves are shown by [Petdex Desktop](https://petdex.dev/download), which
connects your agents from its own Settings window. This CLI is the catalog client.

- **Gallery & docs:** <https://petdex.dev>
- **Repo:** <https://github.com/crafter-station/petdex>
- **Hatch a new pet:** <https://petdex.dev/create>

## Install

```sh
# One-shot via npx (no global install)
npx petdex --help

# Or install globally
npm install -g petdex
```

Requires Node.js 20+ (also runs on Bun).

## Quick start

```sh
petdex login                       # opens browser, OAuth + PKCE via Clerk
petdex list                        # browse approved pets
petdex install boba                 # drops boba into ~/.petdex/pets/boba/
petdex submit ~/.petdex/pets/boba   # share a single pet
petdex submit ~/.petdex/pets        # bulk submit every subfolder
petdex whoami                      # confirm signed-in identity
petdex logout                      # clear stored credentials
```

After installing a pet, pick the active mascot in Petdex Desktop: hover the pet and
press <kbd>Cmd</kbd>+<kbd>,</kbd> to open Settings.

## Desktop app

The floating mascot ships as the **Petdex desktop app**, not through this CLI. The app installs agent hooks from its Settings window (one click per agent) and updates itself. Download it at <https://petdex.dev/download>.

The `init`, `up`, `down`, `toggle`, `desktop`, `update`, `doctor`, and `hooks` commands were removed in v1.0.0; running them prints a pointer to the app.

## Commands

| Command | Description |
| --- | --- |
| `petdex login` | Authenticate via Clerk OAuth + PKCE (browser callback). Tokens stored in OS keychain. |
| `petdex logout` | Clear local credentials. |
| `petdex whoami` | Print the signed-in user's identity. |
| `petdex list` | List approved pets in the gallery. |
| `petdex install <slug>` | Install a pet into `~/.petdex/pets/<slug>/` and `~/.codex/pets/<slug>/`. |
| `petdex submit <path>` | Submit a pet folder, zip, or parent of pets (bulk). |
| `petdex edit <slug>` | Edit a pet you own (`--desc`, `--displayName`, `--sprite`, `--meta`, `--zip`). |
| `petdex telemetry [on\|off\|status]` | Manage anonymous usage telemetry. |
| `petdex --version` | Print the CLI version. |

## How `submit` works

The CLI accepts three input shapes:

```sh
petdex submit ~/.petdex/pets/boba      # single folder (must contain pet.json + spritesheet.{webp,png})
petdex submit ~/Downloads/boba.zip     # single zip with the same root layout
petdex submit ~/.petdex/pets           # parent folder: every subfolder containing pet.json is submitted
```

Per submission the CLI:

1. Builds a clean zip in memory from `pet.json` + `spritesheet.{webp,png}`.
2. Calls `POST /api/cli/submit` with a Clerk OAuth bearer to get presigned R2 PUT URLs (60s TTL).
3. PUTs the three files to Cloudflare R2 directly. No body passes through Petdex servers.
4. Calls `POST /api/cli/submit/register` to record the submission as `pending`. Identity comes from the verified token, never from the body.

A spinner shows progress per pet; a summary lists failures with reasons. Slugs auto-deduplicate (`boba` → `boba-2` → `boba-3` → …) so submissions never rebote on collisions.

## Validation rules

- `pet.json` and `spritesheet.webp` (or `.png`) must exist at the root.
- Spritesheet must be an 8x9 grid (**1536x1872**) or a v2 8x11 grid (**1536x2288**),
  or a clean scale of either. ChatGPT pet exports are already the v2 shape.
- Rate limit: **10 submissions / 24h** per user. Admins bypass.

## Configuration

Override the defaults with environment variables when pointing at a non-production deployment:

```sh
PETDEX_URL=https://your-host.example.com \
CLERK_ISSUER=https://clerk.your-host.example.com \
CLERK_OAUTH_CLIENT_ID=public_client_id \
petdex login
```

## Authentication details

- OAuth 2.0 Authorization Code with **PKCE** (S256). Public client, no secrets stored on your machine.
- Localhost callback on a random port (`http://127.0.0.1:0/callback`).
- Tokens stored in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service). Falls back to a `chmod 600` file if a keychain is unavailable.
- Access tokens auto-refresh using the stored refresh token; you stay signed in until you `petdex logout`.

The flow uses the [`@clerk/cli-auth`](https://github.com/Railly/clerk-cli-auth-example) reference implementation, vendored into this package.

## How to make a pet

This CLI distributes pets. It does not generate them.

**In the ChatGPT desktop app.** Type `/pet` and describe what you want, then submit
the folder it writes: `petdex submit ~/.codex/pets/<slug>`.

**From a ChatGPT pet export.** ChatGPT exports a 1536x2288 spritesheet, which is the
same atlas Petdex reads: nine state rows, matching frame counts. Download the PNG and
drop it on <https://petdex.dev/submit>. The grid is measured for you and the `pet.json`
the export omits is generated before you name it.

The full step-by-step (with tips on what makes a great pet) lives at <https://petdex.dev/create>.

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Not signed in` | No tokens or session expired | `petdex login` |
| `presign 401` | Bearer rejected by Clerk userinfo | `petdex logout && petdex login` |
| `presign 429` | 20 CLI presign requests/hour exceeded | Wait for the retry window and retry the command |
| `register 429` | 10 persisted submissions/24h exceeded | Wait 24h before submitting again |
| `register 400 invalid_spritesheet` | Not an 8x9 or 8x11 grid | Re-export at 1536x1872 or 1536x2288 |
| `register 400 missing_field` | Folder missing `pet.json` or `spritesheet.{webp,png}` | Inspect folder contents, re-export the pet if needed |
| `R2 PUT 403` | Presigned URL expired (60s TTL) | Retry the failed submission. CLI auto-presigns fresh URLs |

## Common install issues

The CLI is a single bundled JS file with no native dependencies.
install path is just `fetch a JSON manifest, write two files to
~/.petdex/pets/<slug>/`. Most "stuck" reports trace to one of these:

| Symptom | Cause | Fix |
| --- | --- | --- |
| Hangs at `Need to install the following packages: petdex@x` | `npx`'s own confirmation prompt, not a hang. Press `y` or auto-confirm | `npx -y petdex install <slug>` |
| `npm ERR! engine Unsupported engine` | Node < 20 | Upgrade Node to 20+ (`nvm install 20` is the easiest path) |
| `manifest fetch 5xx` / network timeout | Slow connection or corporate/national firewall blocking `petdex.dev` | Set a proxy: `HTTPS_PROXY=http://your.proxy:port npx petdex install <slug>` |
| `EACCES: permission denied … ~/.petdex/pets/` | Pets dir owned by another user | `sudo chown -R "$USER" ~/.petdex` or remove the dir and retry |
| Windows: `'sh' is not recognized` | CLI version older than 0.1.1 piped through `curl … \| sh` | Upgrade: `npm i -g petdex@latest` or `npx petdex@latest install <slug>` |

The CLI bundles `@clack/prompts`, `picocolors`, and `jszip` into the
shipped JS. There is no separate dependency-install step on your
machine. If something appears to be stuck on "installing
dependencies", it's almost always npm's own progress bar for the
`petdex` package itself, not a sub-dependency tree.

## License

MIT, same as the [Petdex repo](https://github.com/crafter-station/petdex).
