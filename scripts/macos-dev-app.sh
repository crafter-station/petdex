#!/usr/bin/env bash
set -euo pipefail

# Build a local macOS app wrapper for the desktop binary.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$ROOT/packages/petdex-desktop"
APP_PATH="${PETDEX_DEV_APP_PATH:-$HOME/Applications/Petdex Dev.app}"
EXECUTABLE="$DESKTOP_DIR/zig-out/bin/petdex-desktop"
CONTENTS_DIR="$APP_PATH/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
LAUNCHER="$MACOS_DIR/PetdexDev"

mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

if [[ -f "$DESKTOP_DIR/assets/icon.icns" ]]; then
  cp "$DESKTOP_DIR/assets/icon.icns" "$RESOURCES_DIR/icon.icns"
fi

cat > "$CONTENTS_DIR/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Petdex Dev</string>
  <key>CFBundleExecutable</key>
  <string>PetdexDev</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleIdentifier</key>
  <string>run.crafter.petdex-desktop.dev</string>
  <key>CFBundleName</key>
  <string>Petdex Dev</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.0.0-dev</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

cat > "$LAUNCHER" <<LAUNCHER
#!/usr/bin/env bash
set -euo pipefail

cd "$DESKTOP_DIR"
exec "$EXECUTABLE"
LAUNCHER
chmod +x "$LAUNCHER"

echo "Petdex Dev.app ready: $APP_PATH"
