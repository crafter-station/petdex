import { describe, expect, test } from "bun:test";

import { createNormalizer } from "./src/normalize.js";

function session(
  id: string,
  options: { parentSession?: string; origin?: string } = {},
) {
  return {
    id,
    header: {
      parentSession: options.parentSession,
      origin: options.origin,
    },
  };
}

describe("DSH event normalization", () => {
  test("maps a nested subagent event to the top-level session", () => {
    const normalizer = createNormalizer();
    normalizer.rememberSession(session("root"));
    normalizer.rememberSession(
      session("child", { parentSession: "root", origin: "subagent" }),
    );

    expect(
      normalizer.normalize(session("child"), {
        type: "tool-workflow/run-start",
        seq: 7,
        time: 123,
        data: { runId: "secret-run", prompt: "must not escape" },
      }),
    ).toEqual({
      kind: "workflow.started",
      rootSessionId: "root",
      sourceSessionId: "child",
      sourceSeq: 7,
      occurredAt: 123,
      state: "running",
      text: "Workflow running",
      busy: true,
    });
  });

  test("does not collapse an ordinary fork into its parent", () => {
    const normalizer = createNormalizer();
    normalizer.rememberSession(session("root"));
    normalizer.rememberSession(
      session("fork", { parentSession: "root", origin: "fork" }),
    );

    expect(
      normalizer.normalize(session("fork"), {
        type: "turn/start",
        seq: 1,
        time: 10,
        data: {},
      })?.rootSessionId,
    ).toBe("fork");
  });

  test("aggregates approvals without exposing the approval payload", () => {
    const normalizer = createNormalizer();
    const root = session("root");
    normalizer.rememberSession(root);

    expect(
      normalizer.normalize(root, {
        type: "approval/asked",
        seq: 3,
        time: 30,
        data: {
          id: "approval-a",
          toolName: "shell",
          reason: "private reason",
        },
      }),
    ).toEqual({
      kind: "intervention.requested",
      rootSessionId: "root",
      sourceSessionId: "root",
      sourceSeq: 3,
      occurredAt: 30,
      state: "waiting",
      text: "Needs your attention",
      busy: true,
    });

    expect(
      normalizer.normalize(root, {
        type: "approval/decided",
        seq: 4,
        time: 31,
        data: { id: "approval-a", outcome: { kind: "allow-once" } },
      }),
    ).toEqual({
      kind: "intervention.resolved",
      rootSessionId: "root",
      sourceSessionId: "root",
      sourceSeq: 4,
      occurredAt: 31,
      state: "running",
      text: "Working",
      busy: true,
    });
  });

  test("allows only fixed content-free lifecycle projections", () => {
    const normalizer = createNormalizer();
    const root = session("root");
    normalizer.rememberSession(root);

    expect(
      normalizer.normalize(root, {
        type: "tool/call",
        seq: 5,
        time: 50,
        data: {
          name: "bash",
          arguments: { command: "cat ~/.ssh/id_rsa" },
        },
      }),
    ).toMatchObject({
      kind: "tool.started",
      state: "running",
      text: "Using a tool",
    });

    expect(
      normalizer.normalize(root, {
        type: "assistant/chunk",
        seq: 6,
        time: 51,
        data: { text: "private output" },
      }),
    ).toBeNull();
  });

  test("only a root turn ending can complete the top-level card", () => {
    const normalizer = createNormalizer();
    const root = session("root");
    const child = session("child", {
      parentSession: "root",
      origin: "subagent",
    });
    normalizer.rememberSession(root);
    normalizer.rememberSession(child);

    expect(
      normalizer.normalize(child, {
        type: "turn/end",
        seq: 9,
        time: 90,
        data: { reason: { kind: "completed" } },
      }),
    ).toMatchObject({
      kind: "subagent.updated",
      rootSessionId: "root",
      state: "running",
      busy: true,
    });

    expect(
      normalizer.normalize(root, {
        type: "turn/end",
        seq: 10,
        time: 100,
        data: { reason: { kind: "completed" } },
      }),
    ).toMatchObject({
      kind: "turn.completed",
      rootSessionId: "root",
      state: "waving",
      text: "Done",
      busy: false,
    });
  });

  test("deduplicates by source session and source sequence", () => {
    const normalizer = createNormalizer();
    const root = session("root");
    normalizer.rememberSession(root);
    const event = { type: "turn/start", seq: 1, time: 10, data: {} };

    expect(normalizer.normalize(root, event)).not.toBeNull();
    expect(normalizer.normalize(root, event)).toBeNull();
  });
});
