#!/usr/bin/env bash
set -euo pipefail

# Rebuild and relaunch the local macOS native desktop app.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$ROOT/packages/petdex-desktop-native"
EXECUTABLE="$DESKTOP_DIR/zig-out/bin/petdex-desktop-native"
APP_PATH="${PETDEX_DEV_APP_PATH:-$HOME/Applications/Petdex Dev.app}"
NATIVE_CLI="${NATIVE_CLI:-$(command -v native || true)}"

if [[ -z "$NATIVE_CLI" || ! -x "$NATIVE_CLI" ]]; then
  echo "macos-dev-restart: native CLI not found. Set NATIVE_CLI=/path/to/native" >&2
  exit 1
fi

echo "==> Build native desktop"
(cd "$DESKTOP_DIR" && "$NATIVE_CLI" build -Dcpu=baseline)

echo "==> Ensure Petdex Dev.app"
"$ROOT/scripts/macos-dev-app.sh" >/dev/null

echo "==> Stop existing dev desktop"
while read -r pid; do
  [[ -n "$pid" ]] || continue
  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command_line" in
    *"$EXECUTABLE"*) kill "$pid" || true ;;
  esac
done < <(pgrep -x "$(basename "$EXECUTABLE")" || true)

sleep 0.4

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
