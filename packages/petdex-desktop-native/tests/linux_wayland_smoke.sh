#!/bin/sh
set -eu

ARTIFACTS=""
BINARY="zig-out/bin/petdex-desktop-native"
NATIVE_CLI="${NATIVE_CLI:-native}"
FIXTURE=""
INSIDE_SESSION=0
SMOKE_ROOT=""
APP_PID=""
LAUNCHED_APP_PID=""
WESTON_PID=""
FAILURE_REASON="scenario did not complete"
AUTOMATION_DIR=".zig-cache/native-sdk-automation"
ACTION_RAIL_STATUS="not-reached"

usage() {
    echo "usage: $0 --self-test | --artifacts DIR --fixture DIR [--binary FILE] [--native-cli FILE]" >&2
}

fail() {
    FAILURE_REASON=$*
    echo "linux Wayland smoke: FAIL: $*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

stop_pid() {
    target_pid=$1
    if [ -n "$target_pid" ] && kill -0 "$target_pid" 2>/dev/null; then
        kill "$target_pid" 2>/dev/null || true
        wait "$target_pid" 2>/dev/null || true
    fi
}

write_summary() {
    summary_status_value=$1
    summary_reason_value=$2
    jq -n --arg status "$summary_status_value" --arg reason "$summary_reason_value" \
        --arg compositor weston-headless --arg backend wayland \
        --arg actionRail "$ACTION_RAIL_STATUS" \
        --argjson appPid "${LAUNCHED_APP_PID:-0}" \
        '{status:$status,reason:$reason,compositor:$compositor,backend:$backend,appPid:$appPid,actionRailAutomation:$actionRail,inputRegionGapHitTesting:"manual"}' \
        > "$ARTIFACTS/summary.json.tmp"
    mv "$ARTIFACTS/summary.json.tmp" "$ARTIFACTS/summary.json"
}

automation_assert() {
    # Keep the CLI's own diagnostic timeout shorter than the outer process
    # ceiling so a failed assertion prints its missing patterns and snapshot
    # tail instead of being killed silently by `timeout` first.
    timeout 15s "$NATIVE_CLI" automate assert --timeout-ms 10000 "$@"
}

automation_assert_disclosure_focused() {
    disclosure_label=$1
    # The disclosure is deliberately keyed, so its original widget id must
    # remain the focused target as its icon/count presentation changes.
    automation_assert "bubble-canvas#$disclosure_id .*name=\"$disclosure_label\".*focused=true"
}

cleanup() {
    cleanup_status=$?
    trap - EXIT INT TERM
    stop_pid "$APP_PID"
    stop_pid "$WESTON_PID"
    if [ -n "$ARTIFACTS" ] && [ -d "$ARTIFACTS" ] && [ "$FAILURE_REASON" != passed ]; then
        write_summary fail "$FAILURE_REASON"
    fi
    exit "$cleanup_status"
}

self_test() {
    root=$(mktemp -d "${TMPDIR:-/tmp}/petdex-wayland-smoke-self.XXXXXX")
    trap 'rm -rf "$root"' EXIT
    chmod 700 "$root"
    case "$(uname -s)" in
        MINGW*|MSYS*) ;;
        *) [ "$(stat -c '%a' "$root")" = 700 ] || fail "private runtime mode check failed" ;;
    esac
    snapshot="$root/snapshot.txt"
    printf '%s\n' \
        'view @w2/bubble-canvas kind=gpu_surface' \
        '    widget @w2/bubble-canvas#11 role=button name="Show most recent active session only" actions=[focus,press]' \
        '    widget @w2/bubble-canvas#12 role=group name="Agent session" actions=[focus,press]' > "$snapshot"
    disclosure_id=$(awk '/bubble-canvas#[0-9]+ .*name="Show most recent active session only"/ { sub(/^.*bubble-canvas#/, ""); sub(/ .*/, ""); print; exit }' "$snapshot")
    card_id=$(awk '/bubble-canvas#[0-9]+ .*name="Agent session"/ { sub(/^.*bubble-canvas#/, ""); sub(/ .*/, ""); print; exit }' "$snapshot")
    [ "$disclosure_id" = 11 ] && [ "$card_id" = 12 ] || fail "snapshot widget parser self-test failed"
    ! grep -F 'name="Open agent session"' "$snapshot" >/dev/null || fail "unsupported Open absence self-test failed"
    echo "linux Wayland smoke self-test: PASS"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --self-test) self_test; exit 0 ;;
        --artifacts) [ $# -ge 2 ] || { usage; exit 2; }; ARTIFACTS=$2; shift 2 ;;
        --binary) [ $# -ge 2 ] || { usage; exit 2; }; BINARY=$2; shift 2 ;;
        --native-cli) [ $# -ge 2 ] || { usage; exit 2; }; NATIVE_CLI=$2; shift 2 ;;
        --fixture) [ $# -ge 2 ] || { usage; exit 2; }; FIXTURE=$2; shift 2 ;;
        --inside-session) INSIDE_SESSION=1; shift ;;
        --smoke-root) [ $# -ge 2 ] || { usage; exit 2; }; SMOKE_ROOT=$2; shift 2 ;;
        *) usage; exit 2 ;;
    esac
done

[ -n "$ARTIFACTS" ] && [ -n "$FIXTURE" ] || { usage; exit 2; }
require_command realpath
BINARY=$(realpath "$BINARY")
NATIVE_CLI=$(realpath "$NATIVE_CLI")
FIXTURE=$(realpath "$FIXTURE")
mkdir -p "$ARTIFACTS"
ARTIFACTS=$(realpath "$ARTIFACTS")
[ -x "$BINARY" ] || fail "binary is not executable: $BINARY"
[ -x "$NATIVE_CLI" ] || fail "Native SDK CLI is not executable: $NATIVE_CLI"
fixture_sheet=$(jq -er '.spritesheetPath | select(. == "spritesheet.png" or . == "spritesheet.webp")' "$FIXTURE/pet.json") ||
    fail "fixture pet.json is missing or invalid"
[ -s "$FIXTURE/$fixture_sheet" ] || fail "fixture spritesheet is missing"

if [ "$INSIDE_SESSION" -eq 0 ]; then
    require_command dbus-run-session
    script=$(realpath "$0")
    SMOKE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/petdex-wayland-smoke.XXXXXX")
    mkdir -p "$SMOKE_ROOT/home" "$SMOKE_ROOT/runtime"
    chmod 700 "$SMOKE_ROOT" "$SMOKE_ROOT/home" "$SMOKE_ROOT/runtime"
    set +e
    env HOME="$SMOKE_ROOT/home" XDG_RUNTIME_DIR="$SMOKE_ROOT/runtime" \
        GIO_USE_VFS=local GIO_USE_VOLUME_MONITOR=unix GTK_USE_PORTAL=0 NO_AT_BRIDGE=1 \
        dbus-run-session -- "$script" --inside-session --smoke-root "$SMOKE_ROOT" \
        --artifacts "$ARTIFACTS" --fixture "$FIXTURE" --binary "$BINARY" --native-cli "$NATIVE_CLI" \
        2> "$ARTIFACTS/dbus-session.log"
    session_status=$?
    set -e
    if [ "$session_status" -ne 0 ]; then
        cat "$ARTIFACTS/dbus-session.log" >&2
    fi
    case "$SMOKE_ROOT" in "${TMPDIR:-/tmp}"/petdex-wayland-smoke.*) rm -rf "$SMOKE_ROOT" ;; *) exit 1 ;; esac
    exit "$session_status"
fi

trap cleanup EXIT INT TERM
for command in weston curl jq ss busctl readlink timeout awk sed seq cp stat; do require_command "$command"; done
[ "$(stat -c '%a' "$HOME")" = 700 ] || fail "isolated HOME is not mode 700"
[ "$(stat -c '%a' "$XDG_RUNTIME_DIR")" = 700 ] || fail "isolated runtime is not mode 700"
[ -z "$(ss -H -ltn 'sport = :7777' 2>/dev/null)" ] || fail "port 7777 already has a listener"

mkdir -p "$HOME/.petdex/pets/ci-pet" "$AUTOMATION_DIR"
chmod 700 "$HOME/.petdex" "$HOME/.petdex/pets" "$HOME/.petdex/pets/ci-pet"
cp "$FIXTURE/pet.json" "$HOME/.petdex/pets/ci-pet/pet.json"
cp "$FIXTURE/$fixture_sheet" "$HOME/.petdex/pets/ci-pet/$fixture_sheet"
rm -f "$AUTOMATION_DIR/snapshot.txt" "$AUTOMATION_DIR/accessibility.txt" \
    "$AUTOMATION_DIR/windows.txt" "$AUTOMATION_DIR"/command-*.txt "$AUTOMATION_DIR"/screenshot-*.png

WAYLAND_DISPLAY=wayland-petdex-ci
export WAYLAND_DISPLAY
unset DISPLAY
weston --backend=headless-backend.so --socket="$WAYLAND_DISPLAY" --width=1280 --height=800 --idle-time=0 \
    > "$ARTIFACTS/weston.log" 2>&1 &
WESTON_PID=$!
ready=0
for _ in $(seq 1 100); do
    if kill -0 "$WESTON_PID" 2>/dev/null && [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]; then ready=1; break; fi
    sleep 0.1
done
[ "$ready" -eq 1 ] || fail "headless Weston did not become ready"

PETDEX_PET=ci-pet GDK_BACKEND=wayland GSK_RENDERER=cairo \
    "$BINARY" > "$ARTIFACTS/app.log" 2>&1 &
APP_PID=$!
LAUNCHED_APP_PID=$APP_PID
ready=0
for _ in $(seq 1 120); do
    if kill -0 "$APP_PID" 2>/dev/null && curl --max-time 2 -fsS http://127.0.0.1:7777/health >/dev/null 2>&1 && [ -s "$HOME/.petdex/runtime/update-token" ]; then
        ready=1; break
    fi
    sleep 0.1
done
[ "$ready" -eq 1 ] || fail "app, listener, or token did not become ready under Weston"

whoami=$(curl --max-time 3 -fsS http://127.0.0.1:7777/whoami)
printf '%s\n' "$whoami" > "$ARTIFACTS/whoami.json"
[ "$(printf '%s' "$whoami" | jq -er .pid)" = "$APP_PID" ] || fail "whoami PID does not match launched process"
[ "$(readlink -f "/proc/$APP_PID/exe")" = "$BINARY" ] || fail "launched process is not the built ELF"
busctl --user status dev.petdex.desktop-native --no-pager > "$ARTIFACTS/dbus-status.txt" 2>&1 || fail "D-Bus app name is not owned"
ss -H -ltnp 'sport = :7777' > "$ARTIFACTS/listener.txt"
listener_pid=$(sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' "$ARTIFACTS/listener.txt" | sed -n '1p')
[ "$listener_pid" = "$APP_PID" ] || fail "listener PID does not match app"

timeout 20s "$NATIVE_CLI" automate wait > "$ARTIFACTS/automation-ready.txt"
token=$(cat "$HOME/.petdex/runtime/update-token")
curl --max-time 5 -fsS -o "$ARTIFACTS/bubble-post.json" -X POST \
    -H "x-petdex-update-token: $token" -H 'Content-Type: application/json' \
    --data '{"text":"Wayland popup-local automation","title":"PetDex Wayland CI","session_id":"wayland-smoke","agent_source":"codex","status":"completed","busy":false}' \
    http://127.0.0.1:7777/bubble || fail "authenticated bubble publication failed"
curl --max-time 3 -fsS http://127.0.0.1:7777/bubble > "$ARTIFACTS/bubble-parent-get.json"
jq -e '.text == "Wayland popup-local automation"' "$ARTIFACTS/bubble-parent-get.json" >/dev/null || fail "published parent bubble was not observable"
curl --max-time 5 -fsS -o "$ARTIFACTS/subagent-post.json" -X POST \
    -H "x-petdex-update-token: $token" -H 'Content-Type: application/json' \
    --data '{"text":"Child result from Weston","title":"PetDex Wayland CI","session_id":"wayland-child","source_session_id":"wayland-child","parent_session_id":"wayland-smoke","session_kind":"subagent","subagent_label":"CI child","message_kind":"assistant","agent_source":"codex","status":"completed","busy":false}' \
    http://127.0.0.1:7777/bubble || fail "authenticated subagent publication failed"
token=""

snapshot_ready=0
for _ in $(seq 1 100); do
    if [ -s "$AUTOMATION_DIR/snapshot.txt" ] && grep -F 'name="Agent session"' "$AUTOMATION_DIR/snapshot.txt" >/dev/null; then snapshot_ready=1; break; fi
    sleep 0.1
done
[ "$snapshot_ready" -eq 1 ] || fail "automation snapshot never exposed the Wayland bubble"
automation_assert 'name="Agent session"' 'name="Show most recent active session only"' 'Wayland popup-local automation'
automation_assert --absent 'name="Open agent session"'
cp "$AUTOMATION_DIR/snapshot.txt" "$ARTIFACTS/snapshot-published.txt"
cp "$AUTOMATION_DIR/accessibility.txt" "$ARTIFACTS/accessibility-published.txt"
cp "$AUTOMATION_DIR/windows.txt" "$ARTIFACTS/windows-published.txt"
grep -F 'name="Agent session"' "$ARTIFACTS/accessibility-published.txt" >/dev/null || fail "bubble card is absent from accessibility surface"
if grep -F 'name="Open agent session"' "$ARTIFACTS/snapshot-published.txt" "$ARTIFACTS/accessibility-published.txt" >/dev/null; then
    fail "unsupported Open action was generated on Wayland"
fi

disclosure_id=$(awk '/bubble-canvas#[0-9]+ .*name="Show most recent active session only"/ { sub(/^.*bubble-canvas#/, ""); sub(/ .*/, ""); print; exit }' "$ARTIFACTS/snapshot-published.txt")
card_id=$(awk '/bubble-canvas#[0-9]+ .*name="Agent session"/ { sub(/^.*bubble-canvas#/, ""); sub(/ .*/, ""); print; exit }' "$ARTIFACTS/snapshot-published.txt")
[ -n "$disclosure_id" ] && [ -n "$card_id" ] || fail "popup-local automation targets were not generated"

# Pointer activation uses widget-local bounds from the SDK snapshot; it does
# not depend on compositor-global coordinates (which Wayland intentionally
# withholds). The keyboard path focuses and activates the same accessible
# disclosure command.
timeout 15s "$NATIVE_CLI" automate widget-click bubble-canvas "$disclosure_id"
automation_assert 'name="Hide session cards"' 'name="Agent session"'
timeout 15s "$NATIVE_CLI" automate widget-action bubble-canvas "$disclosure_id" focus
automation_assert_disclosure_focused 'Hide session cards'
timeout 15s "$NATIVE_CLI" automate widget-key bubble-canvas enter
automation_assert 'name="Show all active sessions"'
automation_assert --absent 'name="Agent session"'
automation_assert_disclosure_focused 'Show all active sessions'
# Hidden -> All restores the card without replacing the focused,
# accessible popup-local disclosure.
timeout 15s "$NATIVE_CLI" automate widget-key bubble-canvas enter
automation_assert 'name="Show most recent active session only"' 'name="Agent session"'
automation_assert_disclosure_focused 'Show most recent active session only'

# The card receives a complete popup-local pointer gesture. The pinned SDK has
# no drag-dispatch or compositor-position query, so this only proves delivery
# plus continued presentation/liveness; real movement stays a manual check.
timeout 15s "$NATIVE_CLI" automate widget-drag bubble-canvas "$card_id" 0.25 0.75 0.5 0.5
kill -0 "$APP_PID" 2>/dev/null || fail "app exited during popup-local movement"
curl --max-time 3 -fsS http://127.0.0.1:7777/bubble > "$ARTIFACTS/bubble-after-actions.json"
jq -e '.text != null' "$ARTIFACTS/bubble-after-actions.json" >/dev/null || fail "bubble state was lost during actions"

# A synthetic card-local pointer gesture may cause the SDK to publish the
# hover-only portable action rail. Exercise every generated action when it
# does. Current file-drop automation has no standalone pointer-hover verb, so
# compositors where the drag does not retain hover record that limitation
# explicitly instead of pretending the controls were tested.
rail_ready=0
for _ in $(seq 1 30); do
    if grep -F 'name="Pin session to front"' "$AUTOMATION_DIR/snapshot.txt" >/dev/null; then rail_ready=1; break; fi
    sleep 0.1
done
if [ "$rail_ready" -eq 1 ]; then
    ACTION_RAIL_STATUS="automated"
    pin_id=$(awk '/bubble-canvas#[0-9]+ .*name="Pin session to front"/ { sub(/^.*bubble-canvas#/, ""); sub(/ .*/, ""); print; exit }' "$AUTOMATION_DIR/snapshot.txt")
    subagents_id=$(awk '/bubble-canvas#[0-9]+ .*name="Expand subagent messages"/ { sub(/^.*bubble-canvas#/, ""); sub(/ .*/, ""); print; exit }' "$AUTOMATION_DIR/snapshot.txt")
    dismiss_id=$(awk '/bubble-canvas#[0-9]+ .*name="Dismiss ended session"/ { sub(/^.*bubble-canvas#/, ""); sub(/ .*/, ""); print; exit }' "$AUTOMATION_DIR/snapshot.txt")
    [ -n "$pin_id" ] && [ -n "$subagents_id" ] && [ -n "$dismiss_id" ] || fail "hover rail omitted Pin, Subagents, or Dismiss"
    timeout 15s "$NATIVE_CLI" automate widget-action bubble-canvas "$pin_id" focus
    timeout 15s "$NATIVE_CLI" automate widget-key bubble-canvas enter
    automation_assert 'name="Unpin session"'
    timeout 15s "$NATIVE_CLI" automate widget-click bubble-canvas "$subagents_id"
    automation_assert 'name="Collapse subagent messages"' 'Child result from Weston'
    printf '%s\n' 'Pin: keyboard PASS' 'Subagents: pointer PASS' 'Dismiss: deferred until after screenshot' > "$ARTIFACTS/action-rail.txt"
else
    ACTION_RAIL_STATUS="unavailable-no-hover-verb"
    printf '%s\n' 'NOT AUTOMATED: Native SDK file-drop automation has no pointer-hover verb; the hover-only Pin/Subagents/Dismiss rail did not materialize after a local card drag.' > "$ARTIFACTS/action-rail.txt"
fi

timeout 20s "$NATIVE_CLI" automate screenshot bubble-canvas > "$ARTIFACTS/screenshot-command.txt"
[ -s "$AUTOMATION_DIR/screenshot-bubble-canvas.png" ] || fail "Native SDK produced no bubble screenshot"
cp "$AUTOMATION_DIR/screenshot-bubble-canvas.png" "$ARTIFACTS/wayland-bubble-canvas.png"
cp "$AUTOMATION_DIR/snapshot.txt" "$ARTIFACTS/snapshot-after-actions.txt"
cp "$AUTOMATION_DIR/accessibility.txt" "$ARTIFACTS/accessibility-after-actions.txt"

if [ "$rail_ready" -eq 1 ]; then
    # Resolve again because expanding nested content regenerates widget ids.
    dismiss_id=$(awk '/bubble-canvas#[0-9]+ .*name="Dismiss ended session"/ { sub(/^.*bubble-canvas#/, ""); sub(/ .*/, ""); print; exit }' "$AUTOMATION_DIR/snapshot.txt")
    [ -n "$dismiss_id" ] || fail "Dismiss disappeared before activation"
    timeout 15s "$NATIVE_CLI" automate widget-click bubble-canvas "$dismiss_id"
    automation_assert --absent 'name="Agent session"'
    printf '%s\n' 'Dismiss: pointer PASS' >> "$ARTIFACTS/action-rail.txt"
fi

stop_pid "$APP_PID"
APP_PID=""
for _ in $(seq 1 30); do [ -z "$(ss -H -ltn 'sport = :7777' 2>/dev/null)" ] && break; sleep 0.1; done
[ -z "$(ss -H -ltn 'sport = :7777' 2>/dev/null)" ] || fail "listener remained after app cleanup"
FAILURE_REASON=passed
if [ "$ACTION_RAIL_STATUS" = automated ]; then
    summary_reason="all automated assertions passed; transparent input-region gap hit-testing remains manual"
else
    summary_reason="core automated assertions passed; hover-only Pin/Subagents/Dismiss unavailable to SDK automation; transparent input-region gap hit-testing remains manual"
fi
write_summary pass "$summary_reason"
echo "linux Wayland smoke: PASS"
