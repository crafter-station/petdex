#!/usr/bin/env bash
set -euo pipefail

# Apply the Petdex-owned Native SDK patch to the exact SDK used for a build.
# The operation is idempotent and fails when the pinned source no longer
# matches, so an SDK upgrade cannot silently drop the signing fix.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCHES=(
  "$ROOT/patches/native-sdk-macos-headerpad.patch"
  "$ROOT/patches/native-sdk-windows-pet-input.patch"
)
SDK="${NATIVE_SDK_PATH:-}"

if [[ -z "$SDK" ]]; then
  echo "patch-native-sdk: NATIVE_SDK_PATH is required" >&2
  exit 1
fi
if ! git -C "$SDK" rev-parse --git-dir >/dev/null 2>&1; then
  echo "patch-native-sdk: SDK checkout not found: $SDK" >&2
  exit 1
fi
for PATCH in "${PATCHES[@]}"; do
  if [[ ! -f "$PATCH" ]]; then
    echo "patch-native-sdk: patch file not found: $PATCH" >&2
    exit 1
  fi
  if git -C "$SDK" apply --unidiff-zero --reverse --check "$PATCH" >/dev/null 2>&1; then
    echo "patch-native-sdk: already applied $(basename "$PATCH")"
    continue
  fi
  if ! git -C "$SDK" apply --unidiff-zero --check "$PATCH" >/dev/null 2>&1; then
    echo "patch-native-sdk: patch does not match this SDK: $PATCH" >&2
    exit 1
  fi
  git -C "$SDK" apply --unidiff-zero "$PATCH"
  echo "patch-native-sdk: applied $(basename "$PATCH")"
done
