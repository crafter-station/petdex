/**
 * `petdex doctor` — diagnostic for the full petdex install.
 *
 * Designed to be the first thing a confused user runs. Each check
 * answers a yes/no question and (when failing) suggests the
 * smallest follow-up action. Output is plain text + colored
 * symbols so it copy-pastes cleanly into a bug report.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import pc from "picocolors";

import {
  AGENTS,
  antigravityMcpConfigPaths,
  antigravitySkillDir,
} from "../hooks/agents.js";
import { getKillswitchState } from "../hooks/killswitch.js";
import { desktopBinPath, sidecarPath } from "./install.js";

type CheckResult = {
  status: "ok" | "warn" | "fail" | "info";
  label: string;
  detail?: string;
  hint?: string;
};

function homeDir(): string {
  return process.env.HOME ?? homedir();
}

function tokenPath(): string {
  return path.join(homeDir(), ".petdex", "runtime", "update-token");
}

function pidFilePath(): string {
  return path.join(homeDir(), ".petdex", "desktop.pid");
}

function checkBinary(): CheckResult {
  const bin = desktopBinPath();
  if (!existsSync(bin)) {
    return {
      status: "fail",
      label: "Desktop binary",
      detail: `not found at ${bin}`,
      hint: "Run `petdex install desktop` to download it.",
    };
  }
  try {
    const stat = statSync(bin);
    if (!(stat.mode & 0o111)) {
      return {
        status: "fail",
        label: "Desktop binary",
        detail: `${bin} exists but is not executable`,
        hint: `chmod +x ${bin}`,
      };
    }
  } catch {
    // existsSync said yes but stat failed — treat as broken.
    return {
      status: "fail",
      label: "Desktop binary",
      detail: `${bin} unreadable`,
      hint: "Reinstall: `petdex install desktop`",
    };
  }
  return { status: "ok", label: "Desktop binary", detail: bin };
}

function checkSidecar(): CheckResult {
  const sc = sidecarPath();
  if (!existsSync(sc)) {
    return {
      status: "fail",
      label: "Sidecar bundle",
      detail: `not found at ${sc}`,
      hint: "Reinstall: `petdex install desktop`",
    };
  }
  return { status: "ok", label: "Sidecar bundle", detail: sc };
}

async function checkSidecarReachable(): Promise<CheckResult> {
  try {
    const res = await fetch("http://127.0.0.1:7777/health", {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) {
      return {
        status: "warn",
        label: "Sidecar reachable",
        detail: `:7777 responded ${res.status}`,
        hint: "Restart: `petdex desktop stop && petdex desktop start`",
      };
    }
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      port?: number;
    } | null;
    if (body?.ok && body?.port === 7777) {
      return {
        status: "ok",
        label: "Sidecar reachable",
        detail: ":7777 healthy",
      };
    }
    return {
      status: "warn",
      label: "Sidecar reachable",
      detail: ":7777 responded but body shape was unexpected",
    };
  } catch {
    return {
      status: "info",
      label: "Sidecar reachable",
      detail: "not running (this is fine if you haven't started the desktop)",
      hint: "Start with `petdex desktop start`",
    };
  }
}

function checkPidFile(): CheckResult {
  const pf = pidFilePath();
  if (!existsSync(pf)) {
    return {
      status: "info",
      label: "PID file",
      detail: "not present (desktop not running)",
    };
  }
  let txt: string;
  try {
    txt = readFileSync(pf, "utf8").trim();
  } catch {
    return {
      status: "warn",
      label: "PID file",
      detail: `unreadable at ${pf}`,
      hint: `Delete it: rm ${pf}`,
    };
  }
  if (!txt.startsWith("{")) {
    // Legacy bare-pid format. Newer code treats it as stale and
    // refuses to signal — surface that to the user explicitly so
    // they know why `desktop stop` won't kill anything.
    return {
      status: "warn",
      label: "PID file",
      detail: "legacy bare-pid format detected",
      hint: "Run `petdex desktop start` to rewrite it in the new format.",
    };
  }
  try {
    const parsed = JSON.parse(txt) as { pid?: number; lstart?: string };
    if (typeof parsed.pid !== "number" || typeof parsed.lstart !== "string") {
      return {
        status: "warn",
        label: "PID file",
        detail: "unexpected JSON shape",
        hint: `Delete it: rm ${pf}`,
      };
    }
    return {
      status: "ok",
      label: "PID file",
      detail: `pid ${parsed.pid}, started ${parsed.lstart}`,
    };
  } catch {
    return {
      status: "warn",
      label: "PID file",
      detail: "JSON parse failed",
      hint: `Delete it: rm ${pf}`,
    };
  }
}

function checkToken(): CheckResult {
  const tp = tokenPath();
  if (!existsSync(tp)) {
    return {
      status: "info",
      label: "Update token",
      detail: "absent (will be created when sidecar starts)",
    };
  }
  try {
    const tok = readFileSync(tp, "utf8").trim();
    if (tok.length < 16) {
      return {
        status: "warn",
        label: "Update token",
        detail: "present but suspiciously short",
        hint: `Stop the desktop and run \`petdex desktop start\` to regenerate.`,
      };
    }
    const stat = statSync(tp);
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      return {
        status: "warn",
        label: "Update token",
        detail: `present, mode ${mode.toString(8)} (expected 600)`,
        hint: `chmod 600 ${tp}`,
      };
    }
    return { status: "ok", label: "Update token", detail: "present, mode 600" };
  } catch (err) {
    return {
      status: "warn",
      label: "Update token",
      detail: `read failed: ${(err as Error).message}`,
    };
  }
}

function checkKillswitch(): CheckResult {
  const state = getKillswitchState();
  if (state === "off") {
    return {
      status: "warn",
      label: "Killswitch",
      detail: "DISABLED. Agent hooks are short-circuited.",
      hint: "Re-enable with `petdex hooks on` or `/petdex on` from inside your agent.",
    };
  }
  return { status: "ok", label: "Killswitch", detail: "hooks enabled" };
}

function checkHooksInstalled(): CheckResult[] {
  const results: CheckResult[] = [];
  for (const agent of AGENTS) {
    const resolvedConfigFile =
      agent.id === "antigravity"
        ? (() => {
            const paths = antigravityMcpConfigPaths();
            const [primary] = paths;
            return paths.find((mcpPath) => existsSync(mcpPath)) ?? primary;
          })()
        : agent.configFile;
    const hookFileExists = existsSync(resolvedConfigFile);
    const slashFileExists = existsSync(agent.slashCommandPath);
    if (!agentInstalled(agent)) {
      results.push({
        status: "info",
        label: agent.displayName,
        detail: `not installed on this machine`,
      });
      continue;
    }
    let hookOk = false;
    if (hookFileExists) {
      try {
        const text = readFileSync(resolvedConfigFile, "utf8");
        // Antigravity uses MCP config (look for "petdex" under mcpServers)
        // instead of hook URLs. All other agents embed the sidecar URL.
        if (agent.id === "antigravity") {
          hookOk = text.includes('"petdex"') || text.includes("petdex");
        } else {
          hookOk =
            text.includes("127.0.0.1:7777/state") || text.includes("/state");
        }
      } catch {
        hookOk = false;
      }
    }
    if (!hookOk) {
      results.push({
        status: "warn",
        label: agent.displayName,
        detail: "petdex hook NOT detected",
        hint: "Run `petdex hooks install`",
      });
      continue;
    }
    // Antigravity uses a SKILL.md instead of a /petdex slash command
    if (agent.id === "antigravity") {
      const skillExists = existsSync(antigravitySkillDir());
      results.push({
        status: skillExists ? "ok" : "warn",
        label: agent.displayName,
        detail: skillExists
          ? "MCP server + Skill installed"
          : "MCP server configured, but Skill not found",
        hint: skillExists
          ? undefined
          : "Re-run `petdex hooks install` to install the Agent Skill.",
      });
      continue;
    }
    if (!slashFileExists) {
      results.push({
        status: "warn",
        label: agent.displayName,
        detail: "hook installed, but /petdex slash command missing",
        hint: "Re-run `petdex hooks install` to add the slash command.",
      });
      continue;
    }
    results.push({
      status: "ok",
      label: agent.displayName,
      detail: "hooks + /petdex installed",
    });
  }
  return results;
}

function agentInstalled(agent: (typeof AGENTS)[number]): boolean {
  if (agent.id !== "antigravity") return existsSync(agent.configDir);
  return (
    antigravityMcpConfigPaths().some((mcpPath) =>
      existsSync(path.dirname(mcpPath)),
    ) || existsSync(antigravitySkillDir())
  );
}

function checkCodexFeatureFlag(): CheckResult {
  const tomlPath = path.join(homeDir(), ".codex", "config.toml");
  if (!existsSync(tomlPath)) {
    return {
      status: "info",
      label: "Codex codex_hooks flag",
      detail: "config.toml absent (Codex not installed?)",
    };
  }
  try {
    const text = readFileSync(tomlPath, "utf8");
    // Naive but matches `petdex hooks install`'s own inspectFeaturesCodexHooks.
    if (/\[features\][\s\S]*?codex_hooks\s*=\s*true/.test(text)) {
      return {
        status: "ok",
        label: "Codex codex_hooks flag",
        detail: "[features] codex_hooks = true",
      };
    }
    return {
      status: "warn",
      label: "Codex codex_hooks flag",
      detail: "missing or set to non-true",
      hint: "Re-run `petdex hooks install` and accept the auto-fix prompt.",
    };
  } catch {
    return {
      status: "warn",
      label: "Codex codex_hooks flag",
      detail: "config.toml unreadable",
    };
  }
}

function checkPets(): CheckResult {
  const roots = [
    path.join(homeDir(), ".petdex", "pets"),
    path.join(homeDir(), ".codex", "pets"),
  ];
  let usable = 0;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      const { readdirSync } = require("node:fs") as {
        readdirSync: (p: string) => string[];
      };
      const entries = readdirSync(root);
      for (const slug of entries) {
        const dir = path.join(root, slug);
        for (const sprite of ["spritesheet.webp", "spritesheet.png"]) {
          const sp = path.join(dir, sprite);
          if (!existsSync(sp)) continue;
          try {
            const s = statSync(sp);
            if (s.size > 0 && s.size <= 16 * 1024 * 1024) {
              usable += 1;
              break;
            }
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore — root unreadable
    }
  }
  if (usable === 0) {
    return {
      status: "fail",
      label: "Installed pets",
      detail: "no usable pets in ~/.petdex/pets or ~/.codex/pets",
      hint: "Install one with `petdex install <slug>`",
    };
  }
  return {
    status: "ok",
    label: "Installed pets",
    detail: `${usable} usable spritesheet(s) on disk`,
  };
}

function symbol(status: CheckResult["status"]): string {
  switch (status) {
    case "ok":
      return pc.green("✓");
    case "warn":
      return pc.yellow("!");
    case "fail":
      return pc.red("✗");
    case "info":
      return pc.dim("○");
  }
}

function printResult(r: CheckResult): void {
  const detail = r.detail ? `  ${pc.dim(r.detail)}` : "";
  console.log(`  ${symbol(r.status)} ${pc.bold(r.label)}${detail}`);
  if (r.hint) {
    console.log(`    ${pc.cyan("→")} ${r.hint}`);
  }
}

export async function runDoctor(): Promise<void> {
  console.log(pc.bgMagenta(pc.white(" petdex doctor ")));
  console.log("");

  console.log(pc.bold("Install"));
  printResult(checkBinary());
  printResult(checkSidecar());
  printResult(checkPets());
  console.log("");

  console.log(pc.bold("Runtime"));
  printResult(await checkSidecarReachable());
  printResult(checkPidFile());
  printResult(checkToken());
  printResult(checkKillswitch());
  console.log("");

  console.log(pc.bold("Agents"));
  for (const r of checkHooksInstalled()) printResult(r);
  printResult(checkCodexFeatureFlag());
  console.log("");

  // Also surface any obvious port collisions — quick lsof if it
  // exists. Best-effort, no warning if lsof isn't on PATH.
  console.log(pc.bold("Network"));
  // lsof exits 1 when nothing matches, so a non-zero exit is normal
  // here. We only fall to the catch when lsof itself isn't on PATH.
  let lsofOut: string | null = null;
  try {
    lsofOut = execSync("lsof -nP -iTCP:7777 -sTCP:LISTEN 2>/dev/null || true", {
      encoding: "utf8",
    }).trim();
  } catch {
    lsofOut = null;
  }
  if (lsofOut === null) {
    printResult({
      status: "info",
      label: ":7777 listener",
      detail: "lsof unavailable",
    });
  } else if (lsofOut.length === 0) {
    printResult({
      status: "info",
      label: ":7777 listener",
      detail: "nothing bound (sidecar offline)",
    });
  } else {
    // First line is the lsof header; data lines follow.
    const dataLines = lsofOut.split("\n").length - 1;
    printResult({
      status: dataLines === 1 ? "ok" : "warn",
      label: ":7777 listener",
      detail:
        dataLines === 1 ? "1 process bound" : `${dataLines} processes bound`,
      hint:
        dataLines > 1
          ? "Multiple sidecars contending for the same port. Stop both and start fresh."
          : undefined,
    });
  }
  console.log("");
}
