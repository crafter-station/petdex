/**
 * `petdex hooks install` — interactive wizard that detects installed coding
 * agents (~/.claude, ~/.codex, ~/.gemini, ~/.config/opencode), lets the user
 * pick which ones should drive the petdex mascot, and writes the right hook
 * config into each agent (with .bak backup of any existing settings).
 *
 * Detects 4 agents today; adding a 5th is a single AGENTS entry away.
 */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import * as p from "@clack/prompts";
import pc from "picocolors";

import {
  AGENTS,
  type Agent,
  antigravitySkillDir,
  PETDEX_PORT,
  type PostInstallNote,
  resolveAntigravityMcpConfigPath,
  SIDECAR_URL,
} from "./agents.js";
import { generateMcpConfig, generateSkillMd } from "./antigravity-skill.js";
import { PERSIST_PATH, persistRunningBinary } from "./persist-binary.js";
import { installSlashCommand, uninstallSlashCommand } from "./slash-command.js";

type Detection = { agent: Agent; installed: boolean };

const LEGACY_ANTIGRAVITY_SKILL_DIR = path.join(
  homedir(),
  ".antigravity",
  "skills",
  "petdex",
);

export async function detectAgents(): Promise<Detection[]> {
  return Promise.all(
    AGENTS.map(async (agent) => ({
      agent,
      installed: await pathExists(agent.configDir),
    })),
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export type HooksInstallResult = {
  /**
   * Agent IDs that were written successfully. Empty array means the
   * user cancelled or every agent threw — caller should NOT emit a
   * success telemetry event in that case.
   */
  installedAgents: string[];
};

export async function runInstall(): Promise<HooksInstallResult> {
  p.intro(pc.bgMagenta(pc.white(" petdex hooks install ")));

  // Snapshot the running petdex binary to a known path so hooks can
  // invoke it with an absolute path. See persist-binary.ts for why.
  // Best-effort: a failure here only prevents bubble hooks from
  // running, the state hooks still work via curl.
  try {
    const { persistRunningBinary } = await import("./persist-binary");
    const result = await persistRunningBinary();
    if (!result.ok && result.reason) {
      p.log.warn(
        `Could not persist petdex binary (${result.reason}). Bubbles will be disabled.`,
      );
    }
  } catch (err) {
    p.log.warn(
      `Could not persist petdex binary (${(err as Error).message}). Bubbles will be disabled.`,
    );
  }

  const detections = await detectAgents();
  const anyInstalled = detections.some((d) => d.installed);

  p.log.info(
    anyInstalled
      ? "Found these agents on your system:"
      : "No coding agent configs detected. You can still pre-write hooks for any agent. They'll activate when you install it.",
  );

  for (const { agent, installed } of detections) {
    const badge = installed ? pc.green("●") : pc.dim("○");
    const label = installed ? pc.dim("installed") : pc.dim("not found");
    console.log(`   ${badge} ${pc.bold(agent.displayName)}  ${label}`);
  }

  const selected = await p.multiselect<string>({
    message: "Which agents should drive the mascot?",
    options: detections.map(({ agent, installed }) => ({
      value: agent.id,
      label: agent.displayName,
      hint: installed ? "installed" : "not installed yet",
    })),
    initialValues: detections.filter((d) => d.installed).map((d) => d.agent.id),
    required: false,
  });

  if (p.isCancel(selected) || selected.length === 0) {
    p.cancel("No agents selected. Bye.");
    return { installedAgents: [] };
  }

  const summary: string[] = [];
  const followUps: { agent: string; notes: PostInstallNote[] }[] = [];
  const installedAgents: string[] = [];
  const selectedAgentIds = selected as string[];
  const selectedIds = new Set<string>(selectedAgentIds);
  for (const id of selectedAgentIds) {
    const agent = AGENTS.find((a) => a.id === id);
    if (!agent) continue;
    try {
      await installForAgent(agent, {
        installSlashCommand: shouldInstallSlashCommand(agent, selectedIds),
      });
      installedAgents.push(agent.id);
      // Keep summary lines short and uniform — earlier the long
      // backup filename + full config path made @clack/prompts'
      // bordered note overflow inconsistently between agents that
      // had a prior config (with backup) and those that didn't
      // (without). Now every line is just the agent name. Backups
      // are still written to disk; they're recoverable via shell
      // if the user ever needs to roll back.
      summary.push(`  ${pc.green("✓")} ${pc.bold(agent.displayName)}`);
      if (agent.postInstallChecks) {
        try {
          const notes = await agent.postInstallChecks();
          if (notes.length > 0) {
            followUps.push({ agent: agent.displayName, notes });
          }
        } catch {
          // Post-install checks are best-effort; don't fail the whole flow.
        }
      }
    } catch (err) {
      summary.push(
        `  ${pc.red("✗")} ${pc.bold(agent.displayName)} ${pc.red(err instanceof Error ? err.message : String(err))}`,
      );
    }
  }

  p.note(summary.join("\n"), "Done");

  for (const { agent, notes } of followUps) {
    for (const note of notes) {
      const tag =
        note.level === "action"
          ? pc.bgYellow(pc.black(" action needed "))
          : note.level === "warn"
            ? pc.yellow("!")
            : pc.cyan("i");
      p.log.warn(`${tag} ${pc.bold(agent)}\n${note.message}`);

      if (note.fix) {
        const apply = await p.confirm({
          message: note.fix.prompt,
          initialValue: true,
        });
        if (!p.isCancel(apply) && apply) {
          const result = await note.fix.apply();
          if (result.ok) {
            p.log.info(`${pc.green("✓")} ${result.message}`);
          } else {
            p.log.warn(`${pc.red("✗")} ${result.message}`);
          }
        }
      }
    }
  }

  // No outro from this function — the caller (cmdInit) prints the
  // hand-off line. Keeping `runHooksInstall` to just hooks-install
  // means the same wizard works whether the user invoked
  // `petdex hooks install` directly or `petdex init` (which wraps
  // it). Implementation details (sidecar URL, token, curl test
  // command) used to leak here; they don't belong in the user's
  // success path — anyone who needs them can run `petdex doctor`.

  return { installedAgents };
}

export type InstallResult = { backupPath: string | null };

export type InstallForAgentOptions = {
  installSlashCommand?: boolean;
};

export function shouldInstallSlashCommand(
  agent: Agent,
  selectedIds: Set<string>,
): boolean {
  return (
    agent.id !== "antigravity" &&
    !(agent.id === "gemini" && selectedIds.has("antigravity"))
  );
}

export async function installForAgent(
  agent: Agent,
  options: InstallForAgentOptions = {},
): Promise<InstallResult> {
  await mkdir(path.dirname(agent.configFile), { recursive: true });

  const config = agent.build();

  // Antigravity doesn't use slash commands — its Agent Skill (SKILL.md)
  // lives at the same path that slashCommandPath points to, so calling
  // installSlashCommand would overwrite the skill with a slash-command
  // body. Skip it entirely; the Antigravity installer handles the path.
  if (agent.id !== "antigravity") {
    if (options.installSlashCommand === false) {
      await uninstallSlashCommand(agent);
    } else {
      // /petdex slash command — installed alongside the hook config so
      // users can toggle the killswitch from inside their agent without
      // dropping to a shell. Idempotent: overwrites our own file, never
      // user-authored content (we own the path under <agent>/commands/).
      await installSlashCommand(agent);
    }
  }

  // OpenCode plugin is a JS source file — write it whole, no merge.
  if (agent.id === "opencode") {
    const backupPath = await maybeBackup(agent.configFile);
    await writeFile(agent.configFile, config as string, "utf8");
    return { backupPath };
  }

  // Antigravity uses MCP config + Agent Skill instead of hooks.
  if (agent.id === "antigravity") {
    await installForAntigravity();
    return { backupPath: null };
  }

  // JSON-based agents: merge our hooks into existing settings.
  // readJson distinguishes "missing" (treat as fresh config) from
  // "exists but unreadable / unparseable" (refuse to write — would
  // silently overwrite the user's data otherwise). We always back up
  // the raw bytes before writing if the file existed.
  const existing = await readJson(agent.configFile);
  if (existing.kind === "error") {
    throw new Error(
      `Refusing to overwrite ${agent.configFile}: ${existing.message}.\n   Fix the file (or rename it) and run \`petdex hooks install\` again.`,
    );
  }
  const backupPath =
    existing.kind === "ok" ? await maybeBackup(agent.configFile) : null;
  const base =
    existing.kind === "ok" ? (existing.value as Record<string, unknown>) : {};
  const merged = mergeHooks(base, config as Record<string, unknown>);
  await writeFile(
    agent.configFile,
    `${JSON.stringify(merged, null, 2)}\n`,
    "utf8",
  );
  return { backupPath };
}

type ReadJsonResult =
  | { kind: "missing" }
  | { kind: "ok"; value: unknown }
  | { kind: "error"; message: string };

async function readJson(file: string): Promise<ReadJsonResult> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    return {
      kind: "error",
      message: `read failed (${code ?? (err as Error).name}): ${(err as Error).message}`,
    };
  }
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch (err) {
    return {
      kind: "error",
      message: `JSON parse failed: ${(err as Error).message}`,
    };
  }
}

async function maybeBackup(file: string): Promise<string | null> {
  if (!(await pathExists(file))) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${file}.${stamp}.bak`;
  const content = await readFile(file);
  await writeFile(backup, content);
  return backup;
}

/**
 * Shallow merge agent config into existing settings: existing keys are kept,
 * `hooks` is merged at the event level. Petdex hook entries are appended (so
 * we don't drop user's existing hooks for the same event).
 */
function mergeHooks(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...existing };
  const patchHooks = (patch.hooks ?? {}) as Record<string, unknown[]>;
  const existingHooks = (out.hooks ?? {}) as Record<string, unknown[]>;
  const mergedHooks: Record<string, unknown[]> = { ...existingHooks };

  for (const [event, entries] of Object.entries(patchHooks)) {
    const prior = Array.isArray(mergedHooks[event])
      ? (mergedHooks[event] as unknown[])
      : [];
    const filteredPrior = prior.filter((entry) => !isPetdexEntry(entry));
    mergedHooks[event] = [...filteredPrior, ...entries];
  }

  out.hooks = mergedHooks;
  return out;
}

/** Detects whether an existing hook entry was previously written by petdex. */
function isPetdexEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry == null) return false;
  const cmds = collectCommands(entry);
  return cmds.some(
    (c) =>
      c.includes(`localhost:${PETDEX_PORT}/state`) || c.includes(SIDECAR_URL),
  );
}

function collectCommands(entry: unknown): string[] {
  const acc: string[] = [];
  function walk(value: unknown) {
    if (typeof value === "string") {
      acc.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
      return;
    }
    if (typeof value === "object" && value != null) {
      for (const v of Object.values(value)) walk(v);
    }
  }
  walk(entry);
  return acc;
}

/**
 * Install petdex hooks for Antigravity.
 *
 * Unlike hook-based agents (Claude Code, Codex, Gemini CLI), Antigravity
 * integrates via two mechanisms:
 *
 * 1. MCP Server injection: We add a "petdex" entry to Antigravity's
 *    mcp_config.json so the agent can call petdex_set_state etc.
 * 2. Agent Skill: We install a SKILL.md to ~/.antigravity/skills/petdex/
 *    that tells the agent WHEN to call the MCP tools.
 *
 * This function is called from installForAgent when agent.id === "antigravity".
 */
/**
 * Verify the persisted binary exists AND can start the Antigravity MCP server.
 * A stale ~/.petdex/bin/petdex.js from an older install might exist but lack
 * the mcp-server subcommand, which would make Antigravity silently fail.
 */
async function validatePersistedBinary(): Promise<boolean> {
  try {
    await stat(PERSIST_PATH);
    const result = spawnSync(process.execPath, [PERSIST_PATH, "mcp-server"], {
      encoding: "utf8",
      input: "",
      timeout: 5000,
    });
    return result.status === 0 && result.stdout === "";
  } catch {
    return false;
  }
}

async function installForAntigravity(): Promise<void> {
  // 0. Always persist a fresh snapshot of the running CLI binary, then
  // validate it supports the mcp-server subcommand. Antigravity's MCP server
  // runs via node ~/.petdex/bin/petdex.js mcp-server. Unlike hook agents
  // (which fall back to curl-only state hooks on failure), Antigravity has
  // no fallback — a missing or stale binary silently fails to start, making
  // the install appear successful.
  //
  // We always persist here (not just when the file is missing) because:
  //   (a) persistRunningBinary() in runInstall() is best-effort and may skip
  //   (b) a stale binary from an older version might exist but lack mcp-server
  await persistRunningBinary().catch(() => {});
  const binaryOk = await validatePersistedBinary();
  if (!binaryOk) {
    throw new Error(
      `Petdex persisted binary missing or not functional: ${PERSIST_PATH}.\n` +
        `  The mcp-server subcommand is required for Antigravity integration.\n` +
        `  Run \`npx petdex@latest hooks install\` to persist a fresh binary, then re-run.`,
    );
  }

  // 1. Install/update the MCP config
  const mcpConfigPath = await resolveAntigravityMcpConfigPath();
  await mkdir(path.dirname(mcpConfigPath), { recursive: true });
  const mcpConfig = generateMcpConfig();

  const existing = await readAntigravityMcpJson(mcpConfigPath);
  if (existing.kind === "error") {
    throw new Error(
      `Refusing to overwrite ${mcpConfigPath}: ${existing.message}.\n   Fix the file (or rename it) and run \`petdex hooks install\` again.`,
    );
  }
  if (existing.kind === "ok") await maybeBackup(mcpConfigPath);
  const base =
    existing.kind === "ok" ? (existing.value as Record<string, unknown>) : {};
  const existingServers = (base.mcpServers ?? {}) as Record<string, unknown>;
  const merged = {
    ...base,
    mcpServers: {
      ...existingServers,
      ...(mcpConfig.mcpServers as Record<string, unknown>),
    },
  };
  await writeFile(
    mcpConfigPath,
    `${JSON.stringify(merged, null, 2)}\n`,
    "utf8",
  );

  // 2. Install the Agent Skill (global scope only)
  const skillDir = antigravitySkillDir();
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), generateSkillMd(), "utf8");
  await rm(LEGACY_ANTIGRAVITY_SKILL_DIR, { recursive: true, force: true });
}

async function readAntigravityMcpJson(file: string): Promise<ReadJsonResult> {
  try {
    const text = await readFile(file, "utf8");
    if (text.trim() === "") return { kind: "missing" };
  } catch {
    return readJson(file);
  }
  return readJson(file);
}
