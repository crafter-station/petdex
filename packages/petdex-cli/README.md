# petdex

The Petdex CLI: browse, install, and submit animated pets for [OpenAI Codex](https://openai.com/codex) from your terminal.

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
petdex install boba                # drops boba into ~/.codex/pets/boba/
petdex select                      # pick active mascot from installed pets (interactive)
petdex select boba                 # set active mascot directly
petdex submit ~/.codex/pets/boba   # share a single pet
petdex submit ~/.codex/pets        # bulk submit every subfolder
petdex whoami                      # confirm signed-in identity
petdex logout                      # clear stored credentials
```

After installing a pet, set it as active with `petdex select` or inside Codex: **Settings → Appearance → Pets → Select**. Use `/pet` inside Codex to wake or tuck it away.

## Commands

| Command | Description |
| --- | --- |
| `petdex login` | Authenticate via Clerk OAuth + PKCE (browser callback). Tokens stored in OS keychain. |
| `petdex logout` | Clear local credentials. |
| `petdex whoami` | Print the signed-in user's identity. |
| `petdex list` | List approved pets in the gallery. |
| `petdex install <slug>` | Install a pet into `~/.codex/pets/<slug>/` and `~/.petdex/pets/<slug>/`. |
| `petdex select [slug]` | Set the active pet shown by Petdex Desktop. No args = interactive picker; pass a slug to skip the prompt. |
| `petdex submit <path>` | Submit a pet folder, zip, or parent of pets (bulk). |
| `petdex --version` | Print the CLI version. |

## How `submit` works

The CLI accepts three input shapes:

```sh
petdex submit ~/.codex/pets/boba       # single folder (must contain pet.json + spritesheet.{webp,png})
petdex submit ~/Downloads/boba.zip     # single zip with the same root layout
petdex submit ~/.codex/pets            # parent folder: every subfolder containing pet.json is submitted
```

Per submission the CLI:

1. Builds a clean zip in memory from `pet.json` + `spritesheet.{webp,png}`.
2. Calls `POST /api/cli/submit` with a Clerk OAuth bearer to get presigned R2 PUT URLs (60s TTL).
3. PUTs the three files to Cloudflare R2 directly. No body passes through Petdex servers.
4. Calls `POST /api/cli/submit/register` to record the submission as `pending`. Identity comes from the verified token, never from the body.

A spinner shows progress per pet; a summary lists failures with reasons. Slugs auto-deduplicate (`boba` → `boba-2` → `boba-3` → …) so submissions never rebote on collisions.

## Validation rules

- `pet.json` and `spritesheet.webp` (or `.png`) must exist at the root.
- Spritesheet ≥ 256×256. Recommended **1536×1872** (8×9 frame grid).
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

## How to make a pet (creation lives inside Codex)

This CLI distributes pets. It does not generate them. To create one:

1. Open the **Codex desktop app** (download at <https://openai.com/codex>).
2. Go to **Skills** in the top navbar → install **Hatch Pet**.
3. In a Codex chat, type `/pet` and describe what you want (e.g. *"a tiny otter sipping bubble tea"*).
4. Codex generates the spritesheet and animations into `~/.codex/pets/<slug>/`.
5. Submit it: `petdex submit ~/.codex/pets/<slug>`.

The full step-by-step (with tips on what makes a great pet) lives at <https://petdex.dev/create>.

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Not signed in` | No tokens or session expired | `petdex login` |
| `presign 401` | Bearer rejected by Clerk userinfo | `petdex logout && petdex login` |
| `presign 429` | 10/24h rate limit hit | Wait 24h or open a [submit-fallback issue](https://github.com/crafter-station/petdex/issues/new?labels=submit-fallback) |
| `register 400 invalid_spritesheet` | Sprite < 256×256 | Regenerate with bigger dims (recommend 1536×1872) |
| `register 400 missing_field` | Folder missing `pet.json` or `spritesheet.{webp,png}` | Inspect folder contents, re-export from Codex if needed |
| `R2 PUT 403` | Presigned URL expired (60s TTL) | Retry the failed submission. CLI auto-presigns fresh URLs |

## Common install issues

The CLI is a single bundled JS file with no native dependencies.
install path is just `fetch a JSON manifest, write two files to
~/.codex/pets/<slug>/`. Most "stuck" reports trace to one of these:

| Symptom | Cause | Fix |
| --- | --- | --- |
| Hangs at `Need to install the following packages: petdex@x` | `npx`'s own confirmation prompt, not a hang. Press `y` or auto-confirm | `npx -y petdex install <slug>` |
| `npm ERR! engine Unsupported engine` | Node < 20 | Upgrade Node to 20+ (`nvm install 20` is the easiest path) |
| `manifest fetch 5xx` / network timeout | Slow connection or corporate/national firewall blocking `petdex.dev` | Set a proxy: `HTTPS_PROXY=http://your.proxy:port npx petdex install <slug>` |
| `EACCES: permission denied … ~/.codex/pets/` | Pets dir owned by another user | `sudo chown -R "$USER" ~/.codex` or remove the dir and retry |
| Windows: `'sh' is not recognized` | CLI version older than 0.1.1 piped through `curl … \| sh` | Upgrade: `npm i -g petdex@latest` or `npx petdex@latest install <slug>` |

The CLI bundles `@clack/prompts`, `picocolors`, and `jszip` into the
shipped JS. There is no separate dependency-install step on your
machine. If something appears to be stuck on "installing
dependencies", it's almost always npm's own progress bar for the
`petdex` package itself, not a sub-dependency tree.

## License

MIT, same as the [Petdex repo](https://github.com/crafter-station/petdex).
