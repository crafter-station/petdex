import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type HerdrAgent = {
  agent?: string | null;
  agent_session?: { value?: string | null } | null;
  agent_status?: AgentStatus | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  pane_id?: string | null;
  state_labels?: Record<string, string> | null;
  terminal_title_stripped?: string | null;
};

export type HerdrEvent = {
  data?: {
    agent?: string | null;
    agent_status?: AgentStatus | null;
    display_agent?: string | null;
    pane_id?: string | null;
    state_labels?: Record<string, string> | null;
    title?: string | null;
    workspace_id?: string | null;
  };
  event?: string;
};

export type BridgeConfig = {
  excludeAgents?: string[];
  includeAgents?: string[];
};

export type PetdexUpdate = {
  bubble: {
    agent_source: string;
    busy: boolean;
    herdr_pane_id: string;
    session_id: string;
    source_cwd?: string;
    text: string;
    title: string;
  };
  state: "idle" | "jumping" | "running" | "waiting";
};

const directPetdexAgents = new Set([
  "claude",
  "claude-code",
  "codebuddy",
  "codex",
  "gemini",
  "hermes",
  "kimi",
  "kimi-code",
  "omp",
  "open-code",
  "opencode",
  "qoder",
  "qodercli",
]);

const decoder = new TextDecoder();

export function normalizeAgent(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-");
}

export function shouldBridge(agent: string, config: BridgeConfig): boolean {
  const normalized = normalizeAgent(agent);
  if (!normalized) return false;
  const include = (config.includeAgents ?? [])
    .map(normalizeAgent)
    .filter(Boolean);
  if (include.length > 0)
    return include.includes("*") || include.includes(normalized);
  const excluded = new Set([
    ...directPetdexAgents,
    ...(config.excludeAgents ?? []).map(normalizeAgent).filter(Boolean),
  ]);
  return !excluded.has(normalized);
}

export function safeText(value: unknown, max = 96): string {
  return Array.from(String(value ?? ""), (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 || character === '"' || character === "\\"
      ? " "
      : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function safePaneId(value: unknown): string {
  const pane = String(value ?? "").trim();
  return /^[A-Za-z0-9:_-]{1,64}$/.test(pane) ? pane : "";
}

export function statusState(status: AgentStatus): PetdexUpdate["state"] | null {
  if (status === "blocked") return "waiting";
  if (status === "working") return "running";
  if (status === "idle" || status === "done") return "idle";
  return null;
}

export function aggregateState(
  agents: HerdrAgent[],
  current?: Pick<HerdrAgent, "agent_status" | "pane_id">,
): PetdexUpdate["state"] {
  const currentPane = safePaneId(current?.pane_id);
  let reconciled = false;
  const statuses = agents.map((agent) => {
    if (currentPane && safePaneId(agent.pane_id) === currentPane) {
      reconciled = true;
      return current?.agent_status;
    }
    return agent.agent_status;
  });
  if (!reconciled && current?.agent_status) statuses.push(current.agent_status);
  if (statuses.includes("blocked")) return "waiting";
  if (statuses.includes("working")) return "running";
  return "idle";
}

export function updateFromEvent(
  event: HerdrEvent,
  agentInfo: HerdrAgent | undefined,
  aggregate: PetdexUpdate["state"],
  config: BridgeConfig,
): PetdexUpdate | null {
  const data = event.data ?? {};
  const paneId = safePaneId(data.pane_id ?? agentInfo?.pane_id);
  const agent = normalizeAgent(data.agent ?? agentInfo?.agent);
  const status = data.agent_status ?? agentInfo?.agent_status ?? "unknown";
  if (!paneId || !shouldBridge(agent, config) || !statusState(status))
    return null;
  const label =
    safeText(data.display_agent ?? agentInfo?.agent ?? agent, 32) || "Agent";
  const stateLabels = data.state_labels ?? agentInfo?.state_labels ?? {};
  const fallback =
    status === "blocked"
      ? `${label} needs you`
      : status === "working"
        ? `${label} is working`
        : `${label} is ready`;
  const text = safeText(stateLabels[status] ?? fallback, 110) || fallback;
  const title =
    safeText(data.title ?? agentInfo?.terminal_title_stripped ?? label, 60) ||
    label;
  const nativeSession = safeText(agentInfo?.agent_session?.value, 64);
  const sourceCwd = safeText(agentInfo?.foreground_cwd ?? agentInfo?.cwd, 511);
  return {
    bubble: {
      agent_source: agent,
      busy: status === "working",
      herdr_pane_id: paneId,
      session_id: nativeSession || `herdr:${paneId}`,
      ...(sourceCwd.startsWith("/") ? { source_cwd: sourceCwd } : {}),
      text,
      title,
    },
    state: aggregate,
  };
}

export function parseCliAgents(raw: string): HerdrAgent[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.result?.agents) ? parsed.result.agents : [];
  } catch {
    return [];
  }
}

export function parseEvent(raw: string | undefined): HerdrEvent {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export async function postUpdate(
  update: PetdexUpdate,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const headers = {
    "content-type": "application/json",
    "x-petdex-update-token": token,
  };
  const requests = [
    fetcher("http://127.0.0.1:7777/bubble", {
      method: "POST",
      headers,
      body: JSON.stringify(update.bubble),
      signal: AbortSignal.timeout(500),
    }),
    fetcher("http://127.0.0.1:7777/state", {
      method: "POST",
      headers,
      body: JSON.stringify({
        state: update.state,
        agent_source: update.bubble.agent_source,
      }),
      signal: AbortSignal.timeout(500),
    }),
  ];
  const responses = await Promise.all(requests);
  if (responses.some((response) => !response.ok))
    throw new Error("Petdex rejected Herdr update");
}

async function loadConfig(): Promise<BridgeConfig> {
  const root = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!root) return {};
  try {
    return JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  } catch {
    return {};
  }
}

export function herdrAgents(): HerdrAgent[] {
  const herdr = process.env.HERDR_BIN_PATH || "herdr";
  try {
    const child = Bun.spawnSync([herdr, "agent", "list"], {
      stderr: "pipe",
      stdout: "pipe",
    });
    if (child.exitCode !== 0) return [];
    return parseCliAgents(decoder.decode(child.stdout));
  } catch {
    return [];
  }
}

async function token(): Promise<string> {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home || existsSync(join(home, ".petdex", "runtime", "hooks-disabled")))
    return "";
  try {
    return (
      await readFile(join(home, ".petdex", "runtime", "update-token"), "utf8")
    ).trim();
  } catch {
    return "";
  }
}

async function deliver(event: HerdrEvent, config: BridgeConfig): Promise<void> {
  if (event.data?.agent && !shouldBridge(event.data.agent, config)) return;
  const agents = herdrAgents();
  const pane = safePaneId(event.data?.pane_id);
  const info = agents.find((agent) => safePaneId(agent.pane_id) === pane);
  const update = updateFromEvent(
    event,
    info,
    aggregateState(agents, event.data),
    config,
  );
  const secret = update ? await token() : "";
  if (update && secret) await postUpdate(update, secret);
}

async function snapshot(config: BridgeConfig): Promise<void> {
  const agents = herdrAgents();
  const secret = await token();
  if (!secret) return;
  const aggregate = aggregateState(agents);
  for (const agent of agents) {
    if (agent.agent_status !== "working" && agent.agent_status !== "blocked")
      continue;
    const event: HerdrEvent = {
      event: "pane.agent_status_changed",
      data: {
        agent: agent.agent,
        agent_status: agent.agent_status,
        pane_id: agent.pane_id,
        state_labels: agent.state_labels,
        title: agent.terminal_title_stripped,
      },
    };
    const update = updateFromEvent(event, agent, aggregate, config);
    if (update) await postUpdate(update, secret);
  }
}

async function testBridge(): Promise<void> {
  const secret = await token();
  if (!secret) throw new Error("Petdex is not running");
  const pane = safePaneId(process.env.HERDR_PANE_ID) || "herdr:test";
  await postUpdate(
    {
      bubble: {
        agent_source: "herdr",
        busy: false,
        herdr_pane_id: pane,
        session_id: `herdr:${pane}`,
        text: "Herdr bridge connected",
        title: "Petdex",
      },
      state: "jumping",
    },
    secret,
  );
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "event";
  const config = await loadConfig();
  if (mode === "snapshot") return snapshot(config);
  if (mode === "test") return testBridge();
  const eventName = process.env.HERDR_PLUGIN_EVENT;
  if (eventName && eventName !== "pane.agent_status_changed") return;
  return deliver(parseEvent(process.env.HERDR_PLUGIN_EVENT_JSON), config);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
