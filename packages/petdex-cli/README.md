# @petdex/cli

Upload local Codex pet characters from `~/.codex/pets` to Petdex.

```bash
npx @petdex/cli login
npx @petdex/cli install boba
npx @petdex/cli upload
```

The CLI scans `~/.codex/pets`, shows a numbered selection, validates
`pet.json` and `spritesheet.webp`, builds a ZIP, and submits the selected
characters to `/api/cli/submit`. Login opens Petdex in your browser, completes
Clerk authentication there, and sends a CLI token back through a localhost
callback.

`petdex install <slug>` installs an approved Petdex pet into `~/.codex/pets`
using the same installer script shown on pet pages. Run `petdex install` with no
slug to choose from the Petdex manifest.

## Options

```bash
petdex login --url https://petdex.crafter.run
petdex install boba
petdex install
petdex upload --url https://petdex.crafter.run
petdex upload --dir ~/.codex/pets --pet paperclip
petdex upload --all --yes
petdex whoami
petdex logout
petdex list
```

Environment variables:

- `PETDEX_TOKEN`: optional upload token override for automation
- `PETDEX_URL`: Petdex site URL, defaults to `https://petdex.crafter.run`
- `PETDEX_PETS_DIR`: pets directory, defaults to `~/.codex/pets`
- `PETDEX_OWNER_EMAIL`: optional email attached to the submission
