# Native desktop platform verification

Use this checklist for changes to bubbles, window movement, accessibility,
session reconciliation, or Native SDK patches. Automated checks are merge
gates. Manual rows are release gates when affected platform behavior changes;
do not infer a manual pass from shared Zig tests.

## 1. Prerequisites and build

Record the Petdex commit and SDK pin from
.github/workflows/desktop-native-ci.yml in 00-environment.txt. Use the Native
CLI built from that exact SDK checkout.

    git rev-parse HEAD
    git status --short
    export NATIVE_SDK_PATH=/absolute/path/to/native-sdk
    export NATIVE_CLI="$NATIVE_SDK_PATH/zig-out/bin/native"
    scripts/patch-native-sdk.sh
    (cd packages/petdex-desktop-native && "$NATIVE_CLI" test .)
    (cd packages/petdex-desktop-native && \
      "$NATIVE_CLI" build -Dcpu=baseline -Dtrace=off)
    python3 packages/petdex-desktop-native/tests/linux_smoke_fixture.py \
      --dest packages/petdex-desktop-native/.zig-cache/manual-fixture

On Windows, set the variables in PowerShell and run the patch script from Git
Bash. Launch zig-out/bin/petdex-desktop-native.exe. On Linux, launch
zig-out/bin/petdex-desktop-native. On macOS, use the app bundle so
LaunchServices, accessibility, and focus behavior are real:

    NATIVE_CLI="$NATIVE_CLI" NATIVE_SDK_PATH="$NATIVE_SDK_PATH" \
      PETDEX_DEV_AUTOMATION=false scripts/macos-dev-restart.sh

Linux X11 automation needs GTK 4, Xvfb, xcompmgr, ImageMagick, xdotool,
x11-utils, jq, D-Bus, and Tesseract. On Ubuntu:

    sudo apt-get install -y libgtk-4-dev libx11-dev pkg-config \
      webp-pixbuf-loader xvfb xcompmgr imagemagick x11-utils \
      x11-xserver-utils xdotool jq dbus-daemon tesseract-ocr

For manual runs, install the fixed fixture under the account running Petdex:

    mkdir -p ~/.petdex/pets/ci-pet
    cp packages/petdex-desktop-native/.zig-cache/manual-fixture/pet.json \
      packages/petdex-desktop-native/.zig-cache/manual-fixture/spritesheet.png \
      ~/.petdex/pets/ci-pet/

Set PETDEX_PET=ci-pet before launch. Verify /health, /whoami, and the PID
listening on loopback port 7777 belong to that launch. Never copy the update
token into evidence.

## 2. Fixture and session setup

Create two local primary conversations with different agents and titles. Keep
the first running, put the second into needs_input, and add one completed child
under the first. Hooks or real agent stores are preferred; authenticated
/bubble requests may be used for deterministic visual testing. The UI must
contain:

1. a busy Codex card titled Local build;
2. a Claude Code card titled Approval needed with attention state;
3. one completed Reviewer child under Local build;
4. distinct Open, Pin, Subagents, and Dismiss eligibility.

Repeat primary-session cases with one remote POSIX host. Configure
~/.petdex/remote-agents.json per the desktop README, using a unique host label
and an SSH key accepted in batch mode. The host needs sh, ps, curl, and python3
for Codex/Hermes reconciliation. Confirm a remote card shows its host, does not
overwrite the same local conversation ID, and exposes Open only when activation
is supported. Save a redacted copy as 02-remote-config.json.

Exercise this state sequence before each platform checklist:

1. All shows both primary cards.
2. Recent shows only the newest eligible conversation.
3. Hidden removes cards but leaves the 30 px disclosure target.
4. All restores ordering and child state.
5. Pin Local build, update Approval needed, and confirm the pin remains nearest
   the pet.
6. Expand Subagents, then dismiss only an eligible quiet primary card.

### 2A. Durable recovery and directory-watch evidence

Durable recovery is intentionally narrower than hook support. Test only real
provider-generated artifacts; do not create JSON shaped to match an adapter.

| Provider | Durable recovery expectation |
| --- | --- |
| Codex | Read-only rollout recovery enabled |
| Claude Code | Read-only transcript recovery enabled |
| Gemini | Read-only chat recovery enabled |
| OMP | Read-only session-log recovery enabled |
| Hermes | Read-only `state.db` recovery enabled |
| OpenCode, Qoder, Kimi Code, CodeBuddy | Hooks work; durable-store recovery fails closed |

For each enabled durable provider, record the provider version and resolved
store path in `recovery-roots-redacted.txt`, create a new session with hooks
disabled, then produce one additional turn and a terminal or attention state
supported by that provider. Confirm the card appears and advances without an
app restart. Save timestamps and observed identity/title/status in
`recovery-durable.tsv`; preserve only sanitized excerpts as
`recovery-<provider>-sanitized.txt`.

    mkdir -p ~/.petdex/runtime
    touch ~/.petdex/runtime/hooks-disabled

Remove `~/.petdex/runtime/hooks-disabled` only for the hook-fed half of the
hooks-only check below. On Windows:

    New-Item -ItemType Directory "$HOME\.petdex\runtime" -Force
    New-Item -ItemType File "$HOME\.petdex\runtime\hooks-disabled" -Force
    # Run the durable/fail-closed checks, then enable hooks:
    Remove-Item -LiteralPath "$HOME\.petdex\runtime\hooks-disabled"

Do not alter installed provider configuration to simulate a missing hook.

Exercise default and custom roots with the watcher already running. On macOS or
Linux, one repeatable custom-root setup is:

    export CLAUDE_CONFIG_DIR="$PWD/.zig-cache/manual-roots/claude"
    export PI_CODING_AGENT_DIR="$PWD/.zig-cache/manual-roots/omp"
    export HERMES_HOME="$PWD/.zig-cache/manual-roots/hermes"
    mkdir -p "$CLAUDE_CONFIG_DIR" "$PI_CODING_AGENT_DIR" "$HERMES_HOME"

Use equivalent absolute environment variables in PowerShell on Windows. Launch
Petdex from that environment before the provider creates its project/session
subdirectory. Then:

    $env:CLAUDE_CONFIG_DIR = [IO.Path]::GetFullPath(".zig-cache\manual-roots\claude")
    $env:PI_CODING_AGENT_DIR = [IO.Path]::GetFullPath(".zig-cache\manual-roots\omp")
    $env:HERMES_HOME = [IO.Path]::GetFullPath(".zig-cache\manual-roots\hermes")
    New-Item -ItemType Directory $env:CLAUDE_CONFIG_DIR,$env:PI_CODING_AGENT_DIR,$env:HERMES_HOME -Force

1. Start one real session under each default root and one under each applicable
   custom root above; use a project directory that did not exist at Petdex
   launch so the change is nested below the watched root.
2. Record provider-write and Petdex-visible timestamps. The native notification
   should reconcile well before the 60-second safety sweep; record the actual
   latency and fail the row if discovery occurs only at the sweep.
3. Add a turn, cause a supported attention/terminal transition, and start a
   second newly nested project. Confirm identity remains stable and no duplicate
   top-level card appears.
4. Restart Petdex while the durable session remains active. Confirm it is
   recovered read-only and the provider artifact timestamp/checksum is
   unchanged by Petdex.

Save `watch-default-roots.tsv`, `watch-custom-roots.tsv`, redacted watcher/app
logs, and before/after provider-artifact metadata. This verifies the recursive
`ReadDirectoryChangesW`, bounded recursive inotify, or recursive FSEvents path
plus the safety fallback; shared Zig tests alone are not runtime evidence.

For OpenCode, Qoder, Kimi Code, and CodeBuddy, keep hooks disabled and start a
real session. Confirm no durable-store card is guessed. Re-enable hooks, start a
new event, and confirm the hook-fed card appears. Save
`recovery-hooks-only.tsv` with provider version, no-card observation window,
and hook-fed result; never include the update token.

## 3. Shared expected results

Apply these assertions everywhere unless a platform case names a fallback.

- Corners are smoothly rounded with no opaque rectangular fringe. Gaps,
  outside-corner pixels, and space between pet and bubble are click-through;
  controls and visible card bodies accept input.
- Disclosure cycles All → Recent → Hidden → All exactly once per click. Hidden
  exposes no stale title/message pixels. Hover never changes disclosure mode.
- Open appears only for a verified activation target. Pin is primary-only.
  Subagents appears only with children. Dismiss appears only for a quiet keyed
  primary session.
- Busy cards use only authored progress motion. Completed and needs-input cards
  settle. Reduce Motion stops shimmer/spring motion without hiding status.
- Titles, messages, provenance, status, and children never overlap at 100% or
  200%. Text wraps or truncates inside its assigned band.
- Equal local and remote conversation IDs remain separate. Children stay under
  the correct agent/host parent and never duplicate as top-level cards.
- Drag/throw keeps a stable pet-relative offset. Cross-display movement does
  not teleport, flap placement, or leave stale input regions. Closing the pet
  closes companions and port 7777.
- Screen-reader names include agent, title/status, and action purpose.
  Hidden/ineligible actions are absent. Activation occurs once and does not
  focus a no-activate bubble panel.

## 4. Automated coverage

| Platform | Automated merge evidence | Not proven by automation |
| --- | --- | --- |
| macOS, Linux, Windows | Pinned patched SDK build and native test suite | Native material, compositor focus, screen reader, mixed-DPI behavior |
| Linux X11 | Isolated Xvfb/cairo idle, bubble, disclosure interaction at GDK scale 1 and 2, OCR, process identity, and resource smoke | Real desktop compositor focus and accessibility |
| Linux Wayland | Isolated headless Weston launch/process/listener identity, authenticated publication, asserted disclosure transitions through popup-local pointer/keyboard actions, card-local gesture delivery, bounded accessibility metadata, unsupported-Open absence, and canvas screenshot | Real GTK AT traversal/action state, observable compositor movement, transparent input-region gap hit-testing, real GNOME/KWin stacking, compositor focus, screen reader, and mixed-DPI placement |
| Windows | Process/listener/whoami identity, authenticated health/state and Herdr round trip, liveness, deep link, native UIA card/disclosure enumeration, nonactivating All→Recent→Hidden→All Toggle, and baseline-vs-bubble pixel checks proving all four rounded-card corners remain background while the center paints; screenshots and deltas uploaded | High Contrast, DWM fallback variants, screen-reader navigation across every action, DPI/multi-monitor |
| Repository | PR-wide diff check, pre-commit hook self-test, adapter-specific durable fixtures/fail-closed registry tests, and directory-watch policy/backend contracts | Installed-provider compatibility, native notification delivery/overflow, provider artifact immutability, and platform runtime behavior |

The fixture is generated locally as a fixed v2 RGBA atlas. Catalog/CDN changes
cannot alter render screenshots. Deep-link scenarios remain separate network
coverage.

## 5. Windows 10 and Windows 11

Save Get-ComputerInfo, GPU/driver, DWM state, monitor bounds, DPI, theme, and
local-versus-Remote-Desktop state in windows-environment.txt.

### W1 — Windows 11 DWM material and controls

1. Use local Windows 11 with DWM at 100%.
2. Run the fixture sequence and hover every card and control.
3. Test Light/Dark and Transparency Effects on/off.

Expected: rounded native cards use supported DWM treatment with no black or
opaque rectangle; text remains readable; visual and input geometry agree;
Open/Pin/Subagents/Dismiss act once; the panel does not take focus.

Evidence: windows-w11-dwm-all.png, windows-w11-dwm-hidden.png,
windows-w11-controls.mp4.

The Windows CI artifact also contains `windows-screen.png`,
`windows-bubble.png`, `windows-rounded-corners.json`, and
`windows-uia-toggle.txt`. The JSON records the four outside-corner RGB deltas
and the painted-center delta; the text file records the native UIA transition
and foreground-focus assertion. Retain them with W1 evidence, but do not use
the normal-theme runner as a substitute for W2–W4.

### W2 — Windows 10, composition fallback, and Remote Desktop

1. Repeat W1 on Windows 10 where available.
2. Repeat under Remote Desktop or another material-unavailable environment.

Expected: software/solid fallback is readable, rounded, and interactive rather
than blank/black. Click-through gaps remain correct. Unsupported material or
shimmer does not create a settled presentation loop.

Evidence: windows-fallback-all.png, windows-fallback-interaction.mp4.

### W3 — High Contrast, keyboard, and accessibility

1. Enable a Windows High Contrast theme.
2. Inspect with Accessibility Insights or Inspect.exe.
3. Invoke each eligible action through accessibility tooling and keyboard.

Expected: system contrast colors override decoration; focus indicators and text
remain visible; names/roles match shared requirements; activation occurs once;
the no-activate panel never becomes foreground.

Evidence: windows-high-contrast.png, windows-accessibility.txt.

### W4 — DPI, mixed monitors, drag, and focus

1. Test 100% and 200%, then two displays with different scaling.
2. Place at each edge, drag across the boundary, then throw.
3. Trigger Open for a local terminal/agent and the remote fixture.

Expected: logical size changes once, stays on screen, and keeps input/rounded
geometry aligned. No scale doubling, offset jump, stuck hover, or phantom input
region. Local Open activates the recorded origin. Unsupported remote activation
hides Open rather than showing an inert button.

Evidence: windows-scale-100.png, windows-scale-200.png,
windows-mixed-dpi-drag.mp4, windows-focus.txt.

## 6. macOS 15 and macOS 26+

Record sw_vers, system_profiler SPDisplaysDataType, display scaling, Reduce
Motion/Contrast settings, and bundle signature in macos-environment.txt.

### M1 — macOS 26+ Liquid Glass

1. Use the launched app bundle on macOS 26+ Apple Silicon.
2. Run the fixture sequence in Light and Dark.
3. Move over light, dark, and detailed backgrounds.

Expected: cards use system Liquid Glass with clean rounded corners and adaptive
readability. Disclosure/actions keep correct hit regions without focusing the
panel. Material remains attached during pet movement.

Evidence: macos26-glass-light.png, macos26-glass-dark.png,
macos26-controls.mp4.

### M2 — Reduce Motion and lifecycle

1. Toggle Reduce Motion while a busy card is present.
2. Transition through needs-input, completed, and a new running turn.

Expected: Reduce Motion snaps transitions and stops continuous shimmer while
preserving status. Re-enabling motion affects active/new transitions only;
settled cards never self-rearm.

Evidence: macos26-reduce-motion.mp4, macos26-lifecycle.txt.

### M3 — macOS 15+ VoiceOver

1. Repeat on macOS 15+ and 26+ with VoiceOver.
2. Navigate disclosure, primary cards, child, and each eligible action.
3. Activate each action once.

Expected: VoiceOver order follows visual order; labels include title/status;
hidden/ineligible actions are absent; actions work once without foregrounding
the panel.

Evidence: macos-voiceover.mp4, macos-voiceover.txt.

### M4 — scaling, multi-monitor drag, and focus

1. Test default and scaled Retina modes, then mixed backing-scale displays.
2. Repeat edge placement, cross-display drag/throw, and local/remote Open.

Expected: crisp text, one logical size, stable offset, no placement oscillation
or stale companion. Verified local origins activate; unverifiable targets hide
Open.

Evidence: macos-mixed-scale-drag.mp4, macos-focus.txt.

## 7. Linux X11

Run from packages/petdex-desktop-native:

    python3 tests/linux_smoke_fixture.py --dest .zig-cache/linux-smoke-fixture
    sh tests/linux_desktop_smoke.sh --self-test
    for scenario in idle bubble interaction; do
      sh tests/linux_desktop_smoke.sh \
        --scenario "$scenario" \
        --artifacts ".zig-cache/verification/x11-$scenario" \
        --fixture .zig-cache/linux-smoke-fixture
    done
    sh tests/linux_perf_smoke.sh --quick \
      --artifacts .zig-cache/verification/x11-perf \
      --fixture .zig-cache/linux-smoke-fixture

### X1 — automated rendering and disclosure

Expected: every command passes; OCR finds title/message; bubble/hidden images
change materially; disclosure hides/restores; /whoami, D-Bus owner, executable,
and listener identify one process.

Evidence: preserve .zig-cache/verification as linux-x11-automated.zip.

### X2 — real X11 controls and click-through

1. Launch under a compositing X11 desktop, not Xvfb.
2. Run the sequence and click through every gap/corner.
3. Test every eligible control.

Expected: portable panels use supported solid/translucent fills, with no fake
blur. Gaps click through while controls do not. Toggle/actions match shared
semantics.

Evidence: linux-x11-all.png, linux-x11-clickthrough.mp4.

### X3 — scale, monitors, accessibility, and focus

1. Test scale 1 and 2, then mixed-resolution displays.
2. Drag/throw across displays. Inspect with Accerciser/Orca where available.
3. Trigger Open for supported local origins and the remote fixture. Include a
   browser-origin event and confirm browser Open is absent.

Expected: geometry/text scale once; accessibility names/actions are correct;
supported activation works and inert Open is absent. Linux browser Open stays
hidden until registered-default resolution is implemented. CI only
cross-compiles the X11 activation backend; successful focus against the real
window manager is established by this manual row.

Evidence: linux-x11-scale2.png, linux-x11-drag.mp4,
linux-x11-accessibility.txt, linux-x11-focus.txt.

## 8. GNOME Wayland

CI supplies a headless-Weston contract check for the shared Wayland GTK path:
launch identity, authenticated publication, individually asserted popup-local
pointer/keyboard disclosure transitions, card-local gesture delivery,
accessibility metadata, and absence of unsupported Open. The pinned SDK has no
drag-dispatch or compositor-position oracle, so movement remains manual. The
compositor-specific GNOME cases below
remain manual. In particular, headless Weston has no trustworthy oracle for
transparent input-region gap hit-testing, shell focus policy, or mixed-monitor
placement; its screenshot alone is not a pass for those assertions. Pin,
Subagents, and Dismiss are exercised when a local synthetic card gesture makes
the hover-only rail appear. If it does not, the artifact records
`unavailable-no-hover-verb`: the pinned SDK file-drop automation has no
standalone pointer-hover verb, so those three controls remain manual for that
run rather than receiving a false pass.

### GW1 — popup stacking and click-through

1. Use a real GNOME Wayland session at scale 1.
2. Show two cards plus child, overlap another app, and exercise gaps, corners,
   disclosure, and controls.

Expected: popup stays stacked with the pet; transparent gaps reach the
underlying app; cards/controls do not; Hidden leaves only disclosure.

Evidence: gnome-wayland-stacking.mp4.

### GW2 — activation and accessibility

1. Start local sessions from Terminal and VS Code; add the remote fixture.
2. Inspect with Orca/Accerciser and trigger every offered Open. Include a
   browser-origin event and confirm it exposes no Open control.
3. Start with a running primary card that has a session ID but no child: Pin is
   present, while Subagents and Dismiss are absent. Focus Pin through GTK/AT,
   activate it, and verify its checked/name state changes exactly once.
4. Add a completed child, then complete the primary. Without restarting, verify
   Subagents and then Dismiss appear with the right roles/names. Expand/collapse
   Subagents, remove or reorder the front card, traverse again, and confirm each
   retained control still invokes the action it announces.

Expected: Open exists only when GNOME can verifiably activate the origin;
offered actions focus the correct window once; remote/unverifiable origins hide
it. Browser Open remains hidden until a registered-default handler can be
resolved to one exact executable/window identity. GTK controls remain
pointer-transparent before hover; keyboard/AT focus paints a visible focus
affordance, toggle state follows Pin/Subagents, and eligibility/reordering never
leaves a stale role, name, checked state, or command.

Evidence: gnome-wayland-focus.txt, gnome-wayland-accessibility.txt,
gnome-wayland-gtk-eligibility.mp4, gnome-wayland-gtk-transitions.txt.

### GW3 — scale 2, mixed monitors, drag, and motion

1. Repeat at scale 2 and mixed-scale monitors, every edge, and a cross-display
   drag/throw.
2. Enable GNOME reduced animation and repeat busy/settled transitions.

Expected: no lag, offset drift, clipping, double scaling, or stale input region.
Reduced animation settles without losing status.

Evidence: gnome-wayland-scale2.png, gnome-wayland-drag.mp4.

## 9. KDE Plasma Wayland

These cases are manual in a real Plasma Wayland session.

### KW1 — stacking, controls, and click-through

Repeat GW1 under KWin.

Expected: stacking, rounded clipping, disclosure/action eligibility, and input
regions match shared assertions.

Evidence: kde-wayland-stacking.mp4, kde-wayland-controls.png.

### KW2 — activation and accessibility

Repeat GW2 using Konsole and another native app with Orca/Accerciser where
available.

Expected: only verified targets expose Open; activation does not focus the
panel; accessibility order/names/actions are correct. Repeat GW2's
Pin/Subagents/Dismiss eligibility, checked-state, card-removal, and reorder
sequence; browser Open remains absent.

Evidence: kde-wayland-focus.txt, kde-wayland-accessibility.txt,
kde-wayland-gtk-eligibility.mp4, kde-wayland-gtk-transitions.txt.

### KW3 — scale 2, mixed monitors, drag, and motion

Repeat GW3 at scale 1 and 2 and across mixed-scale displays.

Expected: stable logical size, attachment, placement, hover, and input geometry
with no cross-display jump.

Evidence: kde-wayland-scale2.png, kde-wayland-drag.mp4.

## 10. Performance and resource budgets

Linux is the only automated performance oracle. Run:

    sh tests/linux_perf_smoke.sh --quick \
      --artifacts .zig-cache/verification/perf-quick \
      --fixture .zig-cache/linux-smoke-fixture
    sh tests/linux_perf_smoke.sh --soak 600 \
      --artifacts .zig-cache/verification/perf-soak \
      --fixture .zig-cache/linux-smoke-fixture

Exact automated budgets:

- idle/static cumulative process CPU at or below 35% under Xvfb/cairo;
- RSS growth at or below 32 MiB;
- thread-count growth at or below 8;
- file-descriptor growth at or below 8;
- busy/rapid stays alive and within growth budgets; software-rendered CPU is
  recorded but has no fixed ceiling;
- bubble-stats.json reports positive bounded Linux native accessibility
  submissions, zero portable-only commits, and advancing view generations for
  non-idle work; all submission counters stop changing after the UI settles.

For Windows, macOS, and real Wayland/X11, capture 10-minute idle and
settled-static samples in the platform task monitor. Fail for monotonic RSS
growth above 32 MiB, more than 8 added threads/handles or file descriptors,
continuous settled presentation commits, or CPU that does not return near the
pre-change baseline. OS counters differ, so preserve raw samples and baseline
rather than applying the Linux 35% software-renderer ceiling.

Evidence: platform-perf-idle.csv, platform-perf-static.csv,
platform-perf-notes.txt.

## 11. Evidence and sign-off

Create commit-native-verification/ containing:

- 00-environment.txt, 01-build-and-tests.txt, and redacted
  02-remote-config.json;
- exact evidence filenames requested by each executed case;
- performance/ with raw CSV/JSON and notes;
- failures/ with reproduction, logs, and linked issue IDs.

Complete results.md. Use Blocked, never Pass, if required OS/hardware/tooling was
unavailable.

| ID | Platform/version | Scale/displays/session | Pass/Fail/Blocked | Evidence | Issue/notes |
| --- | --- | --- | --- | --- | --- |
| W1 |  |  |  |  |  |
| W2 |  |  |  |  |  |
| W3 |  |  |  |  |  |
| W4 |  |  |  |  |  |
| M1 |  |  |  |  |  |
| M2 |  |  |  |  |  |
| M3 |  |  |  |  |  |
| M4 |  |  |  |  |  |
| X1 |  |  |  |  |  |
| X2 |  |  |  |  |  |
| X3 |  |  |  |  |  |
| GW1 |  |  |  |  |  |
| GW2 |  |  |  |  |  |
| GW3 |  |  |  |  |  |
| KW1 |  |  |  |  |  |
| KW2 |  |  |  |  |  |
| KW3 |  |  |  |  |  |
| RECOVERY |  |  |  |  |  |
| WATCH |  |  |  |  |  |
| GTK-AT |  |  |  |  |  |
| PERF |  |  |  |  |  |

Update docs/fork-native-platform-gaps.md with completed results or a linked
follow-up issue. Transparent input-region gap hit-testing, GNOME/KWin focus and
stacking policy, mixed-DPI placement, and real screen-reader behavior remain
manual until a runner exposes a trustworthy compositor/accessibility oracle.
