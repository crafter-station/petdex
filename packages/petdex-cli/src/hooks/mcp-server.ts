/**
 * Petdex MCP Server — stdio-based Model Context Protocol server for Antigravity.
 *
 * Antigravity connects to this via its MCP Servers panel. The agent calls
 * tools like `petdex_set_state` during its work, which POST to the petdex
 * sidecar for the desktop mascot to display.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (standard MCP transport).
 * No external MCP SDK dependency — the surface is small enough to inline.
 *
 * IMPORTANT: We MUST NOT write anything to stdout until the client sends
 * an `initialize` request. The MCP lifecycle requires the client to be the
 * first speaker. Any unsolicited stdout output (startup message, telemetry
 * notice, etc.) breaks the handshake.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const SIDECAR_URL = "http://127.0.0.1:7777";
const STATE_URL = `${SIDECAR_URL}/state`;
const BUBBLE_URL = `${SIDECAR_URL}/bubble`;
const TOKEN_PATH = path.join(homedir(), ".petdex", "runtime", "update-token");
const KILLSWITCH_PATH = path.join(
  homedir(),
  ".petdex",
  "runtime",
  "hooks-disabled",
);
const VERSION = "0.1.0";
type TransportMode = "framed" | "jsonl";
let transportMode: TransportMode = "framed";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

async function readToken(): Promise<string | null> {
  try {
    return (await readFile(TOKEN_PATH, "utf8")).trim();
  } catch {
    return null;
  }
}

async function killswitchActive(): Promise<boolean> {
  try {
    await readFile(KILLSWITCH_PATH);
    return true;
  } catch {
    return false;
  }
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number }> {
  const token = await readToken();
  if (!token) return { ok: false, status: 0 };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Petdex-Update-Token": token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

const TOOLS = [
  {
    name: "petdex_set_state",
    description:
      "Set the pet's animation state. Call this before/after tool use to reflect agent activity.",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          description:
            "Animation state: idle, running, running-left, running-right, waving, jumping, failed, review, waiting",
          enum: [
            "idle",
            "running",
            "running-left",
            "running-right",
            "waving",
            "jumping",
            "failed",
            "review",
            "waiting",
          ],
        },
        duration: {
          type: "number",
          description: "Optional duration in ms to hold this state",
        },
      },
      required: ["state"],
    },
  },
  {
    name: "petdex_show_bubble",
    description:
      "Show a speech bubble above the pet with the given text. Use to display what the agent is currently doing.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The bubble text to display (e.g. 'Reading server.ts')",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "petdex_status",
    description:
      "Check if the petdex desktop mascot is reachable. Returns connection status.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

function sendMessage(msg: JsonRpcResponse): void {
  const body = JSON.stringify(msg);
  if (transportMode === "jsonl") {
    process.stdout.write(`${body}\n`);
    return;
  }
  const encoded = new TextEncoder().encode(body);
  // MCP stdio framing: Content-Length header + empty line + JSON body
  const header = `Content-Length: ${encoded.length}\r\n\r\n`;
  process.stdout.write(header);
  process.stdout.write(body);
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  const { id, method, params } = req;

  switch (method) {
    case "initialize": {
      // MCP protocol version negotiation: return the version the client
      // requested (or a reasonable default). Per the MCP spec, protocol
      // versions are date-based (e.g. "2025-03-26"). The serverInfo
      // version is separate — it's our own package version.
      const clientVersion =
        (params?.protocolVersion as string | undefined) ?? "2025-03-26";
      sendMessage({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: clientVersion,
          capabilities: {
            tools: {
              listChanged: false,
            },
          },
          serverInfo: {
            name: "petdex-mcp-server",
            version: VERSION,
          },
        },
      });
      return;
    }

    case "tools/list": {
      sendMessage({
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS },
      });
      return;
    }

    case "tools/call": {
      const toolName = params?.name as string | undefined;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;

      if (await killswitchActive()) {
        sendMessage({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: "Petdex hooks are disabled. Run /petdex in your agent or `petdex hooks on` to re-enable.",
              },
            ],
          },
        });
        return;
      }

      switch (toolName) {
        case "petdex_set_state": {
          const state = args.state as string;
          if (!state) {
            sendMessage(
              errorResponse(id, -32602, "Missing required argument: state"),
            );
            return;
          }
          const body: Record<string, unknown> = {
            state,
            agent_source: "antigravity",
          };
          if (typeof args.duration === "number") {
            body.duration = args.duration;
          }
          const result = await postJson(STATE_URL, body);
          sendMessage({
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: result.ok
                    ? `Pet state set to "${state}"`
                    : "Sidecar unreachable — is petdex-desktop running?",
                },
              ],
            },
          });
          return;
        }

        case "petdex_show_bubble": {
          const text = args.text as string;
          if (!text) {
            sendMessage(
              errorResponse(id, -32602, "Missing required argument: text"),
            );
            return;
          }
          const result = await postJson(BUBBLE_URL, {
            text,
            agent_source: "antigravity",
          });
          sendMessage({
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: result.ok
                    ? `Bubble shown: "${text}"`
                    : "Sidecar unreachable — is petdex-desktop running?",
                },
              ],
            },
          });
          return;
        }

        case "petdex_status": {
          // Probe the live sidecar health endpoint instead of just checking
          // token presence — the token file persists across restarts and is
          // not removed on shutdown, so token presence alone is not a reliable
          // indicator of whether the desktop is currently running.
          let reachable = false;
          try {
            const res = await fetch(`${SIDECAR_URL}/health`, {
              signal: AbortSignal.timeout(500),
            });
            reachable = res.ok;
          } catch {
            reachable = false;
          }
          sendMessage({
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: reachable
                    ? "Petdex desktop is reachable."
                    : "Petdex desktop not detected. Start it with `petdex up`.",
                },
              ],
            },
          });
          return;
        }

        default: {
          sendMessage(errorResponse(id, -32601, `Unknown tool: ${toolName}`));
          return;
        }
      }
    }

    case "notifications/initialized": {
      return;
    }

    default: {
      sendMessage(errorResponse(id, -32601, `Unknown method: ${method}`));
    }
  }
}

export async function runMcpServer(): Promise<void> {
  let buffer = new Uint8Array(0);
  let pending = 0;
  let draining = false;
  const decoder = new TextDecoder();

  function exitWhenDrained() {
    if (pending === 0) process.exit(0);
  }

  process.stdin.on("data", (chunk: Uint8Array | string) => {
    const raw =
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    // Append to buffer
    const newBuf = new Uint8Array(buffer.length + raw.length);
    newBuf.set(buffer);
    newBuf.set(raw, buffer.length);
    buffer = newBuf;

    while (true) {
      const firstByte = firstNonWhitespaceByte(buffer);
      if (firstByte === 0x7b || firstByte === 0x5b) {
        const lineEnd = findSequence(buffer, new Uint8Array([0x0a]));
        if (lineEnd === -1) break;
        const lineBytes = trimTrailingCarriageReturn(buffer.slice(0, lineEnd));
        buffer = buffer.slice(lineEnd + 1);
        const line = decoder.decode(lineBytes).trim();
        if (!line) continue;
        transportMode = "jsonl";
        dispatchRequest(line);
        continue;
      }

      const headerBoundary = findHeaderBoundary(buffer);
      const headerEnd = headerBoundary.index;
      if (headerEnd === -1) break;

      const headerSection = buffer.slice(0, headerEnd);
      const headerStr = decoder.decode(headerSection);
      const contentLengthMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        buffer = buffer.slice(headerEnd + headerBoundary.length);
        continue;
      }
      const contentLength = parseInt(contentLengthMatch[1], 10);
      const bodyStart = headerEnd + headerBoundary.length;
      const frameEnd = bodyStart + contentLength;

      if (buffer.length < frameEnd) break;

      const bodyBytes = buffer.slice(bodyStart, frameEnd);
      const bodyStr = decoder.decode(bodyBytes);
      buffer = buffer.slice(frameEnd);
      transportMode = "framed";
      dispatchRequest(bodyStr);
    }
  });

  process.stdin.on("end", () => {
    draining = true;
    exitWhenDrained();
    setTimeout(() => process.exit(0), 3000).unref();
  });

  // Do NOT write anything to stdout here.

  function dispatchRequest(bodyStr: string) {
    try {
      const req = JSON.parse(bodyStr) as JsonRpcRequest;
      pending++;
      handleRequest(req)
        .catch((err) => {
          sendMessage(
            errorResponse(
              req.id,
              -32603,
              `Internal error: ${(err as Error).message}`,
            ),
          );
        })
        .finally(() => {
          pending--;
          if (draining) exitWhenDrained();
        });
    } catch (err) {
      sendMessage({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${(err as Error).message}`,
        },
      });
    }
  }
}

/**
 * Find the first occurrence of needle (a Uint8Array) in haystack.
 * Returns the starting index, or -1 if not found.
 */
function findSequence(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function findHeaderBoundary(buffer: Uint8Array): {
  index: number;
  length: number;
} {
  const crlf = findSequence(buffer, new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]));
  if (crlf !== -1) return { index: crlf, length: 4 };
  const lf = findSequence(buffer, new Uint8Array([0x0a, 0x0a]));
  if (lf !== -1) return { index: lf, length: 2 };
  return { index: -1, length: 0 };
}

function firstNonWhitespaceByte(buffer: Uint8Array): number | null {
  for (const byte of buffer) {
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      return byte;
    }
  }
  return null;
}

function trimTrailingCarriageReturn(buffer: Uint8Array): Uint8Array {
  if (buffer.at(-1) === 0x0d) return buffer.slice(0, -1);
  return buffer;
}
