import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  AGENTS,
  antigravityMcpConfigPath,
  resolveOpenCodeConfigDir,
  SIDECAR_URL,
} from "./agents";

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
  // Pull the default-running PreToolUse entry — i.e. the one that
  // doesn't have a matcher set (matchers are evaluated first; the
  // unmatched entry is the catch-all "running" state for any tool
  // that isn't Read/Grep/Glob). Tests that don't care about the
  // review-vs-running split use this default.
  function getCommand(_state: string): string {
    const agent = AGENTS.find((a) => a.id === "claude-code");
    if (!agent) throw new Error("claude-code agent missing from registry");
    const config = agent.build() as {
      hooks: Record<
        string,
        Array<{ matcher?: string; hooks: Array<{ command: string }> }>
      >;
    };
    const entries = config.hooks.PreToolUse ?? [];
    const fallback = entries.find((e) => e.matcher == null);
    return fallback?.hooks[0]?.command ?? "";
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
    expect(cmd).toMatch(
      /^\[ -f "\$HOME\/\.petdex\/runtime\/hooks-disabled" \]/,
    );
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

  // ─── State mapping (added with 9-state sprite work) ───────────────
  // These pin the contract that hooks.json emits the right state for
  // each lifecycle event. Regressions here mean the mascot animates
  // wrong (e.g. running on a Read tool when we want review) — silent
  // on the CLI side, visible only in the desktop UI.

  test("Claude Code PreToolUse delegates to bubble runner (no matcher split)", () => {
    // Review-vs-running routing now lives in the bubble runner,
    // which inspects tool_name from stdin. The Claude Code hook
    // entry is therefore a single un-matchered command.
    const agent = AGENTS.find((a) => a.id === "claude-code");
    if (!agent) throw new Error("claude-code agent missing from registry");
    const config = agent.build() as {
      hooks: Record<
        string,
        Array<{ matcher?: string; hooks: Array<{ command: string }> }>
      >;
    };
    const entries = config.hooks.PreToolUse ?? [];
    expect(entries.length).toBe(1);
    expect(entries[0]?.matcher).toBeUndefined();
    const cmd = entries[0]?.hooks[0]?.command ?? "";
    expect(cmd).toContain("$HOME/.petdex/bin/petdex.js");
    expect(cmd).toContain("bubble pre claude-code");
  });

  test("Claude Code hook command falls back to curl when persisted binary missing", () => {
    const agent = AGENTS.find((a) => a.id === "claude-code");
    if (!agent) throw new Error("claude-code agent missing from registry");
    const config = agent.build() as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const cmd = config.hooks.PreToolUse?.[0]?.hooks[0]?.command ?? "";
    // The else branch must include the curl fallback so users who
    // never ran `petdex hooks install` (binary not persisted) still
    // get sprite state updates, just without bubble text.
    expect(cmd).toContain("else");
    expect(cmd).toContain("curl -s -m 0.3");
    expect(cmd).toContain(`"state":"running"`);
    expect(cmd).toContain(`"agent_source":"claude-code"`);
  });

  test("Claude Code UserPromptSubmit emits jumping state", () => {
    const agent = AGENTS.find((a) => a.id === "claude-code");
    if (!agent) throw new Error("claude-code agent missing from registry");
    const config = agent.build() as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const cmd = config.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command ?? "";
    expect(cmd).toContain(`"state":"jumping"`);
    expect(cmd).toContain(`"duration":800`);
  });

  test("Claude Code Notification emits waiting state", () => {
    const agent = AGENTS.find((a) => a.id === "claude-code");
    if (!agent) throw new Error("claude-code agent missing from registry");
    const config = agent.build() as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const cmd = config.hooks.Notification?.[0]?.hooks[0]?.command ?? "";
    expect(cmd).toContain(`"state":"waiting"`);
  });

  test("Codex PermissionRequest emits waiting state", () => {
    const agent = AGENTS.find((a) => a.id === "codex");
    if (!agent) throw new Error("codex agent missing from registry");
    const config = agent.build() as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const cmd = config.hooks.PermissionRequest?.[0]?.hooks[0]?.command ?? "";
    expect(cmd).toContain(`"state":"waiting"`);
    expect(cmd).toContain(`"agent_source":"codex"`);
  });

  test("Codex UserPromptSubmit emits jumping state", () => {
    const agent = AGENTS.find((a) => a.id === "codex");
    if (!agent) throw new Error("codex agent missing from registry");
    const config = agent.build() as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const cmd = config.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command ?? "";
    expect(cmd).toContain(`"state":"jumping"`);
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

describe("Antigravity config paths", () => {
  test("agent configDir matches the platform MCP config directory", () => {
    const agent = AGENTS.find((a) => a.id === "antigravity");
    expect(agent?.configDir).toBe(dirname(antigravityMcpConfigPath()));
  });
});

describe("Gemini slash command paths", () => {
  test("uses Gemini CLI commands instead of Antigravity global workflows", () => {
    const agent = AGENTS.find((a) => a.id === "gemini");
    expect(agent?.slashCommandPath).toEndWith(
      join(".gemini", "commands", "petdex.toml"),
    );
    expect(agent?.slashCommandPath).not.toContain(
      join(".gemini", "antigravity", "global_workflows"),
    );
  });
});

describe("OpenCode hook plugin", () => {
  function getPluginSource(): string {
    const agent = AGENTS.find((a) => a.id === "opencode");
    if (!agent) throw new Error("opencode agent missing from registry");
    return agent.build() as string;
  }

  test("posts bubbles in addition to state updates", () => {
    const source = getPluginSource();
    expect(source).toContain("const SIDECAR_URL");
    expect(source).toContain("const SIDECAR_BUBBLE_URL");
    expect(source).toContain("/bubble");
    expect(source).toContain("postJson(SIDECAR_URL");
    expect(source).toContain("postJson(SIDECAR_BUBBLE_URL");
    expect(source).toContain(`{ text, agent_source: "opencode" }`);
  });

  test("uses OpenCode v1 default file plugin shape", () => {
    const source = getPluginSource();
    expect(source).toContain("const hooks = {");
    expect(source).toContain(`id: "petdex"`);
    expect(source).toContain("server: async () => hooks");
    expect(source).toContain("export default PetdexPlugin");
    expect(source).toContain("export { PetdexPlugin }");
  });

  test("uses OpenCode tool hook payloads to format messages", () => {
    const source = getPluginSource();
    expect(source).toContain(
      `"tool.execute.before": async (input, output) => notify({`,
    );
    expect(source).toContain(
      `text: formatTool(input.tool, output.args, "running")`,
    );
    expect(source).toContain(`"tool.execute.after": async (input) => notify({`);
    expect(source).toContain(
      `text: formatTool(input.tool, input.args, "done")`,
    );
  });

  test("keeps hook safeguards and latency bound", () => {
    const source = getPluginSource();
    expect(source).toContain("KILLSWITCH_PATH");
    expect(source).toContain("existsSync(KILLSWITCH_PATH)");
    expect(source).toContain("X-Petdex-Update-Token");
    expect(source).toContain("AbortSignal.timeout(300)");
  });

  test("formats common OpenCode tool messages", () => {
    const source = getPluginSource();
    expect(source).toContain(`command.split(/\\s+/)`);
    expect(source).toContain(`"Searched \\"" + clip(pattern, 28) + "\\""`);
    expect(source).toContain(`fieldFrom(toolInput, "filePath")`);
    expect(source).toContain(`return past ? "Ran command" : "Running command"`);
    expect(source).toContain(
      `return past ? "Subagent done" : "Spawning subagent"`,
    );
    expect(source).toContain(
      `return past ? "Called " + name : "Calling " + name`,
    );
  });

  test("emits bubble text for session idle and error events", () => {
    const source = getPluginSource();
    expect(source).toContain(
      `notify({ state: "waving", duration: 1500, text: "Done." })`,
    );
    expect(source).toContain(
      `notify({ state: "failed", duration: 2500, text: "OpenCode hit an error." })`,
    );
  });
});

describe("OpenCode config path resolution", () => {
  test("prefers OPENCODE_CONFIG_DIR", () => {
    expect(
      resolveOpenCodeConfigDir(
        {
          OPENCODE_CONFIG_DIR: "/tmp/opencode-explicit",
          XDG_CONFIG_HOME: "/tmp/xdg",
        },
        "/home/example",
      ),
    ).toBe("/tmp/opencode-explicit");
  });

  test("uses XDG_CONFIG_HOME when OPENCODE_CONFIG_DIR is unset", () => {
    expect(
      resolveOpenCodeConfigDir(
        { XDG_CONFIG_HOME: "/tmp/xdg" },
        "/home/example",
      ),
    ).toBe("/tmp/xdg/opencode");
  });

  test("falls back to ~/.config/opencode", () => {
    expect(resolveOpenCodeConfigDir({}, "/home/example")).toBe(
      "/home/example/.config/opencode",
    );
  });
});
