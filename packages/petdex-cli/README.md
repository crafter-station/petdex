# @petdex/cli

Upload local Codex pet characters from `~/.codex/pets` to Petdex.

```bash
PETDEX_TOKEN=... npx @petdex/cli upload
```

The CLI scans `~/.codex/pets`, shows a numbered selection, validates
`pet.json` and `spritesheet.webp`, builds a ZIP, and submits the selected
characters to `/api/cli/submit`.

## Options

```bash
petdex upload --url https://petdex.crafter.run
petdex upload --dir ~/.codex/pets --pet paperclip
petdex upload --all --yes
petdex list
```

Environment variables:

- `PETDEX_TOKEN`: upload token expected by the Petdex server
- `PETDEX_URL`: Petdex site URL, defaults to `https://petdex.crafter.run`
- `PETDEX_PETS_DIR`: pets directory, defaults to `~/.codex/pets`
- `PETDEX_OWNER_EMAIL`: optional email attached to the submission
