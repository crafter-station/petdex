#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE_DIR="$ROOT/crates/petdex-core"
MACOS_DIR="$ROOT/crates/petdex-macos"
PLIST_TEMPLATE="$MACOS_DIR/Info.plist.template"
ICON_SOURCE="$ROOT/public/brand/petdex-desktop-icon.png"
DIST_DIR="$MACOS_DIR/dist"
APP_BUNDLE="$DIST_DIR/Petdex.app"
CONTENTS_DIR="$APP_BUNDLE/Contents"
APP_MACOS_DIR="$CONTENTS_DIR/MacOS"
APP_RESOURCES_DIR="$CONTENTS_DIR/Resources"

PETDEX_VERSION="${PETDEX_VERSION:-0.1.0}"
PETDEX_BUILD_NUMBER="${PETDEX_BUILD_NUMBER:-1}"

if [[ ! -f "$PLIST_TEMPLATE" ]]; then
  echo "build-macos-swift-app: missing Info.plist.template at $PLIST_TEMPLATE" >&2
  exit 1
fi

if [[ ! -f "$ICON_SOURCE" ]]; then
  echo "build-macos-swift-app: missing icon source at $ICON_SOURCE" >&2
  exit 1
fi

echo "==> Building crates/petdex-core (release)"
cargo build --release --manifest-path "$CORE_DIR/Cargo.toml"

echo "==> Building crates/petdex-macos (release)"
swift build -c release --package-path "$MACOS_DIR"

BIN_DIR="$(swift build -c release --package-path "$MACOS_DIR" --show-bin-path)"
EXECUTABLE="$BIN_DIR/PetdexMacOS"
if [[ ! -x "$EXECUTABLE" ]]; then
  echo "build-macos-swift-app: built executable not found at $EXECUTABLE" >&2
  exit 1
fi

echo "==> Generating AppIcon.icns from $ICON_SOURCE"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
ICONSET_DIR="$TMP_DIR/AppIcon.iconset"
mkdir -p "$ICONSET_DIR"

sips -z 16 16     "$ICON_SOURCE" --out "$ICONSET_DIR/icon_16x16.png" >/dev/null
sips -z 32 32     "$ICON_SOURCE" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null
sips -z 32 32     "$ICON_SOURCE" --out "$ICONSET_DIR/icon_32x32.png" >/dev/null
sips -z 64 64     "$ICON_SOURCE" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null
sips -z 128 128   "$ICON_SOURCE" --out "$ICONSET_DIR/icon_128x128.png" >/dev/null
sips -z 256 256   "$ICON_SOURCE" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null
sips -z 256 256   "$ICON_SOURCE" --out "$ICONSET_DIR/icon_256x256.png" >/dev/null
sips -z 512 512   "$ICON_SOURCE" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null
sips -z 512 512   "$ICON_SOURCE" --out "$ICONSET_DIR/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$ICON_SOURCE" --out "$ICONSET_DIR/icon_512x512@2x.png" >/dev/null

ICNS_PATH="$TMP_DIR/AppIcon.icns"
iconutil -c icns "$ICONSET_DIR" -o "$ICNS_PATH"

echo "==> Assembling $APP_BUNDLE"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_MACOS_DIR" "$APP_RESOURCES_DIR"

cp "$EXECUTABLE" "$APP_MACOS_DIR/PetdexMacOS"
chmod +x "$APP_MACOS_DIR/PetdexMacOS"
cp "$ICNS_PATH" "$APP_RESOURCES_DIR/AppIcon.icns"

RESOURCE_BUNDLE="$BIN_DIR/PetdexMacOS_PetdexMacOS.bundle"
if [[ -d "$RESOURCE_BUNDLE" ]]; then
  cp -R "$RESOURCE_BUNDLE" "$APP_RESOURCES_DIR/"
fi

sed \
  -e "s/__PETDEX_VERSION__/$PETDEX_VERSION/g" \
  -e "s/__PETDEX_BUILD_NUMBER__/$PETDEX_BUILD_NUMBER/g" \
  "$PLIST_TEMPLATE" > "$CONTENTS_DIR/Info.plist"

if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP_BUNDLE" >/dev/null 2>&1 || true
fi

echo "==> Done: $APP_BUNDLE"
