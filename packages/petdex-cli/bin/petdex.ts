import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import * as p from "@clack/prompts";
import JSZip from "jszip";
import pc from "picocolors";

import pkg from "../package.json";
import { isTrustedAssetUrl } from "../src/asset-hosts.js";
import { resolveAuthConfig } from "../src/auth-config.js";
import { ClerkCliAuth } from "../src/cli-auth/index.js";
import {
  parseImageDims,
  readEditMetadataAsset,
  readEditSpriteAsset,
  readEditZipAsset,
} from "../src/edit-assets.js";
import {
  emit,
  getStatus,
  maybeShowFirstRunNotice,
  setEnabled,
} from "../src/telemetry.js";

// ─── config ────────────────────────────────────────────────────────────────
const PETDEX_URL = process.env.PETDEX_URL ?? "https://petdex.dev";
const PETDEX_REFERER = `${PETDEX_URL.replace(/\/+$/, "")}/`;
const DOWNLOAD_URL = `${PETDEX_URL.replace(/\/+$/, "")}/download`;

// Every command the desktop app absorbed. Value is the sentence that
// replaces it, so the user learns where the capability went instead of
// hunting for a flag that no longer exists. Declared here, above the
// top-level main() call, so the lookup is not in the temporal dead zone.
const DESKTOP_START_REDIRECT =
  "The desktop app runs on its own. Launch Petdex from Applications.";
const DESKTOP_STOP_REDIRECT = "Quit Petdex from its menu bar icon to stop it.";

const RETIRED_COMMANDS = new Map<string, string>([
  // Desktop Settings → Agents:
  // packages/petdex-desktop-native/src/settings_view.zig (`agentsSection`).
  ["init", "The desktop app installs its own agent hooks from Settings."],
  ["up", DESKTOP_START_REDIRECT],
  ["start", DESKTOP_START_REDIRECT],
  ["restart", DESKTOP_START_REDIRECT],
  ["down", DESKTOP_STOP_REDIRECT],
  ["stop", DESKTOP_STOP_REDIRECT],
  ["toggle", "Toggle the mascot from the Petdex menu bar icon."],
  ["desktop", "The desktop app manages its own lifecycle."],
  ["update", "The desktop app updates itself automatically."],
  // Desktop Settings → Agents:
  // packages/petdex-desktop-native/src/settings_view.zig (`agentsSection`).
  // This view renders agent/hook status and the Install/Update actions.
  ["doctor", "Petdex Settings shows agent and hook status directly."],
  ["hooks", "Install agent hooks from Petdex Settings, one click per agent."],
]);
let _auth: ClerkCliAuth | null = null;
async function getAuth({
  warnOnFallback = true,
}: {
  warnOnFallback?: boolean;
} = {}): Promise<ClerkCliAuth> {
  if (_auth) return _auth;
  const cfg = await resolveAuthConfig({
    petdexUrl: PETDEX_URL,
    warnOnFallback,
  });
  _auth = new ClerkCliAuth({
    clientId: cfg.clientId,
    issuer: cfg.issuer,
    scopes: cfg.scopes,
    storage: "keychain",
    keychainService: "petdex-cli",
  });
  return _auth;
}

const VERSION = pkg.version;

// ─── entrypoint ────────────────────────────────────────────────────────────
main().catch((err) => {
  p.cancel(`petdex: ${(err as Error).message}`);
  process.exit(1);
});

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  // Hot path: `petdex bubble <event>` runs from agent hooks on every
  // tool call. We bypass the help/notice/telemetry pipeline so the
  // Node startup is the only overhead — no extra fs reads, no
  // banner logic. Anything else here would multiply across the
  // 20-50 hooks/min an active session generates.
  if (cmd === "bubble") {
    const { runBubble } = await import("../src/hooks/bubble-runner");
    await runBubble(args.slice(1));
    return;
  }

  // `petdex mcp-server` is also a hot path run as a subprocess by
  // Antigravity. Any stdout output (telemetry notice, help text)
  // before the client sends `initialize` breaks the MCP handshake.
  if (cmd === "mcp-server") {
    const { runMcpServer } = await import("../src/hooks/mcp-server.js");
    await runMcpServer();
    return;
  }

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    return;
  }

  // Retired in v1: the desktop app owns its own lifecycle, updates, and
  // hook installation now. These names stay in the dispatcher because
  // slash commands already written to users' agent config invoke
  // `petdex up|down|doctor|hooks status`, and the download page still
  // prints `npx petdex init`. A bare "Unknown command" there reads like
  // a broken CLI; the pointer to the app is the actual fix.
  if (RETIRED_COMMANDS.has(cmd)) {
    printRetired(cmd);
    return;
  }

  // Meta commands must produce machine-readable output. `petdex --version`
  // is parsed by package managers and CI scripts; the multi-line telemetry
  // notice would corrupt that. `telemetry on|off|status` manages the
  // notice itself, so triggering it there creates a confusing UX. The
  // notice still fires on the first real command (install / submit).
  const META_COMMANDS = new Set(["version", "--version", "-v", "telemetry"]);
  if (!META_COMMANDS.has(cmd)) {
    maybeShowFirstRunNotice();
  }

  switch (cmd) {
    case "login":
      await cmdLogin();
      break;
    case "logout":
      await cmdLogout();
      break;
    case "whoami":
      await cmdWhoami();
      break;
    case "submit":
      await cmdSubmit(args.slice(1));
      break;
    case "edit":
      await cmdEdit(args.slice(1));
      break;
    case "install":
      await cmdInstall(args.slice(1));
      break;
    case "list":
      await cmdList();
      break;
    case "telemetry":
      cmdTelemetry(args.slice(1));
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    default:
      console.error(pc.red(`Unknown command: ${cmd}`));
      printHelp();
      process.exit(1);
  }
}

function printRetired(cmd: string): void {
  const detail = RETIRED_COMMANDS.get(cmd) ?? "";
  console.error(
    [
      "",
      `  ${pc.yellow("!")} ${pc.bold(`petdex ${cmd}`)} was removed in v${VERSION.split(".")[0]}.`,
      "",
      `  ${detail}`,
      `  Get the app: ${pc.underline(DOWNLOAD_URL)}`,
      "",
      `  This CLI now manages the pet catalog: ${pc.cyan("petdex list")}, ${pc.cyan("petdex install <slug>")}.`,
      "",
    ].join("\n"),
  );
}

function printHelp() {
  const c = pc.cyan;
  const dim = pc.dim;
  console.log(
    [
      "",
      `  ${pc.bold(pc.magenta("petdex"))} ${dim(VERSION)} ${dim("Codex pet gallery CLI")}`,
      "",
      `  ${c("Usage")}`,
      `    petdex <command> [args]`,
      "",
      `  ${c("Commands")}`,
      `    ${pc.bold("list")}               List approved pets`,
      `    ${pc.bold("install")} <slug...>  Install one or more pets into ~/.petdex/pets and ~/.codex/pets`,
      `    ${pc.bold("login")}              Sign in with Clerk OAuth`,
      `    ${pc.bold("logout")}             Clear stored credentials`,
      `    ${pc.bold("whoami")}             Show signed-in user`,
      `    ${pc.bold("submit")} <path>      Submit a pet folder, zip, or parent of pets (bulk)`,
      `    ${pc.bold("edit")} <slug>        Edit a pet you own (--desc, --displayName, --sprite, --meta, --zip)`,
      `    ${pc.bold("telemetry")} [on|off|status]  Manage anonymous usage telemetry`,
      `    ${pc.bold("version")}            Print the CLI version`,
      "",
      `  ${c("Examples")}`,
      `    ${dim("$")} petdex list                            ${dim("# browse the gallery")}`,
      `    ${dim("$")} petdex install boba                    ${dim("# install a pet by slug")}`,
      `    ${dim("$")} petdex install boba doraemon mochi     ${dim("# install several at once")}`,
      `    ${dim("$")} petdex login`,
      `    ${dim("$")} petdex submit ~/.codex/pets/boba       ${dim("# single folder")}`,
      "",
      `  ${dim("The desktop mascot is now the Petdex app: it installs agent hooks")}`,
      `  ${dim("from Settings and updates itself.")} ${pc.underline(DOWNLOAD_URL)}`,
      "",
      `  ${dim("Gallery & docs:")} ${pc.underline(PETDEX_URL)}`,
      "",
    ].join("\n"),
  );
}

// ─── commands ──────────────────────────────────────────────────────────────

async function cmdLogin() {
  p.intro(pc.bgMagenta(pc.white(" petdex login ")));
  const s = p.spinner();
  s.start("Opening your browser to sign in with Clerk");
  try {
    const auth = await getAuth();
    const { user } = await auth.login();
    const label = firstString(user.email, user.username, user.sub) ?? "unknown";
    s.stop(`${pc.green("✓ ")}Signed in as ${pc.cyan(label)}`);
    p.outro(
      `Try ${pc.cyan("petdex submit ~/.codex/pets")} to share your pets.`,
    );
  } catch (err) {
    s.stop(pc.red("× login failed"));
    throw new Error(translateLoginError((err as Error).message));
  }
}

async function cmdLogout() {
  const auth = await getAuth({ warnOnFallback: false });
  await auth.logout();
  console.log(`${pc.green("✓ ")}Signed out`);
}

async function cmdWhoami() {
  try {
    const auth = await getAuth();
    const me = await auth.whoami();
    if (!me) throw new Error("not signed in");
    const name = [asString(me.given_name), asString(me.family_name)]
      .filter(Boolean)
      .join(" ");
    p.note(
      [
        `${pc.dim("user:    ")}${me.sub}`,
        `${pc.dim("email:   ")}${me.email ?? "—"}`,
        `${pc.dim("name:    ")}${name || "—"}`,
        `${pc.dim("username:")}${asString(me.preferred_username) ?? "—"}`,
      ].join("\n"),
      "Signed in",
    );
  } catch {
    p.cancel(`Not signed in. Run ${pc.cyan("petdex login")}.`);
    process.exit(1);
  }
}

type ManifestPet = {
  slug: string;
  displayName: string;
  spritesheetUrl: string;
  petJsonUrl: string;
  spriteVersionNumber?: 1 | 2;
};

function parseSpriteVersionNumber(petJson: Record<string, unknown>): 1 | 2 {
  const value = petJson.spriteVersionNumber;
  if (value === undefined || value === 1) return 1;
  if (value === 2) return 2;
  throw new Error("spriteVersionNumber must be omitted, 1, or 2");
}

async function fetchManifest(): Promise<ManifestPet[]> {
  const res = await fetch(`${PETDEX_URL}/api/manifest`);
  if (!res.ok) throw new Error(`manifest fetch ${res.status}`);
  const data = (await res.json()) as { pets: ManifestPet[] };
  return data.pets;
}

async function installOne(pet: ManifestPet): Promise<void> {
  const slug = pet.slug;
  // Belt-and-braces: server-side validation already enforces the host
  // allowlist on submission, but a legacy/compromised approved row
  // could still slip a non-allowlisted URL into /api/manifest. Refuse
  // to download bytes from anything outside the trusted asset origins.
  if (
    !isTrustedAssetUrl(pet.spritesheetUrl) ||
    !isTrustedAssetUrl(pet.petJsonUrl)
  ) {
    throw new Error(
      `untrusted asset host for ${slug} (admin needs to re-upload)`,
    );
  }

  // Multi-target: ~/.petdex/pets and ~/.codex/pets so both Petdex
  // Desktop and Codex Desktop see the pet immediately.
  const petdexDir = path.join(homedir(), ".petdex", "pets", slug);
  const codexDir = path.join(homedir(), ".codex", "pets", slug);
  await Promise.all([
    mkdir(petdexDir, { recursive: true }),
    mkdir(codexDir, { recursive: true }),
  ]);

  const ext = pet.spritesheetUrl.endsWith(".png") ? "png" : "webp";
  // Validate response status before reading the body so a 404/500
  // doesn't silently land HTML inside pet.json or spritesheet.*.
  const fetchOrThrow = async (url: string): Promise<ArrayBuffer> => {
    const res = await fetch(url, { headers: { Referer: PETDEX_REFERER } });
    if (!res.ok) {
      throw new Error(`download ${url} -> ${res.status} ${res.statusText}`);
    }
    return res.arrayBuffer();
  };
  const [petJson, spritesheet] = await Promise.all([
    fetchOrThrow(pet.petJsonUrl),
    fetchOrThrow(pet.spritesheetUrl),
  ]);
  await Promise.all([
    writeFile(path.join(petdexDir, "pet.json"), Buffer.from(petJson)),
    writeFile(
      path.join(petdexDir, `spritesheet.${ext}`),
      Buffer.from(spritesheet),
    ),
    writeFile(path.join(codexDir, "pet.json"), Buffer.from(petJson)),
    writeFile(
      path.join(codexDir, `spritesheet.${ext}`),
      Buffer.from(spritesheet),
    ),
  ]);

  // Fire-and-forget install metric so the gallery counter ticks up.
  void fetch(`${PETDEX_URL}/install/${slug}`, { method: "GET" }).catch(
    () => {},
  );
}

async function cmdInstall(args: string[]) {
  const first = args[0];
  if (!first) {
    p.cancel(`Usage: ${pc.cyan("petdex install <slug> [slug...]")}`);
    process.exit(1);
  }
  // "desktop" is not a pet slug. It used to download the desktop binary,
  // which the self-updating app replaced. Treating it as a slug would
  // send the user to a confusing "no pets matched" instead.
  if (first === "desktop") {
    printRetired("desktop");
    return;
  }

  // Dedupe slugs so a user pasting a long list with a repeat does not
  // pay double bandwidth or get a confusing "installed twice" log line.
  const slugs = Array.from(new Set(args));

  const s = p.spinner();
  s.start(
    slugs.length === 1
      ? `Resolving ${slugs[0]}`
      : `Resolving ${slugs.length} pets`,
  );

  let manifest: ManifestPet[];
  try {
    manifest = await fetchManifest();
  } catch (err) {
    s.stop(pc.red("manifest failed"));
    throw err;
  }

  const found: ManifestPet[] = [];
  const missing: string[] = [];
  for (const slug of slugs) {
    const hit = manifest.find((m) => m.slug === slug);
    if (hit) found.push(hit);
    else missing.push(slug);
  }

  if (found.length === 0) {
    s.stop(pc.red("none found"));
    p.cancel(
      `No pets matched. Try ${pc.cyan("petdex list")} to see what's available.`,
    );
    process.exit(1);
  }

  // Cross-platform install implemented in Node. Earlier versions piped a
  // POSIX shell script through `sh`, which crashed on Windows where there
  // is no `sh` (#10 from kayotimoteo). We resolve asset URLs from
  // /api/manifest and write files ourselves so it works identically on
  // macOS, Linux, and Windows.
  const installed: string[] = [];
  const failed: Array<{ slug: string; reason: string }> = [];
  for (let i = 0; i < found.length; i++) {
    const pet = found[i];
    s.message(
      found.length === 1
        ? `Downloading ${pet.slug}`
        : `Downloading ${pet.slug} (${i + 1}/${found.length})`,
    );
    try {
      await installOne(pet);
      installed.push(pet.displayName);
    } catch (err) {
      failed.push({
        slug: pet.slug,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (installed.length === found.length) {
    s.stop(
      installed.length === 1
        ? `Installed ${pc.cyan(installed[0])}`
        : `Installed ${pc.cyan(installed.length)} pets`,
    );
  } else if (installed.length > 0) {
    s.stop(
      `Installed ${pc.cyan(installed.length)} of ${found.length} (${pc.red(`${failed.length} failed`)})`,
    );
  } else {
    s.stop(pc.red("all failed"));
  }

  const lines: string[] = [];
  if (installed.length > 0) {
    lines.push("Paths:");
    lines.push(`  ${pc.dim("~/.petdex/pets/")} (Petdex Desktop)`);
    lines.push(`  ${pc.dim("~/.codex/pets/")} (Codex Desktop)`);
    lines.push("");
    lines.push("Activate in Petdex Desktop: right-click the mascot.");
    lines.push("Activate in Codex Desktop:");
    lines.push(`  ${pc.cyan("Settings -> Appearance -> Pets")}`);
  }
  if (missing.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(pc.yellow(`Skipped (slug not found):`));
    for (const slug of missing) lines.push(`  ${slug}`);
  }
  if (failed.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(pc.red(`Failed:`));
    for (const f of failed) lines.push(`  ${f.slug}: ${f.reason}`);
  }
  if (lines.length > 0) p.note(lines.join("\n"), "Next steps");

  if (failed.length > 0 && installed.length === 0) {
    process.exit(1);
  }
}

async function cmdList() {
  const s = p.spinner();
  s.start("Fetching gallery");
  const res = await fetch(`${PETDEX_URL}/api/manifest`);
  if (!res.ok) {
    s.stop(pc.red("failed"));
    throw new Error(`failed to fetch manifest: ${res.status}`);
  }
  const data = (await res.json()) as {
    total: number;
    pets: Array<{
      slug: string;
      displayName: string;
      kind: string;
      submittedBy: string | null;
    }>;
  };
  s.stop(`${data.total} pets`);

  const lines = data.pets.map((pet) => {
    const tag = pet.submittedBy ? pc.dim(` by ${pet.submittedBy}`) : "";
    return `  ${pc.cyan(pet.slug.padEnd(26))} ${pet.displayName}${tag}`;
  });
  console.log(lines.join("\n"));
  console.log(
    `\n${pc.dim("Install with")} ${pc.cyan("petdex install <slug>")}\n${pc.dim("Browse:")} ${pc.underline(PETDEX_URL)}`,
  );
}

async function cmdSubmit(args: string[]) {
  const positionals = args.filter((a) => !a.startsWith("--"));
  const target = positionals[0];
  if (!target) {
    p.cancel(`Usage: ${pc.cyan("petdex submit <path> [--force]")}`);
    process.exit(1);
  }

  // Ensure auth before doing any work.
  const auth = await getAuth();
  let token: string;
  try {
    const t = await auth.getAccessToken();
    if (!t) {
      p.cancel(`Not signed in. Run ${pc.cyan("petdex login")}.`);
      process.exit(1);
    }
    token = t;
  } catch {
    p.cancel(`Not signed in. Run ${pc.cyan("petdex login")}.`);
    process.exit(1);
  }
  let profileUrl = PETDEX_URL;
  try {
    profileUrl = userProfileUrl(await auth.whoami());
  } catch {
    /* non-fatal; submit can still continue */
  }

  const absPath = path.resolve(target);
  const stats = await stat(absPath).catch(() => null);
  if (!stats) {
    p.cancel(`No such file or directory: ${target}`);
    process.exit(1);
  }

  p.intro(pc.bgMagenta(pc.white(" petdex submit ")));
  const scan = p.spinner();
  scan.start(`Scanning ${absPath}`);
  const candidates = await collectCandidates(absPath, stats.isDirectory());
  scan.stop(
    candidates.length > 0
      ? `${candidates.length} pet${candidates.length === 1 ? "" : "s"} found`
      : pc.red("no pets found"),
  );

  if (candidates.length === 0) {
    p.cancel("A pet folder must contain pet.json and spritesheet.{webp,png}.");
    process.exit(1);
  }

  // Look up which of these are already owned by this user so we can skip
  // duplicates by default. Server-side check ignores `submittedBy` collisions
  // — we only flag pets the *same* signed-in user already submitted.
  const force = args.includes("--force");
  const ownedSlugs = force
    ? new Map<string, OwnedPet>()
    : await fetchOwnedSlugs(candidates, token);

  let toSubmit = candidates;
  let skipped = 0;
  if (ownedSlugs.size > 0) {
    const dupes = candidates.filter((c) =>
      ownedSlugs.has(deriveSlug(c.petIdHint)),
    );
    const fresh = candidates.filter(
      (c) => !ownedSlugs.has(deriveSlug(c.petIdHint)),
    );
    p.note(
      dupes
        .map((c) => {
          const owned = ownedSlugs.get(deriveSlug(c.petIdHint));
          const status = owned?.status ?? "unknown";
          return `${pc.yellow("•")} ${pc.bold(c.label)} ${pc.dim(`(${status})`)}`;
        })
        .join("\n"),
      `${dupes.length} already submitted by you`,
    );
    const choice = await p.select({
      message: "How should we handle these duplicates?",
      options: [
        { value: "skip", label: "Skip duplicates (recommended)" },
        {
          value: "resubmit",
          label: "Submit all anyway (will create -2 / -3 slugs)",
        },
        { value: "cancel", label: "Cancel" },
      ],
      initialValue: "skip",
    });
    if (p.isCancel(choice) || choice === "cancel") {
      p.cancel("Aborted.");
      process.exit(1);
    }
    if (choice === "skip") {
      toSubmit = fresh;
      skipped = dupes.length;
      if (toSubmit.length === 0) {
        p.outro(
          `Nothing new to submit. Track approval at ${pc.underline(profileUrl)}.`,
        );
        return;
      }
    }
  }

  if (toSubmit.length > 1) {
    const proceed = await p.confirm({
      message: `Submit ${pc.bold(String(toSubmit.length))} pet${toSubmit.length === 1 ? "" : "s"}?`,
    });
    if (p.isCancel(proceed) || !proceed) {
      p.cancel("Aborted.");
      process.exit(1);
    }
  }

  let succeeded = 0;
  let failed = 0;
  const failures: Array<{ label: string; error: string }> = [];

  for (const cand of toSubmit) {
    const ps = p.spinner();
    ps.start(`Submitting ${pc.cyan(cand.label)}`);
    try {
      const t = await auth.getAccessToken();
      if (!t) throw new Error("session expired");
      token = t;
      const result = await submitOne(cand, token);
      profileUrl = absoluteProfileUrl(result.profileUrl) ?? profileUrl;
      ps.stop(
        `${pc.green("✓")} ${pc.cyan(cand.label)} → ${formatSubmissionOutcome(result)}`,
      );
      succeeded++;
    } catch (err) {
      const msg = (err as Error).message;
      ps.stop(
        `${pc.red("×")} ${pc.cyan(cand.label)} ${pc.red(msg.slice(0, 60))}`,
      );
      failures.push({ label: cand.label, error: msg });
      failed++;
    }
  }

  if (failures.length > 0) {
    p.note(
      failures
        .map((f) => `${pc.red("•")} ${pc.bold(f.label)}: ${f.error}`)
        .join("\n"),
      "Failures",
    );
  }

  const skipPart = skipped > 0 ? `, ${pc.yellow(String(skipped))} skipped` : "";
  p.outro(
    [
      `${pc.green(String(succeeded))} submitted${skipPart}, ${
        failed > 0 ? pc.red(String(failed)) : pc.dim(String(failed))
      } failed.`,
      `Held submissions stay visible at ${pc.underline(profileUrl)}.`,
    ].join("\n"),
  );
  if (failed > 0) process.exit(1);
}

// ─── edit ──────────────────────────────────────────────────────────────────

async function cmdEdit(args: string[]): Promise<void> {
  const positionals = args.filter((a) => !a.startsWith("--"));
  const slug = positionals[0];
  if (!slug) {
    p.cancel(
      `Usage: ${pc.cyan('petdex edit <slug> [--desc "..."] [--displayName "..."] [--sprite ./new.webp] [--meta ./pet.json] [--zip ./pet.zip]')}`,
    );
    process.exit(1);
  }

  const auth = await getAuth();
  let token: string;
  try {
    const t = await auth.getAccessToken();
    if (!t) {
      p.cancel(`Not signed in. Run ${pc.cyan("petdex login")}.`);
      process.exit(1);
    }
    token = t;
  } catch {
    p.cancel(`Not signed in. Run ${pc.cyan("petdex login")}.`);
    process.exit(1);
  }

  function flagValue(flag: string): string | null {
    const idx = args.indexOf(flag);
    if (idx === -1) return null;
    const val = args[idx + 1];
    return typeof val === "string" && !val.startsWith("--") ? val : null;
  }

  const descArg = flagValue("--desc");
  const displayNameArg = flagValue("--displayName");
  const spritePath = flagValue("--sprite");
  const metaPath = flagValue("--meta");
  const zipPath = flagValue("--zip");

  if (!descArg && !displayNameArg && !spritePath && !metaPath && !zipPath) {
    p.cancel("Nothing to edit. Provide at least one flag.");
    process.exit(1);
  }

  p.intro(pc.bgMagenta(pc.white(" petdex edit ")));
  const s = p.spinner();
  s.start(`Resolving ${slug}`);

  const petRes = await fetch(`${PETDEX_URL}/api/pets/${slug}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!petRes.ok) {
    s.stop(pc.red("not found"));
    p.cancel(`Pet "${slug}" not found or you don't own it.`);
    process.exit(1);
  }
  const petData = (await petRes.json()) as { id?: string };
  const petId = petData.id;
  if (!petId) {
    s.stop(pc.red("could not resolve pet id"));
    process.exit(1);
  }
  s.stop(`Found ${pc.cyan(slug)}`);

  const body: Record<string, unknown> = {};
  if (descArg) body.description = descArg;
  if (displayNameArg) body.displayName = displayNameArg;

  if (spritePath || metaPath || zipPath) {
    s.start("Uploading assets");
    let spriteAsset: Awaited<ReturnType<typeof readEditSpriteAsset>> | null =
      null;
    let metaBuffer: Buffer | null = null;
    let zipBuffer: Buffer | null = null;
    try {
      spriteAsset = spritePath ? await readEditSpriteAsset(spritePath) : null;
      metaBuffer = metaPath ? await readEditMetadataAsset(metaPath) : null;
      zipBuffer = zipPath ? await readEditZipAsset(zipPath) : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      s.stop(pc.red("asset validation failed"));
      p.cancel(message);
      process.exit(1);
    }
    const presignRes = await fetch(`${PETDEX_URL}/api/cli/edit-presign`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        petId,
        hasSprite: Boolean(spriteAsset),
        hasMeta: Boolean(metaBuffer),
        hasZip: Boolean(zipBuffer),
        spritesheetExt: spriteAsset?.format,
      }),
    });
    if (!presignRes.ok) {
      const text = await presignRes.text().catch(() => "");
      s.stop(pc.red(`asset presign failed: ${presignRes.status}`));
      p.cancel(text.slice(0, 120));
      process.exit(1);
    }

    const presigned = (await presignRes.json()) as {
      files?: Array<{
        role: "sprite" | "petjson" | "zip";
        uploadUrl: string;
        publicUrl: string;
      }>;
    };
    if (!Array.isArray(presigned.files)) {
      s.stop(pc.red("asset presign returned no files"));
      process.exit(1);
    }
    const slot = (role: "sprite" | "petjson" | "zip") => {
      const file = presigned.files?.find((f) => f.role === role);
      if (!file) {
        s.stop(pc.red(`asset presign missing ${role}`));
        process.exit(1);
      }
      return file;
    };

    if (spriteAsset) {
      const ss = slot("sprite");
      await putR2(ss.uploadUrl, spriteAsset.buffer, spriteAsset.contentType);
      const { width, height } = spriteAsset;
      body.spritesheetUrl = ss.publicUrl;
      body.spritesheetWidth = width;
      body.spritesheetHeight = height;
    }
    if (metaPath && metaBuffer) {
      const ms = slot("petjson");
      await putR2(ms.uploadUrl, metaBuffer, "application/json");
      body.petJsonUrl = ms.publicUrl;
      body.spriteVersionNumber = parseSpriteVersionNumber(
        JSON.parse(metaBuffer.toString("utf8")) as Record<string, unknown>,
      );
    }
    if (zipPath && zipBuffer) {
      const zs = slot("zip");
      await putR2(zs.uploadUrl, zipBuffer, "application/zip");
      body.zipUrl = zs.publicUrl;
    }
    s.stop("Assets uploaded");
  }

  s.start("Submitting edit");
  const editRes = await fetch(`${PETDEX_URL}/api/cli/edit`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Origin: PETDEX_URL,
    },
    body: JSON.stringify({ ...body, petId }),
  });

  if (!editRes.ok) {
    const text = await editRes.text().catch(() => "");
    s.stop(pc.red(`edit failed: ${editRes.status}`));
    p.cancel(text.slice(0, 120));
    process.exit(1);
  }

  const result = (await editRes.json()) as { status?: string };
  s.stop(
    result.status === "auto_approved"
      ? `${pc.green("✓")} Edit auto-approved and live`
      : `${pc.yellow("·")} Edit queued for admin review`,
  );

  emit("cli_edit_invoked", { cli_version: VERSION });
  p.outro(`Gallery: ${pc.underline(`${PETDEX_URL}/pets/${slug}`)}`);
}

// ─── candidate collection ──────────────────────────────────────────────────

type Candidate = {
  label: string;
  source: "folder" | "zip";
  petJson: string;
  petJsonObj: Record<string, unknown>;
  zipBuffer: Buffer;
  zipFileName: string;
  spritesheetBuffer: Buffer;
  spritesheetExt: "webp" | "png";
  petIdHint: string;
};

type SubmissionReviewOutcome = {
  decision: "approved" | "rejected" | "hold";
  applied: boolean;
  reasonCode: string | null;
  summary: string | null;
};

type SubmitOneResult = {
  slug: string;
  profileUrl?: string;
  review: SubmissionReviewOutcome;
};

async function collectCandidates(
  target: string,
  isDir: boolean,
): Promise<Candidate[]> {
  if (!isDir) {
    if (!target.endsWith(".zip")) {
      throw new Error(`Expected a .zip file or a folder, got: ${target}`);
    }
    const cand = await readZipCandidate(target);
    return cand ? [cand] : [];
  }

  const targetHasPetJson = await fileExists(path.join(target, "pet.json"));
  if (targetHasPetJson) {
    const cand = await readFolderCandidate(target);
    return cand ? [cand] : [];
  }

  const entries = await readdir(target, { withFileTypes: true });
  const out: Candidate[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sub = path.join(target, e.name);
    const cand = await readFolderCandidate(sub);
    if (cand) out.push(cand);
  }
  return out;
}

async function readFolderCandidate(folder: string): Promise<Candidate | null> {
  const petJsonPath = path.join(folder, "pet.json");
  if (!(await fileExists(petJsonPath))) return null;

  let spritePath = path.join(folder, "spritesheet.webp");
  let spritesheetExt: "webp" | "png" = "webp";
  if (!(await fileExists(spritePath))) {
    const pngPath = path.join(folder, "spritesheet.png");
    if (!(await fileExists(pngPath))) return null;
    spritePath = pngPath;
    spritesheetExt = "png";
  }

  const petJson = await readFile(petJsonPath, "utf8");
  let petJsonObj: Record<string, unknown> = {};
  try {
    petJsonObj = JSON.parse(petJson);
  } catch {
    throw new Error(`pet.json in ${folder} is not valid JSON`);
  }
  const spritesheetBuffer = await readFile(spritePath);

  const zip = new JSZip();
  zip.file("pet.json", petJson);
  zip.file(`spritesheet.${spritesheetExt}`, spritesheetBuffer);
  const zipBuffer = Buffer.from(
    await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
  );

  const folderName = path.basename(folder);
  return {
    label: folderName,
    source: "folder",
    petJson,
    petJsonObj,
    zipBuffer,
    zipFileName: `${folderName}.zip`,
    spritesheetBuffer,
    spritesheetExt,
    petIdHint: typeof petJsonObj.id === "string" ? petJsonObj.id : folderName,
  };
}

async function readZipCandidate(zipPath: string): Promise<Candidate | null> {
  const buf = await readFile(zipPath);
  const zip = await JSZip.loadAsync(buf);
  const petJsonEntry = zip.file("pet.json");
  const webpEntry = zip.file("spritesheet.webp");
  const pngEntry = zip.file("spritesheet.png");
  const spriteEntry = webpEntry ?? pngEntry;
  const spritesheetExt: "webp" | "png" = webpEntry ? "webp" : "png";

  if (!petJsonEntry || !spriteEntry) {
    throw new Error(
      `Zip is missing pet.json or spritesheet.{webp,png}: ${zipPath}`,
    );
  }

  const petJson = await petJsonEntry.async("string");
  let petJsonObj: Record<string, unknown> = {};
  try {
    petJsonObj = JSON.parse(petJson);
  } catch {
    throw new Error(`pet.json in zip is not valid JSON`);
  }
  const spritesheetBuffer = Buffer.from(await spriteEntry.async("uint8array"));

  const baseName = path.basename(zipPath, ".zip");
  return {
    label: baseName,
    source: "zip",
    petJson,
    petJsonObj,
    zipBuffer: buf,
    zipFileName: path.basename(zipPath),
    spritesheetBuffer,
    spritesheetExt,
    petIdHint: typeof petJsonObj.id === "string" ? petJsonObj.id : baseName,
  };
}

// ─── upload pipeline ───────────────────────────────────────────────────────

async function submitOne(
  cand: Candidate,
  bearer: string,
): Promise<SubmitOneResult> {
  const { width, height } = parseImageDims(cand.spritesheetBuffer);
  if (width === 0 || height === 0) {
    throw new Error("spritesheet dimensions could not be parsed");
  }

  const presignRes = await fetch(`${PETDEX_URL}/api/cli/submit`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      slugHint: deriveSlug(cand.petIdHint),
      petId: cand.petIdHint,
      spritesheetExt: cand.spritesheetExt,
    }),
  });

  if (!presignRes.ok) {
    const text = await presignRes.text().catch(() => "");
    throw new Error(`presign ${presignRes.status} ${text.slice(0, 100)}`);
  }

  const presigned = (await presignRes.json()) as {
    files: Array<{
      role: "zip" | "sprite" | "petjson";
      uploadUrl: string;
      publicUrl: string;
    }>;
  };

  const slot = (role: "zip" | "sprite" | "petjson") => {
    const f = presigned.files.find((x) => x.role === role);
    if (!f) throw new Error(`presign response missing ${role}`);
    return f;
  };
  const zipSlot = slot("zip");
  const spriteSlot = slot("sprite");
  const petSlot = slot("petjson");

  const spriteMime = cand.spritesheetExt === "png" ? "image/png" : "image/webp";

  await Promise.all([
    putR2(zipSlot.uploadUrl, cand.zipBuffer, "application/zip"),
    putR2(spriteSlot.uploadUrl, cand.spritesheetBuffer, spriteMime),
    putR2(
      petSlot.uploadUrl,
      Buffer.from(cand.petJson, "utf8"),
      "application/json",
    ),
  ]);

  const reg = await fetch(`${PETDEX_URL}/api/cli/submit/register`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      zipUrl: zipSlot.publicUrl,
      spritesheetUrl: spriteSlot.publicUrl,
      petJsonUrl: petSlot.publicUrl,
      petId: cand.petIdHint,
      displayName: pickString(cand.petJsonObj.displayName, "Untitled pet"),
      description: pickString(
        cand.petJsonObj.description,
        "A Codex-compatible digital pet.",
      ),
      spritesheetWidth: width,
      spritesheetHeight: height,
      spriteVersionNumber: parseSpriteVersionNumber(cand.petJsonObj),
    }),
  });

  if (!reg.ok) {
    const text = await reg.text().catch(() => "");
    throw new Error(`register ${reg.status} ${text.slice(0, 100)}`);
  }

  const data = (await reg.json()) as SubmitOneResult;
  return data;
}

function formatSubmissionOutcome(result: SubmitOneResult): string {
  const slug = pc.dim(result.slug);
  const explanation = reviewExplanation(result.review);
  if (result.review.decision === "approved") {
    return `${slug} ${pc.green("approved")}`;
  }
  if (result.review.decision === "rejected") {
    return `${slug} ${pc.red("rejected")}${explanation ? pc.dim(`: ${explanation}`) : ""}`;
  }
  return `${slug} ${pc.yellow("held for review")}${explanation ? pc.dim(`: ${explanation}`) : ""}`;
}

function reviewExplanation(review: SubmissionReviewOutcome): string | null {
  const reasonCode = review.reasonCode ?? "";
  if (reasonCode.startsWith("duplicate_")) {
    return review.summary ?? "appears to duplicate an existing pet";
  }
  if (reasonCode.startsWith("policy_")) {
    return "possible policy issue";
  }
  if (reasonCode.startsWith("asset_")) {
    return "package file or spritesheet issue";
  }
  if (reasonCode === "review_timeout") return "automated review timed out";
  if (reasonCode === "review_error" || reasonCode === "review_failed") {
    return "automated review failed";
  }
  if (review.decision === "rejected")
    return "high-confidence automated review issue";
  if (review.decision === "hold")
    return "not confident enough to approve automatically";
  return null;
}

async function putR2(
  url: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body,
  });
  if (!res.ok) {
    throw new Error(`R2 PUT ${res.status}`);
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

type OwnedPet = {
  slug: string;
  displayName: string;
  status: "pending" | "approved" | "rejected" | string;
  createdAt: string;
};

async function fetchOwnedSlugs(
  cands: Candidate[],
  bearer: string,
): Promise<Map<string, OwnedPet>> {
  const out = new Map<string, OwnedPet>();
  if (cands.length === 0) return out;
  try {
    const res = await fetch(`${PETDEX_URL}/api/cli/submit/check`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        candidates: cands.map((c) => ({
          petId: c.petIdHint,
          slugHint: deriveSlug(c.petIdHint),
        })),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return out; // older server: just skip dedup, don't block submit
    const data = (await res.json()) as { existing?: OwnedPet[] };
    for (const row of data.existing ?? []) {
      if (row && typeof row.slug === "string") out.set(row.slug, row);
    }
  } catch {
    /* server doesn't support dedup yet — fall back to old behavior */
  }
  return out;
}

function translateLoginError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid_client") || m.includes("client does not exist")) {
    return [
      "Clerk OAuth rejected this CLI build (invalid_client).",
      "This usually means your installed CLI is out of date. Try:",
      "  npm cache clean --force && npx -y petdex@latest login",
      "If it still fails: https://github.com/crafter-station/petdex/issues",
    ].join("\n");
  }
  if (
    m.includes("invalid_grant") ||
    m.includes("does not match the redirect")
  ) {
    return [
      "OAuth callback was rejected by Clerk (invalid_grant).",
      "Common cause: you closed the browser before approving, or the local",
      "callback server timed out. Try `petdex login` again.",
    ].join("\n");
  }
  if (m.includes("redirect_uri") && m.includes("pre-registered")) {
    return [
      "Clerk OAuth rejected the local callback URL.",
      "The petdex OAuth Application needs http://127.0.0.1 in its allowed",
      "redirect URLs. Please file an issue:",
      "  https://github.com/crafter-station/petdex/issues",
    ].join("\n");
  }
  return message;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function pickString(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const str = asString(value);
    if (str) return str;
  }
  return null;
}

function petdexUrl(pathname: string): string {
  const base = PETDEX_URL.replace(/\/+$/, "");
  const pathPart = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base}${pathPart}`;
}

function absoluteProfileUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return petdexUrl(value);
}

function userProfileUrl(
  user: {
    sub?: unknown;
    preferred_username?: unknown;
    username?: unknown;
  } | null,
): string {
  const handle =
    firstString(user?.preferred_username, user?.username) ??
    (typeof user?.sub === "string" ? user.sub.slice(-8).toLowerCase() : null);
  return handle
    ? petdexUrl(`/u/${encodeURIComponent(handle.toLowerCase())}`)
    : PETDEX_URL;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Mirrors deriveSlug in the web app's src/lib/slug.ts: a non-Latin pet id
 *  falls back to a deterministic pet-<hash> slug instead of "", so dedup
 *  and slugHint agree with what the server derives. Keep in sync. */
function deriveSlug(petId: string): string {
  const direct = slugify(petId);
  if (direct) return direct;
  const seed = petId.trim();
  if (!seed) return "";
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(seed)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `pet-${hash.toString(36).padStart(7, "0")}`;
}

// ─── telemetry ─────────────────────────────────────────────────────────────

function cmdTelemetry(args: string[]): void {
  const sub = args[0];
  if (sub === "on" || sub === "off") {
    // setEnabled returns false when ~/.petdex/telemetry.json can't be
    // written (read-only HOME, disk full, perms changed). Without
    // checking it we'd report "Telemetry disabled" while the live
    // config still reads enabled=true — the worst possible outcome
    // for a privacy toggle. Surface the failure and exit 1 so scripts
    // can detect it.
    const desired = sub === "on";
    if (setEnabled(desired)) {
      console.log(desired ? "Telemetry enabled" : "Telemetry disabled");
    } else {
      console.error(
        pc.red(
          `${pc.bold("Failed to persist preference.")} ~/.petdex/telemetry.json is not writable. Check filesystem permissions, then run \`petdex telemetry ${sub}\` again.`,
        ),
      );
      process.exit(1);
    }
  } else if (sub === "status" || !sub) {
    const status = getStatus();
    console.log(`Status: ${status.enabled ? "enabled" : "disabled"}`);
    if (status.install_id) console.log(`Install ID: ${status.install_id}`);
  } else {
    console.error(pc.red(`Unknown telemetry subcommand: ${sub}`));
    console.error("Use: petdex telemetry [on|off|status]");
    process.exit(1);
  }
}
