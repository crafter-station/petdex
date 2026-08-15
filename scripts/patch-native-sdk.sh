#!/usr/bin/env bash
set -euo pipefail

# Apply the Petdex-owned Native SDK patches to the exact SDK used for a build.
# The operation is idempotent and fails when the pinned source no longer
# matches, so an SDK upgrade cannot silently drop a required platform fix.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEADERPAD_PATCH="$ROOT/patches/native-sdk-macos-headerpad.patch"
ACCESSIBILITY_PATCH="$ROOT/patches/native-sdk-macos-accessibility-element.patch"
LINUX_POPUP_PATCH="$ROOT/patches/native-sdk-linux-popup-surface.patch"
SECONDARY_WINDOW_GENERATION_PATCH="$ROOT/patches/native-sdk-secondary-window-generation.patch"
WINDOWS_CANVAS_DRAG_PATCH="$ROOT/patches/native-sdk-windows-canvas-drag.patch"
SDK="${NATIVE_SDK_PATH:-}"

if [[ -z "$SDK" ]]; then
  echo "patch-native-sdk: NATIVE_SDK_PATH is required" >&2
  exit 1
fi
if ! git -C "$SDK" rev-parse --git-dir >/dev/null 2>&1; then
  echo "patch-native-sdk: SDK checkout not found: $SDK" >&2
  exit 1
fi
apply_patch() {
  local path="$1"
  local label="$2"

  if [[ ! -f "$path" ]]; then
    echo "patch-native-sdk: patch file not found: $path" >&2
    exit 1
  fi
  if git -C "$SDK" apply --reverse --check "$path" >/dev/null 2>&1; then
    echo "patch-native-sdk: $label patch already applied"
    return
  fi
  if ! git -C "$SDK" apply --check "$path" >/dev/null 2>&1; then
    echo "patch-native-sdk: $label patch does not match this SDK" >&2
    exit 1
  fi
  git -C "$SDK" apply "$path"
  echo "patch-native-sdk: applied $label fix"
}

apply_patch "$HEADERPAD_PATCH" "macOS Mach-O headerpad"
apply_patch "$ACCESSIBILITY_PATCH" "macOS accessibility element"
apply_patch "$LINUX_POPUP_PATCH" "Linux popup surface"
apply_patch "$SECONDARY_WINDOW_GENERATION_PATCH" "secondary-window content generation"
apply_patch "$WINDOWS_CANVAS_DRAG_PATCH" "Windows canvas, drag, and window services"
