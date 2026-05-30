import { describe, expect, test } from "bun:test";

import { eventFromArgs, stateForEvent } from "./bubble-runner";

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
