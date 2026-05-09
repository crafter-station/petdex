/**
 * Anonymous usage telemetry. Fire-and-forget POST to petdex.crafter.run.
 *
 * Privacy:
 * - install_id is a random UUID v4 generated on first run, stored at
 *   ~/.petdex/telemetry.json. No email, no username, no PII.
 * - User can opt out: `petdex telemetry off`.
 * - Notice shown once on first run (notice_seen flag).
 * - PETDEX_TELEMETRY=0 env var also disables.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const TELEMETRY_FILE = path.join(homedir(), ".petdex", "telemetry.json");
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

function readConfig(): TelemetryConfig | null {
  if (!existsSync(TELEMETRY_FILE)) return null;
  try {
    return JSON.parse(readFileSync(TELEMETRY_FILE, "utf8")) as TelemetryConfig;
  } catch {
    return null;
  }
}

function writeConfig(config: TelemetryConfig): void {
  mkdirSync(path.dirname(TELEMETRY_FILE), { recursive: true });
  writeFileSync(TELEMETRY_FILE, `${JSON.stringify(config, null, 2)}\n`);
}

export function ensureTelemetryConfig(): TelemetryConfig {
  let config = readConfig();
  if (!config) {
    config = {
      install_id: randomUUID(),
      enabled: true,
      notice_seen: false,
      first_seen: new Date().toISOString(),
    };
    writeConfig(config);
  }
  return config;
}

export function isEnabled(): boolean {
  if (process.env.PETDEX_TELEMETRY === "0") return false;
  const config = readConfig();
  if (!config) return true;
  return config.enabled;
}

export function setEnabled(enabled: boolean): void {
  const config = ensureTelemetryConfig();
  config.enabled = enabled;
  writeConfig(config);
}

export function getStatus(): { enabled: boolean; install_id: string | null } {
  const config = readConfig();
  return {
    enabled: isEnabled(),
    install_id: config?.install_id ?? null,
  };
}

export function maybeShowFirstRunNotice(): void {
  const config = ensureTelemetryConfig();
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
  writeConfig(config);
}

export function emit(
  event: TelemetryEvent,
  payload: TelemetryPayload = {},
): void {
  if (!isEnabled()) return;
  const config = ensureTelemetryConfig();
  const body = JSON.stringify({
    install_id: config.install_id,
    event,
    ...payload,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as NodeJS.Timeout).unref();
  }
  fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: controller.signal,
  }).catch(() => {
    // Telemetry failures are silent.
  });
}
