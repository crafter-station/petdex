# Petdex Documentation

Repository map and engineering documentation for `crafter-station/petdex` (`https://petdex.dev`), created by Railly Hugo at Crafter Station.

## Repository Structure

| Path | Purpose |
|---|---|
| `src/` | Next.js 16 web application (`en`/`es`/`zh`), 56 API routes, Pocket Toy + `@ui-sdk/react` design system, and domain modules |
| `crates/petdex-core/` | Pure-Rust shared desktop core (9-state animation engine, multi-session attention coordinator, loopback `:7777` hook server, durable session reconciliation, hook installer, C-ABI FFI) |
| `crates/petdex-macos/` | Native macOS app (`Petdex.app`): Swift/AppKit `NSPanel`, `ImageIO` WebP sprite renderer, spring 3D bubble deck, SwiftUI Settings, live catalog browser, `petdex://` URL scheme |
| `crates/petdex-windows/` | Native Windows app (`petdex-windows.exe`): pure-Rust WebP decoder, Win32 `UpdateLayeredWindow` per-pixel alpha rendering, pearl bubble overlay, system tray |
| `packages/petdex-cli/` | Published npm CLI (`npx petdex install <slug>`) |
| `packages/discord-bot/` | Discord community bot |
| `packages/petdex-desktop-native/` | Legacy Zig/Native SDK desktop app (maintained until Rust/Swift/Win32 reaches full release cutover) |
| `drizzle/` | PostgreSQL / Neon SQL migrations |
| `workers/` | Cloudflare Worker assets proxy (`wrangler.petdex-assets.toml`) |
| `scripts/` | Dev, CI, asset/snapshot, and release scripts (see [scripts/README.md](../scripts/README.md)) |

## Domain & Architecture

- [CONTEXT-MAP.md](../CONTEXT-MAP.md): Bounded contexts and relationships
- [CONTEXT.md](../CONTEXT.md): Ubiquitous language glossary
- [docs/adr/0001-desktop-native-rust-core.md](adr/0001-desktop-native-rust-core.md): Full-native desktop architecture (`petdex-core` + Swift macOS + Rust Win32)
- [docs/adr/0002-pet-pack-v3-game-ready-contract.md](adr/0002-pet-pack-v3-game-ready-contract.md): Pet Pack v3 schema and fail-closed `pet_license` gate

## Technical References

- [docs/agent-adapters-research.md](agent-adapters-research.md): Coding agent hook & session store contracts
- [docs/chatgpt-pet-integration.md](chatgpt-pet-integration.md): `codex://pets/install` protocol notes
- [docs/cost-sweep-2026-06.md](cost-sweep-2026-06.md): Infrastructure cost audit
- [docs/discord/SETUP.md](discord/SETUP.md): Discord server template & setup
- [docs/archive/](archive/): Completed historical plans and superseded migration notes
