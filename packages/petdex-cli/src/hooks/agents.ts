/**
 * Agent registry: where each coding agent lives, how it spells its hooks,
 * and the snippet we drop in to forward events to the petdex sidecar.
 *
 * Adding a new agent means: configDir + configFile + hookEvents.
 * The wizard handles detection, multi-select, and write/restore generically.
 */
import { homedir } from "node:os";
import path from "node:path";

export const PETDEX_PORT = 7777;
export const SIDECAR_URL = `http://127.0.0.1:${PETDEX_PORT}/state`;

export type PetState =
  | "idle"
  | "running"
  | "running-left"
  | "running-right"
  | "waving"
  | "jumping"
  | "failed"
  | "review"
  | "waiting";

/** Mapping from "what kind of CLI lifecycle event happened" to "what state". */
export type EventKind =
  | "tool.before"
  | "tool.after"
  | "session.end"
  | "session.error"
  | "user.prompt";

export const STATE_MAP: Record<EventKind, PetState> = {
  "tool.before": "running",
  "tool.after": "idle",
  "session.end": "waving",
  "session.error": "failed",
  "user.prompt": "jumping",
};

/** A handler maps the agent's hook event name to one of our EventKinds. */
export type HookEntry = {
  event: string;
  kind: EventKind;
  matcher?: string;
};

export type Agent = {
  id: "claude-code" | "codex" | "gemini" | "opencode";
  displayName: string;
  configDir: string;
  configFile: string;
  hookEntries: HookEntry[];
  docsUrl: string;
  /**
   * Build the actual config object the agent expects, given the hook entries.
   * Returns the whole settings object so we can merge into existing files.
   */
  build(): unknown;
};

const HOME = homedir();

export const AGENTS: Agent[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    configDir: path.join(HOME, ".claude"),
    configFile: path.join(HOME, ".claude", "settings.json"),
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code/hooks",
    hookEntries: [
      { event: "PreToolUse", kind: "tool.before" },
      { event: "PostToolUse", kind: "tool.after" },
      { event: "Stop", kind: "session.end" },
    ],
    build() {
      return {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: curlCommand("running"),
                },
              ],
            },
          ],
          PostToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: curlCommand("idle"),
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: curlCommand("waving", 1500),
                },
              ],
            },
          ],
        },
      };
    },
  },
  {
    id: "codex",
    displayName: "Codex CLI",
    configDir: path.join(HOME, ".codex"),
    configFile: path.join(HOME, ".codex", "hooks.json"),
    docsUrl: "https://developers.openai.com/codex/hooks",
    hookEntries: [
      { event: "PreToolUse", kind: "tool.before" },
      { event: "PostToolUse", kind: "tool.after" },
      { event: "Stop", kind: "session.end" },
    ],
    build() {
      return {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: curlCommand("running"),
                },
              ],
            },
          ],
          PostToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: curlCommand("idle"),
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: curlCommand("waving", 1500),
                },
              ],
            },
          ],
        },
      };
    },
  },
  {
    id: "gemini",
    displayName: "Gemini CLI",
    configDir: path.join(HOME, ".gemini"),
    configFile: path.join(HOME, ".gemini", "settings.json"),
    docsUrl: "https://google-gemini.github.io/gemini-cli/docs/hooks",
    hookEntries: [
      { event: "BeforeTool", kind: "tool.before" },
      { event: "AfterTool", kind: "tool.after" },
      { event: "SessionEnd", kind: "session.end" },
    ],
    build() {
      return {
        hooks: {
          BeforeTool: [
            {
              hooks: [
                {
                  type: "command",
                  command: curlCommand("running"),
                },
              ],
            },
          ],
          AfterTool: [
            {
              hooks: [
                {
                  type: "command",
                  command: curlCommand("idle"),
                },
              ],
            },
          ],
          SessionEnd: [
            {
              hooks: [
                {
                  type: "command",
                  command: curlCommand("waving", 1500),
                },
              ],
            },
          ],
        },
      };
    },
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    configDir: path.join(HOME, ".config", "opencode"),
    // OpenCode plugins live as TS/JS files, not in the JSON config. We treat
    // the plugin path as the "config file" for write/uninstall purposes.
    configFile: path.join(HOME, ".config", "opencode", "plugins", "petdex.js"),
    docsUrl: "https://opencode.ai/docs/plugins",
    hookEntries: [
      { event: "tool.execute.before", kind: "tool.before" },
      { event: "tool.execute.after", kind: "tool.after" },
      { event: "session.idle", kind: "session.end" },
      { event: "session.error", kind: "session.error" },
    ],
    build() {
      return openCodePluginSource();
    },
  },
];

function curlCommand(state: PetState, duration?: number): string {
  const body =
    duration != null
      ? `{\\"state\\":\\"${state}\\",\\"duration\\":${duration}}`
      : `{\\"state\\":\\"${state}\\"}`;
  return `curl -s -m 1 -X POST ${SIDECAR_URL} -H 'Content-Type: application/json' -d "${body}" >/dev/null 2>&1 || true`;
}

function openCodePluginSource(): string {
  return `// petdex hook plugin — auto-generated by \`petdex hooks install\`.
// Forwards OpenCode lifecycle events to the petdex desktop mascot via HTTP.
// Edit STATE_MAP below to customize which state each event triggers.

const SIDECAR_URL = ${JSON.stringify(SIDECAR_URL)};

async function setState(state, duration) {
  try {
    await fetch(SIDECAR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(duration != null ? { state, duration } : { state }),
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    // sidecar offline: stay quiet, the agent shouldn't notice.
  }
}

export const PetdexPlugin = async () => ({
  "tool.execute.before": async () => setState("running"),
  "tool.execute.after": async () => setState("idle"),
  event: async ({ event }) => {
    if (event.type === "session.idle") setState("waving", 1500);
    else if (event.type === "session.error") setState("failed", 2500);
  },
});
`;
}
