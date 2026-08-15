#!/usr/bin/env bash
set -euo pipefail

# Rebuild and relaunch the local macOS native desktop app.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$ROOT/packages/petdex-desktop-native"
EXECUTABLE="$DESKTOP_DIR/zig-out/bin/petdex-desktop-native"
APP_PATH="${PETDEX_DEV_APP_PATH:-$HOME/Applications/Petdex Dev.app}"
APP_EXECUTABLE="$APP_PATH/Contents/MacOS/PetdexDev"
NATIVE_CLI="${NATIVE_CLI:-$(command -v native || true)}"
NATIVE_SDK_PATH="${NATIVE_SDK_PATH:-}"
# Petdex Dev is what we use for interactive desktop smoke tests, so it should
# behave like a responsive app rather than a trace recorder.  Override either
# setting explicitly when diagnosing Native SDK internals.
PETDEX_DEV_OPTIMIZE="${PETDEX_DEV_OPTIMIZE:-ReleaseSafe}"
PETDEX_DEV_TRACE="${PETDEX_DEV_TRACE:-off}"
# Native SDK's file-backed automation publisher writes a complete snapshot
# after every application event.  It is useful for CI smoke tests, but turns
# ordinary bubble timers into disk work in an interactive desktop build.
# Keep it opt-in for Petdex Dev; hooks and remote-agent transport do not use
# this diagnostic surface.
PETDEX_DEV_AUTOMATION="${PETDEX_DEV_AUTOMATION:-false}"

if [[ -n "$NATIVE_CLI" && "$NATIVE_CLI" != /* ]]; then
  NATIVE_CLI="$ROOT/$NATIVE_CLI"
fi
if [[ -n "$NATIVE_SDK_PATH" && "$NATIVE_SDK_PATH" != /* ]]; then
  NATIVE_SDK_PATH="$ROOT/$NATIVE_SDK_PATH"
fi

if [[ -z "$NATIVE_CLI" || ! -x "$NATIVE_CLI" ]]; then
  echo "macos-dev-restart: native CLI not found. Set NATIVE_CLI=/path/to/native" >&2
  exit 1
fi
if [[ -z "$NATIVE_SDK_PATH" ]]; then
  echo "macos-dev-restart: NATIVE_SDK_PATH is required for the pinned SDK" >&2
  exit 1
fi

"$ROOT/scripts/patch-native-sdk.sh"

echo "==> Build native desktop"
(cd "$DESKTOP_DIR" && "$NATIVE_CLI" build -Dcpu=baseline "-Doptimize=$PETDEX_DEV_OPTIMIZE" "-Dtrace=$PETDEX_DEV_TRACE" "-Dautomation=$PETDEX_DEV_AUTOMATION")

echo "==> Ensure Petdex Dev.app"
"$ROOT/scripts/macos-dev-app.sh" >/dev/null

echo "==> Stop existing dev desktop"
stopped_pids=()
while read -r pid command_line; do
  [[ -n "$pid" ]] || continue
  [[ "$pid" =~ ^[0-9]+$ ]] || continue
  # `open -n` may expose either the bundle launcher or the executable
  # behind it. Enumerate the bounded process table instead of relying on
  # an exact basename match, which misses app launches and path variants.
  if [[ "$command_line" == *"$EXECUTABLE"* || "$command_line" == *"$APP_EXECUTABLE"* ]]; then
    kill "$pid" || true
    stopped_pids+=("$pid")
  fi
done < <(ps -axo pid=,command= 2>/dev/null || true)

remaining=0
# macOS still ships Bash 3.2, where expanding an empty array under
# `set -u` raises "unbound variable". Skip the expansion entirely when
# there was no prior dev process to stop.
if ((${#stopped_pids[@]} > 0)); then
  for _ in {1..50}; do
    remaining=0
    for pid in "${stopped_pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        remaining=1
        break
      fi
    done
    if ((remaining == 0)); then
      break
    fi
    sleep 0.1
  done
fi
if ((remaining != 0)); then
  echo "macos-dev-restart: existing desktop process did not exit within 5 seconds" >&2
  exit 1
fi

echo "==> Launch $APP_PATH"
open -n "$APP_PATH"

echo "==> Wait for in-process hook server"
for _ in {1..25}; do
  if curl --connect-timeout 0.3 --max-time 0.8 -fsS http://127.0.0.1:7777/health >/dev/null 2>&1; then
    curl --connect-timeout 0.3 --max-time 0.8 -fsS http://127.0.0.1:7777/health
    printf "\n"
    echo "Petdex Dev.app is running."
    exit 0
  fi
  sleep 0.2
done

echo "macos-dev-restart: app launched, but the in-process hook server did not respond yet" >&2
exit 1
