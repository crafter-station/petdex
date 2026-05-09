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

export type PostInstallNote = {
  level: "info" | "warn" | "action";
  message: string;
  /**
   * Optional auto-fix the wizard offers to apply after asking the user.
   * The closure must be idempotent and surface its own success/failure
   * via the returned message; we do not retry or roll back automatically.
   */
  fix?: {
    prompt: string;
    apply: () => Promise<{ ok: boolean; message: string }>;
  };
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
  /**
   * Optional follow-up checks the wizard runs after writing the config.
   * Used to surface agent-specific feature flags or steps the user must
   * still take (e.g. Codex requires `[features] codex_hooks = true` in
   * config.toml before hooks load).
   */
  postInstallChecks?(): Promise<PostInstallNote[]>;
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
    async postInstallChecks() {
      // Codex only loads hooks.json when `[features] codex_hooks = true`
      // is present in ~/.codex/config.toml. We surface the requirement and
      // offer an opt-in auto-fix that appends safely without touching the
      // user's existing comments or formatting.
      const { readFile } = await import("node:fs/promises");
      const tomlPath = path.join(HOME, ".codex", "config.toml");
      const enabledRe = /^\s*codex_hooks\s*=\s*true\b/m;
      let exists = true;
      let text = "";
      try {
        text = await readFile(tomlPath, "utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          exists = false;
        } else {
          return [
            {
              level: "warn",
              message: `Could not read ${tomlPath} (${code ?? "io_error"}). Make sure [features] codex_hooks = true is set there before Codex picks up the hooks.`,
            },
          ];
        }
      }
      if (exists && enabledRe.test(text)) return [];

      const fix = {
        prompt: exists
          ? `Append [features] codex_hooks = true to ${tildePath(tomlPath)}? (a .bak of the current file is created first)`
          : `Create ${tildePath(tomlPath)} with [features] codex_hooks = true?`,
        apply: async () => {
          const { writeFile, mkdir } = await import("node:fs/promises");
          await mkdir(path.dirname(tomlPath), { recursive: true });
          if (exists) {
            // Back up first.
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const backup = `${tomlPath}.${stamp}.bak`;
            try {
              await writeFile(backup, text);
            } catch (err) {
              return {
                ok: false,
                message: `Backup failed: ${(err as Error).message}`,
              };
            }
            // Append-safe edit: never rewrites existing lines. If [features]
            // already exists, insert codex_hooks = true right after the
            // header. Otherwise append the whole block at the end.
            const featuresHeader = /^\s*\[features\]\s*$/m;
            let next: string;
            if (featuresHeader.test(text)) {
              next = text.replace(
                featuresHeader,
                (m) => `${m}\ncodex_hooks = true`,
              );
            } else {
              const sep = text.endsWith("\n") || text.length === 0 ? "" : "\n";
              next = `${text}${sep}\n[features]\ncodex_hooks = true\n`;
            }
            try {
              await writeFile(tomlPath, next, "utf8");
              return {
                ok: true,
                message: `codex_hooks = true added to ${tildePath(tomlPath)} (backup: ${path.basename(backup)})`,
              };
            } catch (err) {
              return {
                ok: false,
                message: `Write failed: ${(err as Error).message}`,
              };
            }
          }
          // File doesn't exist: create fresh.
          try {
            await writeFile(
              tomlPath,
              `[features]\ncodex_hooks = true\n`,
              "utf8",
            );
            return {
              ok: true,
              message: `Created ${tildePath(tomlPath)} with [features] codex_hooks = true`,
            };
          } catch (err) {
            return {
              ok: false,
              message: `Write failed: ${(err as Error).message}`,
            };
          }
        },
      };

      return [
        {
          level: "action",
          message: `Codex needs codex_hooks = true under [features] in ${tildePath(tomlPath)} before it loads ${tildePath(path.join(HOME, ".codex", "hooks.json"))}.`,
          fix,
        },
      ];
    },
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

function tildePath(p: string): string {
  if (p.startsWith(HOME)) return `~${p.slice(HOME.length)}`;
  return p;
}
