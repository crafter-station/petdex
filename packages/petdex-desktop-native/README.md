# petdex-desktop-native

Petdex on Native SDK (vercel-labs/native): no WebView, no Node sidecar.
Rewrite slice 1; strategy: upstream-first on latest Native SDK, no maintained fork.

## V1 (this package)

Runtime-loaded pet animating its real atlas in a chromeless window:
- Scans `~/.petdex/pets` + `~/.codex/pets` (`PETDEX_PET=<dir>` overrides).
- Canonical state table ported from the WebView renderer (9 states,
  per-frame durations, idle's irregular blink timing).
- App-side atlas decode (registry caps one image at 1MB pixels and the
  platform decode scratch at 1.25MB, so full sheets can't ride
  `registerImageBytes`): V1 uses a macOS dev shim (`sips` -> TGA -> Zig
  TGA parser); V5 replaces it with vendored libwebp on all platforms.
- Frames registered per state into slots 1..8, replaced in place.
- Space or `native automate native-command petdex.cycle` cycles states.

## Build & run

```bash
native build -Dautomation
PETDEX_PET=boba ./zig-out/bin/petdex-desktop-native
native automate screenshot pet-canvas
```

Requires the `@native-sdk/cli` global (`bun add -g @native-sdk/cli`).
