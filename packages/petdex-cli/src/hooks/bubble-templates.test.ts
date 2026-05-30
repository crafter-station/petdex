import { describe, expect, test } from "bun:test";

import { formatBubble } from "./bubble-templates";

describe("formatBubble - session events", () => {
  test("session.start renders Thinking", () => {
    expect(formatBubble({ kind: "session.start" })).toBe("Thinking…");
  });

  test("session.end renders Done", () => {
    expect(formatBubble({ kind: "session.end" })).toBe("Done.");
  });

  test("session.waiting renders Waiting", () => {
    expect(formatBubble({ kind: "session.waiting" })).toBe("Waiting for you…");
  });
});

describe("formatBubble - read tool", () => {
  test("running with file_path uses basename", () => {
    expect(
      formatBubble({
        kind: "tool",
        phase: "running",
        toolName: "Read",
        toolInput: { file_path: "/Users/r/src/server.ts" },
      }),
    ).toBe("Reading server.ts");
  });

  test("done past tense with basename", () => {
    expect(
      formatBubble({
        kind: "tool",
        phase: "done",
        toolName: "Read",
        toolInput: { file_path: "/Users/r/src/server.ts" },
      }),
    ).toBe("Read server.ts");
  });

  test("missing file_path falls back to generic", () => {
    expect(
      formatBubble({
        kind: "tool",
        phase: "running",
        toolName: "Read",
        toolInput: {},
      }),
    ).toBe("Reading file");
  });
});

describe("formatBubble - edit + write", () => {
  test("Edit running shows Editing", () => {
    expect(
      formatBubble({
        kind: "tool",
        phase: "running",
        toolName: "Edit",
        toolInput: { file_path: "/a/b/c.ts" },
      }),
    ).toBe("Editing c.ts");
  });

  test("Write done shows Edited (write maps to edit family)", () => {
    expect(
      formatBubble({
        kind: "tool",
        phase: "done",
        toolName: "Write",
        toolInput: { file_path: "x.md" },
      }),
    ).toBe("Edited x.md");
  });

  test("MultiEdit groups under edit", () => {
    expect(
      formatBubble({
        kind: "tool",
        phase: "running",
        toolName: "MultiEdit",
        toolInput: { file_path: "foo.tsx" },
      }),
    ).toBe("Editing foo.tsx");
  });
});

describe("formatBubble - bash/shell", () => {
  test("running with command shows first token", () => {
    expect(
      formatBubble({
        kind: "tool",
        phase: "running",
        toolName: "Bash",
        toolInput: { command: "bun test --watch" },
      }),
    ).toBe("Running bun");
  });

  test("done past tense", () => {
    expect(
      formatBubble({
        kind: "tool",
        phase: "done",
        toolName: "Bash",
        toolInput: { command: "git status" },
      }),
    ).toBe("Ran git");
  });

  test("missing command falls back", () => {
    expect(
      formatBubble({
        kind: "tool",
        phase: "running",
        toolName: "shell",
        toolInput: {},
      }),
    ).toBe("Running command");
  });
});

describe("formatBubble - grep + glob", () => {
  test("Grep running with pattern", () => {
    expect(
      formatBubble({
        kind: "tool",
        phase: "running",
        toolName: "Grep",
        toolInput: { pattern: "TODO" },
      }),
    ).toBe('Searching "TODO"');
  });

  test("Glob done with pattern", () => {
    expect(
      formatBubble({
        kind: "tool",
        phase: "done",
        toolName: "Glob",
        toolInput: { pattern: "**/*.ts" },
      }),
    ).toBe("Listed **/*.ts");
  });
});

describe("formatBubble - WebFetch", () => {
  test("running shows hostname", () => {
    expect(
      formatBubble({
        kind: "tool",
        phase: "running",
        toolName: "WebFetch",
        toolInput: { url: "https://docs.anthropic.com/en/docs/x" },
      }),
    ).toBe("Fetching docs.anthropic.com");
  });

  test("invalid URL falls back to generic", () => {
    expect(
      formatBubble({
        kind: "tool",
        phase: "running",
        toolName: "WebFetch",
        toolInput: { url: "not a url" },
      }),
    ).toBe("Searching web");
  });
});

describe("formatBubble - unknown tool", () => {
  test("uses generic Calling X / Called X", () => {
    expect(
      formatBubble({
        kind: "tool",
        phase: "running",
        toolName: "mcp__custom__do_thing",
        toolInput: {},
      }),
    ).toBe("Calling mcp__custom__do_thing");
    expect(
      formatBubble({
        kind: "tool",
        phase: "done",
        toolName: "mcp__custom__do_thing",
        toolInput: {},
      }),
    ).toBe("Called mcp__custom__do_thing");
  });
});

describe("formatBubble - clipping", () => {
  test("very long basename gets ellipsized", () => {
    const longName = `${"a".repeat(100)}.ts`;
    const text = formatBubble({
      kind: "tool",
      phase: "running",
      toolName: "Read",
      toolInput: { file_path: `/x/${longName}` },
    });
    expect(text.length).toBeLessThanOrEqual("Reading ".length + 41);
    expect(text).toContain("Reading ");
    expect(text).toContain("…");
  });

  test("never throws on weird input", () => {
    expect(() =>
      formatBubble({
        kind: "tool",
        phase: "running",
        toolName: "Whatever",
        toolInput: null,
      }),
    ).not.toThrow();
    expect(() =>
      formatBubble({
        kind: "tool",
        phase: "done",
        toolName: "Read",
        toolInput: 42,
      }),
    ).not.toThrow();
  });
});
