import { describe, expect, test } from "bun:test";

import { stripPetdexHooks } from "./uninstall";
import { PETDEX_PORT, SIDECAR_URL } from "./agents";

// stripPetdexHooks is the pure-data half of `petdex hooks uninstall`.
// It must:
//   - leave non-petdex entries alone (the user's own hooks),
//   - drop entries whose command references our sidecar URL or port,
//   - clean up empty event arrays,
//   - drop the entire `hooks` key when nothing remains,
//   - leave non-hook config keys (mcpServers, statusLine, etc.)
//     untouched.

describe("stripPetdexHooks", () => {
  test("removes only the petdex entry, keeps user's own hooks", () => {
    const before = {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: 'echo "user hook"',
              },
            ],
          },
          {
            hooks: [
              {
                type: "command",
                command: `curl ${SIDECAR_URL} -d 'x'`,
              },
            ],
          },
        ],
      },
    };
    const { value, changed } = stripPetdexHooks(before);
    expect(changed).toBe(true);
    const result = value as { hooks: { PreToolUse: unknown[] } };
    expect(result.hooks.PreToolUse).toHaveLength(1);
    expect(JSON.stringify(result)).toContain("user hook");
    expect(JSON.stringify(result)).not.toContain(SIDECAR_URL);
  });

  test("drops entries that reference :7777/state even on a different host string", () => {
    const before = {
      hooks: {
        PostToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: `curl http://localhost:${PETDEX_PORT}/state -d 'x'`,
              },
            ],
          },
        ],
      },
    };
    const { value, changed } = stripPetdexHooks(before);
    expect(changed).toBe(true);
    expect((value as Record<string, unknown>).hooks).toBeUndefined();
  });

  test("drops the hooks key entirely when no events remain", () => {
    const before = {
      mcpServers: { foo: { command: "x" } },
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: `curl ${SIDECAR_URL}` },
            ],
          },
        ],
      },
    };
    const { value, changed } = stripPetdexHooks(before);
    expect(changed).toBe(true);
    expect((value as Record<string, unknown>).hooks).toBeUndefined();
    // mcpServers must be preserved.
    expect((value as Record<string, unknown>).mcpServers).toEqual({
      foo: { command: "x" },
    });
  });

  test("returns changed=false when nothing matches", () => {
    const before = {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              { type: "command", command: 'echo "user hook"' },
            ],
          },
        ],
      },
    };
    const { value, changed } = stripPetdexHooks(before);
    expect(changed).toBe(false);
    expect(value).toEqual(before);
  });

  test("handles missing hooks key gracefully", () => {
    const before = { mcpServers: {} };
    const { value, changed } = stripPetdexHooks(before);
    expect(changed).toBe(false);
    expect(value).toEqual(before);
  });

  test("handles non-array entries by passing them through", () => {
    // If a future agent uses a non-array shape under hooks, leave it
    // alone — better than silently corrupting unfamiliar config.
    const before = {
      hooks: {
        custom: { someKey: "someValue" },
      },
    };
    const { value, changed } = stripPetdexHooks(before);
    expect(changed).toBe(false);
    expect(value).toEqual(before);
  });

  test("preserves nested user hooks under the same event", () => {
    // Multiple user hooks + one petdex hook under the same event.
    // After strip we expect the user's two hooks intact and the
    // petdex entry gone.
    const before = {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "command", command: "echo a" }] },
          { hooks: [{ type: "command", command: `curl ${SIDECAR_URL}` }] },
          { hooks: [{ type: "command", command: "echo b" }] },
        ],
      },
    };
    const { value, changed } = stripPetdexHooks(before);
    expect(changed).toBe(true);
    const result = value as { hooks: { PreToolUse: unknown[] } };
    expect(result.hooks.PreToolUse).toHaveLength(2);
    expect(JSON.stringify(result)).toContain("echo a");
    expect(JSON.stringify(result)).toContain("echo b");
    expect(JSON.stringify(result)).not.toContain(SIDECAR_URL);
  });
});
