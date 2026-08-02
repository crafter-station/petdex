#!/usr/bin/env bash
# Build, sign, notarize and staple the macOS desktop app, then stage the
# release zips beside it.
#
# This runs from a workstation, not CI: the Developer ID lives in a local
# keychain. Skipping it produces an adhoc bundle that Gatekeeper rejects
# everywhere except the machine that built it, which is exactly how
# v0.3.0 first shipped.
#
# Needs ~/.config/petdex-apple/env with:
#   APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER, SIGN_IDENTITY
#
# Usage:
#   scripts/sign-macos.sh [output-dir] [arm64|x64]
#   gh release upload desktop-vX.Y.Z <output-dir>/*.zip --clobber
set -euo pipefail

OUT="${1:-dist/macos}"
# Which Mac this build runs on. arm64 by default so the common case is
# unchanged; pass x64 for the Intel build (#609). Cross-compiled from
# either host: Zig does not need an Intel machine, but the signature and
# notarization still come from this keychain, so both architectures ship
# from the same workstation run.
ARCH="${2:-arm64}"
case "$ARCH" in
  arm64) ZIG_TARGET="aarch64-macos" ;;
  x64)   ZIG_TARGET="x86_64-macos" ;;
  *) echo "unknown arch: $ARCH (expected arm64 or x64)" >&2; exit 1 ;;
esac
PKG="packages/petdex-desktop-native"
CREDS="$HOME/.config/petdex-apple/env"

[ -f "$CREDS" ] || { echo "missing $CREDS" >&2; exit 1; }
# shellcheck disable=SC1090
set -a && . "$CREDS" && set +a

# The key path in env may be a bare filename; resolve it next to the env.
KEY="$APPLE_API_KEY"
[ -f "$KEY" ] || KEY="$(dirname "$CREDS")/$(basename "$APPLE_API_KEY")"
[ -f "$KEY" ] || { echo "missing notarization key: $APPLE_API_KEY" >&2; exit 1; }

: "${NATIVE_CLI:?set NATIVE_CLI to the native CLI built from the pinned SDK}"
: "${NATIVE_SDK_PATH:?set NATIVE_SDK_PATH to the pinned SDK checkout}"

mkdir -p "$OUT"
# Only this arch's outputs: a second run for the other arch must not
# delete what the first one produced.
rm -rf "$OUT/Petdex.app" "$OUT/petdex-desktop-darwin-$ARCH.zip" \
  "$OUT/petdex-desktop-native-darwin-$ARCH.zip" "$OUT/Petdex-$ARCH.dmg"

echo "==> build ($ARCH)"
# -Dcpu=baseline for the same reason the release workflow uses it: Zig
# targets the host CPU otherwise, and a Mac newer than the user's would
# emit instructions their machine cannot decode (#604 was exactly this
# on Windows).
(cd "$PKG" && "$NATIVE_CLI" build -Dtarget="$ZIG_TARGET" -Dcpu=baseline)

echo "==> package + sign"
# The bundle must be named Petdex.app: the name is baked into the
# signature, so renaming it afterwards breaks the seal.
(cd "$PKG" && "$NATIVE_CLI" package \
  --target macos \
  --binary zig-out/bin/petdex-desktop-native \
  --output "$OLDPWD/$OUT/Petdex.app" \
  --signing identity \
  --identity "$SIGN_IDENTITY")

# Agent logos are compiled into the binary, so only the app icon still
# has to survive packaging.
test -f "$OUT/Petdex.app/Contents/Resources/assets/icon.png"

echo "==> notarize"
ditto -c -k --keepParent "$OUT/Petdex.app" "$OUT/notarize.zip"
xcrun notarytool submit "$OUT/notarize.zip" \
  --key "$KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait
rm -f "$OUT/notarize.zip"

echo "==> staple"
# Stapling embeds the ticket so the app opens without a network round
# trip on first launch.
xcrun stapler staple "$OUT/Petdex.app"

echo "==> verify"
spctl -a -vvv "$OUT/Petdex.app"

echo "==> dmg"
# The DMG exists to make people drag the app to Applications before
# opening it. Launching a .app straight out of Downloads triggers
# macOS App Translocation: the app runs from a random read-only path
# under /var/folders, so anything it writes that points at its own
# binary (the agent hook symlink, for one) breaks on the next boot.
DMG="$OUT/Petdex-$ARCH.dmg"
STAGE="$OUT/dmg-stage"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$OUT/Petdex.app" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Petdex" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

# The DMG is signed and notarized in its own right: Gatekeeper checks
# the container the user actually double-clicks, not just what is
# inside it.
codesign --force --sign "$SIGN_IDENTITY" "$DMG"
xcrun notarytool submit "$DMG" \
  --key "$KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "$DMG"
spctl -a -vvv -t open --context context:primary-signature "$DMG"

echo "==> stage release assets"
# Both zip names carry the same notarized bundle. petdex-desktop-<target>
# is the name existing installs update through; shipping a bare
# executable under it does not work, since a lone Mach-O outside its
# bundle fails Gatekeeper the same way an unsigned app does.
ditto -c -k --keepParent "$OUT/Petdex.app" "$OUT/petdex-desktop-native-darwin-$ARCH.zip"
cp "$OUT/petdex-desktop-native-darwin-$ARCH.zip" "$OUT/petdex-desktop-darwin-$ARCH.zip"

ls -lh "$OUT"/*.zip "$DMG"
echo
echo "Upload with:"
echo "  gh release upload desktop-vX.Y.Z $OUT/*.zip $DMG --clobber"
