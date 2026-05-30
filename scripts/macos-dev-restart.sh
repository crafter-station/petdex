#!/usr/bin/env bash
set -euo pipefail

# Rebuild and relaunch the local macOS desktop app.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$ROOT/packages/petdex-desktop"
SIDECAR_DIR="$DESKTOP_DIR/sidecar"
APP_PATH="${PETDEX_DEV_APP_PATH:-$HOME/Applications/Petdex Dev.app}"
ZERO_NATIVE_PATH="${ZERO_NATIVE_PATH:-$(cd "$ROOT/../zero-native" 2>/dev/null && pwd || true)}"
ZIG="${ZIG:-$(command -v zig || true)}"

if [[ -z "$ZERO_NATIVE_PATH" || ! -d "$ZERO_NATIVE_PATH" ]]; then
  echo "macos-dev-restart: ZERO_NATIVE_PATH is not set and ../zero-native was not found" >&2
  exit 1
fi

if [[ -z "$ZIG" || ! -x "$ZIG" ]]; then
  echo "macos-dev-restart: zig not found. Set ZIG=/path/to/zig" >&2
  exit 1
fi

echo "==> Build sidecar"
(cd "$SIDECAR_DIR" && npm exec --yes --package bun -- bun run build)

echo "==> Build desktop"
(cd "$DESKTOP_DIR" && ZERO_NATIVE_PATH="$ZERO_NATIVE_PATH" "$ZIG" build)

echo "==> Sync sidecar runtime"
mkdir -p "$HOME/.petdex/sidecar"
cp "$SIDECAR_DIR/server.js" "$HOME/.petdex/sidecar/server.js"

echo "==> Ensure Petdex Dev.app"
"$ROOT/scripts/macos-dev-app.sh" >/dev/null

echo "==> Stop existing dev desktop"
for pid in $(pgrep -x petdex-desktop || true); do
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' || true)"
  if [[ "$cwd" == "$DESKTOP_DIR" ]]; then
    kill "$pid" || true
  fi
done

sidecar_pids="$(pgrep -f "$HOME/.petdex/sidecar/server.js" || true)"
if [[ -n "$sidecar_pids" ]]; then
  # shellcheck disable=SC2086
  kill $sidecar_pids || true
fi

sleep 0.4

echo "==> Launch $APP_PATH"
open -n "$APP_PATH"

echo "==> Wait for sidecar health"
for _ in {1..25}; do
  if curl -fsS http://127.0.0.1:7777/health >/dev/null 2>&1; then
    curl -fsS http://127.0.0.1:7777/health
    printf "\n"
    echo "Petdex Dev.app is running."
    exit 0
  fi
  sleep 0.2
done

echo "macos-dev-restart: app launched, but sidecar health did not respond yet" >&2
exit 1
