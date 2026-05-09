/**
 * `petdex hooks install` — interactive wizard that detects installed coding
 * agents (~/.claude, ~/.codex, ~/.gemini, ~/.config/opencode), lets the user
 * pick which ones should drive the petdex mascot, and writes the right hook
 * config into each agent (with .bak backup of any existing settings).
 *
 * Detects 4 agents today; adding a 5th is a single AGENTS entry away.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import * as p from "@clack/prompts";
import pc from "picocolors";

import { desktopStatus, startDesktop } from "../desktop/process.js";
import { AGENTS, type Agent, PETDEX_PORT, SIDECAR_URL } from "./agents.js";

type Detection = { agent: Agent; installed: boolean };

async function detectAgents(): Promise<Detection[]> {
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

export async function runInstall(): Promise<void> {
  p.intro(pc.bgMagenta(pc.white(" petdex hooks install ")));

  const detections = await detectAgents();
  const anyInstalled = detections.some((d) => d.installed);

  p.log.info(
    anyInstalled
      ? "Found these agents on your system:"
      : "No coding agent configs detected. You can still pre-write hooks for any agent — they'll activate when you install it.",
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
    return;
  }

  const summary: string[] = [];
  for (const id of selected) {
    const agent = AGENTS.find((a) => a.id === id);
    if (!agent) continue;
    try {
      const result = await installForAgent(agent);
      summary.push(
        `  ${pc.green("✓")} ${pc.bold(agent.displayName)} ${pc.dim(`→ ${tildeify(agent.configFile)}`)}${result.backupPath ? pc.dim(` (backup: ${path.basename(result.backupPath)})`) : ""}`,
      );
    } catch (err) {
      summary.push(
        `  ${pc.red("✗")} ${pc.bold(agent.displayName)} ${pc.red(err instanceof Error ? err.message : String(err))}`,
      );
    }
  }

  p.note(summary.join("\n"), "Done");

  const status = desktopStatus();
  if (status.state === "running") {
    p.log.info(
      `${pc.green("●")} petdex-desktop already running (pid ${status.pid}).`,
    );
  } else {
    const shouldStart = await p.confirm({
      message: "Start petdex-desktop now so hooks have somewhere to land?",
      initialValue: true,
    });
    if (!p.isCancel(shouldStart) && shouldStart) {
      const result = await startDesktop();
      if (result.ok) {
        p.log.info(
          result.alreadyRunning
            ? `${pc.dim("•")} already running (pid ${result.pid})`
            : `${pc.green("✓")} petdex-desktop started (pid ${result.pid})`,
        );
      } else {
        p.log.warn(
          `${pc.yellow("!")} Could not start petdex-desktop: ${result.reason}`,
        );
        p.log.info(
          `Install it with ${pc.cyan("petdex install desktop")} and then ${pc.cyan("petdex desktop start")}.`,
        );
      }
    }
  }

  p.log.info(
    [
      `Petdex listens on ${pc.cyan(SIDECAR_URL)} when ${pc.bold("petdex-desktop")} is running.`,
      `Test it: ${pc.cyan(`curl -X POST ${SIDECAR_URL} -d '{"state":"waving"}'`)}`,
    ].join("\n"),
  );

  p.outro(pc.dim(`Restart your agent for the hooks to load.`));
}

type InstallResult = { backupPath: string | null };

async function installForAgent(agent: Agent): Promise<InstallResult> {
  await mkdir(path.dirname(agent.configFile), { recursive: true });

  const config = agent.build();

  // OpenCode plugin is a JS source file — write it whole, no merge.
  if (agent.id === "opencode") {
    const backupPath = await maybeBackup(agent.configFile);
    await writeFile(agent.configFile, config as string, "utf8");
    return { backupPath };
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
    const prior = Array.isArray(mergedHooks[event]) ? mergedHooks[event]! : [];
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

function tildeify(p: string): string {
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}
