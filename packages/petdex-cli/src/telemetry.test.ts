import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureTelemetryConfig, isEnabled, setEnabled } from "./telemetry";

// telemetry.ts looks up HOME lazily, so swapping process.env.HOME in
// beforeEach is enough to redirect every read/write at runtime — no
// module re-import needed. Each test gets a fresh tmpdir for HOME so
// state doesn't leak across tests.

let realHome: string | undefined;
let tmpHome: string;

function petdexConfigPath(): string {
  return join(tmpHome, ".petdex", "telemetry.json");
}

function writeCorruptConfig() {
  mkdirSync(join(tmpHome, ".petdex"), { recursive: true });
  writeFileSync(petdexConfigPath(), "{ corrupt", "utf8");
}

describe("telemetry config", () => {
  beforeEach(() => {
    realHome = process.env.HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "petdex-telemetry-test-"));
    process.env.HOME = tmpHome;
    delete process.env.PETDEX_TELEMETRY;
  });

  afterEach(() => {
    if (realHome !== undefined) process.env.HOME = realHome;
    rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.PETDEX_TELEMETRY;
  });

  test("missing config: opt-out default keeps telemetry enabled", () => {
    expect(isEnabled()).toBe(true);
  });

  test("PETDEX_TELEMETRY=0 short-circuits before any filesystem touch", () => {
    process.env.PETDEX_TELEMETRY = "0";
    expect(isEnabled()).toBe(false);
    expect(existsSync(petdexConfigPath())).toBe(false);
  });

  test("corrupted JSON: isEnabled fails closed", () => {
    writeCorruptConfig();
    expect(isEnabled()).toBe(false);
  });

  test("corrupted JSON: ensureTelemetryConfig returns null instead of recreating", () => {
    writeCorruptConfig();
    // Sanity: confirm the file is actually what we wrote — guards
    // against test isolation surprises that gave us false positives
    // earlier in this suite's history.
    expect(readFileSync(petdexConfigPath(), "utf8")).toBe("{ corrupt");
    expect(ensureTelemetryConfig()).toBeNull();
  });

  test("setEnabled(false) overwrites a corrupt config (explicit user intent)", () => {
    writeCorruptConfig();
    expect(setEnabled(false)).toBe(true);
    expect(isEnabled()).toBe(false);
  });

  test("setEnabled(true) round-trips through isEnabled", () => {
    expect(setEnabled(true)).toBe(true);
    expect(isEnabled()).toBe(true);
    expect(setEnabled(false)).toBe(true);
    expect(isEnabled()).toBe(false);
  });
});
