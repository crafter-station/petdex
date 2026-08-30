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

## Durable session recovery

Installed hooks remain the low-latency path for every supported agent. Local,
read-only durable recovery is enabled only for formats backed by
provider-owned artifacts and adapter-specific fixture/test evidence: Codex
rollouts, Claude transcripts, Gemini chats, OMP session logs, and Hermes
`state.db`. OpenCode, Qoder, Kimi Code, and CodeBuddy remain hook-supported,
but their stores have no stable evidenced contract here; durable recovery
fails closed instead of guessing a session from unrelated data.

Recovery scans are bounded and remain the source of truth. Native directory
notifications are coalesced hints, with a periodic polling sweep covering
dropped events and backend failure. Only relevant durable roots are watched,
including configured `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, and
`HERMES_HOME` locations.

## Native session bubbles

Concurrent agent sessions render as a bounded native card stack. Presentation
updates are content- and geometry-deduplicated so a settled stack stops
submitting work, while authored running animations remain responsive. Cards
carry allowlisted agent, host, project, status, and subagent metadata and expose
native accessibility roles and labels.

The action rail supports opening the originating application when it can be
identified safely, pinning a session, showing subagents, and dismissing a
completed card. Legacy hook payloads continue to render through the canonical
session contract.

For the pinned desktop build, set `NATIVE_CLI` and `NATIVE_SDK_PATH` to the
CLI and SDK checkout used by the matching release workflow. The build scripts
apply the Petdex-owned macOS, Linux, Windows, and shared runtime patches before
compiling; they fail if the SDK source no longer matches the pinned patches.

## Linux desktop smoke

The Linux harness launches the exact built ELF in a fresh mode-700 home and
runtime directory, a private D-Bus session, and a composited Xvfb display. It
verifies that the ELF, process, D-Bus owner, `/whoami`, and port-7777 listener
all identify the same process. It never prints or stores the hook update token.

Generate the repository-local deterministic pet fixture before the runtime scenario, then run:

```bash
python3 tests/linux_smoke_fixture.py --dest .zig-cache/linux-smoke-fixture
sh tests/linux_desktop_smoke.sh --self-test
sh tests/linux_desktop_smoke.sh \
  --scenario idle \
  --artifacts .zig-cache/linux-smoke-idle \
  --fixture .zig-cache/linux-smoke-fixture
sh tests/linux_desktop_smoke.sh \
  --scenario bubble \
  --artifacts .zig-cache/linux-smoke-bubble \
  --fixture .zig-cache/linux-smoke-fixture
sh tests/linux_desktop_smoke.sh \
  --scenario interaction \
  --artifacts .zig-cache/linux-smoke-interaction \
  --fixture .zig-cache/linux-smoke-fixture
sh tests/linux_perf_smoke.sh --quick
```

`interaction` adds real X11 pointer input, while `perf` records bounded process
samples (`--duration` defaults to 10 seconds). The performance wrapper covers
idle, settled static, busy/shimmer, and rapid update/hover workloads; its long
`--soak SECONDS` form limits the soak to settled idle/static states. RSS,
thread, and file-descriptor growth are bounded for every workload. The
deterministic Xvfb/cairo idle and static profiles also use a generous 35%
cumulative-CPU ceiling to catch presentation loops; busy/rapid work is excluded
because its authored software-rendering load is machine-specific. The harness
fails rather than reusing an existing port-7777 listener or silently running
without a compositor.

Bubble cards on Linux use the portable UI library's panels, text, icons, and
buttons with semantic solid/translucent fills and no Liquid Glass/backdrop blur.
The same bounded presentation snapshot also retains GTK-native keyboard and
assistive-technology controls. Those controls stay pointer-transparent until
focus paints the platform theme's focus-visible affordance, so Wayland never
depends on global cursor polling and an invisible action rail cannot steal a
click from the canvas or an application underneath a transparent gap. The GTK
bridge has shared-model, serialization, pinned-patch, and cross-compile
coverage. Real Orca/Accerciser traversal and activation remain manual release
checks. X11 origin activation is likewise cross-compiled, not proven against a
real window manager in CI. Linux browser Open remains hidden: it will not be
offered until the registered default handler can be resolved to one exact
executable/window identity.

## Herdr

The local Herdr plugin mirrors agent attention from Herdr into Petdex and
preserves the exact pane ID so clicking the pet can focus that pane. Direct
Petdex hooks remain preferred for supported agents. See
[`integrations/herdr`](integrations/herdr/README.md) for setup and filtering.

## DeepSeek Harness (macOS)

The bundled DeepSeek Harness plugin mirrors official DSH Web session events
into Petdex. Install it from Settings, restart DSH Web, then start or continue
a task; Petdex reports the integration as connected only after receiving a real
event. One top-level DSH session becomes one task card, while subagents,
workflows, goals, and compaction update their parent card.

Clicking the pet activates the currently running default browser without
navigating to a URL or opening a tab. See
[`integrations/dsh`](integrations/dsh/README.md) for setup, behavior, and
troubleshooting.

## Remote agents (SSH)

Agents running on other machines can drive the same pet. Declare remotes in
`~/.petdex/remote-agents.json`:

```json
{
  "remotes": [
    {
      "name": "rogue",
      "host": "shakib@rogue.lan",
      "port": 22,
      "identity_file": "~/.ssh/id_ed25519",
      "enabled": true,
      "agents": {
        "opencode": { "enabled": true },
        "codex": { "enabled": false },
        "hermes": { "enabled": true, "home": "~/.hermes" }
      }
    }
  ]
}
```

At launch the desktop probes each enabled remote (`ssh` with `BatchMode=yes`,
no password prompts ever), then runs a fetch-merge-writeback: the remote's
existing hook configs are read, merged locally by the exact installers a local
connect uses, and written back. Foreign hooks are preserved, never clobbered.
The desktop first verifies a supervised reverse tunnel
(`ssh -R 127.0.0.1:7777:127.0.0.1:7777`), installs executable dependencies
before the configs that enable them, starts the session reconcilers, and only
then atomically publishes the hook-server update token. Hook POSTs from the
remote can reach the desktop's loopback server only after that complete gated
patch pass succeeds.

Remote shell-exec agents (codex, hermes) invoke `~/.petdex/bin/petdex-hook` on
the remote, where a small POSIX sh + curl script (`src/assets/petdex-remote-hook.sh`)
mirrors the desktop hook runner's contract: stdin drain, killswitch
(`~/.petdex/runtime/hooks-disabled`), token-gated POSTs to `127.0.0.1:7777`,
never fails outward. The opencode plugin POSTs directly and works unchanged.

Notes:
- SSH only; there is no API fallback transport. Windows desktops use the
  installed OpenSSH client, but remote target accounts must still be POSIX;
  Windows remote targets are out of scope.
- Remote accounts need a POSIX shell and `ps`; Codex/Hermes reconciliation
  additionally needs `python3`, and their shell hooks need `curl`. Startup
  stays gated and reports a retrying state when a required dependency is absent.
- Names are `[a-zA-Z0-9_-]{1,32}`, must be unique ignoring case, and appear
  in logs and private staging paths.
- `agents.hermes.home` is optional. Set it to Hermes's remote `HERMES_HOME`
  when that installation does not use `~/.hermes`; it must be absolute or
  begin with `~/`.
- Sync runs after every tunnel establishment, before that tunnel's feed token
  becomes available; the Settings "Remote Agents" section reports live status
  and stays read-only.
- If a remote account also runs a petdex desktop, do not point a remote at it:
  the writeback replaces that account's `~/.petdex/bin/petdex-hook` with the
  sh script.
