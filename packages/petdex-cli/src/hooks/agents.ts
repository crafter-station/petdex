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
  | "session.waiting"
  | "user.prompt";

export const STATE_MAP: Record<EventKind, PetState> = {
  "tool.before": "running",
  "tool.after": "idle",
  "session.end": "waving",
  "session.error": "failed",
  "session.waiting": "waiting",
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
  id: "claude-code" | "codex" | "gemini" | "opencode" | "antigravity";
  displayName: string;
  configDir: string;
  configFile: string;
  hookEntries: HookEntry[];
  docsUrl: string;
  /**
   * Where this agent looks for user-defined slash commands. We drop a
   * /petdex command file here so users can toggle the killswitch from
   * inside their agent without leaving for a shell.
   *
   * Each agent has its own directory:
   *   - Claude Code:  ~/.claude/commands/petdex.md
   *   - Codex:        ~/.codex/prompts/petdex.md
   *   - OpenCode:     ~/.config/opencode/command/petdex.md
   *   - Gemini:       ~/.gemini/commands/petdex.toml
   */
  slashCommandPath: string;
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
const OPENCODE_CONFIG_DIR = resolveOpenCodeConfigDir();

export function resolveOpenCodeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home = HOME,
): string {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, "opencode");
  return path.join(home, ".config", "opencode");
}

/**
 * Antigravity MCP config paths.
 *
 * Antigravity stores its global MCP config in different places depending
 * on the platform:
 *
 *   Windows: %LOCALAPPDATA%\Programs\antigravity\User\mcp_config.json
 *   macOS/Linux: ~/.gemini/antigravity/mcp_config.json
 */
export function antigravityMcpConfigPaths(): string[] {
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(HOME, "AppData", "Local");
  const winPath = path.join(
    localAppData,
    "Programs",
    "antigravity",
    "User",
    "mcp_config.json",
  );
  const geminiPath = path.join(
    HOME,
    ".gemini",
    "antigravity",
    "mcp_config.json",
  );
  const legacyUnixPath = path.join(HOME, ".antigravity", "mcp_config.json");
  if (process.platform === "win32") {
    return [winPath, geminiPath, legacyUnixPath];
  }
  return [geminiPath, legacyUnixPath, winPath];
}

/**
 * Resolve the Antigravity MCP config path that actually exists, or
 * return the platform-default if neither exists.
 */
export async function resolveAntigravityMcpConfigPath(): Promise<string> {
  const { stat } = await import("node:fs/promises");
  const [primary, ...fallbacks] = antigravityMcpConfigPaths();
  for (const candidate of [primary, ...fallbacks]) {
    try {
      await stat(candidate);
      return candidate;
    } catch {}
  }
  return primary;
}

/**
 * Synchronous version — returns the platform-default primary path.
 * The async `resolveAntigravityMcpConfigPath()` should be used at
 * install time; this is only for the static Agent configFile field.
 */
export function antigravityMcpConfigPath(): string {
  const [primary] = antigravityMcpConfigPaths();
  return primary;
}

export function antigravityConfigDir(): string {
  return path.dirname(antigravityMcpConfigPath());
}

export function antigravityGlobalMcpConfigPath(): string {
  return antigravityMcpConfigPath();
}

export function antigravitySkillDir(): string {
  return path.join(HOME, ".gemini", "antigravity", "skills", "petdex");
}

export const AGENTS: Agent[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    configDir: path.join(HOME, ".claude"),
    configFile: path.join(HOME, ".claude", "settings.json"),
    slashCommandPath: path.join(HOME, ".claude", "commands", "petdex.md"),
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code/hooks",
    hookEntries: [
      { event: "UserPromptSubmit", kind: "user.prompt" },
      // No matcher split here — the bubble runner reads tool_name from
      // the agent's hook stdin and decides Read/Grep/Glob → review
      // vs everything else → running, all in one place.
      { event: "PreToolUse", kind: "tool.before" },
      { event: "PostToolUse", kind: "tool.after" },
      // Notifications fire on permission prompts and idle alerts —
      // perfect signal for the "waiting" state.
      { event: "Notification", kind: "session.waiting" },
      { event: "Stop", kind: "session.end" },
    ],
    build() {
      return {
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: bubbleHookCommand(
                    "claude-code",
                    "user-prompt",
                    "jumping",
                    800,
                  ),
                },
              ],
            },
          ],
          PreToolUse: [
            // We DON'T split on matcher anymore: the bubble runner
            // looks at tool_name from stdin and routes Read/Grep/Glob
            // to "review" itself. One unified entry keeps the hooks
            // file compact and removes a maintenance trap (matcher
            // drift between agents.ts and bubble-runner.ts).
            {
              hooks: [
                {
                  type: "command",
                  command: bubbleHookCommand("claude-code", "pre", "running"),
                },
              ],
            },
          ],
          PostToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: bubbleHookCommand("claude-code", "post", "idle"),
                },
              ],
            },
          ],
          Notification: [
            {
              hooks: [
                {
                  type: "command",
                  command: bubbleHookCommand(
                    "claude-code",
                    "notification",
                    "waiting",
                  ),
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: bubbleHookCommand(
                    "claude-code",
                    "stop",
                    "waving",
                    1500,
                  ),
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
    slashCommandPath: path.join(HOME, ".codex", "prompts", "petdex.md"),
    docsUrl: "https://developers.openai.com/codex/hooks",
    hookEntries: [
      { event: "UserPromptSubmit", kind: "user.prompt" },
      { event: "PreToolUse", kind: "tool.before" },
      { event: "PostToolUse", kind: "tool.after" },
      { event: "PermissionRequest", kind: "session.waiting" },
      { event: "Stop", kind: "session.end" },
    ],
    async postInstallChecks() {
      // Codex only loads hooks.json when [features] codex_hooks = true is
      // present in ~/.codex/config.toml. The detect + edit pair below is
      // section-aware: a top-level codex_hooks or a codex_hooks under a
      // different table doesn't count, and an existing
      // [features].codex_hooks gets its value rewritten in place rather
      // than appended (which would produce ambiguous TOML).
      const { readFile } = await import("node:fs/promises");
      const tomlPath = path.join(HOME, ".codex", "config.toml");
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

      const inspection = exists
        ? inspectFeaturesCodexHooks(text)
        : { state: "missing-file" as const };
      if (inspection.state === "enabled") return [];

      const fix = {
        prompt:
          inspection.state === "missing-file"
            ? `Create ${tildePath(tomlPath)} with [features] codex_hooks = true?`
            : inspection.state === "wrong-value"
              ? `Set codex_hooks = true under [features] in ${tildePath(tomlPath)}? (a .bak of the current file is created first)`
              : `Add codex_hooks = true under [features] in ${tildePath(tomlPath)}? (a .bak of the current file is created first)`,
        apply: async () => {
          const { writeFile, mkdir } = await import("node:fs/promises");
          await mkdir(path.dirname(tomlPath), { recursive: true });
          if (!exists) {
            try {
              await writeFile(
                tomlPath,
                "[features]\ncodex_hooks = true\n",
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
          }
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
          const next = applyCodexHooksFix(text, inspection);
          try {
            await writeFile(tomlPath, next, "utf8");
            return {
              ok: true,
              message: `codex_hooks = true set in ${tildePath(tomlPath)} (backup: ${path.basename(backup)})`,
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
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: bubbleHookCommand(
                    "codex",
                    "user-prompt",
                    "jumping",
                    800,
                  ),
                },
              ],
            },
          ],
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: bubbleHookCommand("codex", "pre", "running"),
                },
              ],
            },
          ],
          PostToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: bubbleHookCommand("codex", "post", "idle"),
                },
              ],
            },
          ],
          // Codex fires PermissionRequest when it needs the user to
          // approve a sandbox-elevated action; perfect signal for
          // the waiting-for-input state.
          PermissionRequest: [
            {
              hooks: [
                {
                  type: "command",
                  command: bubbleHookCommand(
                    "codex",
                    "notification",
                    "waiting",
                  ),
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: bubbleHookCommand("codex", "stop", "waving", 1500),
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
    slashCommandPath: path.join(HOME, ".gemini", "commands", "petdex.toml"),
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
                  command: bubbleHookCommand("gemini", "pre", "running"),
                },
              ],
            },
          ],
          AfterTool: [
            {
              hooks: [
                {
                  type: "command",
                  command: bubbleHookCommand("gemini", "post", "idle"),
                },
              ],
            },
          ],
          SessionEnd: [
            {
              hooks: [
                {
                  type: "command",
                  command: bubbleHookCommand("gemini", "stop", "waving", 1500),
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
    configDir: OPENCODE_CONFIG_DIR,
    // OpenCode plugins live as TS/JS files, not in the JSON config. We treat
    // the plugin path as the "config file" for write/uninstall purposes.
    configFile: path.join(OPENCODE_CONFIG_DIR, "plugins", "petdex.js"),
    slashCommandPath: path.join(OPENCODE_CONFIG_DIR, "command", "petdex.md"),
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
    async postInstallChecks() {
      return [
        {
          level: "info",
          message: `OpenCode plugin installed at ${tildePath(path.join(OPENCODE_CONFIG_DIR, "plugins", "petdex.js"))}. If hooks still do not load, start OpenCode with the same OPENCODE_CONFIG_DIR/XDG_CONFIG_HOME environment used during install.`,
        },
      ];
    },
  },
  {
    id: "antigravity",
    displayName: "Antigravity",
    configDir: antigravityConfigDir(),
    // Antigravity doesn't use a hooks JSON file. Instead we inject an
    // MCP server config and an Agent Skill. We point configFile to the
    // MCP config so the install/uninstall system knows what to write.
    configFile: antigravityMcpConfigPath(),
    slashCommandPath: path.join(
      HOME,
      ".gemini",
      "antigravity",
      "skills",
      "petdex",
      "SKILL.md",
    ),
    docsUrl: "https://antigravity.google/docs/skills",
    // Antigravity doesn't support lifecycle hooks (BeforeTool/AfterTool).
    // Instead we provide an MCP server + Agent Skill that tells the agent
    // to call MCP tools before/after each action.
    hookEntries: [],
    build() {
      return {};
    },
    async postInstallChecks() {
      return [
        {
          level: "action",
          message: `Antigravity uses MCP instead of hooks. The petdex MCP server was injected into your Antigravity MCP config.\n\nTo activate:\n  1. Open Antigravity → Agent Panel → ... → MCP Servers\n  2. Verify "petdex" MCP server is listed and running\n  3. The Petdex Agent Skill is installed at ~/.gemini/antigravity/skills/petdex/\n\nThe agent should start updating the mascot automatically when working in this project.`,
        },
      ];
    },
  },
];

/**
 * Build a hook command that prefers the persisted petdex binary
 * (~/.petdex/bin/petdex.js, written by `petdex hooks install`).
 *
 * The persisted binary supports `petdex bubble <phase> <agent>` which:
 *   - reads stdin from the agent's hook payload
 *   - posts BOTH the sprite state AND a contextual bubble
 *
 * If the binary isn't there (user didn't run install yet, or persist
 * failed), the command falls back to the simple curl that just sets
 * the sprite state. Bubbles are silently disabled in that mode.
 *
 * Both branches share the killswitch + token-gate envelope of the
 * original curlCommand, so agent UIs stay clean.
 */
function bubbleHookCommand(
  agentId: Agent["id"],
  phase: string,
  fallbackState: PetState,
  fallbackDuration?: number,
): string {
  const killswitch = `[ -f "$HOME/.petdex/runtime/hooks-disabled" ] && exit 0`;
  const persistPath = `$HOME/.petdex/bin/petdex.js`;
  // Persisted binary path: reads stdin via Node, posts both /state
  // and /bubble. We stream stdin into the node process explicitly
  // (via `cat`-style redirect) so the hook payload reaches it.
  // 600ms timeout for the whole node invocation: cold startup runs
  // ~80-150ms, fetch adds ~5ms x 2, leaving headroom.
  // exec command (no `&` background): we want the bubble to land
  // before the agent's next tool call so the WebView shows the
  // current operation, not a stale one.
  const persistedBranch = [
    `if [ -x "${persistPath}" ] || [ -f "${persistPath}" ]; then`,
    // The bubble subcommand reads stdin, so we don't need to
    // transform anything — just invoke and let it consume.
    `  node "${persistPath}" bubble ${phase} ${agentId} >/dev/null 2>&1 || true;`,
    `else`,
    `  ${curlOnlyState(agentId, fallbackState, fallbackDuration)};`,
    `fi`,
  ].join(" ");
  return `${killswitch}; ${persistedBranch}`;
}

/** Emit only the curl part — used by bubbleHookCommand's fallback branch. */
function curlOnlyState(
  agentId: Agent["id"],
  state: PetState,
  duration?: number,
): string {
  const body =
    duration != null
      ? `{"state":"${state}","duration":${duration},"agent_source":"${agentId}"}`
      : `{"state":"${state}","agent_source":"${agentId}"}`;
  return [
    `T="$(cat "$HOME/.petdex/runtime/update-token" 2>/dev/null)"`,
    `[ -n "$T" ] && curl -s -m 0.3 -X POST ${SIDECAR_URL}`,
    `-H "Content-Type: application/json"`,
    `-H "X-Petdex-Update-Token: $T"`,
    `--data-raw '${body}'`,
    `>/dev/null 2>&1 || true`,
  ].join(" ");
}

function _curlCommand(
  agentId: Agent["id"],
  state: PetState,
  duration?: number,
): string {
  // The string we return here is what gets stored as the literal
  // shell command in agent settings JSON. JSON.stringify (called by
  // the agent merging code) handles JSON-escaping; we just need to
  // emit the raw shell text we want the shell to see.
  //
  // Killswitch: if ~/.petdex/runtime/hooks-disabled exists, exit 0
  // before any token read or network attempt. Users toggle it with
  // `/petdex` from inside their agent (or `petdex hooks toggle`
  // from a shell). Important properties:
  //   - exit 0, NEVER non-zero — a non-zero hook in Claude Code
  //     stains the UI; we want this to be invisible.
  //   - check FIRST so a stale token + dead sidecar doesn't waste
  //     even a TCP RST when the user opted out.
  //
  // Token gate: read ~/.petdex/runtime/update-token at hook
  // execution time. POSIX shells happily nest double quotes inside
  // a $() — `T="$(cat "$HOME/foo" 2>/dev/null)"` is well-formed —
  // so we don't need any escapes here. An earlier version pre-
  // escaped the inner quotes, which produced literal backslash-
  // quote sequences in the final settings file and made T always
  // come back empty, silently disabling the hook.
  // Body always carries agent_source so the sidecar can route
  // updates to the correct mascot when we ship per-agent pets in
  // a future PR. Today the field is recorded for telemetry but
  // doesn't affect routing. Stamping it now means existing
  // installs work seamlessly when multi-pet ships.
  const body =
    duration != null
      ? `{"state":"${state}","duration":${duration},"agent_source":"${agentId}"}`
      : `{"state":"${state}","agent_source":"${agentId}"}`;
  // Three statements separated by `;`:
  //   1. killswitch: bail if disabled
  //   2. read token from disk
  //   3. POST iff token non-empty (and swallow any curl error)
  // -m 0.3 instead of -m 1: 300ms is well above any realistic
  // localhost roundtrip and below the threshold a human notices
  // as agent latency. With -m 1 a stuck sidecar would have added
  // up to a full second per tool call.
  const killswitch = `[ -f "$HOME/.petdex/runtime/hooks-disabled" ] && exit 0`;
  const assign = `T="$(cat "$HOME/.petdex/runtime/update-token" 2>/dev/null)"`;
  const post = [
    `[ -n "$T" ] && curl -s -m 0.3 -X POST ${SIDECAR_URL}`,
    `-H "Content-Type: application/json"`,
    `-H "X-Petdex-Update-Token: $T"`,
    `--data-raw '${body}'`,
    `>/dev/null 2>&1 || true`,
  ].join(" ");
  return `${killswitch}; ${assign}; ${post}`;
}

function openCodePluginSource(): string {
  const sidecarBubbleUrl = SIDECAR_URL.replace(/\/state$/, "/bubble");
  return String.raw`// petdex hook plugin. Auto-generated by 'petdex hooks install'.
// Forwards OpenCode lifecycle events to the petdex desktop mascot via HTTP.
// Edit STATE_MAP below to customize which state each event triggers.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SIDECAR_URL = ${JSON.stringify(SIDECAR_URL)};
const SIDECAR_BUBBLE_URL = ${JSON.stringify(sidecarBubbleUrl)};
const RUNTIME_DIR = join(homedir(), ".petdex", "runtime");
const TOKEN_PATH = join(RUNTIME_DIR, "update-token");
const KILLSWITCH_PATH = join(RUNTIME_DIR, "hooks-disabled");

async function readToken() {
  try {
    return (await readFile(TOKEN_PATH, "utf8")).trim();
  } catch {
    return null;
  }
}

function fieldFrom(input, key) {
  if (input == null || typeof input !== "object") return null;
  const value = input[key];
  return typeof value === "string" ? value : null;
}

function basename(filePath) {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return slash >= 0 ? filePath.slice(slash + 1) : filePath;
}

function clip(text, max = 40) {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function canonicalToolKind(toolName) {
  const lower = String(toolName || "").toLowerCase();
  if (lower === "read") return "read";
  if (lower === "edit" || lower === "multiedit") return "edit";
  if (lower === "write") return "write";
  if (lower === "bash" || lower === "shell") return "bash";
  if (lower === "grep") return "grep";
  if (lower === "glob") return "glob";
  if (lower === "webfetch" || lower === "websearch") return "webfetch";
  if (lower === "task" || lower === "agent") return "task";
  return "unknown";
}

function formatTool(toolName, toolInput, phase) {
  const past = phase === "done";
  switch (canonicalToolKind(toolName)) {
    case "read": {
      const path = fieldFrom(toolInput, "file_path") ?? fieldFrom(toolInput, "filePath") ?? fieldFrom(toolInput, "path");
      const name = path ? clip(basename(path)) : null;
      return name ? (past ? "Read " + name : "Reading " + name) : past ? "Read file" : "Reading file";
    }
    case "edit":
    case "write": {
      const path = fieldFrom(toolInput, "file_path") ?? fieldFrom(toolInput, "filePath") ?? fieldFrom(toolInput, "path");
      const name = path ? clip(basename(path)) : null;
      return name ? (past ? "Edited " + name : "Editing " + name) : past ? "Edited file" : "Editing file";
    }
    case "bash": {
      const command = fieldFrom(toolInput, "command");
      if (command) {
        const head = clip(command.split(/\s+/)[0] || command, 24);
        return past ? "Ran " + head : "Running " + head;
      }
      return past ? "Ran command" : "Running command";
    }
    case "grep": {
      const pattern = fieldFrom(toolInput, "pattern");
      return pattern ? (past ? "Searched \"" + clip(pattern, 28) + "\"" : "Searching \"" + clip(pattern, 28) + "\"") : past ? "Searched files" : "Searching files";
    }
    case "glob": {
      const pattern = fieldFrom(toolInput, "pattern");
      return pattern ? (past ? "Listed " + clip(pattern, 28) : "Listing " + clip(pattern, 28)) : past ? "Listed files" : "Listing files";
    }
    case "webfetch": {
      const url = fieldFrom(toolInput, "url");
      if (url) {
        try {
          const host = new URL(url).hostname;
          return past ? "Fetched " + clip(host, 28) : "Fetching " + clip(host, 28);
        } catch {}
      }
      return past ? "Fetched web" : "Searching web";
    }
    case "task":
      return past ? "Subagent done" : "Spawning subagent";
    default: {
      const name = clip(String(toolName || "tool"), 28);
      return past ? "Called " + name : "Calling " + name;
    }
  }
}

async function postJson(url, body, token) {
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Petdex-Update-Token": token,
      },
      body: JSON.stringify(body),
      // 300ms instead of 1s: well above any real localhost roundtrip
      // and below the threshold an agent user notices as latency.
      signal: AbortSignal.timeout(300),
    });
  } catch {
    // sidecar offline: stay quiet, the agent shouldn't notice.
  }
}

async function notify({ state, duration, text }) {
  // Killswitch: users toggle this with /petdex inside their agent
  // (or 'petdex hooks toggle' from a shell). Bail before the token
  // read so the disabled state has zero filesystem cost beyond the
  // existsSync.
  if (existsSync(KILLSWITCH_PATH)) return;
  // Token gate defends against drive-by no-cors POSTs from any site
  // the user visits. The token rotates per sidecar session and lives
  // at mode 0600, so only this user can read it.
  const token = await readToken();
  if (!token) return; // sidecar offline or missing — silently no-op
  // Stamp agent_source so the sidecar can route per-pet when we
  // ship multi-mascot. Today the field is recorded for telemetry
  // but doesn't affect routing.
  const stateBody =
    duration != null
      ? { state, duration, agent_source: "opencode" }
      : { state, agent_source: "opencode" };
  await Promise.all([
    postJson(SIDECAR_URL, stateBody, token),
    text ? postJson(SIDECAR_BUBBLE_URL, { text, agent_source: "opencode" }, token) : Promise.resolve(),
  ]);
}

const hooks = {
  "tool.execute.before": async (input, output) => notify({
    state: "running",
    text: formatTool(input.tool, output.args, "running"),
  }),
  "tool.execute.after": async (input) => notify({
    state: "idle",
    text: formatTool(input.tool, input.args, "done"),
  }),
  event: async ({ event }) => {
    if (event.type === "session.idle") notify({ state: "waving", duration: 1500, text: "Done." });
    else if (event.type === "session.error") notify({ state: "failed", duration: 2500, text: "OpenCode hit an error." });
  },
};

const PetdexPlugin = {
  id: "petdex",
  server: async () => hooks,
};

export default PetdexPlugin;
export { PetdexPlugin };
`;
}

function tildePath(p: string): string {
  if (p.startsWith(HOME)) return `~${p.slice(HOME.length)}`;
  return p;
}

// ─── TOML helpers (codex config.toml only) ─────────────────────────────
//
// We avoid pulling a TOML parser dependency for a single key. Instead we
// walk the file line by line tracking the current section. This is
// deliberately conservative: it only recognizes top-level standard tables
// like [features] and [features.something], and it won't try to handle
// inline tables, dotted keys at the top level (e.g. features.codex_hooks),
// or array-of-tables — Codex's own config doesn't use those for this flag,
// and refusing to act is safer than rewriting structure we don't fully
// understand.

type CodexHooksInspection =
  | { state: "missing-file" }
  | { state: "enabled" }
  | { state: "no-features-section" }
  | { state: "no-key"; insertAfterLine: number }
  | { state: "wrong-value"; replaceLine: number };

function inspectFeaturesCodexHooks(text: string): CodexHooksInspection {
  const lines = text.split("\n");
  const sectionHeaderRe = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/;
  const keyRe = /^\s*codex_hooks\s*=\s*(.+?)\s*(?:#.*)?$/;
  let currentSection: string | null = null;
  let featuresHeaderLine: number | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const sectionMatch = line.match(sectionHeaderRe);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (currentSection === "features" && featuresHeaderLine === null) {
        featuresHeaderLine = i;
      }
      continue;
    }
    if (currentSection !== "features") continue;
    const keyMatch = line.match(keyRe);
    if (!keyMatch) continue;
    const value = keyMatch[1].trim();
    if (value === "true") return { state: "enabled" };
    return { state: "wrong-value", replaceLine: i };
  }

  if (featuresHeaderLine === null) return { state: "no-features-section" };
  return { state: "no-key", insertAfterLine: featuresHeaderLine };
}

function applyCodexHooksFix(
  text: string,
  inspection: CodexHooksInspection,
): string {
  if (inspection.state === "enabled" || inspection.state === "missing-file") {
    // Caller should not reach here for these states, but be conservative.
    return text;
  }

  const lines = text.split("\n");
  if (inspection.state === "wrong-value") {
    // Preserve indentation and any trailing comment by replacing only the
    // value portion of the matched line.
    const original = lines[inspection.replaceLine];
    const valueRe = /^(\s*codex_hooks\s*=\s*)([^#\n]+?)(\s*(?:#.*)?)$/;
    const m = original.match(valueRe);
    lines[inspection.replaceLine] = m
      ? `${m[1]}true${m[3]}`
      : "codex_hooks = true";
    return lines.join("\n");
  }
  if (inspection.state === "no-key") {
    lines.splice(inspection.insertAfterLine + 1, 0, "codex_hooks = true");
    return lines.join("\n");
  }
  // no-features-section: append a fresh [features] block at EOF without
  // collapsing existing trailing content.
  const sep = text.endsWith("\n") || text.length === 0 ? "" : "\n";
  return `${text}${sep}\n[features]\ncodex_hooks = true\n`;
}
