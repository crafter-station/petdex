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
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PETDEX_PORT ?? 7777);
const RUNTIME_DIR = join(homedir(), ".petdex", "runtime");
const STATE_PATH = join(RUNTIME_DIR, "state.json");
const UPDATE_PATH = join(RUNTIME_DIR, "update.json");
const UPDATE_LOG_PATH = join(RUNTIME_DIR, "update.log");
const UPDATE_TOKEN_PATH = join(RUNTIME_DIR, "update-token");
const VERSION_FILE = join(homedir(), ".petdex", "version");
const LOG_PATH = join(RUNTIME_DIR, "sidecar.log");
const MAX_BODY_BYTES = 64 * 1024;
const RELEASE_API =
  "https://api.github.com/repos/crafter-station/petdex/releases/latest";
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

// Generate a fresh per-session token for POST /update. Without this any
// website the user visits could fire `fetch("http://127.0.0.1:7777/update",
// { method: "POST", mode: "no-cors" })` and trigger a silent npm install
// of arbitrary `petdex@latest` code — CORS only blocks the response,
// never the request itself.
//
// The token is written to ~/.petdex/runtime/update-token (mode 0600 so
// only the user can read it). The Zig bridge reads it from disk and
// forwards it as a header when curl-ing the sidecar; remote websites
// can't read user files, so they can't forge the header.
const UPDATE_TOKEN = randomBytes(32).toString("hex");
try {
  writeFileSync(UPDATE_TOKEN_PATH, UPDATE_TOKEN, { mode: 0o600 });
  // writeFile mode applies on create only — chmod again so a leftover
  // token from a previous session can't widen the permissions.
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

writeState("idle");

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
  current: string | null;
  latest: string | null;
  // "idle" → no update detected; "available" → ready for click;
  // "running" → user clicked, npx running; "done" → finished;
  // "error" → something failed.
  status: "idle" | "available" | "running" | "done" | "error";
  message?: string;
  checkedAt: number;
};

function readCurrentVersion(): string | null {
  if (!existsSync(VERSION_FILE)) return null;
  try {
    return readFileSync(VERSION_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function readUpdateInfo(): UpdateInfo {
  if (!existsSync(UPDATE_PATH)) {
    return {
      available: false,
      current: readCurrentVersion(),
      latest: null,
      status: "idle",
      checkedAt: 0,
    };
  }
  try {
    return JSON.parse(readFileSync(UPDATE_PATH, "utf8")) as UpdateInfo;
  } catch {
    return {
      available: false,
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
}

async function checkForUpdate(): Promise<void> {
  const current = readCurrentVersion();
  let latest: string | null = null;
  try {
    const res = await fetch(RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      log(`update check: GH API ${res.status}`);
      return;
    }
    const data = (await res.json()) as { tag_name?: string };
    latest = typeof data.tag_name === "string" ? data.tag_name : null;
  } catch (err) {
    log(`update check failed: ${(err as Error).message}`);
    return;
  }

  const existing = readUpdateInfo();
  // Don't clobber a running/done status with a fresh idle write — the
  // user might still be looking at the notification in the WebView.
  if (existing.status === "running") {
    return;
  }

  const available = !!latest && !!current && latest !== current;
  const next: UpdateInfo = {
    available,
    current,
    latest,
    status: available ? "available" : "idle",
    checkedAt: Date.now(),
  };
  writeUpdateInfo(next);
  log(
    `update check: current=${current ?? "?"} latest=${latest ?? "?"} available=${available}`,
  );
}

function logUpdate(line: string) {
  try {
    appendFileSync(UPDATE_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // best-effort
  }
}

function spawnUpdate(): void {
  // npx so the host machine can pin its own petdex-cli version. The
  // child runs detached + ignored stdio so the sidecar exits cleanly
  // if it gets SIGTERM mid-update; npm waits for the install
  // transaction itself to finish.
  const child = spawn("npx", ["-y", "petdex@latest", "update", "--silent"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    logUpdate(chunk.toString("utf8").trimEnd());
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    logUpdate(`stderr: ${chunk.toString("utf8").trimEnd()}`);
  });
  child.on("exit", (code) => {
    const info = readUpdateInfo();
    if (code === 0) {
      const newCurrent = readCurrentVersion();
      writeUpdateInfo({
        ...info,
        current: newCurrent,
        // Keep `available` true so the WebView shows a "Restart now"
        // affordance after the binary has been swapped on disk.
        status: "done",
        message: "Update installed. Restart the desktop to use it.",
        checkedAt: Date.now(),
      });
      logUpdate(`exit 0 (installed ${newCurrent ?? "?"})`);
    } else {
      writeUpdateInfo({
        ...info,
        status: "error",
        message: `petdex update exited with code ${code ?? "null"}. See ${UPDATE_LOG_PATH}.`,
        checkedAt: Date.now(),
      });
      logUpdate(`exit ${code}`);
    }
  });
  child.on("error", (err) => {
    const info = readUpdateInfo();
    writeUpdateInfo({
      ...info,
      status: "error",
      message: `Could not spawn npx: ${err.message}`,
      checkedAt: Date.now(),
    });
    logUpdate(`spawn error: ${err.message}`);
  });
  child.unref();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return jsonResponse(res, 200, { ok: true, port: PORT });
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
      writeState(state, duration);
      log(`state=${state} duration=${duration ?? "-"}`);
      // Funnel terminal step: emit once on the first accepted state of
      // this sidecar session. Any subsequent hook hits are no-ops.
      emitFirstStateReceived(state, agentSource);
      return jsonResponse(res, 200, {
        ok: true,
        state,
        duration: duration ?? null,
      });
    }

    if (req.method === "GET" && url.pathname === "/update") {
      // The WebView poll endpoint. Cheap reads, no body validation.
      return jsonResponse(res, 200, readUpdateInfo());
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
      const next: UpdateInfo = {
        ...info,
        status: "running",
        message: "Downloading the latest release...",
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

server.listen(PORT, "127.0.0.1", () => {
  log(`petdex sidecar listening on http://127.0.0.1:${PORT}`);
});

server.on("error", (err) => {
  log(`server.error: ${err.message}`);
  process.exit(1);
});

function shutdown(signal: string) {
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
// prevents zombie sidecars after `petdex desktop stop` or a desktop crash.
const parentPid = Number(process.env.PETDEX_PARENT_PID);
if (Number.isFinite(parentPid) && parentPid > 0) {
  log(`sidecar watching parent pid ${parentPid}`);
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      log(`parent ${parentPid} gone, exiting`);
      clearInterval(timer);
      shutdown("parent-gone");
    }
  }, 2000);
  timer.unref();
}
