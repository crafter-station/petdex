# petdex-macos

Native macOS desktop shell scaffold for Petdex built with Swift, AppKit (`NSPanel`), and Metal (`CAMetalLayer`), linked directly against `petdex-core` over the C-ABI (`crates/petdex-core/include/petdex_core.h`).

## Architecture

- `PetdexFloatingPanel`: borderless `NSPanel` using `.nonactivatingPanel` and `.canJoinAllSpaces` so the pet stays visible across Spaces without stealing focus from terminals or editors.
- `PetdexMetalCanvasView`: transparent `CAMetalLayer`-backed `NSView` driving `petdex_engine_new`, `petdex_engine_ingest_status`, `petdex_engine_tick_ms`, and `petdex_engine_free`.
- `CPetdexCore`: Swift Package C bridge module importing `crates/petdex-core/include/petdex_core.h`.

## Build

1. Build the Rust static/dynamic library first:

```sh
cd ../petdex-core
cargo build --release
```

2. Build the macOS Swift package:

```sh
cd ../petdex-macos
swift build
```
