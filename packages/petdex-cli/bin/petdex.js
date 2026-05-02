#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import JSZip from "jszip";

const REQUIRED = { width: 1536, height: 1872 };
const DEFAULT_URL = "https://petdex.crafter.run";

main().catch((error) => {
  console.error(`petdex: ${error.message}`);
  process.exit(1);
});

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));

  if (options.help || command === "help") {
    printHelp();
    return;
  }

  if (command !== "upload" && command !== "list") {
    throw new Error(`Unknown command "${command}". Run petdex --help.`);
  }

  const petsDir = expandHome(
    options.dir ?? process.env.PETDEX_PETS_DIR ?? "~/.codex/pets",
  );
  const candidates = await findCandidates(petsDir);

  if (candidates.length === 0) {
    throw new Error(`No characters found in ${petsDir}`);
  }

  printCandidates(candidates, petsDir);

  if (command === "list") return;

  const selected = await selectCandidates(candidates, options);
  if (selected.length === 0) {
    console.log("No characters selected.");
    return;
  }

  const token = options.token ?? process.env.PETDEX_TOKEN;
  if (!token) {
    throw new Error("Set PETDEX_TOKEN or pass --token to upload.");
  }

  const apiBase = normalizeUrl(
    options.url ?? process.env.PETDEX_URL ?? DEFAULT_URL,
  );
  const ownerEmail = options.email ?? process.env.PETDEX_OWNER_EMAIL;

  for (const candidate of selected) {
    if (candidate.issues.length > 0) {
      console.log(`Skipping ${candidate.displayName}: ${candidate.issues[0]}`);
      continue;
    }

    console.log(`Uploading ${candidate.displayName}...`);
    const result = await uploadCandidate(candidate, {
      apiBase,
      token,
      ownerEmail,
    });
    console.log(
      `Submitted ${candidate.displayName} for review: ${apiBase}/pets/${result.slug}`,
    );
  }
}

async function findCandidates(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dir = path.join(root, entry.name);
    const petJsonPath = path.join(dir, "pet.json");
    if (!(await isFile(petJsonPath))) continue;

    const issues = [];
    let petJson = {};
    let petJsonString = "";
    try {
      petJsonString = await readFile(petJsonPath, "utf8");
      petJson = JSON.parse(petJsonString);
    } catch {
      issues.push("pet.json is not valid JSON");
    }

    const spriteName =
      typeof petJson.spritesheetPath === "string" &&
      petJson.spritesheetPath.trim()
        ? petJson.spritesheetPath.trim()
        : "spritesheet.webp";
    const spritesheetPath = path.resolve(dir, spriteName);
    if (!isInsideDir(dir, spritesheetPath)) {
      issues.push("spritesheetPath must stay inside the character folder");
    }
    if (!(await isFile(spritesheetPath))) {
      issues.push(`Missing ${spriteName}`);
    }

    let dimensions = null;
    if (await isFile(spritesheetPath)) {
      dimensions = getWebpDimensions(await readFile(spritesheetPath));
      if (!dimensions) {
        issues.push("spritesheet.webp is not a readable WebP image");
      } else if (
        dimensions.width !== REQUIRED.width ||
        dimensions.height !== REQUIRED.height
      ) {
        issues.push(
          `spritesheet.webp must be ${REQUIRED.width}x${REQUIRED.height}, got ${dimensions.width}x${dimensions.height}`,
        );
      }
    }

    const id =
      typeof petJson.id === "string" && petJson.id.trim()
        ? petJson.id.trim()
        : entry.name;
    const displayName =
      typeof petJson.displayName === "string" && petJson.displayName.trim()
        ? petJson.displayName.trim()
        : titleize(id);
    const description =
      typeof petJson.description === "string" && petJson.description.trim()
        ? petJson.description.trim()
        : "A Codex-compatible digital pet.";

    candidates.push({
      dir,
      id,
      displayName,
      description,
      petJson,
      petJsonPath,
      petJsonString,
      slug: slugify(id || displayName),
      spritesheetPath,
      dimensions,
      issues,
    });
  }

  return candidates.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function printCandidates(candidates, petsDir) {
  console.log(`Found ${candidates.length} character(s) in ${petsDir}:`);
  candidates.forEach((candidate, index) => {
    const dims = candidate.dimensions
      ? `${candidate.dimensions.width}x${candidate.dimensions.height}`
      : "unknown size";
    const status =
      candidate.issues.length > 0 ? `blocked: ${candidate.issues[0]}` : "ready";
    console.log(
      `${String(index + 1).padStart(2, " ")}. ${candidate.displayName} (${candidate.id}) - ${dims} - ${status}`,
    );
  });
}

async function selectCandidates(candidates, options) {
  if (options.all) return candidates;

  if (options.pet?.length) {
    const requested = new Set(options.pet);
    return candidates.filter(
      (candidate) =>
        requested.has(candidate.id) || requested.has(candidate.slug),
    );
  }

  if (options.yes) {
    return candidates.filter((candidate) => candidate.issues.length === 0);
  }

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      "Select characters to upload (numbers, comma-separated, or all): ",
    );
    return parseSelection(answer, candidates);
  } finally {
    rl.close();
  }
}

function parseSelection(answer, candidates) {
  const trimmed = answer.trim().toLowerCase();
  if (!trimmed) return [];
  if (trimmed === "all" || trimmed === "*") return candidates;

  const selected = [];
  for (const part of trimmed.split(",")) {
    const value = part.trim();
    const index = Number(value);
    if (Number.isInteger(index) && index >= 1 && index <= candidates.length) {
      selected.push(candidates[index - 1]);
      continue;
    }

    const match = candidates.find(
      (candidate) => candidate.id === value || candidate.slug === value,
    );
    if (match) {
      selected.push(match);
      continue;
    }

    throw new Error(`Unknown selection "${value}"`);
  }

  return [...new Set(selected)];
}

async function uploadCandidate(candidate, { apiBase, ownerEmail, token }) {
  const zipBuffer = await buildZip(candidate);
  const petJson = normalizedPetJson(candidate);
  const petJsonString = `${JSON.stringify(petJson, null, 2)}\n`;
  const spritesheetBuffer = await readFile(candidate.spritesheetPath);

  const formData = new FormData();
  formData.append(
    "zip",
    new File([zipBuffer], `${candidate.slug}.zip`, { type: "application/zip" }),
  );
  formData.append(
    "spritesheet",
    new File([spritesheetBuffer], `${candidate.slug}-spritesheet.webp`, {
      type: "image/webp",
    }),
  );
  formData.append(
    "petJson",
    new File([petJsonString], `${candidate.slug}-pet.json`, {
      type: "application/json",
    }),
  );
  formData.append("displayName", candidate.displayName);
  formData.append("description", candidate.description);
  formData.append("petId", candidate.id);
  if (ownerEmail) formData.append("ownerEmail", ownerEmail);

  const response = await fetch(`${apiBase}/api/cli/submit`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.message ?? data.error ?? `HTTP ${response.status}`;
    throw new Error(`Upload failed for ${candidate.displayName}: ${message}`);
  }

  return data;
}

async function buildZip(candidate) {
  const zip = new JSZip();
  zip.file(
    "pet.json",
    `${JSON.stringify(normalizedPetJson(candidate), null, 2)}\n`,
  );
  zip.file("spritesheet.webp", await readFile(candidate.spritesheetPath));
  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
}

function normalizedPetJson(candidate) {
  return {
    ...candidate.petJson,
    id: candidate.id,
    displayName: candidate.displayName,
    description: candidate.description,
    spritesheetPath: "spritesheet.webp",
  };
}

function parseArgs(args) {
  let command = "upload";
  const options = { pet: [] };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (index === 0 && !arg.startsWith("-")) {
      command = arg;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--dir") {
      options.dir = readOptionValue(args, ++index, arg);
    } else if (arg === "--url") {
      options.url = readOptionValue(args, ++index, arg);
    } else if (arg === "--token") {
      options.token = readOptionValue(args, ++index, arg);
    } else if (arg === "--email") {
      options.email = readOptionValue(args, ++index, arg);
    } else if (arg === "--pet") {
      options.pet.push(readOptionValue(args, ++index, arg));
    } else {
      throw new Error(`Unknown option "${arg}"`);
    }
  }

  return { command, options };
}

function readOptionValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`petdex CLI

Usage:
  petdex upload [--dir ~/.codex/pets] [--url https://petdex.crafter.run]
  petdex list

Options:
  --all             Select every detected character
  --yes, -y         Non-interactive: select all ready characters
  --pet <id>        Select one character by id or slug; repeatable
  --dir <path>      Pets directory (default: ~/.codex/pets)
  --url <url>       Petdex URL (default: ${DEFAULT_URL})
  --token <token>   Upload token (or PETDEX_TOKEN)
  --email <email>   Owner email attached to the submission
  --help, -h        Show help
`);
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function normalizeUrl(value) {
  return value.replace(/\/+$/, "");
}

function slugify(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function titleize(value) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function isInsideDir(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function getWebpDimensions(bytes) {
  if (
    bytes.length < 30 ||
    readAscii(bytes, 0, 4) !== "RIFF" ||
    readAscii(bytes, 8, 12) !== "WEBP"
  ) {
    return null;
  }

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunk = readAscii(bytes, offset, offset + 4);
    const size = readUint32Le(bytes, offset + 4);
    const dataOffset = offset + 8;

    if (dataOffset + size > bytes.length) return null;

    if (chunk === "VP8X" && size >= 10) {
      return {
        width: 1 + readUint24Le(bytes, dataOffset + 4),
        height: 1 + readUint24Le(bytes, dataOffset + 7),
      };
    }

    if (chunk === "VP8L" && size >= 5 && bytes[dataOffset] === 0x2f) {
      const b1 = bytes[dataOffset + 1] ?? 0;
      const b2 = bytes[dataOffset + 2] ?? 0;
      const b3 = bytes[dataOffset + 3] ?? 0;
      const b4 = bytes[dataOffset + 4] ?? 0;
      return {
        width: 1 + (((b2 & 0x3f) << 8) | b1),
        height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
      };
    }

    if (chunk === "VP8 " && size >= 10) {
      const frameOffset = dataOffset + 3;
      if (
        bytes[frameOffset] === 0x9d &&
        bytes[frameOffset + 1] === 0x01 &&
        bytes[frameOffset + 2] === 0x2a
      ) {
        return {
          width: readUint16Le(bytes, frameOffset + 3) & 0x3fff,
          height: readUint16Le(bytes, frameOffset + 5) & 0x3fff,
        };
      }
    }

    offset = dataOffset + size + (size % 2);
  }

  return null;
}

function readAscii(bytes, start, end) {
  return String.fromCharCode(...bytes.slice(start, end));
}

function readUint16Le(bytes, offset) {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint24Le(bytes, offset) {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16)
  );
}

function readUint32Le(bytes, offset) {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}
