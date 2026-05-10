import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import * as p from "@clack/prompts";
import JSZip from "jszip";
import pc from "picocolors";

import { ClerkCliAuth } from "../src/cli-auth/index.js";
import {
  isTrustedAssetUrl,
  runInstallDesktop,
} from "../src/desktop/install.js";
import {
  cmdDesktopStart,
  cmdDesktopStatus,
  cmdDesktopStop,
  desktopStatus,
  startDesktop,
  stopDesktop,
} from "../src/desktop/process.js";
import { runDoctor } from "../src/desktop/doctor.js";
import { runUpdate } from "../src/desktop/update.js";
import { runInstall as runHooksInstall } from "../src/hooks/install.js";
import {
  getKillswitchState,
  setKillswitchState,
  toggleKillswitch,
} from "../src/hooks/killswitch.js";
import { runUninstall as runHooksUninstall } from "../src/hooks/uninstall.js";
import {
  emit,
  getStatus,
  maybeShowFirstRunNotice,
  setEnabled,
} from "../src/telemetry.js";

// ─── config ────────────────────────────────────────────────────────────────
const PETDEX_URL = process.env.PETDEX_URL ?? "https://petdex.crafter.run";
const FALLBACK_ISSUER = "https://clerk.petdex.crafter.run";
const FALLBACK_CLIENT_ID = "LcThwEayl6KAA1Qm";
const DEFAULT_SCOPES = ["profile", "email", "openid", "offline_access"];

// Resolve OAuth config in this order:
// 1. Environment overrides (advanced users, CI)
// 2. Server-side /api/cli/auth-config (so we can rotate clientId without
//    forcing every CLI user to reinstall)
// 3. Hardcoded fallback (works offline / first-run / server down)
async function resolveAuthConfig(): Promise<{
  issuer: string;
  clientId: string;
  scopes: string[];
}> {
  const envIssuer = process.env.CLERK_ISSUER;
  const envClientId = process.env.CLERK_OAUTH_CLIENT_ID;
  if (envIssuer && envClientId) {
    return { issuer: envIssuer, clientId: envClientId, scopes: DEFAULT_SCOPES };
  }

  try {
    const res = await fetch(`${PETDEX_URL}/api/cli/auth-config`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        issuer?: unknown;
        clientId?: unknown;
        scopes?: unknown;
      };
      const issuer = typeof data.issuer === "string" ? data.issuer : null;
      const clientId = typeof data.clientId === "string" ? data.clientId : null;
      const scopes = Array.isArray(data.scopes)
        ? data.scopes.filter((s): s is string => typeof s === "string")
        : null;
      if (issuer && clientId) {
        return {
          issuer: envIssuer ?? issuer,
          clientId: envClientId ?? clientId,
          scopes: scopes && scopes.length > 0 ? scopes : DEFAULT_SCOPES,
        };
      }
    }
  } catch {
    /* fall through to baked defaults */
  }

  return {
    issuer: envIssuer ?? FALLBACK_ISSUER,
    clientId: envClientId ?? FALLBACK_CLIENT_ID,
    scopes: DEFAULT_SCOPES,
  };
}

let _auth: ClerkCliAuth | null = null;
async function getAuth(): Promise<ClerkCliAuth> {
  if (_auth) return _auth;
  const cfg = await resolveAuthConfig();
  _auth = new ClerkCliAuth({
    clientId: cfg.clientId,
    issuer: cfg.issuer,
    scopes: cfg.scopes,
    storage: "keychain",
    keychainService: "petdex-cli",
  });
  return _auth;
}

const VERSION = "0.2.0";

// ─── entrypoint ────────────────────────────────────────────────────────────
main().catch((err) => {
  p.cancel(`petdex: ${(err as Error).message}`);
  process.exit(1);
});

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    return;
  }

  // Meta commands must produce machine-readable output. `petdex --version`
  // is parsed by package managers and CI scripts; the multi-line telemetry
  // notice would corrupt that. `telemetry on|off|status` manages the
  // notice itself, so triggering it there creates a confusing UX. The
  // notice still fires on the first real command (install / submit /
  // hooks / desktop / update).
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
    case "install":
      await cmdInstall(args.slice(1));
      break;
    case "list":
      await cmdList();
      break;
    case "hooks":
      await cmdHooks(args.slice(1));
      break;
    case "desktop":
      await cmdDesktop(args.slice(1));
      break;
    case "up":
      await cmdUp();
      break;
    case "down":
      await cmdDown();
      break;
    case "toggle":
      await cmdToggle();
      break;
    case "update":
      await runUpdate(args.slice(1));
      break;
    case "doctor":
      await runDoctor();
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

function printHelp() {
  const c = pc.cyan;
  const dim = pc.dim;
  console.log(
    [
      "",
      `  ${pc.bold(pc.magenta("petdex"))} ${dim(VERSION)} ${dim("— Codex pet gallery CLI")}`,
      "",
      `  ${c("Usage")}`,
      `    petdex <command> [args]`,
      "",
      `  ${c("Commands")}`,
      `    ${pc.bold("login")}              Sign in with Clerk OAuth`,
      `    ${pc.bold("logout")}             Clear stored credentials`,
      `    ${pc.bold("whoami")}             Show signed-in user`,
      `    ${pc.bold("submit")} <path>      Submit a pet folder, zip, or parent of pets (bulk)`,
      `    ${pc.bold("install")} <slug>     Install a pet into ~/.petdex/pets and ~/.codex/pets`,
      `    ${pc.bold("install desktop")}    Install the petdex-desktop binary for your platform`,
      `    ${pc.bold("list")}               List approved pets`,
      `    ${pc.bold("hooks install")}      Wire petdex-desktop into your coding agents`,
      `    ${pc.bold("toggle")}             One-shot wake/sleep — flips the mascot on or off depending on current state`,
      `    ${pc.bold("up")}                 Force-wake the mascot — enables hooks AND launches petdex-desktop`,
      `    ${pc.bold("down")}               Force-sleep the mascot — disables hooks AND stops petdex-desktop`,
      `    ${pc.bold("desktop")} <cmd>      Manage petdex-desktop (start | stop | status)`,
      `    ${pc.bold("update")}             Pull the latest petdex-desktop release and restart`,
      `    ${pc.bold("doctor")}             Diagnose install/runtime/agents and surface fixes`,
      `    ${pc.bold("telemetry")} [on|off|status]  Manage anonymous usage telemetry`,
      "",
      `  ${c("Examples")}`,
      `    ${dim("$")} petdex login`,
      `    ${dim("$")} petdex submit ~/.codex/pets/boba       ${dim("# single folder")}`,
      `    ${dim("$")} petdex submit ~/Downloads/boba.zip     ${dim("# zip file")}`,
      `    ${dim("$")} petdex submit ~/.codex/pets            ${dim("# bulk all subfolders")}`,
      `    ${dim("$")} petdex install boba`,
      `    ${dim("$")} petdex install desktop                 ${dim("# fetch the latest binary")}`,
      `    ${dim("$")} petdex hooks install                   ${dim("# pick agents, write hooks")}`,
      `    ${dim("$")} petdex desktop start                   ${dim("# launch the mascot")}`,
      `    ${dim("$")} petdex update                          ${dim("# pull latest release")}`,
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
  const auth = await getAuth();
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

async function cmdInstall(args: string[]) {
  const slug = args[0];
  if (!slug) {
    p.cancel(`Usage: ${pc.cyan("petdex install <slug|desktop>")}`);
    process.exit(1);
  }
  if (slug === "desktop") {
    const { tag } = await runInstallDesktop();
    emit("cli_install_desktop_success", {
      cli_version: VERSION,
      os: process.platform,
      arch: process.arch,
      // Strip the `desktop-v` prefix from the release tag (e.g.
      // `desktop-v0.1.4` -> `0.1.4`) so it matches the telemetry
      // endpoint's semver-only validator. Without this the value
      // gets dropped server-side and the version adoption chart
      // stays empty.
      binary_version: tag.replace(/^desktop-v/, ""),
    });
    return;
  }

  // Cross-platform install implemented in Node. Earlier versions piped a
  // POSIX shell script through `sh`, which crashed on Windows where there is
  // no `sh` (#10 from kayotimoteo). Now we just resolve the asset URLs from
  // /api/manifest and write the files ourselves — same end result, works
  // identically on macOS, Linux, and Windows.
  const s = p.spinner();
  s.start(`Resolving ${slug}`);

  let pet: {
    slug: string;
    displayName: string;
    spritesheetUrl: string;
    petJsonUrl: string;
  };
  try {
    const manifestRes = await fetch(`${PETDEX_URL}/api/manifest`);
    if (!manifestRes.ok) {
      s.stop(pc.red("failed"));
      throw new Error(`manifest fetch ${manifestRes.status}`);
    }
    const data = (await manifestRes.json()) as {
      pets: Array<{
        slug: string;
        displayName: string;
        spritesheetUrl: string;
        petJsonUrl: string;
      }>;
    };
    const found = data.pets.find((p) => p.slug === slug);
    if (!found) {
      s.stop(pc.red("not found"));
      p.cancel(
        `No pet with slug ${pc.bold(slug)}. Try ${pc.cyan("petdex list")} to see what's available.`,
      );
      process.exit(1);
    }
    // Belt-and-braces: server-side validation already enforces the
    // host allowlist on submission, but a legacy/compromised approved
    // row could still slip a non-allowlisted URL into /api/manifest
    // (the route returns raw DB columns). Refuse to download bytes
    // from anything outside the trusted asset origins instead of
    // writing them into the user's HOME.
    if (
      !isTrustedAssetUrl(found.spritesheetUrl) ||
      !isTrustedAssetUrl(found.petJsonUrl)
    ) {
      s.stop(pc.red("untrusted asset host"));
      p.cancel(
        `Refusing to install ${pc.bold(slug)}: asset URLs are outside the petdex host allowlist. This row may need to be re-uploaded by an admin.`,
      );
      process.exit(1);
    }
    pet = found;
  } catch (err) {
    s.stop(pc.red("failed"));
    throw err;
  }

  // Multi-target install: write to ~/.petdex/pets/ AND ~/.codex/pets/ so
  // both Petdex Desktop and Codex Desktop can see the pet immediately.
  // Petdex Desktop reads from either dir via resolvePetsDir().
  const petdexDir = path.join(homedir(), ".petdex", "pets", slug);
  const codexDir = path.join(homedir(), ".codex", "pets", slug);
  s.message(`Downloading ${slug}`);

  await Promise.all([
    mkdir(petdexDir, { recursive: true }),
    mkdir(codexDir, { recursive: true }),
  ]);

  const ext = pet.spritesheetUrl.endsWith(".png") ? "png" : "webp";
  // Download once, write to both targets to save bandwidth.
  // Validate response status before reading the body so a 404/500
  // doesn't silently land HTML inside pet.json or spritesheet.*.
  const fetchOrThrow = async (url: string): Promise<ArrayBuffer> => {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`download ${url} → ${res.status} ${res.statusText}`);
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

  s.stop(`Installed ${pc.cyan(pet.displayName)}`);

  p.note(
    [
      `Paths:`,
      `  ${pc.dim(`~/.petdex/pets/${slug}`)} (Petdex Desktop)`,
      `  ${pc.dim(`~/.codex/pets/${slug}`)} (Codex Desktop)`,
      "",
      "Activate in Petdex Desktop: right-click the mascot.",
      "Activate in Codex Desktop:",
      `  ${pc.cyan("Settings → Appearance → Pets")} → select ${pc.bold(pet.displayName)}`,
    ].join("\n"),
    "Next steps",
  );
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download ${url} → ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
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
    const tag = pet.submittedBy ? pc.dim(` — by ${pet.submittedBy}`) : "";
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
      ownedSlugs.has(slugify(c.petIdHint)),
    );
    const fresh = candidates.filter(
      (c) => !ownedSlugs.has(slugify(c.petIdHint)),
    );
    p.note(
      dupes
        .map((c) => {
          const owned = ownedSlugs.get(slugify(c.petIdHint));
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
      slugHint: slugify(cand.petIdHint),
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
    return `${slug} ${pc.red("rejected")}${explanation ? pc.dim(` — ${explanation}`) : ""}`;
  }
  return `${slug} ${pc.yellow("held for review")}${explanation ? pc.dim(` — ${explanation}`) : ""}`;
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
          slugHint: slugify(c.petIdHint),
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

function parseImageDims(buf: Buffer): { width: number; height: number } {
  // PNG
  if (
    buf.length > 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // WebP
  if (
    buf.length > 30 &&
    buf.slice(0, 4).toString() === "RIFF" &&
    buf.slice(8, 12).toString() === "WEBP"
  ) {
    const fourcc = buf.slice(12, 16).toString();
    if (fourcc === "VP8X") {
      return {
        width: ((buf[24] | (buf[25] << 8) | (buf[26] << 16)) >>> 0) + 1,
        height: ((buf[27] | (buf[28] << 8) | (buf[29] << 16)) >>> 0) + 1,
      };
    }
    if (fourcc === "VP8L") {
      const b1 = buf[22];
      const b2 = buf[23];
      const b3 = buf[24];
      return {
        width: ((buf[21] | ((b1 & 0x3f) << 8)) >>> 0) + 1,
        height: (((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)) >>> 0) + 1,
      };
    }
    if (fourcc === "VP8 ") {
      for (let i = 23; i < Math.min(60, buf.length - 7); i++) {
        if (buf[i] === 0x9d && buf[i + 1] === 0x01 && buf[i + 2] === 0x2a) {
          return {
            width: (buf[i + 3] | (buf[i + 4] << 8)) & 0x3fff,
            height: (buf[i + 5] | (buf[i + 6] << 8)) & 0x3fff,
          };
        }
      }
    }
  }
  return { width: 0, height: 0 };
}

// ─── hooks ─────────────────────────────────────────────────────────────────

async function cmdHooks(args: string[]) {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    printHooksHelp();
    return;
  }
  switch (sub) {
    case "install": {
      const { installedAgents } = await runHooksInstall();
      // Only emit success when at least one agent was actually written.
      // Cancelled/no-op runs return an empty array; counting those as
      // success makes the dashboard "agents wired up" funnel lie.
      if (installedAgents.length > 0) {
        emit("cli_hooks_install_success", {
          cli_version: VERSION,
          agents: installedAgents,
        });
      }
      break;
    }
    case "toggle":
    case "on":
    case "off":
    case "status": {
      cmdHooksKillswitch(sub);
      break;
    }
    case "uninstall": {
      const removeToken = args.includes("--remove-token");
      await runHooksUninstall({ removeToken });
      break;
    }
    default:
      console.error(pc.red(`Unknown hooks command: ${sub}`));
      printHooksHelp();
      process.exit(1);
  }
}

function cmdHooksKillswitch(sub: "toggle" | "on" | "off" | "status"): void {
  let state: "on" | "off";
  if (sub === "toggle") {
    state = toggleKillswitch();
  } else if (sub === "on") {
    state = setKillswitchState("on");
  } else if (sub === "off") {
    state = setKillswitchState("off");
  } else {
    state = getKillswitchState();
  }
  if (state === "on") {
    console.log(`${pc.green("●")} Petdex hooks are ${pc.bold("ENABLED")}`);
    console.log(
      pc.dim(
        `  agent tool calls will animate the mascot when petdex-desktop is running`,
      ),
    );
  } else {
    console.log(`${pc.yellow("○")} Petdex hooks are ${pc.bold("DISABLED")}`);
    console.log(
      pc.dim(
        `  agent hooks short-circuit before any network call. Re-enable: petdex hooks on`,
      ),
    );
  }
}

// Wake-up: clears the killswitch AND ensures the desktop is running.
// This is what /petdex (no args) calls from inside an agent. The
// command is idempotent — safe to call when desktop is already up,
// or when hooks were already enabled.
async function cmdUp(): Promise<void> {
  setKillswitchState("on");
  console.log(`${pc.green("●")} Hooks ${pc.bold("ENABLED")}`);

  const status = desktopStatus();
  if (status.state === "running") {
    console.log(
      `${pc.green("●")} Desktop already running (pid ${status.pid})`,
    );
    return;
  }
  // Either stopped or stale — startDesktop handles both.
  const result = await startDesktop();
  if (result.ok) {
    console.log(
      result.alreadyRunning
        ? `${pc.dim("•")} Desktop already running (pid ${result.pid})`
        : `${pc.green("✓")} Desktop started (pid ${result.pid})`,
    );
  } else {
    console.log(`${pc.yellow("!")} ${result.reason}`);
    console.log(
      pc.dim(
        `  Install the binary first: ${pc.cyan("petdex install desktop")}`,
      ),
    );
  }
}

// One-shot toggle: if the mascot is awake (hooks on AND desktop
// running), this is `down`. Otherwise it's `up`. Drives the
// /petdex slash with no args — single keystroke flips the whole
// state. "Awake" requires BOTH because either alone is a degraded
// state worth flipping out of.
async function cmdToggle(): Promise<void> {
  const hooksOn = getKillswitchState() === "on";
  const desktopRunning = desktopStatus().state === "running";
  const awake = hooksOn && desktopRunning;
  if (awake) {
    await cmdDown();
  } else {
    await cmdUp();
  }
}

// Sleep: sets the killswitch + stops the desktop. The killswitch
// alone would silence hooks but leave the mascot floating. `down`
// is the symmetric "go away" command.
async function cmdDown(): Promise<void> {
  setKillswitchState("off");
  console.log(`${pc.yellow("○")} Hooks ${pc.bold("DISABLED")}`);

  const status = desktopStatus();
  if (status.state === "stopped") {
    console.log(`${pc.dim("•")} Desktop wasn't running`);
    return;
  }
  const result = await stopDesktop();
  if (result.ok) {
    console.log(`${pc.green("✓")} Desktop stopped (pid ${result.pid})`);
  } else {
    console.log(`${pc.dim("•")} ${result.reason}`);
  }
}

function printHooksHelp() {
  const c = pc.cyan;
  const dim = pc.dim;
  console.log(
    [
      "",
      `  ${pc.bold(pc.magenta("petdex hooks"))}`,
      "",
      `  ${c("Usage")}`,
      `    petdex hooks <command>`,
      "",
      `  ${c("Commands")}`,
      `    ${pc.bold("install")}              Wire petdex into your coding agents`,
      `    ${pc.bold("uninstall")}            Remove petdex from your agent configs (--remove-token also drops the auth token)`,
      `    ${pc.bold("toggle")}               Flip the killswitch — disable/enable hooks without restarting agents`,
      `    ${pc.bold("on")}                   Enable hooks (clears the killswitch)`,
      `    ${pc.bold("off")}                  Disable hooks (sets the killswitch — agent tool calls become no-ops)`,
      `    ${pc.bold("status")}               Show whether hooks are currently enabled`,
      "",
      `  ${c("Examples")}`,
      `    ${dim("$")} petdex hooks install`,
      `    ${dim("$")} petdex hooks toggle`,
      `    ${dim("$")} petdex hooks status`,
      "",
    ].join("\n"),
  );
}

// ─── desktop ───────────────────────────────────────────────────────────────

async function cmdDesktop(args: string[]) {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    printDesktopHelp();
    return;
  }
  switch (sub) {
    case "start":
      await cmdDesktopStart();
      emit("cli_desktop_start_success", { cli_version: VERSION });
      break;
    case "stop":
      await cmdDesktopStop();
      break;
    case "status":
      cmdDesktopStatus();
      break;
    default:
      console.error(pc.red(`Unknown desktop command: ${sub}`));
      printDesktopHelp();
      process.exit(1);
  }
}

function printDesktopHelp() {
  const c = pc.cyan;
  const dim = pc.dim;
  console.log(
    [
      "",
      `  ${pc.bold(pc.magenta("petdex desktop"))}`,
      "",
      `  ${c("Usage")}`,
      `    petdex desktop <command>`,
      "",
      `  ${c("Commands")}`,
      `    ${pc.bold("start")}     Launch petdex-desktop in the background`,
      `    ${pc.bold("stop")}      Terminate the running petdex-desktop process`,
      `    ${pc.bold("status")}    Show whether petdex-desktop is running`,
      "",
      `  ${c("Examples")}`,
      `    ${dim("$")} petdex desktop start`,
      `    ${dim("$")} petdex desktop status`,
      `    ${dim("$")} petdex desktop stop`,
      "",
    ].join("\n"),
  );
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
