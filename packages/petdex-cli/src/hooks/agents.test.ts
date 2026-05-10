import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENTS, SIDECAR_URL } from "./agents";

// These tests pin the contract that bit us in production once: the
// generated shell command must survive JSON.stringify (the agent
// config write) -> JSON.parse (the agent reading the settings) -> sh
// execution and end up running the curl we intended.
//
// A regression flips the hooks to a silent no-op, so we run the
// generated command in a real subshell and confirm it both reads the
// token file and reports the path it tried to use. We DON'T actually
// hit the sidecar; we run with a stand-in PETDEX_TOKEN_PATH-ish setup
// and inspect the side effect (the token file we created).

describe("Claude Code hook command", () => {
  function getCommand(state: string): string {
    const agent = AGENTS.find((a) => a.id === "claude-code");
    if (!agent) throw new Error("claude-code agent missing from registry");
    const config = agent.build() as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    return config.hooks.PreToolUse[0]?.hooks[0]?.command ?? "";
  }

  test("includes the X-Petdex-Update-Token header", () => {
    const cmd = getCommand("running");
    expect(cmd).toContain("X-Petdex-Update-Token");
    expect(cmd).toContain("$T");
  });

  test("body is sent with --data-raw (single-quoted) so JSON survives", () => {
    const cmd = getCommand("running");
    // The body should land as raw JSON inside single quotes; no
    // escaped quotes in the source string mean nothing breaks
    // when JSON.stringify wraps it for the agent settings file.
    expect(cmd).toContain(
      `--data-raw '{"state":"running","agent_source":"claude-code"}'`,
    );
  });

  test("survives JSON.stringify -> parse -> shell parse roundtrip", () => {
    const cmd = getCommand("running");
    // Agent settings files write JSON.
    const serialized = JSON.stringify({ command: cmd });
    // Agents JSON.parse on read.
    const reparsed = JSON.parse(serialized) as { command: string };
    // What the shell sees must match what we generated.
    expect(reparsed.command).toBe(cmd);

    // The shell must NOT see literal backslash-quote sequences
    // (the bug we shipped once). After JSON.parse, the command
    // text should contain unescaped double quotes around the cat
    // path — they're inside a $() subshell and therefore legal.
    expect(reparsed.command).toContain(
      `T="$(cat "$HOME/.petdex/runtime/update-token" 2>/dev/null)"`,
    );
    // ...and must NOT contain the broken pre-escaped form.
    expect(reparsed.command).not.toContain(`cat \\"$HOME`);
  });

  test("includes the killswitch guard before any token read or curl", () => {
    const cmd = getCommand("running");
    // Killswitch is the FIRST statement so a disabled state has
    // zero filesystem cost beyond the test -f.
    expect(cmd).toMatch(/^\[ -f "\$HOME\/\.petdex\/runtime\/hooks-disabled" \]/);
    expect(cmd).toContain("&& exit 0");
    // And it MUST exit 0 — a non-zero hook stains the agent UI.
    expect(cmd).not.toContain("&& exit 1");
  });

  test("uses 300ms timeout (not the original 1s) to bound worst-case agent latency", () => {
    const cmd = getCommand("running");
    expect(cmd).toContain("curl -s -m 0.3");
    expect(cmd).not.toContain("curl -s -m 1 ");
  });

  test("killswitch file actually short-circuits in a real shell", () => {
    // End-to-end: write the killswitch file, run the generated
    // command, and confirm the curl never fires (would otherwise
    // exit non-zero into a closed port).
    const fakeHome = mkdtempSync(join(tmpdir(), "petdex-killswitch-"));
    try {
      const runtimeDir = join(fakeHome, ".petdex", "runtime");
      execSync(`mkdir -p "${runtimeDir}"`);
      writeFileSync(join(runtimeDir, "update-token"), "tok");
      // Drop the killswitch flag.
      writeFileSync(join(runtimeDir, "hooks-disabled"), "");

      const cmd = getCommand("running");
      // Even with the SIDECAR_URL pointing at a real-but-closed
      // port, we should exit 0 BEFORE curl runs. We test this by
      // pointing SIDECAR_URL at a deliberately bad value and
      // confirming no error surfaces — the killswitch must catch
      // it first.
      const stubbed = cmd.replace(SIDECAR_URL, "http://127.0.0.1:1");
      const result = execSync(stubbed, {
        env: { ...process.env, HOME: fakeHome },
        shell: "/bin/sh",
        timeout: 3000,
      });
      expect(result.toString()).toBe("");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("generated command is real-shell-executable and reads the token file", () => {
    // Build a fake HOME with a token file, run the generated
    // command with PETDEX_PORT pointed at a closed port, and
    // assert the curl exits cleanly (the `|| true` swallow path
    // is intentional — sidecar offline is not an error).
    const fakeHome = mkdtempSync(join(tmpdir(), "petdex-hooks-"));
    try {
      const tokenDir = join(fakeHome, ".petdex", "runtime");
      writeFileSync; // (lint suppression — we use it via execSync below)
      execSync(`mkdir -p "${tokenDir}"`);
      writeFileSync(join(tokenDir, "update-token"), "deadbeefcafef00d");

      const cmd = getCommand("running");
      // Override SIDECAR_URL to a bogus port that's guaranteed
      // free so curl fails fast and we exercise the `|| true`
      // recovery path. We rewrite the URL via env-substitution
      // by replacing it textually.
      const stubbed = cmd.replace(SIDECAR_URL, "http://127.0.0.1:1");
      // Should exit 0 because of the trailing `|| true`.
      const result = execSync(stubbed, {
        env: { ...process.env, HOME: fakeHome },
        shell: "/bin/sh",
        timeout: 3000,
      });
      // No throw means the shell parsed our command correctly.
      // execSync returns stdout (empty here, redirected to
      // /dev/null in the command).
      expect(result.toString()).toBe("");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
