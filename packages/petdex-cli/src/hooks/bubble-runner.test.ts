import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  bubbleBody,
  clipPreview,
  clipTitle,
  eventFromArgs,
  FAILED_DURATION_MS,
  lastAssistantText,
  pruneSessions,
  readStdin,
  rememberSessionTitle,
  sessionTitle,
  stateBody,
  stateForEvent,
} from "./bubble-runner";

const CLI_PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForClose(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("close", resolve));
}

function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
  const output = child.stdout;
  if (!output) {
    return Promise.reject(new Error("hook child stdout is unavailable"));
  }

  return new Promise((resolve, reject) => {
    let text = "";
    const failOnClose = (code: number | null) => {
      cleanup();
      reject(new Error(`hook child exited before reading stdin: ${code}`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: string) => {
      text += chunk;
      if (!text.includes("ready\n")) return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      output.off("data", onData);
      child.off("close", failOnClose);
      child.off("error", onError);
    };

    output.setEncoding("utf8");
    output.on("data", onData);
    child.once("close", failOnClose);
    child.once("error", onError);
  });
}

async function writeDelayedInput(
  child: ReturnType<typeof spawn>,
  first: string,
  rest: string,
): Promise<void> {
  const input = child.stdin;
  if (!input) throw new Error("hook child stdin is unavailable");

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      input.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => finish(error);

    input.once("error", onError);
    input.write(first, (error) => {
      if (error) {
        finish(error);
        return;
      }
      setTimeout(() => input.end(rest, () => finish()), 180);
    });
  });
}

describe("readStdin", () => {
  test("returns after EOF with the complete payload", async () => {
    const input = new PassThrough();
    const reading = readStdin(input);
    input.end('{"tool_name":"Read"}');
    await expect(reading).resolves.toBe('{"tool_name":"Read"}');
  });

  test("keeps reading until a delayed hook payload reaches EOF", async () => {
    const input = new PassThrough();
    let settled = false;
    const reading = readStdin(input).then((value) => {
      settled = true;
      return value;
    });

    input.write('{"tool_name":"Read","tool_input":"');
    await delay(180);
    expect(settled).toBeFalse();

    input.end('continued"}');
    await expect(reading).resolves.toBe(
      '{"tool_name":"Read","tool_input":"continued"}',
    );
  });

  test("keeps the first 64KB while continuing to drain oversized input", async () => {
    const input = new PassThrough();
    const payload = "x".repeat(96 * 1024);
    const reading = readStdin(input);
    input.end(payload);
    const result = await reading;
    expect(result).toHaveLength(64 * 1024);
  });

  test("copies the retained prefix out of an oversized source chunk", async () => {
    const input = new PassThrough();
    const source = Buffer.alloc(128 * 1024, "a");
    const reading = readStdin(input);

    input.write(source);
    source.fill("b", 0, 64 * 1024);
    input.end();

    await expect(reading).resolves.toBe("a".repeat(64 * 1024));
  });

  test("caps retained input by bytes when the payload contains UTF-8", async () => {
    const input = new PassThrough();
    const retained = `${"\u591a".repeat(21_845)}a`;
    expect(Buffer.byteLength(retained, "utf8")).toBe(64 * 1024);

    const reading = readStdin(input);
    input.end(`${retained}${"x".repeat(64 * 1024)}`);

    await expect(reading).resolves.toBe(retained);
  });

  test("drops a partial UTF-8 code point at the retained byte boundary", async () => {
    const input = new PassThrough();
    const retained = "a".repeat(64 * 1024 - 1);
    const multibyteCharacter = String.fromCodePoint(0x591a);
    const reading = readStdin(input);

    input.end(`${retained}${multibyteCharacter}${"x".repeat(64 * 1024)}`);

    const result = await reading;
    expect(result).toBe(retained);
    expect(result).not.toContain("\uFFFD");
  });

  test("keeps the hook pipe open when disabled while a host finishes a delayed large payload", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "petdex-hook-stdin-"));
    const runtimeDir = join(fakeHome, ".petdex", "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "hooks-disabled"), "");
    const child = spawn(
      process.execPath,
      [
        "-e",
        'import("./src/hooks/bubble-runner.ts").then(async ({ runBubble }) => { const task = runBubble(["post", "codex"]); process.stdout.write("ready\\n"); await task; })',
      ],
      {
        cwd: CLI_PACKAGE_DIR,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
        },
      },
    );
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    try {
      await waitForReady(child);
      await writeDelayedInput(
        child,
        '{"tool_name":"Read","tool_input":"',
        `${"x".repeat(8 * 1024 * 1024)}"}`,
      );

      expect(await waitForClose(child)).toBe(0);
      expect(stderr).toBe("");
    } finally {
      if (child.exitCode === null && !child.killed) child.kill();
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe("eventFromArgs - session-level", () => {
  test("stop returns session.end", () => {
    expect(eventFromArgs(["stop"], "")).toEqual({ kind: "session.end" });
  });

  test("session-end alias", () => {
    expect(eventFromArgs(["session-end"], "")).toEqual({ kind: "session.end" });
  });

  test("user-prompt returns session.start", () => {
    expect(eventFromArgs(["user-prompt"], "")).toEqual({
      kind: "session.start",
    });
  });

  test("waiting / notification returns session.waiting", () => {
    expect(eventFromArgs(["waiting"], "")).toEqual({ kind: "session.waiting" });
    expect(eventFromArgs(["notification"], "")).toEqual({
      kind: "session.waiting",
    });
  });

  test("unknown phase returns null", () => {
    expect(eventFromArgs(["nope"], "")).toBeNull();
  });

  test("missing phase returns null", () => {
    expect(eventFromArgs([], "")).toBeNull();
  });
});

describe("eventFromArgs - tool events", () => {
  test("pre with tool_name parses stdin JSON", () => {
    const stdin = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "/x/y.ts" },
    });
    expect(eventFromArgs(["pre"], stdin)).toEqual({
      kind: "tool",
      phase: "running",
      toolName: "Read",
      toolInput: { file_path: "/x/y.ts" },
    });
  });

  test("post with tool_name", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(eventFromArgs(["post"], stdin)).toEqual({
      kind: "tool",
      phase: "done",
      toolName: "Bash",
      toolInput: { command: "ls" },
    });
  });

  test("pre with empty stdin falls back to generic 'tool'", () => {
    expect(eventFromArgs(["pre"], "")).toEqual({
      kind: "tool",
      phase: "running",
      toolName: "tool",
      toolInput: undefined,
    });
  });

  test("pre with malformed JSON stdin falls back to generic 'tool'", () => {
    expect(eventFromArgs(["pre"], "{ not valid json")).toEqual({
      kind: "tool",
      phase: "running",
      toolName: "tool",
      toolInput: undefined,
    });
  });
});

describe("tool-failure phase (mirrors hook_runner.zig)", () => {
  test("routes to the failed sprite row", () => {
    expect(stateForEvent(["tool-failure"], "Bash")).toBe("failed");
  });

  test("carries toolName through instead of the generic 'tool' substitution", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      error: 'Command failed: "npm test" exited 1',
    });
    expect(eventFromArgs(["tool-failure"], stdin)).toEqual({
      kind: "tool",
      phase: "failed",
      toolName: "Bash",
      toolInput: undefined,
    });
    // Missing tool_name must NOT pick up the lowercase "tool" fallback the
    // running/done path uses — the Zig runner renders "Tool failed".
    expect(eventFromArgs(["tool-failure"], "{}")).toEqual({
      kind: "tool",
      phase: "failed",
      toolName: "",
      toolInput: undefined,
    });
  });

  test("stateBody adds duration only for the failure phase", () => {
    expect(stateBody("failed", FAILED_DURATION_MS, "qoder")).toEqual({
      state: "failed",
      duration: 1220,
      agent_source: "qoder",
    });
    // Key order matches the Zig port: state, duration, agent_source.
    expect(
      JSON.stringify(stateBody("failed", FAILED_DURATION_MS, "qoder")),
    ).toBe('{"state":"failed","duration":1220,"agent_source":"qoder"}');
    // Regression guard: every pre-existing phase must serialize exactly what
    // shipped before this change, with no duration key at all.
    expect(JSON.stringify(stateBody("idle", 0, "claude-code"))).toBe(
      '{"state":"idle","agent_source":"claude-code"}',
    );
    expect(JSON.stringify(stateBody("waving", 0, "codex"))).toBe(
      '{"state":"waving","agent_source":"codex"}',
    );
  });
});

describe("bubbleBody", () => {
  test("carries the session id so the desktop can key one bubble per conversation", () => {
    expect(
      bubbleBody(
        "Reading main.zig",
        true,
        "claude-code",
        "Fix the tail",
        "abc123",
      ),
    ).toEqual({
      text: "Reading main.zig",
      busy: true,
      agent_source: "claude-code",
      title: "Fix the tail",
      session_id: "abc123",
    });
  });

  test("omits session_id entirely when the payload had none", () => {
    // Regression guard: an agent that sends no session_id must serialize
    // exactly what shipped before multi-bubble, so an older desktop and the
    // MCP path both stay on the server's single-bubble key.
    expect(
      JSON.stringify(bubbleBody("Done.", false, "codex", null, null)),
    ).toBe('{"text":"Done.","busy":false,"agent_source":"codex"}');
    expect(
      JSON.stringify(bubbleBody("Done.", false, "codex", "Ship it", null)),
    ).toBe(
      '{"text":"Done.","busy":false,"agent_source":"codex","title":"Ship it"}',
    );
  });
});

describe("stateForEvent", () => {
  test("pre with Read tool routes to review", () => {
    expect(stateForEvent(["pre"], "Read")).toBe("review");
  });

  test("pre with Grep tool routes to review", () => {
    expect(stateForEvent(["pre"], "Grep")).toBe("review");
  });

  test("pre with Glob tool routes to review", () => {
    expect(stateForEvent(["pre"], "Glob")).toBe("review");
  });

  test("pre with case variations still match review", () => {
    expect(stateForEvent(["pre"], "READ")).toBe("review");
    expect(stateForEvent(["pre"], "grep")).toBe("review");
  });

  test("pre with Edit/Write/Bash routes to running", () => {
    expect(stateForEvent(["pre"], "Edit")).toBe("running");
    expect(stateForEvent(["pre"], "Write")).toBe("running");
    expect(stateForEvent(["pre"], "Bash")).toBe("running");
  });

  test("pre with no tool name defaults to running", () => {
    expect(stateForEvent(["pre"], null)).toBe("running");
  });

  test("post returns idle regardless of tool", () => {
    expect(stateForEvent(["post"], "Read")).toBe("idle");
    expect(stateForEvent(["post"], "Bash")).toBe("idle");
    expect(stateForEvent(["post"], null)).toBe("idle");
  });

  test("stop returns waving", () => {
    expect(stateForEvent(["stop"], null)).toBe("waving");
  });

  test("user-prompt returns jumping", () => {
    expect(stateForEvent(["user-prompt"], null)).toBe("jumping");
  });

  test("notification / waiting returns waiting state", () => {
    expect(stateForEvent(["waiting"], null)).toBe("waiting");
    expect(stateForEvent(["notification"], null)).toBe("waiting");
  });

  test("unknown phase returns null", () => {
    expect(stateForEvent(["bogus"], null)).toBeNull();
  });
});

describe("session titles", () => {
  test("remember then read round-trips a clipped title", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/petdex-title-test-${Date.now()}`;
    rememberSessionTitle(dir, "abc-123", "  arregla   el login\n con oauth  ");
    expect(sessionTitle(dir, "abc-123")).toBe("arregla el login con oauth");
  });

  test("missing session reads null", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/petdex-title-test-miss-${Date.now()}`;
    expect(sessionTitle(dir, "nope")).toBeNull();
  });

  test("clipTitle caps at 60 with ellipsis", () => {
    const long = "a".repeat(80);
    const clipped = clipTitle(long);
    expect(clipped.length).toBe(60);
    expect(clipped.endsWith("…")).toBe(true);
  });
});

describe("close-of-turn preview", () => {
  test("extracts the newest assistant text from a transcript tail", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/petdex-transcript-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    const path = `${dir}/t.jsonl`;
    const lines = [
      JSON.stringify({ type: "user", message: { content: "hola" } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "older answer" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash" },
            { type: "text", text: "Listo, el fix quedo\npusheado." },
          ],
        },
      }),
      JSON.stringify({ type: "system", subtype: "hook" }),
    ];
    writeFileSync(path, lines.join("\n"));
    expect(lastAssistantText(path)).toBe("Listo, el fix quedo\npusheado.");
  });

  test("missing transcript reads null", () => {
    expect(lastAssistantText("/nope/definitely-missing.jsonl")).toBeNull();
  });

  test("clipPreview flattens and caps", () => {
    expect(clipPreview("hola\n  mundo")).toBe("hola mundo");
    const long = "x".repeat(200);
    expect(clipPreview(long).length).toBe(110);
    expect(clipPreview(long).endsWith("…")).toBe(true);
  });
});

describe("session GC", () => {
  test("prunes only stale files", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/petdex-gc-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    const fresh = `${dir}/fresh.json`;
    const stale = `${dir}/stale.json`;
    writeFileSync(fresh, "{}");
    writeFileSync(stale, "{}");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    pruneSessions(dir);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });
});
