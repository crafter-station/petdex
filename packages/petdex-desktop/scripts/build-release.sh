#!/usr/bin/env bash
# Build, vtool-patch, sign, notarize, and bundle Petdex Desktop for
# both Apple Silicon (arm64) and Intel (x86_64). The two architectures
# ship as separate DMGs because:
#   - Apple's universal binary tooling (lipo) doesn't survive vtool
#     post-processing cleanly across both slices.
#   - Most users land on a download page that auto-detects arch and
#     hands them the right DMG directly.
#
# Requires env vars:
#   APPLE_API_KEY_ID, APPLE_API_ISSUER, APPLE_API_KEY,
#   SIGN_IDENTITY="Developer ID Application: ... (TEAM)"
#   ZERO_NATIVE_PATH=/Users/.../zero-native  (or pass --zero-native PATH)

set -euo pipefail

cd "$(dirname "$0")/.."

ZERO_NATIVE_PATH="${ZERO_NATIVE_PATH:-/Users/raillyhugo/Programming/railly/zero-native}"

build_arch() {
  local target="$1"     # aarch64-macos or x86_64-macos
  local label="$2"      # arm64 or x64
  local outname="$3"    # Petdex-arm64.dmg or Petdex-x64.dmg

  echo ""
  echo "=== building $label ($target) ==="
  rm -rf zig-out .zig-cache 2>/dev/null || true
  zig build -Doptimize=ReleaseSafe \
    -Dzero-native-path="$ZERO_NATIVE_PATH" \
    -Dtarget="$target"

  local bin=zig-out/bin/petdex-desktop
  echo "binary: $(file "$bin")"

  # Post-process minos. Without this the binary inherits the host
  # macOS version into LC_BUILD_VERSION and gets blocked on older
  # systems. 13.0 = Ventura, broadest reasonable floor.
  vtool -set-build-version macos 13.0 15.2 -replace -output "$bin.vtool" "$bin"
  mv "$bin.vtool" "$bin"
  chmod +x "$bin"

  # Sign bare binary (used by the CLI's `petdex install desktop`).
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$bin"

  # Bundle the .app
  local APP=Petdex.app
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/sidecar"
  cp "$bin" "$APP/Contents/MacOS/petdex-desktop"
  cp sidecar/server.js "$APP/Contents/Resources/sidecar/server.js"
  cp assets/Info.plist.template "$APP/Contents/Info.plist"
  echo "APPL????" > "$APP/Contents/PkgInfo"
  cp assets/icon.icns "$APP/Contents/Resources/AppIcon.icns"

  # Sign bundle with entitlements
  local ENT=/tmp/petdex.entitlements.plist
  cat > $ENT <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
<key>com.apple.security.network.client</key><true/>
</dict></plist>
EOF
  codesign --force --options runtime --timestamp --entitlements $ENT --sign "$SIGN_IDENTITY" "$APP/Contents/MacOS/petdex-desktop"
  codesign --force --options runtime --timestamp --entitlements $ENT --sign "$SIGN_IDENTITY" "$APP"

  # Notarize the .app
  local ZIPPED=/tmp/Petdex-$label.zip
  rm -f $ZIPPED
  ditto -c -k --keepParent "$APP" $ZIPPED
  xcrun notarytool submit $ZIPPED \
    --key "$APPLE_API_KEY" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER" \
    --wait
  xcrun stapler staple "$APP"

  # Build DMG
  local STAGE=/tmp/petdex-dmg-stage-$label
  rm -rf $STAGE
  mkdir -p $STAGE
  # ditto, not cp -R. The stapled ticket lives in extended attributes
  # (com.apple.cs.CodeDirectoryHash and friends) that plain `cp -R`
  # silently drops. Without ditto the .app inside the DMG arrives
  # un-stapled and macOS Gatekeeper greets the user with "Petdex is
  # damaged" the first time they double-click without internet — even
  # though the same .app on disk validates fine because the stapler
  # ticket is still present in the source. Hunter hit this on
  # 2026-05-11 with v0.1.7.
  ditto "$APP" "$STAGE/$APP"
  ln -s /Applications $STAGE/Applications
  rm -f "$outname"
  hdiutil create -volname "Petdex" -srcfolder $STAGE -ov -format UDZO -fs HFS+ "$outname"
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$outname"
  xcrun notarytool submit "$outname" \
    --key "$APPLE_API_KEY" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER" \
    --wait
  xcrun stapler staple "$outname"

  # Keep the bare binary too — CLI installs may want it directly.
  cp "$bin" "petdex-desktop-darwin-$label"

  rm -rf $STAGE $ZIPPED $ENT

  echo "✓ $outname built"
}

build_arch "aarch64-macos" "arm64" "Petdex-arm64.dmg"
build_arch "x86_64-macos" "x64" "Petdex-x64.dmg"
cp sidecar/server.js petdex-desktop-sidecar.js

echo ""
echo "Done. Artifacts:"
ls -la Petdex-arm64.dmg Petdex-x64.dmg petdex-desktop-darwin-arm64 petdex-desktop-darwin-x64 petdex-desktop-sidecar.js 2>/dev/null
