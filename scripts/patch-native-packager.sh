#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCH="$ROOT/patches/native-sdk-modern-dmg-window.patch"
SDK="${NATIVE_PACKAGER_SDK_PATH:-}"

if [[ -z "$SDK" ]]; then
  echo "patch-native-packager: NATIVE_PACKAGER_SDK_PATH is required" >&2
  exit 1
fi
if ! git -C "$SDK" rev-parse --git-dir >/dev/null 2>&1; then
  echo "patch-native-packager: SDK checkout not found: $SDK" >&2
  exit 1
fi
if git -C "$SDK" apply --reverse --check "$PATCH" >/dev/null 2>&1; then
  echo "patch-native-packager: already applied $(basename "$PATCH")"
  exit 0
fi
if ! git -C "$SDK" apply --check "$PATCH" >/dev/null 2>&1; then
  echo "patch-native-packager: patch does not match this SDK: $PATCH" >&2
  exit 1
fi
git -C "$SDK" apply "$PATCH"
echo "patch-native-packager: applied $(basename "$PATCH")"
