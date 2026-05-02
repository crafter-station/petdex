#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import JSZip from "jszip";

const REQUIRED = { width: 1536, height: 1872 };
const DEFAULT_URL = "https://petdex.crafter.run";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

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

  if (
    !["upload", "list", "install", "login", "logout", "whoami"].includes(
      command,
    )
  ) {
    throw new Error(`Unknown command "${command}". Run petdex --help.`);
  }

  if (command !== "install" && options.args.length > 0) {
    throw new Error(
      `Unexpected argument "${options.args[0]}". Run petdex --help.`,
    );
  }

  if (command === "install") {
    await install(options);
    return;
  }

  if (command === "login") {
    await login(options);
    return;
  }

  if (command === "logout") {
    await logout();
    return;
  }

  if (command === "whoami") {
    await whoami();
    return;
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

  const config = await readConfig();
  const apiBase = normalizeUrl(
    options.url ?? process.env.PETDEX_URL ?? config?.siteUrl ?? DEFAULT_URL,
  );
  const token =
    options.token ??
    process.env.PETDEX_TOKEN ??
    tokenFromConfig(config, apiBase);
  if (!token) {
    throw new Error("Run `petdex login` or set PETDEX_TOKEN before uploading.");
  }

  const ownerEmail =
    options.email ??
    process.env.PETDEX_OWNER_EMAIL ??
    emailFromConfig(config, apiBase);

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

async function login(options) {
  const config = await readConfig();
  const apiBase = normalizeUrl(
    options.url ?? process.env.PETDEX_URL ?? config?.siteUrl ?? DEFAULT_URL,
  );
  const state = randomBytes(24).toString("base64url");
  const result = await waitForBrowserLogin(apiBase, state);

  await writeConfig({
    siteUrl: result.siteUrl ?? apiBase,
    token: result.token,
    ownerEmail: result.ownerEmail,
    expiresAt: result.expiresAt,
    loggedInAt: new Date().toISOString(),
  });

  console.log(
    `Logged in to ${result.siteUrl ?? apiBase}${result.ownerEmail ? ` as ${result.ownerEmail}` : ""}.`,
  );
}

async function logout() {
  try {
    await unlink(configFilePath());
    console.log("Logged out of Petdex CLI.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    console.log("Petdex CLI is already logged out.");
  }
}

async function whoami() {
  const config = await readConfig();
  if (!config?.token) {
    throw new Error("Not logged in. Run `petdex login`.");
  }

  console.log(`Site: ${config.siteUrl ?? DEFAULT_URL}`);
  console.log(`Account: ${config.ownerEmail ?? "unknown"}`);
  if (config.expiresAt) console.log(`Expires: ${config.expiresAt}`);
}

async function install(options) {
  const config = await readConfig();
  const apiBase = normalizeUrl(
    options.url ?? process.env.PETDEX_URL ?? config?.siteUrl ?? DEFAULT_URL,
  );
  const requested = [...options.args, ...options.pet];
  const choices = requested.length
    ? requested.map((slug) => ({ slug, displayName: titleize(slug) }))
    : await selectInstallChoices(await fetchInstallManifest(apiBase), options);

  if (choices.length === 0) {
    console.log("No pets selected.");
    return;
  }

  for (const choice of choices) {
    await installSlug(apiBase, choice.slug);
  }
}

async function fetchInstallManifest(apiBase) {
  const response = await fetch(`${apiBase}/packs/manifest.json`);
  if (!response.ok) {
    throw new Error(`Could not load Petdex manifest: HTTP ${response.status}`);
  }
  const manifest = await response.json();
  if (!Array.isArray(manifest.pets)) {
    throw new Error("Petdex manifest did not include a pets list.");
  }
  return manifest.pets
    .filter(
      (pet) =>
        typeof pet.slug === "string" && typeof pet.displayName === "string",
    )
    .map((pet) => ({ slug: pet.slug, displayName: pet.displayName }));
}

async function selectInstallChoices(pets, options) {
  if (pets.length === 0) {
    throw new Error("No installable pets found in Petdex manifest.");
  }

  console.log("Installable Petdex pets:");
  pets.forEach((pet, index) => {
    console.log(
      `${String(index + 1).padStart(2, " ")}. ${pet.displayName} (${pet.slug})`,
    );
  });

  if (options.all || options.yes) return pets;

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      "Select pets to install (numbers, comma-separated, or all): ",
    );
    return parseSelection(answer, pets);
  } finally {
    rl.close();
  }
}

async function installSlug(apiBase, slug) {
  const safeSlug = slugify(slug);
  if (!safeSlug) {
    throw new Error(`Invalid pet slug "${slug}"`);
  }

  const response = await fetch(
    `${apiBase}/install/${encodeURIComponent(safeSlug)}`,
  );
  const script = await response.text();
  if (!response.ok) {
    throw new Error(
      `Install failed for ${safeSlug}: ${firstNonEmptyLine(script) ?? `HTTP ${response.status}`}`,
    );
  }

  await runShellScript(script);
}

function runShellScript(script) {
  if (process.platform === "win32") {
    throw new Error("petdex install requires a POSIX shell.");
  }

  return new Promise((resolve, reject) => {
    const child = spawn("sh", [], { stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Install script exited with code ${code}`));
      }
    });
    child.stdin.end(script);
  });
}

async function waitForBrowserLogin(apiBase, state) {
  let settle;
  let rejectLogin;
  const loginResult = new Promise((resolve, reject) => {
    settle = resolve;
    rejectLogin = reject;
  });
  let completed = false;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/callback") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(callbackHtml());
      return;
    }

    if (req.method === "POST" && url.pathname === "/complete") {
      try {
        const body = await readJsonBody(req);
        if (body.state !== state) {
          throw new Error("CLI login state did not match.");
        }
        if (typeof body.token !== "string" || !body.token) {
          throw new Error("CLI login did not return a token.");
        }
        if (!completed) {
          completed = true;
          settle({
            expiresAt:
              typeof body.expiresAt === "string" && body.expiresAt
                ? body.expiresAt
                : null,
            ownerEmail:
              typeof body.ownerEmail === "string" && body.ownerEmail
                ? body.ownerEmail
                : null,
            siteUrl:
              typeof body.siteUrl === "string" && body.siteUrl
                ? normalizeUrl(body.siteUrl)
                : apiBase,
            token: body.token,
          });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : "Login failed",
          }),
        );
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not start local CLI login callback.");
  }

  const callback = `http://127.0.0.1:${address.port}/callback`;
  const authUrl = new URL("/cli-auth", apiBase);
  authUrl.searchParams.set("callback", callback);
  authUrl.searchParams.set("state", state);

  console.log(`Opening ${authUrl.toString()}`);
  if (!openBrowser(authUrl.toString())) {
    console.log("Open this URL in your browser to finish login:");
    console.log(authUrl.toString());
  }

  const timeout = setTimeout(() => {
    rejectLogin(new Error("Timed out waiting for browser login."));
  }, LOGIN_TIMEOUT_MS);

  try {
    return await loginResult;
  } finally {
    clearTimeout(timeout);
    server.close();
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
  const options = { args: [], pet: [] };

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
    } else if (!arg.startsWith("-")) {
      options.args.push(arg);
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
  petdex login [--url https://petdex.crafter.run]
  petdex install <slug> [--url https://petdex.crafter.run]
  petdex install [--url https://petdex.crafter.run]
  petdex upload [--dir ~/.codex/pets] [--url https://petdex.crafter.run]
  petdex list
  petdex whoami
  petdex logout

Options:
  --all             Select every detected character
  --yes, -y         Non-interactive: select all ready characters/pets
  --pet <id>        Select one character/pet by id or slug; repeatable
  --dir <path>      Pets directory (default: ~/.codex/pets)
  --url <url>       Petdex URL (default: ${DEFAULT_URL})
  --token <token>   Upload token override (or PETDEX_TOKEN)
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

function firstNonEmptyLine(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/^#? ?/, "").trim())
    .find(Boolean);
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function readConfig() {
  try {
    return JSON.parse(await readFile(configFilePath(), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeConfig(config) {
  const filePath = configFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(filePath, 0o600).catch(() => {});
}

function configFilePath() {
  const configRoot =
    process.env.PETDEX_CONFIG_HOME ??
    process.env.XDG_CONFIG_HOME ??
    path.join(os.homedir(), ".config");
  return path.join(configRoot, "petdex", "config.json");
}

function tokenFromConfig(config, apiBase) {
  if (
    !config?.token ||
    normalizeUrl(config.siteUrl ?? DEFAULT_URL) !== apiBase
  ) {
    return null;
  }
  return config.token;
}

function emailFromConfig(config, apiBase) {
  if (
    !config?.ownerEmail ||
    normalizeUrl(config.siteUrl ?? DEFAULT_URL) !== apiBase
  ) {
    return undefined;
  }
  return config.ownerEmail;
}

function openBrowser(url) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args =
    process.platform === "darwin"
      ? [url]
      : process.platform === "win32"
        ? ["/c", "start", "", url]
        : [url];

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function callbackHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Petdex CLI Login</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 3rem; color: #111; }
      main { max-width: 34rem; margin: 0 auto; line-height: 1.6; }
    </style>
  </head>
  <body>
    <main>
      <h1>Finishing Petdex CLI login...</h1>
      <p>You can close this tab once the terminal says login completed.</p>
    </main>
    <script>
      const params = new URLSearchParams(window.location.hash.slice(1));
      fetch("/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(params))
      }).then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        document.querySelector("h1").textContent = "Petdex CLI login complete";
        document.querySelector("p").textContent = "Return to your terminal.";
      }).catch((error) => {
        document.querySelector("h1").textContent = "Petdex CLI login failed";
        document.querySelector("p").textContent = error.message;
      });
    </script>
  </body>
</html>`;
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
