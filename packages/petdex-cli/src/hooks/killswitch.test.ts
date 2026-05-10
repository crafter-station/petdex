import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getKillswitchState,
  killswitchPath,
  setKillswitchState,
  toggleKillswitch,
} from "./killswitch";

// The killswitch is a file at ~/.petdex/runtime/hooks-disabled.
// Hook snippets installed in agent settings check for it at run
// time, so any process that writes/removes the file changes the
// hook behavior without restarting the agent.

describe("killswitch", () => {
  const realHome = process.env.HOME;
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "petdex-killswitch-test-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = realHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("default state is 'on' (file absent)", () => {
    expect(getKillswitchState()).toBe("on");
    expect(existsSync(killswitchPath())).toBe(false);
  });

  test("setKillswitchState('off') creates the flag file", () => {
    setKillswitchState("off");
    expect(getKillswitchState()).toBe("off");
    expect(existsSync(killswitchPath())).toBe(true);
  });

  test("setKillswitchState('on') removes the flag file", () => {
    setKillswitchState("off");
    expect(getKillswitchState()).toBe("off");
    setKillswitchState("on");
    expect(getKillswitchState()).toBe("on");
    expect(existsSync(killswitchPath())).toBe(false);
  });

  test("setKillswitchState('on') is idempotent when already on", () => {
    expect(getKillswitchState()).toBe("on");
    expect(() => setKillswitchState("on")).not.toThrow();
    expect(getKillswitchState()).toBe("on");
  });

  test("toggleKillswitch flips state each call", () => {
    expect(toggleKillswitch()).toBe("off");
    expect(toggleKillswitch()).toBe("on");
    expect(toggleKillswitch()).toBe("off");
  });

  test("flag file has informational body (so a human grep can find the toggle command)", async () => {
    setKillswitchState("off");
    const { readFileSync } = await import("node:fs");
    const body = readFileSync(killswitchPath(), "utf8");
    expect(body).toMatch(/petdex hooks on/);
    expect(body).toMatch(/\/petdex/);
  });

  test("flag file is mode 0600", async () => {
    setKillswitchState("off");
    const { statSync } = await import("node:fs");
    const stat = statSync(killswitchPath());
    // Mask out the file-type bits, leave only the perm bits.
    expect((stat.mode & 0o777).toString(8)).toBe("600");
  });
});
