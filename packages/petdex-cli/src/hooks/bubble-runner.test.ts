import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";

import {
  clipPreview,
  clipTitle,
  eventFromArgs,
  lastAssistantText,
  pruneSessions,
  readStdin,
  rememberSessionTitle,
  sessionTitle,
  stateForEvent,
} from "./bubble-runner";

describe("readStdin", () => {
  test("returns after EOF with the complete payload", async () => {
    const input = new PassThrough();
    const reading = readStdin(input);
    input.end('{"tool_name":"Read"}');
    await expect(reading).resolves.toBe('{"tool_name":"Read"}');
  });

  test("returns within the deadline when stdin stays open", async () => {
    const input = new PassThrough();
    const start = performance.now();
    const reading = readStdin(input);
    input.write('{"tool_name":"Read"}');
    await expect(reading).resolves.toBe('{"tool_name":"Read"}');
    expect(performance.now() - start).toBeLessThan(500);
    input.destroy();
  });

  test("keeps the first 64KB while continuing to drain oversized input", async () => {
    const input = new PassThrough();
    const payload = "x".repeat(96 * 1024);
    const reading = readStdin(input);
    input.end(payload);
    const result = await reading;
    expect(result).toHaveLength(64 * 1024);
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
