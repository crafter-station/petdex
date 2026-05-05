export type ResolvedPet = {
  slug: string;
  displayName: string;
  petJsonUrl: string;
  spritesheetUrl: string;
  spriteExt: "webp" | "png";
};

export function posixInstallScript(pet: ResolvedPet): string {
  const { slug, displayName, petJsonUrl, spritesheetUrl, spriteExt } = pet;
  // POSIX hard-quote: wrap in single-quotes and replace each ' with '\''.
  // After this every value, even something like
  //   "'; rm -rf $HOME; echo '"
  // is just an opaque string to /bin/sh.
  const q = (s: string) => `'${String(s).replace(/'/g, "'\\''")}'`;
  // Comment lines must also strip newlines so a displayName with a literal
  // \n can't break out into a fresh shell command.
  const safeName = String(displayName).replace(/[\r\n]+/g, " ");
  // Filename within $PET_DIR — strict slug already, but pin the regex so a
  // freak DB row can't produce path traversal.
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
    "",
    `echo "Installing ${safeName.replace(/"/g, "")} into $PET_DIR"`,
    'mkdir -p "$PET_DIR"',
    "",
    `curl -fsSL -o "$PET_DIR/pet.json" ${q(petJsonUrl)}`,
    `curl -fsSL -o "$PET_DIR/spritesheet.${safeExt}" ${q(spritesheetUrl)}`,
    "",
    `echo "Installed: ${safeName.replace(/"/g, "")}"`,
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
  // PowerShell single-quoted hard-quote: ' -> ''.
  const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
  const safeSlug = String(slug).replace(/[^a-z0-9-]/g, "");
  const safeExt = spriteExt === "png" ? "png" : "webp";
  // Strip newlines / quotes from the display name before echoing.
  const safeName = String(displayName).replace(/[\r\n"]+/g, " ");
  return [
    "# Petdex installer",
    `# https://petdex.crafter.run/pets/${safeSlug}`,
    "",
    "$ErrorActionPreference = 'Stop'",
    `$slug = ${q(safeSlug)}`,
    "$petDir = Join-Path $HOME (Join-Path '.codex' (Join-Path 'pets' $slug))",
    "",
    `Write-Host ${q(`Installing ${safeName} into `)}$petDir`,
    "New-Item -ItemType Directory -Force -Path $petDir | Out-Null",
    "",
    `Invoke-WebRequest -Uri ${q(petJsonUrl)} -OutFile (Join-Path $petDir 'pet.json') -UseBasicParsing`,
    `Invoke-WebRequest -Uri ${q(spritesheetUrl)} -OutFile (Join-Path $petDir ${q(`spritesheet.${safeExt}`)}) -UseBasicParsing`,
    "",
    `Write-Host ${q(`Installed: ${safeName}`)}`,
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
