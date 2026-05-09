# petdex-desktop

Floating, draggable, transparent pet companion that lives on your desktop.

Same idea as the Codex Desktop pet, but available to any agent and any
workflow because it does not depend on Codex Desktop being open. The window
is frameless, transparent, and always-on-top, rendering whatever pet is
already installed in `~/.codex/pets/`.

Built on a fork of `vercel-labs/zero-native` that exposes `frameless`,
`transparent`, and `always_on_top` window options. The fork is at
`Railly/zero-native` on the `feature/window-resize` branch (which
builds on `feature/floating-window`, the upstream PR in review). The
diff is upstreamable as a single PR.

## Build

The build needs a local checkout of zero-native. Resolution order:

1. `-Dzero-native-path=<path>` cli flag
2. `ZERO_NATIVE_PATH` environment variable
3. `../../zero-native` relative to this build.zig (sibling of the
   petdex repo, common dev layout)

If none of those resolve to an existing directory, the build panics
with the command you need to run.

```bash
# Common case: clone zero-native next to petdex
git clone --branch feature/window-resize \
  https://github.com/Railly/zero-native.git ../../zero-native

cd packages/petdex-desktop
zig build
./zig-out/bin/petdex-desktop
```

Or pass the path explicitly:

```bash
zig build -Dzero-native-path=/absolute/path/to/zero-native/
# or
ZERO_NATIVE_PATH=/absolute/path/to/zero-native/ zig build
```

You need:

- macOS (Linux/Windows not wired up yet)
- Zig 0.16
- At least one pet installed under `~/.petdex/pets/<slug>/` or
  `~/.codex/pets/<slug>/` (run `npx petdex install boba` if you don't
  have any yet)

## How it works

1. On launch, the binary scans `~/.codex/pets/`, picks the first pet, reads
   its `spritesheet.webp` (or `.png`).
2. The bytes are base64-encoded and inlined into a self-contained HTML
   document with a CSS `steps()` animation matching the petdex web app
   (idle row, 6 frames, 1100ms loop, 192x208 frame at 0.7 scale).
3. The HTML is loaded into a `WKWebView` hosted by a frameless transparent
   floating `NSWindow`. The whole window is drag-anywhere thanks to
   `-webkit-app-region: drag` on the stage.

No daemon, no MCP server, no IPC. v0 is "render the first installed pet".
Reactive states (idle / thinking / celebrate via file watchers or MCP) are
follow-up work, not in v0.

## Files

```
packages/petdex-desktop/
  app.zon          manifest with frameless+transparent+always_on_top
  build.zig        zero-native build pipeline (points to local fork)
  build.zig.zon    Zig package manifest
  src/
    main.zig       loads first pet, builds inline HTML, runs the app
    runner.zig     standard zero-native runner with main_window pass-through
  assets/
    icon.icns      app icon
```

## Known limitations (v0)

- macOS only. Linux/Windows would need similar GTK/Win32 work in the fork.
- Always renders idle. No state changes, no agent integration yet.
- Hardcoded 192x208 frame size and idle animation params (matches current
  petdex web app constants, not read from `pet.json`).
- No quit menu. Use `cmd+Q` or `kill <pid>`.
- Picks the first directory in `~/.codex/pets/` alphabetically. No pet
  picker yet.

## Roadmap

- [ ] Right-click menu: change pet, hide, quit.
- [ ] Read frame size and animation rows from a richer `pet.json` schema
      (collaborate with petdex web on the schema bump).
- [ ] Agent state via local HTTP endpoint or MCP server: idle, thinking,
      celebrating, error.
- [ ] File-watcher mode: watch `~/.codex/sessions/`, `~/.claude/projects/`,
      etc. and infer state from agent activity.
- [ ] Bundle as `.app` with `accessory` activation policy (no dock icon)
      via the zero-native packaging tool.

## Upstream

The three new window options (`frameless`, `transparent`, `always_on_top`)
need to be merged upstream to `vercel-labs/zero-native`. Branch
`feature/floating-window` on `Railly/zero-native`. Until that lands,
`build.zig` points at the local fork.
