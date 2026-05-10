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
   * Where this agent looks for user-defined slash commands. We drop a
   * /petdex command file here so users can toggle the killswitch from
   * inside their agent without leaving for a shell.
   *
   * Each agent has its own directory:
   *   - Claude Code:  ~/.claude/commands/petdex.md
   *   - Codex:        ~/.codex/prompts/petdex.md
   *   - OpenCode:     ~/.config/opencode/command/petdex.md
   *   - Gemini:       ~/.gemini/antigravity/global_workflows/petdex.md
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

export const AGENTS: Agent[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    configDir: path.join(HOME, ".claude"),
    configFile: path.join(HOME, ".claude", "settings.json"),
    slashCommandPath: path.join(HOME, ".claude", "commands", "petdex.md"),
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
                  command: curlCommand("claude-code", "running"),
                },
              ],
            },
          ],
          PostToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: curlCommand("claude-code", "idle"),
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: curlCommand("claude-code", "waving", 1500),
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
      { event: "PreToolUse", kind: "tool.before" },
      { event: "PostToolUse", kind: "tool.after" },
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
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: curlCommand("codex", "running"),
                },
              ],
            },
          ],
          PostToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: curlCommand("codex", "idle"),
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: curlCommand("codex", "waving", 1500),
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
    slashCommandPath: path.join(
      HOME,
      ".gemini",
      "antigravity",
      "global_workflows",
      "petdex.md",
    ),
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
                  command: curlCommand("gemini", "running"),
                },
              ],
            },
          ],
          AfterTool: [
            {
              hooks: [
                {
                  type: "command",
                  command: curlCommand("gemini", "idle"),
                },
              ],
            },
          ],
          SessionEnd: [
            {
              hooks: [
                {
                  type: "command",
                  command: curlCommand("gemini", "waving", 1500),
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
    slashCommandPath: path.join(
      HOME,
      ".config",
      "opencode",
      "command",
      "petdex.md",
    ),
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

function curlCommand(
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
  return `// petdex hook plugin — auto-generated by \`petdex hooks install\`.
// Forwards OpenCode lifecycle events to the petdex desktop mascot via HTTP.
// Edit STATE_MAP below to customize which state each event triggers.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SIDECAR_URL = ${JSON.stringify(SIDECAR_URL)};
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

async function setState(state, duration) {
  // Killswitch: users toggle this with /petdex inside their agent
  // (or \`petdex hooks toggle\` from a shell). Bail before the token
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
  const body =
    duration != null
      ? { state, duration, agent_source: "opencode" }
      : { state, agent_source: "opencode" };
  try {
    await fetch(SIDECAR_URL, {
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
