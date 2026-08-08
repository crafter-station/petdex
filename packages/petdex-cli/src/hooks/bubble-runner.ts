/**
 * `petdex bubble <event>` — invoked from agent hooks on every tool
 * lifecycle event. Reads the agent's hook payload from stdin, formats
 * a human bubble via templates, POSTs to the desktop hook server.
 *
 * Hot path: this runs 20-50× per active session. We:
 *   - retain a bounded stdin prefix while draining the rest, so oversized
 *     payloads cannot OOM us or make their writer hit a broken pipe
 *   - swallow ALL errors silently (a noisy hook stains the agent UI)
 *   - cap stdin reads at 64KB (hooks don't need bigger payloads, and
 *     a runaway upstream shouldn't OOM us)
 *   - use a 300ms fetch timeout (matches /state hook timing)
 *
 * Events:
 *   pre <tool|user-prompt|notification>   — hook server receives "running"-phase bubble
 *   post <tool>                           — hook server receives "done"-phase bubble
 *   stop                                  — session.end bubble
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { type BubbleEvent, formatBubble } from "./bubble-templates";

const RUNTIME_DIR = join(homedir(), ".petdex", "runtime");
const TOKEN_PATH = join(RUNTIME_DIR, "update-token");
const KILLSWITCH_PATH = join(RUNTIME_DIR, "hooks-disabled");
const HOOK_SERVER_BASE = "http://127.0.0.1:7777";
const HOOK_SERVER_BUBBLE_URL = `${HOOK_SERVER_BASE}/bubble`;
const HOOK_SERVER_STATE_URL = `${HOOK_SERVER_BASE}/state`;
const STDIN_CAP = 64 * 1024;
const SESSIONS_DIR = join(RUNTIME_DIR, "sessions");
const TITLE_MAX = 60;

/**
 * Session titles: UserPromptSubmit carries the user's prompt, so we
 * clip it and persist it per session_id; every later hook event in the
 * same session attaches it as the bubble's title. Plain files instead
 * of a daemon: hooks are independent short-lived processes.
 */
export function rememberSessionTitle(
  dir: string,
  sessionId: string,
  prompt: string,
): void {
  try {
    const title = clipTitle(prompt);
    if (!title) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${sessionId}.json`),
      JSON.stringify({ title, at: Date.now() }),
    );
  } catch {
    // Hot path: a failed title write must never stain the agent.
  }
}

export function sessionTitle(dir: string, sessionId: string): string | null {
  try {
    const raw = readFileSync(join(dir, `${sessionId}.json`), "utf8");
    const parsed = JSON.parse(raw) as { title?: unknown };
    return typeof parsed.title === "string" && parsed.title.length > 0
      ? parsed.title
      : null;
  } catch {
    return null;
  }
}

export function clipTitle(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  if (flat.length <= TITLE_MAX) return flat;
  return `${flat.slice(0, TITLE_MAX - 1)}…`;
}

const PREVIEW_MAX = 110;
const TRANSCRIPT_TAIL_CAP = 64 * 1024;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Flatten + clip a close-of-turn preview of what the agent wrote. */
export function clipPreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= PREVIEW_MAX) return flat;
  return `${flat.slice(0, PREVIEW_MAX - 1)}…`;
}

/**
 * Last assistant message from a Claude Code transcript: bounded tail
 * read (64KB), newest JSONL line of type "assistant" that carries a
 * non-empty text part. Codex skips this entirely - its Stop payload
 * ships last_assistant_message directly.
 */
export function lastAssistantText(transcriptPath: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    const want = Math.min(size, TRANSCRIPT_TAIL_CAP);
    const buf = Buffer.alloc(want);
    readSync(fd, buf, 0, want, size - want);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // first line of the tail window may be partial
      }
      if (
        parsed == null ||
        typeof parsed !== "object" ||
        (parsed as Record<string, unknown>).type !== "assistant"
      )
        continue;
      const message = (parsed as Record<string, unknown>).message;
      if (message == null || typeof message !== "object") continue;
      const content = (message as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      const text = content
        .filter(
          (c): c is { type: string; text: string } =>
            c != null &&
            typeof c === "object" &&
            (c as Record<string, unknown>).type === "text" &&
            typeof (c as Record<string, unknown>).text === "string",
        )
        .map((c) => c.text)
        .join(" ")
        .trim();
      if (text) return text;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/** Prune session-title files older than the TTL. Best-effort. */
export function pruneSessions(dir: string, now = Date.now()): void {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const full = join(dir, name);
      try {
        if (now - statSync(full).mtimeMs > SESSION_TTL_MS) unlinkSync(full);
      } catch {}
    }
  } catch {}
}

/** session_id must stay filename-safe: agent payloads are untrusted. */
function safeSessionId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return /^[a-zA-Z0-9_-]{1,64}$/.test(raw) ? raw : null;
}

type HookStdin = Readable & { isTTY?: boolean };

function requiredUtf8ContinuationBytes(byte: number): number | null {
  if (byte <= 0x7f) return 0;
  if (byte >= 0xc2 && byte <= 0xdf) return 1;
  if (byte >= 0xe0 && byte <= 0xef) return 2;
  if (byte >= 0xf0 && byte <= 0xf4) return 3;
  return null;
}

function completeUtf8PrefixLength(prefix: Buffer): number {
  let leadIndex = prefix.length - 1;
  while (leadIndex >= 0 && (prefix[leadIndex] & 0b1100_0000) === 0b1000_0000) {
    leadIndex -= 1;
  }

  if (leadIndex < 0) return prefix.length;

  const requiredContinuations = requiredUtf8ContinuationBytes(
    prefix[leadIndex],
  );
  const actualContinuations = prefix.length - leadIndex - 1;
  if (
    requiredContinuations !== null &&
    actualContinuations < requiredContinuations
  ) {
    return leadIndex;
  }
  return prefix.length;
}

/**
 * Map a hook phase + tool to the sprite state we want.
 * Mirrors the matchers in agents.ts so the hook command is a single
 * `petdex bubble` invocation that sets BOTH state AND bubble.
 */
export function stateForEvent(
  args: string[],
  toolName: string | null,
): string | null {
  const phase = args[0];
  if (phase === "pre") {
    if (toolName) {
      const lower = toolName.toLowerCase();
      // Read-only tools → review state. Matches the Claude Code
      // matcher in agents.ts (Read|Grep|Glob → review).
      if (lower === "read" || lower === "grep" || lower === "glob") {
        return "review";
      }
    }
    return "running";
  }
  if (phase === "post") return "idle";
  if (phase === "tool-failure") return "failed";
  if (phase === "stop" || phase === "session-end") return "waving";
  if (phase === "user-prompt" || phase === "session-start") return "jumping";
  if (phase === "waiting" || phase === "notification") return "waiting";
  return null;
}

/**
 * `failed` is a duration state in the desktop app — it reverts to idle once its
 * dwell expires, and with no explicit duration that dwell is the 250ms floor
 * against a 1220ms animation. 1220 is `failed`'s durationMs in
 * src/lib/pet-states.ts.
 */
export const FAILED_DURATION_MS = 1220;

/**
 * The /state request body. Extracted and pure so it is reachable from tests:
 * built inline in runBubble it sits behind a token read and a fetch, which is
 * why nothing covered it before. One construction path, so `durationMs === 0`
 * provably renders exactly what shipped before the tool-failure phase existed.
 * Key order matches the Zig port byte for byte — JSON.stringify preserves
 * insertion order, so appending `duration` last would silently diverge.
 */
export function stateBody(
  state: string,
  durationMs: number,
  agentSource: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = { state };
  if (durationMs > 0) body.duration = durationMs;
  body.agent_source = agentSource;
  return body;
}

/**
 * The /bubble request body, extracted for the same reason stateBody is: the
 * inline version sat behind a token read and a fetch, unreachable from tests.
 *
 * `session_id` is what lets the desktop keep one bubble per conversation
 * instead of one globally. It is omitted rather than sent null when absent so
 * an older desktop — and the MCP path, which has no session — keeps landing on
 * the server's single-bubble key exactly as before.
 */
export function bubbleBody(
  text: string,
  busy: boolean,
  agentSource: string | null,
  title: string | null,
  sessionId: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    text,
    busy,
    agent_source: agentSource,
  };
  if (title) body.title = title;
  if (sessionId) body.session_id = sessionId;
  return body;
}

export async function readStdin(
  input: HookStdin = process.stdin,
): Promise<string> {
  // Hooks pipe a single JSON payload. Preserve at most STDIN_CAP bytes for
  // parsing, but keep draining until EOF or an input error. Returning early
  // closes the read end of the pipe and can make a host that is still writing
  // report EPIPE. The generated agent hook timeout bounds the process itself.
  if (input.isTTY) return Promise.resolve("");
  return await new Promise((resolve) => {
    const prefix: Buffer[] = [];
    let prefixBytes = 0;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.off("end", finish);
      input.off("error", finish);
      const retained = Buffer.concat(prefix, prefixBytes);
      resolve(retained.toString("utf8", 0, completeUtf8PrefixLength(retained)));
    };

    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = STDIN_CAP - prefixBytes;
      if (remaining <= 0) return;
      const retained = Buffer.from(bytes.subarray(0, remaining));
      prefix.push(retained);
      prefixBytes += retained.length;
    };

    input.on("data", onData);
    input.on("end", finish);
    input.on("error", finish);
    input.resume();
  });
}

function parseStdin(text: string): {
  toolName: string | null;
  toolInput: unknown;
  agentSource: string | null;
  sessionId: string | null;
  prompt: string | null;
  transcriptPath: string | null;
  lastAssistantMessage: string | null;
} {
  if (!text.trim()) {
    return {
      toolName: null,
      toolInput: undefined,
      agentSource: null,
      sessionId: null,
      prompt: null,
      transcriptPath: null,
      lastAssistantMessage: null,
    };
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const toolName =
      typeof parsed.tool_name === "string" ? parsed.tool_name : null;
    const toolInput = parsed.tool_input;
    const agentSource =
      typeof parsed.agent_source === "string" ? parsed.agent_source : null;
    const sessionId = safeSessionId(parsed.session_id);
    const prompt = typeof parsed.prompt === "string" ? parsed.prompt : null;
    const transcriptPath =
      typeof parsed.transcript_path === "string"
        ? parsed.transcript_path
        : null;
    const lastAssistantMessage =
      typeof parsed.last_assistant_message === "string"
        ? parsed.last_assistant_message
        : null;
    return {
      toolName,
      toolInput,
      agentSource,
      sessionId,
      prompt,
      transcriptPath,
      lastAssistantMessage,
    };
  } catch {
    return {
      toolName: null,
      toolInput: undefined,
      agentSource: null,
      sessionId: null,
      prompt: null,
      transcriptPath: null,
      lastAssistantMessage: null,
    };
  }
}

export function eventFromArgs(
  args: string[],
  stdin: string,
): BubbleEvent | null {
  const phase = args[0];
  if (!phase) return null;

  // Session-level events don't need stdin parsing — they're pure
  // signals. Run them first so we don't bother parsing JSON for
  // events that don't carry a tool payload.
  if (phase === "stop" || phase === "session-end")
    return { kind: "session.end" };
  if (phase === "user-prompt" || phase === "session-start")
    return { kind: "session.start" };
  if (phase === "waiting" || phase === "notification")
    return { kind: "session.waiting" };

  // Handled before the generic tool path on purpose. That path substitutes the
  // literal lowercase "tool" when tool_name is missing, which would render
  // "tool failed" here against the Zig runner's "Tool failed" — a parity break.
  // The substitution stays where it is; the running/done templates depend on it.
  if (phase === "tool-failure") {
    const { toolName } = parseStdin(stdin);
    return {
      kind: "tool",
      phase: "failed",
      toolName: toolName ?? "",
      toolInput: undefined,
    };
  }

  // Tool events: "pre" → running, "post" → done
  const toolPhase: "running" | "done" | null =
    phase === "pre" ? "running" : phase === "post" ? "done" : null;
  if (!toolPhase) return null;

  const { toolName, toolInput } = parseStdin(stdin);
  if (!toolName) {
    // Without a tool name we can't render a useful bubble. The hook
    // may have been wired wrong or the agent didn't pass tool_name.
    // Fall back to a generic so we don't lose the signal entirely.
    return {
      kind: "tool",
      phase: toolPhase,
      toolName: "tool",
      toolInput: undefined,
    };
  }

  return { kind: "tool", phase: toolPhase, toolName, toolInput };
}

function readToken(): string | null {
  try {
    const raw = readFileSync(TOKEN_PATH, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

async function postJson(
  url: string,
  body: object,
  token: string,
): Promise<void> {
  // 300ms timeout: well above any localhost roundtrip, well below the
  // threshold an agent user would notice as latency.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300);
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Petdex-Update-Token": token,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // Hook server offline / aborted: stay silent. The agent must never
    // see this fail.
  } finally {
    clearTimeout(timer);
  }
}

export async function runBubble(args: string[]): Promise<void> {
  // Start consuming stdin before checking the killswitch. Hook hosts can
  // write their payload immediately after spawning us; returning before the
  // reader attaches turns that write into EPIPE/Broken pipe.
  const stdinPromise = readStdin();
  if (existsSync(KILLSWITCH_PATH)) {
    await stdinPromise;
    return;
  }

  // The agentSource is also passed as the second arg
  // (`petdex bubble pre claude-code`) so we know it without parsing
  // stdin if stdin is empty (e.g. session.end events from Stop).
  const argSource = args[1] ?? null;

  const stdin = await stdinPromise;
  const event = eventFromArgs(args, stdin);
  if (!event) return;

  const phase = args[0];
  const {
    toolName,
    agentSource: stdinSource,
    sessionId,
    prompt,
    transcriptPath,
    lastAssistantMessage,
  } = parseStdin(stdin);
  const agentSource = stdinSource ?? argSource;
  if (
    sessionId &&
    prompt &&
    (phase === "user-prompt" || phase === "session-start")
  ) {
    rememberSessionTitle(SESSIONS_DIR, sessionId, prompt);
  }
  const title = sessionId ? sessionTitle(SESSIONS_DIR, sessionId) : null;
  let text = formatBubble(event);
  if (phase === "stop" || phase === "session-end") {
    // Close-of-turn preview: what the agent actually wrote beats a
    // generic "Done.". Codex ships it in the payload; Claude Code
    // needs a bounded transcript tail.
    const written =
      lastAssistantMessage ??
      (transcriptPath ? lastAssistantText(transcriptPath) : null);
    if (written) text = clipPreview(written);
    pruneSessions(SESSIONS_DIR);
  }
  const state = stateForEvent(args, toolName);

  const token = readToken();
  if (!token) return;

  // Fire both POSTs in parallel — they hit the same hook server via
  // localhost, the rate limiter shares a budget, and we don't want
  // bubble latency to dominate state latency or vice versa.
  const tasks: Promise<unknown>[] = [];
  if (text) {
    // busy: the turn is still running (prompt submitted, tools firing).
    // stop and waiting events settle it - the app renders a spinner
    // beside the text while busy.
    // tool-failure keeps the spinner: a failed tool does not end the turn, the
    // agent reacts to the error and carries on.
    const busy =
      phase === "user-prompt" ||
      phase === "session-start" ||
      phase === "pre" ||
      phase === "post" ||
      phase === "tool-failure";
    tasks.push(
      postJson(
        HOOK_SERVER_BUBBLE_URL,
        bubbleBody(text, busy, agentSource, title, sessionId),
        token,
      ),
    );
  }
  if (state) {
    const durationMs = phase === "tool-failure" ? FAILED_DURATION_MS : 0;
    tasks.push(
      postJson(
        HOOK_SERVER_STATE_URL,
        stateBody(state, durationMs, agentSource),
        token,
      ),
    );
  }
  await Promise.all(tasks);
}
