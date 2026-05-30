#!/usr/bin/env node
/**
 * Petdex Desktop sidecar HTTP server.
 *
 * Listens on POST /state with { state, duration? } and writes the requested
 * state to ~/.petdex/runtime/state.json. The WebView polls that file every
 * ~200ms and applies the state to the mascot animation.
 *
 * Spawned by petdex-desktop at startup. Talks the same `state` vocabulary
 * as the spritesheet rows: idle, running, running-left, running-right,
 * waving, jumping, failed, review, waiting.
 *
 * Runs on Node ≥ 18 — no third-party deps. Devs using coding agents have
 * Node available almost universally; that's a much safer assumption than
 * requiring Bun.
 */

import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { homedir, arch as nodeArch, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { nextRunningVariant } from "./running-variant";
import { StateQueue } from "./state-queue";
import {
  DEFAULT_DESKTOP_PREFERENCES,
  type DesktopPreferences,
  type DesktopRelease,
  downloadToFile,
  findDmgAsset,
  findEnclosingAppBundle,
  installStagedAppBundle,
  parseDesktopPreferences,
  parseHdiutilMount,
} from "./update-utils";

const PORT = Number(process.env.PETDEX_PORT ?? 7777);
const RUNTIME_DIR = join(homedir(), ".petdex", "runtime");
const STATE_PATH = join(RUNTIME_DIR, "state.json");
const BUBBLE_PATH = join(RUNTIME_DIR, "bubble.json");
const UPDATE_PATH = join(RUNTIME_DIR, "update.json");
const UPDATE_LOG_PATH = join(RUNTIME_DIR, "update.log");
const UPDATE_TOKEN_PATH = join(RUNTIME_DIR, "update-token");
const VERSION_FILE = join(homedir(), ".petdex", "version");
const PREFERENCES_PATH = join(homedir(), ".petdex", "preferences.json");
const INIT_STATUS_PATH = join(RUNTIME_DIR, "init-status.json");
const PERSISTED_BINARY_PATH = join(homedir(), ".petdex", "bin", "petdex.js");
const LOG_PATH = join(RUNTIME_DIR, "sidecar.log");
const MAX_BODY_BYTES = 64 * 1024;
// Listing the last N releases instead of `/releases/latest` because
// the petdex repo publishes multiple release lineages (desktop-v*,
// web-v*, sidecar-v*) under the same tag namespace. `latest` returns
// whichever was published last regardless of prefix, so a non-desktop
// release would make the sidecar surface a bogus update prompt and
// the eventual fetch would 404 because the asset doesn't exist on
// that tag. We paginate (newest-first) until we find a desktop-v*
// or exhaust the cap, so a long streak of web-v*/sidecar-v* releases
// can't hide the latest desktop tag.
const RELEASES_API_BASE =
  "https://api.github.com/repos/crafter-station/petdex/releases";
const RELEASES_PAGE_SIZE = 30;
const RELEASES_MAX_PAGES = 5;
const DESKTOP_TAG_PREFIX = "desktop-v";
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const UPDATE_CHECK_INITIAL_DELAY_MS = 30 * 1000; // 30s after launch
const UPDATE_TOKEN_HEADER = "x-petdex-update-token";

const VALID_STATES = new Set([
  "idle",
  "running",
  "running-left",
  "running-right",
  "waving",
  "jumping",
  "failed",
  "review",
  "waiting",
]);

mkdirSync(RUNTIME_DIR, { recursive: true });

// Token-bucket rate limiter for POST /state. The bucket holds at
// most STATE_RATE_BURST tokens and refills at STATE_RATE_PER_SEC
// per second. A real coding agent under heavy load (rapid greps,
// tight tool loops) tops out around 5-10 tool calls/sec, so 30/sec
// is well above that. The bucket protects against runaway hooks
// (infinite loops in user pre-tool scripts, malicious plugins) by
// 429-ing once exhausted; agent-side curl swallows the response so
// the agent never sees the error.
const STATE_RATE_PER_SEC = 30;
const STATE_RATE_BURST = 60;
type RateLimiter = { consume: () => boolean };
const stateRateLimiter: RateLimiter = (() => {
  let tokens = STATE_RATE_BURST;
  let lastRefill = Date.now();
  return {
    consume(): boolean {
      const now = Date.now();
      const elapsed = (now - lastRefill) / 1000;
      if (elapsed > 0) {
        tokens = Math.min(
          STATE_RATE_BURST,
          tokens + elapsed * STATE_RATE_PER_SEC,
        );
        lastRefill = now;
      }
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
})();

// Generate a fresh per-session token for POST /update + POST /state.
// Without this any website the user visits could fire
// `fetch("http://127.0.0.1:7777/update", { method: "POST",
// mode: "no-cors" })` and trigger a silent npm install of arbitrary
// `petdex@latest` code — CORS only blocks the response, never the
// request itself.
//
// The token lives in memory now and only gets persisted to disk
// AFTER server.listen succeeds. That avoids a nasty failure mode:
// if a stale sidecar is already bound to :7777, the second instance
// would otherwise overwrite the token file before crashing on
// EADDRINUSE, leaving the live sidecar with the old in-memory token
// and the file holding a token nothing accepts. Hooks/update would
// silently 401 until the live process restarts.
//
// File mode is 0600 so only the user can read it. The Zig bridge
// reads it from disk and forwards it as a header when curl-ing the
// sidecar; remote websites can't read user files, so they can't
// forge the header.
const UPDATE_TOKEN = randomBytes(32).toString("hex");

function persistUpdateToken() {
  try {
    writeFileSync(UPDATE_TOKEN_PATH, UPDATE_TOKEN, { mode: 0o600 });
    // writeFile mode applies on create only — chmod again so a
    // leftover token from a previous session can't widen the
    // permissions.
    chmodSync(UPDATE_TOKEN_PATH, 0o600);
  } catch (err) {
    // If we can't persist the token, /update is effectively disabled
    // because the bridge has nothing to send. That's an acceptable
    // failure mode (auto-update is off; user can still run `petdex
    // update` manually).
    process.stderr.write(
      `petdex sidecar: could not persist update token: ${(err as Error).message}\n`,
    );
  }
}

// ─── Telemetry: desktop_first_state_received ─────────────────────────
//
// The dashboard's funnel ends with "first hook event reached the
// mascot". The sidecar is the single source of truth for that — every
// hook curl-POSTs /state. Emit once per sidecar session, keyed off
// the same install_id the CLI uses.

const TELEMETRY_FILE = join(homedir(), ".petdex", "telemetry.json");
const TELEMETRY_ENDPOINT =
  process.env.PETDEX_TELEMETRY_URL ??
  "https://petdex.crafter.run/api/telemetry/event";
let firstStateEmitted = false;

function readTelemetryConfig(): {
  install_id: string;
  enabled: boolean;
} | null {
  if (process.env.PETDEX_TELEMETRY === "0") return null;
  if (!existsSync(TELEMETRY_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(TELEMETRY_FILE, "utf8")) as {
      install_id?: unknown;
      enabled?: unknown;
    };
    if (typeof raw.install_id !== "string") return null;
    if (raw.enabled === false) return null;
    return { install_id: raw.install_id, enabled: true };
  } catch {
    return null;
  }
}

function emitFirstStateReceived(state: string, agentSource: string | null) {
  if (firstStateEmitted) return;
  firstStateEmitted = true;
  const cfg = readTelemetryConfig();
  if (!cfg) return;
  const body = JSON.stringify({
    install_id: cfg.install_id,
    event: "desktop_first_state_received",
    state,
    agent_source: agentSource,
  });
  // Fire-and-forget. AbortSignal.timeout protects against a stuck
  // network; the unref()-style behavior we want comes from running
  // inside the sidecar (already a long-lived process), so we don't
  // need to spawn a worker like the CLI does.
  fetch(TELEMETRY_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(2000),
  }).catch(() => {
    // Swallow telemetry errors — they're not actionable here.
  });
}

function constantTimeEquals(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers; pad to the longer
  // before comparing so a length mismatch is also constant-time.
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still run a fixed-cost comparison so we don't leak length.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function log(line: string) {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  try {
    appendFileSync(LOG_PATH, stamped);
  } catch {
    // best-effort logging; never crash the server because of log io
  }
  process.stderr.write(stamped);
}

let resetTimer: NodeJS.Timeout | null = null;
let counter = 0;

function writeState(state: string, duration?: number) {
  counter += 1;
  const payload = {
    state,
    duration: duration ?? null,
    updatedAt: Date.now(),
    counter,
  };
  writeFileSync(STATE_PATH, JSON.stringify(payload));
  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = null;
  }
  if (typeof duration === "number" && duration > 0 && state !== "idle") {
    resetTimer = setTimeout(() => {
      writeState("idle");
      resetTimer = null;
    }, duration);
  }
}

// State queue: every accepted POST /state pushes here, a worker
// drains. Smooths the running/idle/running/idle pinball that any
// agent doing rapid tool calls would otherwise produce, and bounds
// the queue under burst so we don't lag behind reality. See
// state-queue.ts for the coalesce + dwell rules.
const stateQueue = new StateQueue({ minDwellMs: 250, maxQueueSize: 50 });

// Bubble: persistent text shown above the sprite. Written here, polled
// by the WebView via the petdex.read_runtime_bubble bridge command.
// We use a monotonic counter (same trick as state.json) so the WebView
// can tell "new bubble" from "same bubble re-served on every poll".
// Persistent semantics: a bubble stays visible until the next bubble
// arrives. No timed dismissal here — that'd require a second timer
// and would race the next /state event.
let bubbleCounter = 0;
function writeBubble(text: string, agentSource: string | null) {
  bubbleCounter += 1;
  const payload = {
    text,
    agent_source: agentSource,
    updatedAt: Date.now(),
    counter: bubbleCounter,
  };
  writeFileSync(BUBBLE_PATH, JSON.stringify(payload));
}

// Worker tick: 100ms is well under the WebView's 200ms state.json
// poll, so the user sees changes within one polling cycle.
setInterval(() => {
  const next = stateQueue.tick(Date.now());
  if (next) writeState(next.state, next.duration);
}, 100).unref();

writeState("idle");

// Reset bubble on every sidecar boot. Without this, the WebView reads
// whatever bubble.json was last written (which may be a stale "Reading
// server.ts" from a dev session) and pins it as the welcome message.
// An empty bubble means the WebView's pollBubble sees text="" and
// hides the element — clean slate until the first real hook fires.
try {
  writeBubble("", null);
} catch {}

// Reset stale update.json on boot. The previous sidecar may have died
// before its periodic check fired again, leaving update.json pinned at
// "available, latest=desktop-vOLD". A fresh sidecar attached to a
// freshly updated binary would otherwise read that stale row and the
// WebView would beg the user to install a version they already have.
// Hunter hit exactly this on 2026-05-11: ~/.petdex/version said v0.1.6,
// update.json said latest=v0.1.5 from a check 5 hours earlier.
//
// Strategy: if the persisted `current` doesn't match the on-disk
// VERSION_FILE (or current is null while the version file exists),
// wipe to idle. The next checkForUpdate (30s after launch) will
// repopulate with truth. We never delete the file outright so the
// WebView's first read still gets a coherent JSON.
try {
  const persisted = readUpdateInfo();
  const installed = readCurrentVersion();
  const stale =
    persisted.status === "available" &&
    (persisted.current !== installed || installed === null);
  if (stale) {
    writeUpdateInfo({
      available: false,
      current: installed,
      latest: null,
      status: "idle",
      checkedAt: 0,
    });
    log(
      `cleared stale update.json: persisted.current=${persisted.current ?? "?"} installed=${installed ?? "?"}`,
    );
  }
} catch {}

writeInitStatus();

function jsonResponse(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy(new Error("payload_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text.length === 0 ? {} : JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// ─── Update check ──────────────────────────────────────────────────────
//
// Layer 1 autoupdate (Approach A): poll GH Releases periodically, drop a
// JSON file the WebView can poll, and expose POST /update to actually
// run `petdex update --silent` when the user clicks the notification.

type UpdateInfo = {
  available: boolean;
  installable?: boolean;
  current: string | null;
  latest: string | null;
  // "idle" → no update detected; "available" → ready for click;
  // "running" → user clicked, npx running; "done" → finished;
  // "error" → something failed.
  status: "idle" | "available" | "running" | "done" | "error";
  message?: string;
  checkedAt: number;
};

type CodeSignatureInfo = {
  teamIdentifier: string | null;
  authorities: string[];
};

function canInstallBundledUpdate(): boolean {
  return process.platform === "darwin" && !!appBundleRootPath();
}

function terminalUpdateInstruction(latest: string | null): string {
  return latest
    ? `Update ${latest} is available. Run petdex update in your terminal.`
    : "Run petdex update in your terminal to update this install.";
}

function readCurrentVersion(): string | null {
  if (existsSync(VERSION_FILE)) {
    try {
      const version = readFileSync(VERSION_FILE, "utf8").trim();
      if (version) return version;
    } catch {}
  }
  const appBundleRoot = appBundleRootPath();
  if (!appBundleRoot) return null;
  try {
    const plist = readFileSync(
      join(appBundleRoot, "Contents", "Info.plist"),
      "utf8",
    );
    const match = plist.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
    );
    return match?.[1] ? `desktop-v${match[1].trim()}` : null;
  } catch {
    return null;
  }
}

function readDesktopPreferences(): DesktopPreferences {
  if (!existsSync(PREFERENCES_PATH)) return DEFAULT_DESKTOP_PREFERENCES;
  try {
    return parseDesktopPreferences(readFileSync(PREFERENCES_PATH, "utf8"));
  } catch {
    return DEFAULT_DESKTOP_PREFERENCES;
  }
}

function readUpdateInfo(): UpdateInfo {
  if (!existsSync(UPDATE_PATH)) {
    return {
      available: false,
      installable: canInstallBundledUpdate(),
      current: readCurrentVersion(),
      latest: null,
      status: "idle",
      checkedAt: 0,
    };
  }
  try {
    const info = JSON.parse(readFileSync(UPDATE_PATH, "utf8")) as UpdateInfo;
    const installable = canInstallBundledUpdate();
    if (info.available && !installable) {
      return {
        ...info,
        installable: false,
        status: "available",
        message: info.message ?? terminalUpdateInstruction(info.latest),
      };
    }
    return {
      ...info,
      installable: info.installable ?? installable,
    };
  } catch {
    return {
      available: false,
      installable: canInstallBundledUpdate(),
      current: readCurrentVersion(),
      latest: null,
      status: "idle",
      checkedAt: 0,
    };
  }
}

function writeUpdateInfo(info: UpdateInfo) {
  try {
    writeFileSync(UPDATE_PATH, JSON.stringify(info));
  } catch (err) {
    log(`update.json write failed: ${(err as Error).message}`);
  }
  // Mirror update failures onto the mascot sprite. Hunter 2026-05-11:
  // "cada state error que triggeree el status de mascot failed". Bounded
  // duration (3s) so the failed pose doesn't stick — the state queue
  // auto-reverts to idle after the duration expires. We do this here
  // rather than at every writeUpdateInfo callsite to avoid drift: if
  // a future code path also lands on status=error, the mascot will
  // reflect it without anyone having to remember.
  if (info.status === "error") {
    try {
      stateQueue.enqueue({
        state: "failed",
        duration: 3000,
        receivedAt: Date.now(),
      });
    } catch (err) {
      log(`mascot failed-state enqueue failed: ${(err as Error).message}`);
    }
  }
}

function writeInitStatus(): void {
  const hooksInstalled = existsSync(PERSISTED_BINARY_PATH);
  try {
    writeFileSync(
      INIT_STATUS_PATH,
      JSON.stringify({
        needsInit: !hooksInstalled,
        reason: hooksInstalled ? null : "no_hooks_installed",
        checkedAt: Date.now(),
      }),
    );
  } catch (err) {
    log(`init-status.json write failed: ${(err as Error).message}`);
  }
}

async function fetchLatestDesktopRelease(): Promise<DesktopRelease | null> {
  for (let page = 1; page <= RELEASES_MAX_PAGES; page++) {
    const url = `${RELEASES_API_BASE}?per_page=${RELEASES_PAGE_SIZE}&page=${page}`;
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      log(`update check: GH API ${res.status} on page ${page}`);
      return null;
    }
    const data = (await res.json()) as Array<{
      tag_name?: string;
      assets?: unknown;
      draft?: boolean;
      prerelease?: boolean;
    }>;
    if (!Array.isArray(data) || data.length === 0) return null;
    const hit = data.find(
      (r) =>
        !r.draft &&
        !r.prerelease &&
        typeof r.tag_name === "string" &&
        r.tag_name.startsWith(DESKTOP_TAG_PREFIX),
    );
    if (hit?.tag_name) {
      return {
        tag_name: hit.tag_name,
        assets: Array.isArray(hit.assets)
          ? (hit.assets as DesktopRelease["assets"])
          : [],
      };
    }
    // Short page = end of list, no point asking for the next.
    if (data.length < RELEASES_PAGE_SIZE) return null;
  }
  return null;
}

async function checkForUpdate(): Promise<void> {
  const current = readCurrentVersion();
  let release: DesktopRelease | null = null;
  try {
    release = await fetchLatestDesktopRelease();
  } catch (err) {
    log(`update check failed: ${(err as Error).message}`);
    return;
  }
  const latest = release?.tag_name ?? null;

  const existing = readUpdateInfo();
  // Don't clobber a running/done status with a fresh idle write — the
  // user might still be looking at the notification in the WebView.
  if (existing.status === "running") {
    return;
  }

  const available = !!latest && latest !== current;
  const installable = canInstallBundledUpdate();
  const next: UpdateInfo = {
    available,
    installable,
    current,
    latest,
    status: available ? "available" : "idle",
    message:
      available && !installable ? terminalUpdateInstruction(latest) : undefined,
    checkedAt: Date.now(),
  };
  writeUpdateInfo(next);
  writeInitStatus();
  log(
    `update check: current=${current ?? "?"} latest=${latest ?? "?"} available=${available} installable=${installable}`,
  );
  if (available && installable && readDesktopPreferences().autoInstallUpdates) {
    writeUpdateInfo({
      ...next,
      status: "running",
      message: "Installing the latest desktop release...",
      checkedAt: Date.now(),
    });
    logUpdate(`auto-install triggered for ${latest}`);
    spawnUpdate();
  }
}

function logUpdate(line: string) {
  try {
    appendFileSync(UPDATE_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // best-effort
  }
}

let currentUpdateChild: ReturnType<typeof spawn> | null = null;
let updateInProgress = false;
let updatePromise: Promise<void> | null = null;
let handoffRequested = false;

function appBundleRootPath(): string | null {
  return (
    process.env.PETDEX_APP_BUNDLE ??
    findEnclosingAppBundle(process.argv[1] ?? "")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function runUpdateCommand(
  command: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    currentUpdateChild = child;
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      const line = text.trimEnd();
      if (line) logUpdate(`${command}: ${line}`);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      const line = text.trimEnd();
      if (line) logUpdate(`${command} stderr: ${line}`);
    });
    child.on("error", (err) => {
      currentUpdateChild = null;
      reject(err);
    });
    child.on("exit", (code) => {
      currentUpdateChild = null;
      if (code !== 0 && !options.allowFailure) {
        reject(
          new Error(
            `${command} exited with code ${code ?? "null"}: ${stderr || stdout || "no output"}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

function requiredSha256Digest(asset: {
  digest?: string;
  name?: string;
}): string {
  if (typeof asset.digest !== "string") {
    throw new Error(
      `Release asset ${asset.name ?? "unknown"} has no sha256 digest.`,
    );
  }
  if (!asset.digest.startsWith("sha256:")) {
    throw new Error(
      `Release asset ${asset.name ?? "unknown"} has an unsupported digest.`,
    );
  }
  return asset.digest.slice("sha256:".length).toLowerCase();
}

async function stopParentForUpdate(): Promise<void> {
  const parent = Number(process.env.PETDEX_PARENT_PID);
  if (!Number.isFinite(parent) || parent <= 0) return;
  try {
    process.kill(parent, "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    return;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!pidAlive(parent)) return;
    await sleep(250);
  }
  throw new Error(
    "Petdex is still running after the quit request. Quit Petdex and try again.",
  );
}

async function closeServerForRelaunch(): Promise<void> {
  if (handoffRequested) return;
  handoffRequested = true;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function parseCodeSignatureInfo(output: string): CodeSignatureInfo {
  const authorities: string[] = [];
  let teamIdentifier: string | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("Authority=")) authorities.push(line.slice(10).trim());
    if (line.startsWith("TeamIdentifier=")) {
      const value = line.slice("TeamIdentifier=".length).trim();
      teamIdentifier = value && value !== "not set" ? value : null;
    }
  }
  return { teamIdentifier, authorities };
}

async function readCodeSignatureInfo(
  appPath: string,
): Promise<CodeSignatureInfo> {
  const result = await runUpdateCommand("codesign", [
    "-dv",
    "--verbose=4",
    appPath,
  ]);
  return parseCodeSignatureInfo(`${result.stdout}\n${result.stderr}`);
}

async function verifyTrustedUpdateAppBundle(
  appPath: string,
  currentSignature: CodeSignatureInfo,
): Promise<void> {
  await runUpdateCommand("codesign", [
    "--verify",
    "--deep",
    "--strict",
    appPath,
  ]);
  const signature = await readCodeSignatureInfo(appPath);
  assertTrustedUpdateSignature(currentSignature, signature);
  await runUpdateCommand("spctl", ["-a", "-t", "exec", appPath]);
}

function assertTrustedUpdateSignature(
  current: CodeSignatureInfo,
  next: CodeSignatureInfo,
): void {
  if (!current.teamIdentifier) {
    throw new Error("Current Petdex.app has no Developer ID team identifier.");
  }
  if (!next.teamIdentifier) {
    throw new Error("Update Petdex.app has no Developer ID team identifier.");
  }
  if (current.teamIdentifier !== next.teamIdentifier) {
    throw new Error(
      `Update signer mismatch: expected ${current.teamIdentifier}, got ${next.teamIdentifier}.`,
    );
  }
  if (
    !next.authorities.some((authority) =>
      authority.startsWith("Developer ID Application:"),
    )
  ) {
    throw new Error(
      "Update Petdex.app is not signed with Developer ID Application.",
    );
  }
}

function updateStagingPaths(appBundleRoot: string): {
  stagedApp: string;
  backupApp: string;
} {
  const token = randomBytes(8).toString("hex");
  const parent = dirname(appBundleRoot);
  const appName = basename(appBundleRoot);
  return {
    stagedApp: join(parent, `.${appName}.update-${token}`),
    backupApp: join(parent, `.${appName}.previous-${token}`),
  };
}

async function applyBundledUpdate(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Bundled desktop updater is only available on macOS.");
  }
  const release = await fetchLatestDesktopRelease();
  if (!release) throw new Error("No desktop release found.");
  const current = readCurrentVersion();
  if (current === release.tag_name) {
    writeUpdateInfo({
      available: false,
      current,
      latest: release.tag_name,
      status: "done",
      message: "Already up to date.",
      checkedAt: Date.now(),
    });
    return;
  }
  const dmgAsset = findDmgAsset(release, nodeArch());
  if (!dmgAsset) {
    throw new Error(`No DMG asset for ${nodeArch()} in ${release.tag_name}.`);
  }
  const appBundleRoot = appBundleRootPath();
  if (!appBundleRoot) {
    throw new Error("Petdex.app bundle not found for in-app update.");
  }
  const dmgPath = join(
    tmpdir(),
    `petdex-${randomBytes(8).toString("hex")}-${dmgAsset.name}`,
  );
  let mountPoint: string | null = null;
  let stagedApp: string | null = null;
  let relaunchApp: string | null = null;
  try {
    writeUpdateInfo({
      ...readUpdateInfo(),
      latest: release.tag_name,
      status: "running",
      message: `Downloading ${release.tag_name}...`,
      checkedAt: Date.now(),
    });
    await downloadToFile(
      dmgAsset.browser_download_url,
      dmgPath,
      requiredSha256Digest(dmgAsset),
      dmgAsset.size,
    );
    writeUpdateInfo({
      ...readUpdateInfo(),
      status: "running",
      message: "Mounting update image...",
      checkedAt: Date.now(),
    });
    const mount = await runUpdateCommand("hdiutil", [
      "attach",
      "-nobrowse",
      dmgPath,
    ]);
    mountPoint = parseHdiutilMount(mount.stdout);
    if (!mountPoint) {
      throw new Error("Could not determine mounted update volume.");
    }
    const sourceApp = join(mountPoint, "Petdex.app");
    if (!existsSync(sourceApp)) {
      throw new Error(`Mounted update does not contain ${sourceApp}.`);
    }
    writeUpdateInfo({
      ...readUpdateInfo(),
      status: "running",
      message: "Verifying update signature...",
      checkedAt: Date.now(),
    });
    await runUpdateCommand("codesign", [
      "--verify",
      "--deep",
      "--strict",
      sourceApp,
    ]);
    await runUpdateCommand("codesign", [
      "--verify",
      "--deep",
      "--strict",
      appBundleRoot,
    ]);
    const currentSignature = await readCodeSignatureInfo(appBundleRoot);
    await verifyTrustedUpdateAppBundle(sourceApp, currentSignature);
    writeUpdateInfo({
      ...readUpdateInfo(),
      status: "running",
      message: "Replacing Petdex.app...",
      checkedAt: Date.now(),
    });
    const staging = updateStagingPaths(appBundleRoot);
    stagedApp = staging.stagedApp;
    rmSync(stagedApp, { recursive: true, force: true });
    await runUpdateCommand("ditto", [sourceApp, stagedApp]);
    await verifyTrustedUpdateAppBundle(stagedApp, currentSignature);
    await stopParentForUpdate();
    await installStagedAppBundle(
      appBundleRoot,
      stagedApp,
      staging.backupApp,
      async () => {
        await runUpdateCommand(
          "xattr",
          ["-dr", "com.apple.quarantine", appBundleRoot],
          { allowFailure: true },
        );
        await verifyTrustedUpdateAppBundle(appBundleRoot, currentSignature);
      },
    );
    writeFileSync(VERSION_FILE, `${release.tag_name}\n`);
    writeUpdateInfo({
      available: false,
      current: release.tag_name,
      latest: release.tag_name,
      status: "done",
      message: "Update installed. Relaunching Petdex.",
      checkedAt: Date.now(),
    });
    logUpdate(`installed ${release.tag_name} into ${appBundleRoot}`);
    relaunchApp = appBundleRoot;
  } finally {
    if (mountPoint) {
      await runUpdateCommand("hdiutil", ["detach", "-quiet", mountPoint], {
        allowFailure: true,
      }).catch(() => {});
    }
    rmSync(dmgPath, { force: true });
    if (stagedApp) rmSync(stagedApp, { recursive: true, force: true });
  }
  if (relaunchApp) {
    await closeServerForRelaunch();
    const opener = spawn("open", [relaunchApp], {
      detached: true,
      stdio: "ignore",
    });
    opener.unref();
    setTimeout(() => process.exit(0), 250).unref();
  }
}

function spawnUpdate(): void {
  if (updateInProgress) return;
  updateInProgress = true;
  updatePromise = applyBundledUpdate()
    .catch((err) => {
      const message = (err as Error).message;
      log(`spawnUpdate: ${message}`);
      logUpdate(`error: ${message}`);
      writeUpdateInfo({
        ...readUpdateInfo(),
        status: "error",
        message,
        checkedAt: Date.now(),
      });
    })
    .finally(() => {
      updateInProgress = false;
      currentUpdateChild = null;
      updatePromise = null;
    });
  void updatePromise;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return jsonResponse(res, 200, { ok: true, port: PORT });
    }

    // Identity endpoint used by the EADDRINUSE-recovery path. When a
    // fresh sidecar boots and finds :7777 occupied, it probes /whoami
    // on the incumbent. If the incumbent reports a parentPid that is
    // no longer alive (orphan from a crashed desktop the parent
    // watchdog couldn't catch — e.g. a hard kill), the new sidecar
    // SIGTERMs it and retries listen. No auth required: pid + parent
    // are not secrets, and we want this to work even if the incumbent
    // is wedged enough that token reads would fail.
    if (req.method === "GET" && url.pathname === "/whoami") {
      const parent = Number(process.env.PETDEX_PARENT_PID);
      return jsonResponse(res, 200, {
        ok: true,
        pid: process.pid,
        parentPid: Number.isFinite(parent) && parent > 0 ? parent : null,
      });
    }

    if (req.method === "GET" && url.pathname === "/state") {
      try {
        const { readFileSync } = await import("node:fs");
        const text = readFileSync(STATE_PATH, "utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(text);
        return;
      } catch {
        return jsonResponse(res, 200, { state: "idle", counter: 0 });
      }
    }

    if (req.method === "POST" && url.pathname === "/state") {
      // Token gate, same pattern as POST /update. Defends against
      // drive-by no-cors POSTs from any site the user visits — those
      // would otherwise spam sidecar.log, manipulate the mascot, and
      // trip the desktop_first_state_received telemetry event. Hooks
      // generated by `petdex hooks install` read the token from
      // ~/.petdex/runtime/update-token before each curl; localhost
      // shell commands run as the user so they can read mode-0600
      // files, browsers can't.
      const provided = req.headers[UPDATE_TOKEN_HEADER];
      const providedStr = Array.isArray(provided) ? provided[0] : provided;
      if (!providedStr || !constantTimeEquals(providedStr, UPDATE_TOKEN)) {
        return jsonResponse(res, 401, { ok: false, error: "unauthorized" });
      }
      // Rate limiter: a real agent's tool-call rate caps around
      // 5-10 per second under the loudest workloads (rapid greps,
      // tight loops). 30/sec is well above that and well below
      // anything that could DoS the desktop (sprite updates each
      // tick are bound by frame loop). A runaway hook (infinite
      // loop in a user's pre-tool script, malicious plugin) trips
      // 429 and the hook ignores it via `|| true`.
      if (!stateRateLimiter.consume()) {
        return jsonResponse(res, 429, { ok: false, error: "rate_limited" });
      }

      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        return jsonResponse(res, 400, { ok: false, error: "invalid_json" });
      }
      const data = body as {
        state?: unknown;
        duration?: unknown;
        agent_source?: unknown;
      };
      const state = typeof data.state === "string" ? data.state : null;
      if (!state || !VALID_STATES.has(state)) {
        return jsonResponse(res, 400, {
          ok: false,
          error: "invalid_state",
          valid: [...VALID_STATES],
        });
      }
      const duration =
        typeof data.duration === "number" && data.duration > 0
          ? Math.min(data.duration, 30_000)
          : undefined;
      const agentSource =
        typeof data.agent_source === "string"
          ? data.agent_source.slice(0, 64)
          : null;
      // Sprite variation: rewrite bare "running" to alternating
      // "running-left" / "running-right" so consecutive tool calls
      // don't all show the same sprite frame. The hook stays simple
      // (just sends "running"); the sidecar handles the visual
      // variation. The toggle persists for this sidecar session.
      // running-left / running-right sent explicitly bypass — those
      // are intentional choices (a future hook might want a
      // specific direction).
      const enqueueState = state === "running" ? nextRunningVariant() : state;
      // Enqueue rather than writing directly. The worker tick
      // drains in order with coalesce + min dwell so consecutive
      // identical events (running/idle/running/idle pinball under
      // heavy tool-call activity) don't visually thrash. See
      // state-queue.ts.
      const accepted = stateQueue.enqueue({
        state: enqueueState,
        duration,
        receivedAt: Date.now(),
      });
      log(
        `state=${enqueueState} duration=${duration ?? "-"} ${accepted ? "queued" : "coalesced"}`,
      );
      writeInitStatus();
      // Funnel terminal step: emit once on the first accepted state of
      // this sidecar session. Any subsequent hook hits are no-ops.
      emitFirstStateReceived(state, agentSource);
      return jsonResponse(res, 200, {
        ok: true,
        state,
        duration: duration ?? null,
        queued: accepted,
      });
    }

    if (req.method === "GET" && url.pathname === "/bubble") {
      // The WebView reads this via the bridge (read_runtime_bubble) but
      // we expose it on HTTP too for debugging — `curl localhost:7777/bubble`
      // shows the latest bubble without spinning up the desktop.
      try {
        const { readFileSync } = await import("node:fs");
        const text = readFileSync(BUBBLE_PATH, "utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(text);
        return;
      } catch {
        return jsonResponse(res, 200, { text: "", counter: 0 });
      }
    }

    if (req.method === "POST" && url.pathname === "/bubble") {
      // Same security envelope as /state: token gate + rate limiter
      // (the same bucket — bubbles and states share a budget because
      // they're both driven by the same hook firehose).
      const provided = req.headers[UPDATE_TOKEN_HEADER];
      const providedStr = Array.isArray(provided) ? provided[0] : provided;
      if (!providedStr || !constantTimeEquals(providedStr, UPDATE_TOKEN)) {
        return jsonResponse(res, 401, { ok: false, error: "unauthorized" });
      }
      if (!stateRateLimiter.consume()) {
        return jsonResponse(res, 429, { ok: false, error: "rate_limited" });
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        return jsonResponse(res, 400, { ok: false, error: "invalid_json" });
      }
      const data = body as { text?: unknown; agent_source?: unknown };
      const rawText = typeof data.text === "string" ? data.text : null;
      if (!rawText) {
        return jsonResponse(res, 400, { ok: false, error: "missing_text" });
      }
      // Cap at 200 chars — anything longer would overflow the 240px
      // WebView and hooks shouldn't be writing essays here.
      const text = rawText.slice(0, 200);
      const agentSource =
        typeof data.agent_source === "string"
          ? data.agent_source.slice(0, 64)
          : null;
      writeBubble(text, agentSource);
      writeInitStatus();
      log(`bubble="${text.slice(0, 60)}" source=${agentSource ?? "-"}`);
      return jsonResponse(res, 200, {
        ok: true,
        text,
        counter: bubbleCounter,
      });
    }

    if (req.method === "GET" && url.pathname === "/update") {
      // The WebView poll endpoint. Cheap reads, no body validation.
      return jsonResponse(res, 200, readUpdateInfo());
    }

    if (req.method === "GET" && url.pathname === "/init-status") {
      if (!existsSync(INIT_STATUS_PATH)) {
        return jsonResponse(res, 404, {
          needsInit: true,
          reason: "no_hooks_installed",
          checkedAt: 0,
        });
      }
      try {
        const raw = readFileSync(INIT_STATUS_PATH, "utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(raw);
        return;
      } catch {
        return jsonResponse(res, 200, {
          needsInit: false,
          reason: null,
          checkedAt: 0,
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/update/handoff") {
      // Called by the updater child right before it tries to restart
      // the desktop. We hold :7777 to keep the sidecar alive while the
      // updater runs, but the new desktop's new sidecar can't bind
      // until we let go. Without this signal the updater would block
      // on waitForPortRelease until its 10s deadline (we won't exit
      // until it does), the deadline trips, and the user is left with
      // no desktop.
      //
      // On handoff: stop accepting new connections, mark update.json
      // done, and schedule a hard exit. The updater child keeps
      // running independently — it was spawned detached, so closing
      // our HTTP server doesn't kill it.
      const provided = req.headers[UPDATE_TOKEN_HEADER];
      const providedStr = Array.isArray(provided) ? provided[0] : provided;
      if (!providedStr || !constantTimeEquals(providedStr, UPDATE_TOKEN)) {
        return jsonResponse(res, 401, { ok: false, error: "unauthorized" });
      }
      if (!handoffRequested) {
        handoffRequested = true;
        log("handoff requested by updater; releasing port");
        const info = readUpdateInfo();
        if (info.status === "running") {
          writeUpdateInfo({
            ...info,
            status: "done",
            message: "Update installed. Restarting the desktop.",
            checkedAt: Date.now(),
          });
        }
        // Reply BEFORE close() so the updater sees a 200, then close
        // the listener. server.close() stops accepting new
        // connections; existing ones (just this one) drain to ack.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        server.close(() => {
          log("handoff: server closed, exiting");
          process.exit(0);
        });
        // Hard cap so a stuck connection doesn't deny the port back.
        setTimeout(() => process.exit(0), 1000).unref();
        return;
      }
      return jsonResponse(res, 200, { ok: true, alreadyHandedOff: true });
    }

    if (req.method === "POST" && url.pathname === "/update") {
      // Token gate: defends against drive-by CSRF from any site the
      // user visits. The Zig bridge reads ~/.petdex/runtime/update-token
      // (mode 0600) and forwards it as a header; browsers can't read
      // user files so they can't forge it. timingSafeEqual prevents
      // a length-leak via response time.
      const provided = req.headers[UPDATE_TOKEN_HEADER];
      const providedStr = Array.isArray(provided) ? provided[0] : provided;
      if (!providedStr || !constantTimeEquals(providedStr, UPDATE_TOKEN)) {
        return jsonResponse(res, 401, { ok: false, error: "unauthorized" });
      }

      // Click handler. Idempotent: if an update is already running we
      // just return the current state.
      const info = readUpdateInfo();
      if (info.status === "running") {
        return jsonResponse(res, 200, info);
      }
      if (!info.available && info.status !== "error") {
        return jsonResponse(res, 200, info);
      }
      if (!canInstallBundledUpdate()) {
        const next: UpdateInfo = {
          ...info,
          available: !!info.latest && info.latest !== info.current,
          installable: false,
          status: "available",
          message: terminalUpdateInstruction(info.latest),
          checkedAt: Date.now(),
        };
        writeUpdateInfo(next);
        return jsonResponse(res, 409, {
          ok: false,
          error: "unsupported_install",
          message: next.message,
        });
      }
      const next: UpdateInfo = {
        ...info,
        installable: true,
        status: "running",
        message: "Installing the latest desktop release...",
        checkedAt: Date.now(),
      };
      writeUpdateInfo(next);
      logUpdate("triggered by webview click");
      spawnUpdate();
      return jsonResponse(res, 202, next);
    }

    jsonResponse(res, 404, { ok: false, error: "not_found" });
  } catch (err) {
    log(`server error: ${(err as Error).message}`);
    jsonResponse(res, 500, { ok: false, error: "internal" });
  }
});

// Cap recovery attempts. One retry is enough for the orphan-eviction
// case (we kill, wait, listen). Two attempts is the safety belt for a
// race where another sidecar boots between our SIGTERM and our retry —
// at that point we should yield, not loop. The fresh boot will already
// own :7777.
const LISTEN_MAX_ATTEMPTS = 2;
let listenAttempts = 0;

function attemptListen(): void {
  listenAttempts += 1;
  server.listen(PORT, "127.0.0.1");
}

server.on("listening", () => {
  // Persist the token only after we've successfully bound the port.
  // If a stale sidecar already owns :7777 the listen fails and
  // server.on('error') runs the recovery flow — at which point the
  // on-disk token still belongs to whoever serves requests.
  persistUpdateToken();
  log(`petdex sidecar listening on http://127.0.0.1:${PORT}`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  // Anything other than EADDRINUSE is unrecoverable — bail loudly.
  if (err.code !== "EADDRINUSE") {
    log(`server.error: ${err.message}`);
    process.exit(1);
    return;
  }
  void recoverFromAddrInUse(err);
});

// EADDRINUSE recovery. The sidecar is supposed to die when its parent
// desktop dies (parent watchdog polls process.kill(parent, 0) every 2s
// and exits on ESRCH). That fails when:
//   1. The parent was killed with SIGKILL or crashed before the
//      watchdog could fire — the sidecar is mid-tick.
//   2. The user launched the .app manually (different parent), then
//      ran `petdex desktop start` (different parent), and one sidecar
//      survived the other's cleanup.
//   3. A previous sidecar entered an unrelated bad state and refuses
//      to exit on parent-gone.
//
// The fresh sidecar can't tell the difference from "another live
// desktop is using :7777 (legit, yield)" without asking. We probe
// /whoami: if the incumbent's parentPid is alive, yield (something
// real owns this slot). If the parentPid is dead, the incumbent is
// an orphan — SIGTERM it, wait for the port to free, retry listen.
async function recoverFromAddrInUse(err: NodeJS.ErrnoException): Promise<void> {
  if (listenAttempts >= LISTEN_MAX_ATTEMPTS) {
    log(
      `server.error: ${err.message}; gave up after ${listenAttempts} attempts`,
    );
    process.exit(1);
    return;
  }

  // Probe the incumbent. We don't trust /whoami to be present (an
  // older sidecar predates this endpoint) — a 404 means we can't
  // verify orphan-ness, so we yield rather than blindly killing.
  let incumbent: { pid?: number; parentPid?: number | null } | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/whoami`, {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      incumbent = (await res.json()) as typeof incumbent;
    }
  } catch {
    // Probe failed entirely — the port is held by something that
    // isn't a responsive sidecar. Could be a wedged Node process; we
    // can't safely kill it without identifying it. Yield.
    log(`server.error: ${err.message}; /whoami probe failed, yielding`);
    process.exit(1);
    return;
  }

  if (!incumbent || typeof incumbent.pid !== "number") {
    log(`server.error: ${err.message}; /whoami had no pid, yielding`);
    process.exit(1);
    return;
  }

  // Incumbent is a sidecar. Decide whether its parent desktop is
  // alive. process.kill(pid, 0) throws ESRCH if the pid is gone, EPERM
  // if it exists but we can't signal (still alive). Treat EPERM as
  // alive: we'd rather yield to a sibling user's desktop than kill it.
  const parent = incumbent.parentPid;
  let parentAlive = true;
  if (typeof parent === "number" && parent > 0) {
    try {
      process.kill(parent, 0);
    } catch (probeErr) {
      const code = (probeErr as NodeJS.ErrnoException).code;
      parentAlive = code !== "ESRCH";
    }
  } else {
    // Sidecar with no parent recorded — can't verify orphan, yield.
    log(
      `server.error: ${err.message}; incumbent pid=${incumbent.pid} has no parentPid, yielding`,
    );
    process.exit(1);
    return;
  }

  if (parentAlive) {
    log(
      `server.error: ${err.message}; incumbent pid=${incumbent.pid} parent=${parent} is alive, yielding`,
    );
    process.exit(1);
    return;
  }

  // Orphan confirmed. SIGTERM it, wait for :7777 to free, retry listen.
  log(
    `server.error: ${err.message}; killing orphan sidecar pid=${incumbent.pid} (parent=${parent} dead)`,
  );
  try {
    process.kill(incumbent.pid, "SIGTERM");
  } catch (killErr) {
    log(`failed to SIGTERM orphan: ${(killErr as Error).message}`);
    process.exit(1);
    return;
  }

  const freed = await waitForPortFree(PORT, 5000);
  if (!freed) {
    log(`port :${PORT} still busy 5s after killing orphan, giving up`);
    process.exit(1);
    return;
  }

  log(`orphan evicted, retrying listen (attempt ${listenAttempts + 1})`);
  attemptListen();
}

async function waitForPortFree(
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = http
        .createServer()
        .once("error", () => resolve(false))
        .once("listening", () => probe.close(() => resolve(true)));
      probe.listen(port, "127.0.0.1");
    });
    if (free) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

attemptListen();

const UPDATE_CHILD_GRACE_MS = 60_000;

function shutdown(signal: string) {
  // Handoff already initiated a clean shutdown sequence (server
  // closed, exit scheduled). A second shutdown call from SIGTERM or
  // the parent watchdog at this point would just race the same exit;
  // ignore it.
  if (handoffRequested) {
    log(`shutdown(${signal}) ignored: handoff in progress`);
    return;
  }
  if (updateInProgress) {
    log(`sidecar received ${signal}; update in progress`);
    const start = Date.now();
    const giveUp = setTimeout(() => {
      log(
        `update still running after ${UPDATE_CHILD_GRACE_MS}ms; forcing exit`,
      );
      // Mark the row as error so the WebView doesn't get stuck.
      const info = readUpdateInfo();
      if (info.status === "running") {
        writeUpdateInfo({
          ...info,
          status: "error",
          message:
            "Sidecar shut down before update finished. Re-launch Petdex and try again.",
          checkedAt: Date.now(),
        });
      }
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    }, UPDATE_CHILD_GRACE_MS);
    if (!updatePromise) {
      giveUp.unref();
      return;
    }
    updatePromise.finally(() => {
      clearTimeout(giveUp);
      if (handoffRequested) return;
      log(`update settled after ${Date.now() - start}ms; shutting down`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    });
    return;
  }
  log(`sidecar received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  // hard-exit if close hangs
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Update poll: 30s after launch (so we don't fight the WebView's first
// paint), then every 6h. Running detached + unref means a slow GH
// network never blocks shutdown.
const initialUpdateTimer = setTimeout(() => {
  void checkForUpdate();
  const periodic = setInterval(
    () => void checkForUpdate(),
    UPDATE_CHECK_INTERVAL_MS,
  );
  periodic.unref();
}, UPDATE_CHECK_INITIAL_DELAY_MS);
initialUpdateTimer.unref();

// Parent watchdog: if petdex-desktop spawned us with PETDEX_PARENT_PID,
// poll the parent every 2s and exit cleanly when it disappears. This
// prevents zombie sidecars after `petdex desktop stop` or a desktop
// crash. While an update is in flight we deliberately ignore the
// parent-gone signal: the updater itself stops the desktop (so the
// new binary can be renamed into place), so the parent-gone signal is
// expected.
const parentPid = Number(process.env.PETDEX_PARENT_PID);
if (Number.isFinite(parentPid) && parentPid > 0) {
  log(`sidecar watching parent pid ${parentPid}`);
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      if (updateInProgress || currentUpdateChild) return;
      log(`parent ${parentPid} gone, exiting`);
      clearInterval(timer);
      shutdown("parent-gone");
    }
  }, 2000);
  timer.unref();
}
