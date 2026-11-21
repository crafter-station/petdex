# Petdex Scripts Inventory

Practical inventory of the 77 TypeScript scripts and 8 shell scripts in `scripts/`.
Run TypeScript scripts with `bun` (never `npm`), and prefer the `package.json` entrypoints when available.

## 1. Active Dev & CI Scripts (referenced in `package.json`)

| Script | `package.json` Command | Purpose |
| --- | --- | --- |
| `dev-docker.ts` | `bun run dev:docker` | Start local Postgres/Redis via Docker or Podman for development. |
| `dev-mock.ts` | `bun run dev:mock` | Start local dev server with mocked external dependencies. |
| `seed-dev.ts` | `bun run seed:dev` | Seed local development database with sample data. |
| `write-build-version.ts` | `bun run build` | Generate build version metadata before `next build`. |
| `install-git-hooks.sh` | `bun run hooks:install` | Install local git hooks. |
| `pre-commit-hook-self-test.sh` | `bun run hooks:test` | Self-test the pre-commit hook behavior. |
| `i18n-check.ts` | `bun run i18n:check` | Validate i18n translation keys across locales in CI. |
| `vercel-cost-report.ts` | `bun run cost:report` | Report Vercel usage and route cost metrics. |
| `apply-route-cost-buckets.ts` | `bun run cost:apply-route-buckets` | Apply route cost bucket classification (also listed under active cost ops). |
| `auto-tag.ts` | `bun run auto-tag` | Run automated tagging across pet entries. |
| `build-version.ts` | (imported by `write-build-version.ts`) | Shared build version helper. |
| `env.ts` | (imported by scripts) | Shared environment loader for standalone scripts. |

## 2. Asset, Snapshot & Desktop Pipelines

### Asset & Snapshot Publishers

| Script | `package.json` Command | Purpose |
| --- | --- | --- |
| `generate-assets.ts` | `bun run generate-assets` | Generate static pet and site assets. |
| `publish-manifest-snapshots.ts` | `manifest:snapshot:check` / `apply` | Check or publish manifest snapshots to storage. |
| `publish-pet-thumbnails.ts` | `thumbs:snapshot:check` / `apply` | Check or publish pet thumbnail snapshots. |
| `publish-pet-previews.ts` | `previews:snapshot:check` / `apply` | Check or publish pet preview snapshots. |
| `publish-pet-sticker-artifacts.ts` | `stickers:snapshot:check` / `apply` | Check or publish pet sticker artifact snapshots. |
| `render-pet-sticker-review.ts` | `bun run stickers:review` | Render sticker review previews for QA. |
| `audit-pet-atlases.ts` | `bun run audit:pet-atlases` | Audit sprite atlas dimensions, grids, and integrity. |
| `audit-pet-atlases.test.ts` | `bun run test` | Unit tests for `audit-pet-atlases.ts`. |
| `generate-announcement-banner.ts` | (manual) | Generate announcement banner artwork. |
| `generate-discord-icon.ts` | (manual) | Generate Discord server icon assets. |
| `generate-pet-sounds.ts` | (manual) | Generate pet sound assets. |
| `minimax-image-generation.ts` | (manual / helper) | Minimax image generation client helper. |
| `minimax-image-generation.test.ts` | `bun run test` | Unit tests for `minimax-image-generation.ts`. |

### Desktop & macOS Packaging

| Script | `package.json` Command | Purpose |
| --- | --- | --- |
| `release-desktop.ts` | `bun run release:desktop` | Orchestrate desktop app release packaging and publishing. |
| `build-macos-swift-app.sh` | (invoked by release/dev) | Build the macOS Swift desktop app bundle. |
| `macos-dev-app.sh` | (manual) | Launch local macOS desktop dev build. |
| `macos-dev-restart.sh` | (manual) | Rebuild and restart local macOS desktop dev build. |
| `patch-native-packager.sh` | (manual / build) | Patch native desktop packager configuration. |
| `patch-native-sdk.sh` | (manual / build) | Patch Native SDK integration for desktop builds. |
| `sign-macos.sh` | (invoked by release) | Code-sign and notarize macOS app artifacts. |

## 3. Historical One-Off DB Migrations & Backfills

WARNING: The scripts below were executed as one-off schema migrations, data backfills, or incident fixes. Do not re-run them blindly against production. Inspect the script and target database state before running anything here.

### One-Off Schema & Feature Migrations (`apply-*`)

- `apply-add-color-columns.ts`
- `apply-add-preferred-locale.ts`
- `apply-add-sound-url.ts`
- `apply-email-campaign-desktop-launch.ts`
- `apply-email-preferences.ts`
- `apply-feedback-status.ts`
- `apply-feedback-threads.ts`
- `apply-gallery-position.ts`
- `apply-manifest-fetches.ts`
- `apply-multi-pin.ts`
- `apply-notifications.ts`
- `apply-pending-edits.ts`
- `apply-pet-collection-requests.ts`
- `apply-pet-request-candidates.ts`
- `apply-pet-source.ts`
- `apply-request-fulfilled-kind.ts`
- `apply-sprite-version-number.ts`
- `apply-sticker-exports.ts`
- `apply-telemetry-events.ts`
- `apply-user-profiles.ts`

### One-Off Data Backfills (`backfill-*`)

- `backfill-clerk-usernames.ts`
- `backfill-color.ts`
- `backfill-credits-from-clerk.ts`
- `backfill-credits.ts`
- `backfill-email-preferences-from-clerk.ts`
- `backfill-email-prefs.ts`
- `backfill-metrics.ts`
- `backfill-sprite-version-number.ts`

### One-Off Fixes (`fix-*`)

- `fix-shrimpy-issue-81.ts`

## 4. Operational, Moderation & Catalog Maintenance Scripts

Run manually only when performing targeted admin, moderation, catalog curation, or recovery operations:

- **Moderation & Review**: `admin-import-pet.ts`, `audit-pet-security.ts`, `review-pending-submissions.ts`, `takedown-by-keyword.ts`, `takedown-pet.ts`
- **Recovery & Relinking**: `gc-pending-r2.ts`, `reassign-rescued-pets.ts`, `relink-by-email.ts`, `relink-rescued-owners.ts`, `rescue-failed-submissions.ts`, `revive-rejected-pets.ts`
- **Catalog Classification & Similarity**: `classify-unflagged-pets.ts`, `classify-unknown-franchises.ts`, `compute-similarity.ts`, `extract-franchises.ts`, `merge-classifications.ts`, `normalize-franchises.ts`, `split-large-categories.ts`
- **Collections & Campaigns**: `process-pending-collection-requests.ts`, `reorganize-collections.ts`, `seed-all-collections.ts`, `seed-curated-collections.ts`, `seed-themed-collections.ts`, `send-desktop-launch-test.ts`
