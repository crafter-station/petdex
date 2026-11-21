---
status: accepted
date: 2026-11-21
---

# Desktop Full-Native Architecture with Shared Rust Core

We are migrating Petdex Desktop from a monolithic Zig/Native SDK package (`packages/petdex-desktop-native`, 26.5k LOC plus five local SDK patches pinned to `Railly/native@c0b10d0`) to a shared Rust core (`crates/petdex-core`) paired with 100% native OS shells: Swift/AppKit + SwiftUI + Metal on macOS, and Rust + `windows-rs` + DirectComposition/Direct2D on Windows.

## Considered Options

- **Keep Native SDK (Zig) and upstream the five patches**: keeps a single codebase across macOS, Windows, and Linux, but leaves Windows parity (`gpu_surface_scroll_drivers`, `view_surface_adoption`) and macOS packaging (`headerpad`, activation) coupled to upstream SDK churn.
- **Shared Rust core + native OS shells (chosen)**: isolates hook server, durable session reconciliation, agent adapters, sprite decoding, and SSH tunneling inside one tested Rust core exposed over C-ABI/UniFFI, while giving macOS and Windows first-class native windowing, transparency, tray, and settings UI.
- **Pure Rust cross-platform UI**: single language, but native settings ergonomics and accessibility lag behind AppKit/SwiftUI and Win32/WinUI.

## Consequences

- Migration happens incrementally: `crates/petdex-core` is extracted and verified against existing `session-reconcile` fixtures before replacing platform shells.
- `packages/petdex-desktop-native` remains the shipping release path until the macOS and Windows native shells reach feature parity.
- The Rust core also serves as the shared foundation for future Petdex games and desktop interactive modes.
