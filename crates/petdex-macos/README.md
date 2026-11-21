# petdex-macos

Native macOS animated desktop pet app for Petdex built with Swift, AppKit (`NSPanel`), `ImageIO`, and `QuartzCore`/`CoreGraphics`, linked directly against `petdex-core` over the C-ABI (`crates/petdex-core/include/petdex_core.h`).

## Architecture

- `PetdexFloatingPanel`: borderless, draggable `NSPanel` using `.nonactivatingPanel`, `.canJoinAllSpaces`, and `isMovableByWindowBackground = true` so the pet floats across Spaces without stealing focus.
- `PetSpriteAtlas` and `PetCatalog`: discovers installed pets in `~/.petdex/pets` and `~/.codex/pets` (directories containing `spritesheet.webp`), decodes WebP natively via macOS `ImageIO` (`CGImageSourceCreateWithURL` / `CGImageSourceCreateImageAtIndex`), and slices the 8-column by 9-row atlas into cached `CGImage` frames.
- `PetdexSpriteCanvasView`: transparent `CALayer`-backed `NSView` driving `petdex_engine_tick_ms` at 60Hz, rendering each frame with nearest-neighbor scaling (`interpolationQuality = .none`, `magnificationFilter = .nearest`) for crisp Retina pixel art, with a drawn Petdex cobalt tactile squircle fallback when no pet spritesheet is loaded.
- `PetdexAppDelegate`: provides an `NSStatusItem` menubar tray and right-click context menu with live **Pets** switching, state controls, and panel toggling.
- `CPetdexCore`: Swift Package C bridge module importing `crates/petdex-core/include/petdex_core.h`.

## Build

1. Build the Rust static library first:

```sh
cd ../petdex-core
cargo build --release
```

2. Build the macOS Swift package:

```sh
cd ../petdex-macos
swift build
```

## Run

Run with a specific installed pet using `PETDEX_PET` (defaults to `boba` if installed, otherwise the first discovered pet in `~/.petdex/pets` or `~/.codex/pets`, otherwise the built-in cobalt squircle fallback):

```sh
PETDEX_PET=boba swift run
```
