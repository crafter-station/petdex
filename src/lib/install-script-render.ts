export type ResolvedPet = {
  slug: string;
  displayName: string;
  petJsonUrl: string;
  spritesheetUrl: string;
  spriteExt: "webp" | "png";
};

function singleLine(value: string): string {
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

function quotePosix(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function quotePowerShell(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function posixInstallScript(pet: ResolvedPet): string {
  const { slug, displayName, petJsonUrl, spritesheetUrl, spriteExt } = pet;
  const displayNameText = singleLine(displayName);
  // Filename within $PET_DIR - strict slug already, but pin the regex so a
  // bad legacy DB row cannot produce path traversal.
  const safeSlug = String(slug).replace(/[^a-z0-9-]/g, "");
  const safeExt = spriteExt === "png" ? "png" : "webp";
  return [
    "#!/bin/sh",
    "# Petdex installer",
    `# https://petdex.crafter.run/pets/${safeSlug}`,
    "",
    "set -e",
    "",
    `PET_DIR="$HOME/.codex/pets/${safeSlug}"`,
    `DISPLAY_NAME=${quotePosix(displayNameText)}`,
    "",
    'printf "Installing %s into %s\\n" "$DISPLAY_NAME" "$PET_DIR"',
    'mkdir -p "$PET_DIR"',
    "",
    `curl -fsSL -o "$PET_DIR/pet.json" ${quotePosix(petJsonUrl)}`,
    `curl -fsSL -o "$PET_DIR/spritesheet.${safeExt}" ${quotePosix(spritesheetUrl)}`,
    "",
    'printf "Installed: %s\\n" "$DISPLAY_NAME"',
    'echo "  Path: $PET_DIR"',
    'echo ""',
    'echo "Activate it inside Codex:"',
    'echo "  Settings -> Appearance -> Pets -> select your pet"',
    'echo ""',
    'echo "Then use /pet inside Codex to wake or tuck it away."',
    "",
  ].join("\n");
}

export function powershellInstallScript(pet: ResolvedPet): string {
  const { slug, displayName, petJsonUrl, spritesheetUrl, spriteExt } = pet;
  const safeSlug = String(slug).replace(/[^a-z0-9-]/g, "");
  const safeExt = spriteExt === "png" ? "png" : "webp";
  const displayNameText = singleLine(displayName);
  return [
    "# Petdex installer",
    `# https://petdex.crafter.run/pets/${safeSlug}`,
    "",
    "$ErrorActionPreference = 'Stop'",
    `$slug = ${quotePowerShell(safeSlug)}`,
    "$petDir = Join-Path $HOME (Join-Path '.codex' (Join-Path 'pets' $slug))",
    "",
    `Write-Host ${quotePowerShell(`Installing ${displayNameText} into `)}$petDir`,
    "New-Item -ItemType Directory -Force -Path $petDir | Out-Null",
    "",
    `Invoke-WebRequest -Uri ${quotePowerShell(petJsonUrl)} -OutFile (Join-Path $petDir 'pet.json') -UseBasicParsing`,
    `Invoke-WebRequest -Uri ${quotePowerShell(spritesheetUrl)} -OutFile (Join-Path $petDir ${quotePowerShell(`spritesheet.${safeExt}`)}) -UseBasicParsing`,
    "",
    `Write-Host ${quotePowerShell(`Installed: ${displayNameText}`)}`,
    'Write-Host "  Path: $petDir"',
    'Write-Host ""',
    'Write-Host "Activate it inside Codex:"',
    'Write-Host "  Settings -> Appearance -> Pets -> select your pet"',
    'Write-Host ""',
    'Write-Host "Then use /pet inside Codex to wake or tuck it away."',
    "",
  ].join("\n");
}

export function posixNotFoundScript(slug: string): string {
  const safe = String(slug).replace(/[^a-z0-9-]/g, "");
  return [
    "#!/bin/sh",
    `echo "Pet '${safe}' not found in Petdex." >&2`,
    'echo "Browse pets at https://petdex.crafter.run" >&2',
    "exit 1",
    "",
  ].join("\n");
}

export function powershellNotFoundScript(slug: string): string {
  const safe = String(slug).replace(/[^a-z0-9-]/g, "");
  return [
    `Write-Error "Pet '${safe}' not found in Petdex."`,
    'Write-Error "Browse pets at https://petdex.crafter.run"',
    "exit 1",
    "",
  ].join("\n");
}
