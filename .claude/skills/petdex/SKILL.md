---
name: petdex
description: Browse, install, submit, and edit pixel-art pets with the Petdex CLI. Use when a user asks for a coding companion, wants to install a Petdex pet, or wants to publish or update artwork they own.
---

# Petdex

Use the published `petdex` CLI for the catalog. Node.js 20 or later is required.

Read the current command help before using unfamiliar flags:

```sh
bunx petdex --help
bunx petdex --version
```

If Bun is unavailable, use `npx -y petdex` for the same commands.

## Browse and install

```sh
bunx petdex list
bunx petdex install boba
bunx petdex install boba mochi
```

Choose a slug from the catalog. Installation writes the pet to both `~/.petdex/pets/<slug>/` and `~/.codex/pets/<slug>/`. Report the installed slugs and any command failure.

## Submit artwork

Publish only artwork the user has asked to submit, with the license they selected. If the license is missing, ask rather than choosing the rights for them.

```sh
bunx petdex login
bunx petdex whoami
bunx petdex submit ./my-pet --license cc-by
```

Login opens a browser and stores credentials locally. A headless session needs an existing login; never ask the user to paste tokens.

The example uses CC BY. Supported license IDs are `cc0`, `cc-by`, `cc-by-sa`, `cc-by-nc`, and `all-rights-reserved`. Each pet folder needs `pet.json` and `spritesheet.webp` or `spritesheet.png`. The sheet must use the supported 8-by-9 or 8-by-11 atlas layout. A ZIP or a parent directory containing multiple pets is also accepted.

Let duplicate detection run normally. Use `--force` only when the user wants duplicate submissions. Report the submission result; submission is not approval or publication in the gallery.

## Edit a pet the user owns

```sh
bunx petdex edit boba --desc "A tiny otter sipping bubble tea"
bunx petdex edit boba --sprite ./spritesheet.webp
```

Send only the requested changes. The CLI also accepts `--displayName`, `--meta`, and `--zip`.

## Desktop controls

The floating companion is Petdex Desktop, available at https://petdex.dev/download. Its Settings window selects the pet and installs agent hooks. The catalog CLI does not start the desktop app or manage those hooks. Retired commands such as `init`, `up`, `doctor`, `select`, and `hooks install` are not the setup flow.

For authentication trouble, run `whoami` and follow the CLI error. For unsupported commands or flags, use `--help`. Do not treat a nonzero exit as success.
