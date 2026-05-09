/**
 * Anonymous usage telemetry. Fire-and-forget POST to petdex.crafter.run.
 *
 * Privacy:
 * - install_id is a random UUID v4 generated on first run, stored at
 *   ~/.petdex/telemetry.json. No email, no username, no PII.
 * - User can opt out: `petdex telemetry off`.
 * - Notice shown once on first run (notice_seen flag).
 * - PETDEX_TELEMETRY=0 env var also disables.
 *
 * Failure modes:
 * - HOME unwritable / config read error / opt-out: degrade silently.
 *   Telemetry is best-effort; never block or crash an unrelated CLI
 *   command because the user's filesystem is read-only.
 * - Slow endpoint: emit() spawns a detached worker process so the main
 *   CLI exits immediately even if the network is hung. A global fetch
 *   in the parent would keep the event loop alive until it settled.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Lazy lookup so tests (and any sandboxed flow that mutates HOME at
// runtime) see the current value rather than whatever HOME happened
// to be when this module was first imported.
//
// We prefer process.env.HOME over os.homedir() so a test setting HOME
// to a tmpdir actually redirects the read/write. On macOS,
// os.homedir() resolves via getpwuid() and ignores HOME entirely.
function telemetryFile(): string {
  const home = process.env.HOME ?? homedir();
  return path.join(home, ".petdex", "telemetry.json");
}
const ENDPOINT =
  process.env.PETDEX_TELEMETRY_URL ??
  "https://petdex.crafter.run/api/telemetry/event";
const TIMEOUT_MS = 2000;

type TelemetryConfig = {
  install_id: string;
  enabled: boolean;
  notice_seen: boolean;
  first_seen: string;
};

export type TelemetryEvent =
  | "cli_install_desktop_success"
  | "cli_hooks_install_success"
  | "cli_desktop_start_success";

export type TelemetryPayload = {
  cli_version?: string;
  binary_version?: string;
  os?: string;
  arch?: string;
  agents?: string[];
};

// Three-state read result so callers can distinguish "no config yet"
// (fresh install — opt-out default kicks in) from "config exists but
// we can't trust what's in it" (read error / parse error — fail
// closed so a corrupted file can't silently re-enable telemetry for a
// user who had explicitly opted out).
type ReadConfigResult =
  | { kind: "missing" }
  | { kind: "ok"; config: TelemetryConfig }
  | { kind: "error"; reason: string };

function readConfig(): ReadConfigResult {
  if (!existsSync(telemetryFile())) return { kind: "missing" };
  let raw: string;
  try {
    raw = readFileSync(telemetryFile(), "utf8");
  } catch (err) {
    return {
      kind: "error",
      reason: `read failed: ${(err as Error).message}`,
    };
  }
  try {
    return { kind: "ok", config: JSON.parse(raw) as TelemetryConfig };
  } catch (err) {
    return {
      kind: "error",
      reason: `parse failed: ${(err as Error).message}`,
    };
  }
}

function writeConfigSafe(config: TelemetryConfig): boolean {
  try {
    mkdirSync(path.dirname(telemetryFile()), { recursive: true });
    writeFileSync(telemetryFile(), `${JSON.stringify(config, null, 2)}\n`);
    return true;
  } catch {
    // HOME unwritable, disk full, etc. Telemetry must never crash the
    // surrounding CLI command, so we degrade silently.
    return false;
  }
}

/**
 * Returns existing config, or creates one when telemetry is enabled
 * AND the filesystem allows writing. Returns null in every other case
 * (env opt-out, read/parse error, write failure) so callers
 * short-circuit cleanly. A corrupted config file is never replaced
 * here because that would silently flip a previously opted-out user
 * back on; the only way to recover is `petdex telemetry on/off` which
 * goes through a different path that overwrites the file explicitly.
 */
export function ensureTelemetryConfig(): TelemetryConfig | null {
  // Hard opt-out via env: never read or create the file. This is what
  // CI / sandbox / restricted-HOME users rely on.
  if (process.env.PETDEX_TELEMETRY === "0") return null;

  const result = readConfig();
  if (result.kind === "ok") return result.config;
  if (result.kind === "error") return null; // fail closed

  const fresh: TelemetryConfig = {
    install_id: randomUUID(),
    enabled: true,
    notice_seen: false,
    first_seen: new Date().toISOString(),
  };
  return writeConfigSafe(fresh) ? fresh : null;
}

export function isEnabled(): boolean {
  if (process.env.PETDEX_TELEMETRY === "0") return false;
  const result = readConfig();
  if (result.kind === "missing") return true; // opt-out model default
  if (result.kind === "error") return false; // fail closed on corruption
  return result.config.enabled;
}

export function setEnabled(enabled: boolean): boolean {
  // For an explicit `petdex telemetry on/off` call we need a config
  // file even if PETDEX_TELEMETRY=0 was set; the user is overriding.
  // A read/parse error here is the one place we DO want to overwrite
  // the corrupt file: the user just typed an explicit toggle, so
  // their intent is clear and we should honor it with a fresh config.
  const result = readConfig();
  let config: TelemetryConfig;
  if (result.kind === "ok") {
    config = result.config;
    config.enabled = enabled;
  } else {
    config = {
      install_id: randomUUID(),
      enabled,
      notice_seen: true,
      first_seen: new Date().toISOString(),
    };
  }
  return writeConfigSafe(config);
}

export function getStatus(): { enabled: boolean; install_id: string | null } {
  const result = readConfig();
  return {
    enabled: isEnabled(),
    install_id: result.kind === "ok" ? result.config.install_id : null,
  };
}

export function maybeShowFirstRunNotice(): void {
  if (process.env.PETDEX_TELEMETRY === "0") return;
  const config = ensureTelemetryConfig();
  if (!config) return; // best-effort: skip notice when we can't persist it
  if (config.notice_seen) return;
  console.log(
    [
      "",
      "petdex collects anonymous usage stats (install volume, OS, agents wired up).",
      "No personal data, no file contents. Disable any time:",
      "  petdex telemetry off",
      "Details: https://petdex.crafter.run/legal/telemetry",
      "",
    ].join("\n"),
  );
  config.notice_seen = true;
  // If write fails, just show the notice again next run — no big deal.
  writeConfigSafe(config);
}

/**
 * Fire-and-forget telemetry event. The POST runs in a detached worker
 * process so the parent CLI can exit immediately. A global fetch() in
 * the parent process keeps the event loop alive until the request
 * settles, which adds the full TIMEOUT_MS to every successful command
 * that reaches emit() — exactly the lag this function is meant to
 * avoid.
 */
export function emit(
  event: TelemetryEvent,
  payload: TelemetryPayload = {},
): void {
  if (!isEnabled()) return;
  const config = ensureTelemetryConfig();
  if (!config) return; // no install_id, nothing to send

  const body = JSON.stringify({
    install_id: config.install_id,
    event,
    ...payload,
  });

  // Spawn a tiny Node process that owns the fetch. `unref` drops the
  // parent's reference so process.exit doesn't wait on this child;
  // detached + ignored stdio means the OS reaps it after it settles.
  // If anything fails (Node missing, sandbox, etc.), swallow.
  try {
    const worker = `
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), ${TIMEOUT_MS});
      fetch(${JSON.stringify(ENDPOINT)}, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: ${JSON.stringify(body)},
        signal: controller.signal,
      }).catch(() => {}).finally(() => clearTimeout(t));
    `;
    const child = spawn(process.execPath, ["-e", worker], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // Telemetry failures are silent.
  }
}
