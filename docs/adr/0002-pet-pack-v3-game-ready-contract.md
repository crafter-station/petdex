---
status: accepted
date: 2026-11-21
---

# Pet Pack v3 Game-Ready Contract and License Gate

## Context

Petdex ships desktop companion pets as folders containing `pet.json` and a spritesheet atlas (v1: 8x9 grid of 192x208 frames at 1536x1872; v2: 8x11 grid of 192x208 frames at 1536x2288) with nine canonical animation states defined in `packages/petdex-desktop-native/src/sprite.zig` and `src/lib/pet-states.ts`: `idle`, `running-right`, `running-left`, `waving`, `jumping`, `failed`, `waiting`, `running`, and `review`.

While the Petdex repository code is MIT-licensed, pet artwork belongs to its creators. Every row in `submitted_pets` (`src/lib/db/schema.ts`) carries an explicit `pet_license` enum (`unspecified`, `cc0`, `cc-by`, `cc-by-sa`, `cc-by-nc`, `all-rights-reserved`), defaulting to `unspecified` when a creator has not declared terms.

As `crafter-games/petdex-brawl` and future mini-games begin consuming Petdex catalog packs, two gaps must be closed before any game ingests community pets:

1. v2 packs describe sprite layout and playback timing, but lack optional game physics and fighter metadata (`hitbox`, `anchor`, and bounded fighter `stats`).
2. Downstream games need a single fail-closed license gate so creator rights are never violated by importing `unspecified`, `cc-by-nc`, or `all-rights-reserved` artwork.

## Decision

We introduce **Pet Pack v3** (`schemaVersion: 3`), formalized in `src/lib/pet-pack-v3.ts`, as a backward-compatible extension of v2 atlases:

- **Atlas compatibility**: v3 preserves the 192x208 canonical frame grid (and integer-scaled equivalents) and the nine canonical animation state names (`idle`, `running-right`, `running-left`, `waving`, `jumping`, `failed`, `waiting`, `running`, `review`), validating that frame dimensions divide the atlas cleanly and that every declared state fits within the grid.
- **Optional `game` block**: packs may attach optional `game` metadata containing:
  - `hitbox`: pixel rectangle (`x`, `y`, `width`, `height`) bounded within a single frame (`frameWidth` x `frameHeight`).
  - `anchor`: normalized pivot point (`x`, `y` in `[0, 1]`).
  - `stats`: integer fighter attributes (`hp`, `attack`, `defense`, `speed`) each clamped to `1..100`.
- **Optional `sound` block**: packs may reference an audio cue URL and normalized `volume` (`0..1`).
- **Mandatory explicit `license` field and fail-closed gate**: every v3 pack must declare one of the six `pet_license` values from `src/lib/db/schema.ts`. Derivative games must gate ingestion through `isGameDerivatableLicense` and `assertGameEligiblePetPack`:
  - **Allowed**: `cc0`, `cc-by`, `cc-by-sa`.
  - **Blocked by default**: `unspecified`, `cc-by-nc`, `all-rights-reserved`.
  - **Attribution tracking**: `assertGameEligiblePetPack` returns a typed receipt setting `requiresAttribution: true` for `cc-by` and `cc-by-sa`, and `requiresShareAlike: true` for `cc-by-sa`, so games surface mandatory creator credit.

## Considered Options

- **Allow `unspecified` packs with an opt-out list**: rejected because `unspecified` means the creator never granted derivative rights; defaulting to inclusion violates creator trust and copyright.
- **Allow `cc-by-nc` in free mini-games**: rejected because future monetization, sponsorships, or commercial distribution of mini-games would silently breach non-commercial terms.
- **Mandatory explicit license gate with optional `game` metadata (chosen)**: keeps v2 atlases trivially upgradable to v3 without re-exporting spritesheets while enforcing creator art rights at the schema and runtime boundary.

## Consequences

- Existing v1/v2 spritesheets remain valid in v3 packs with zero pixel re-authoring; creators or curators only add `schemaVersion: 3`, explicit `license`, and optional `game` metadata.
- `crafter-games/petdex-brawl` and future mini-games must validate manifests with `parsePetPackV3` and pass `assertGameEligiblePetPack` before loading any community pet.
- Pets with `unspecified`, `cc-by-nc`, or `all-rights-reserved` licenses stay visible in the Petdex desktop catalog but are excluded from derivative game pools unless the creator explicitly updates their license.
- Games consuming `cc-by` or `cc-by-sa` pets must render creator attribution whenever `requiresAttribution` is `true`, and comply with share-alike obligations when `requiresShareAlike` is `true`.
