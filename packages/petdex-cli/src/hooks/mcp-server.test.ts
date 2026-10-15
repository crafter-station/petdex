import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI_PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));

function frame(message: unknown, newline: "\r\n" | "\n" = "\r\n"): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}${newline}${newline}${body}`;
}

function parseFrames(output: string): unknown[] {
  const frames: unknown[] = [];
  let rest = output;
  while (rest.length > 0) {
    const match = rest.match(/^Content-Length:\s*(\d+)\r\n\r\n/);
    if (!match) break;
    const length = Number.parseInt(match[1], 10);
    const bodyStart = match[0].length;
    const body = rest.slice(bodyStart, bodyStart + length);
    frames.push(JSON.parse(body));
    rest = rest.slice(bodyStart + length);
  }
  return frames;
}

function parseJsonLines(output: string): unknown[] {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runServer(input: string, beforeInputDelay = 0) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'import("./src/hooks/mcp-server.ts").then(({ runMcpServer }) => runMcpServer())',
    ],
    {
      cwd: CLI_PACKAGE_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  if (beforeInputDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, beforeInputDelay));
  }
  const beforeInputStdout = stdout;
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });
  return {
    beforeInputStdout,
    code,
    frames: parseFrames(stdout),
    stderr,
    stdout,
  };
}

describe("Petdex MCP server stdio", () => {
  test("does not write stdout before initialize", async () => {
    const initialize = frame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });

    const result = await runServer(initialize, 100);

    expect(result.beforeInputStdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.frames).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "petdex-mcp-server", version: "0.1.0" },
        },
      },
    ]);
  });

  test("returns framed tools list response", async () => {
    const initialize = frame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    const toolsList = frame({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    const result = await runServer(initialize + toolsList);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.frames).toHaveLength(2);
    expect(result.frames[1]).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          { name: "petdex_set_state" },
          { name: "petdex_show_bubble" },
          { name: "petdex_status" },
        ],
      },
    });
  });

  test("accepts LF-only client frames", async () => {
    const initialize = frame(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      },
      "\n",
    );

    const result = await runServer(initialize);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.frames[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "petdex-mcp-server" } },
    });
  });

  test("refuses a frame whose declared length is past the ceiling", async () => {
    // A framed client that declares a huge Content-Length would otherwise make
    // the server buffer up to the declaration before it can parse anything.
    // The server refuses the declaration and keeps serving, so a following
    // valid frame still gets an answer.
    const oversized = `Content-Length: 999999999\r\n\r\n`;
    const initialize = frame({
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });

    const result = await runServer(oversized + initialize);

    expect(result.code).toBe(0);
    // The first response is the refusal (id null, parse error), then the
    // initialize is answered normally.
    expect(result.frames[0]).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700 },
    });
    expect(result.frames[1]).toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      result: { serverInfo: { name: "petdex-mcp-server" } },
    });
  });

  test("refuses a JSONL line that never terminates within the ceiling", async () => {
    // No newline ever arrives and the buffer passes the ceiling: the server
    // answers with a parse error rather than growing memory without bound.
    // (One byte over the cap, so the test stays cheap.)
    const cap = 16 * 1024 * 1024;
    const blob = `{"jsonrpc":"2.0","id":1,"method":"initialize","padding":"${"x".repeat(
      cap,
    )}"}`;

    const result = await runServer(blob);

    expect(result.code).toBe(0);
    expect(result.frames[0]).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700 },
    });
  });

  test("answers a framed null body instead of crashing", async () => {
    // `JSON.parse("null")` succeeds, so a framed body of `null` used to reach
    // `handleRequest(null)`, whose rejection handler read `req.id` off null and
    // threw again — inside the handler, so the finally never ran and the
    // process died with an unhandled rejection, dropping any buffered sibling
    // frame. It must instead answer an invalid-request error and keep serving.
    const initialize = frame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    const result = await runServer(frame(null) + initialize);

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("null is not an object");
    // The refusal comes first, then the initialize is still answered.
    expect(result.frames[0]).toMatchObject({
      id: null,
      error: { code: -32600 },
    });
    expect(result.frames[1]).toMatchObject({
      id: 1,
      result: { serverInfo: { name: "petdex-mcp-server" } },
    });
  });

  test("rejects a tools/call whose name is not a string", async () => {
    const initialize = frame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    const badCall = frame({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: 123, arguments: {} },
    });

    const result = await runServer(initialize + badCall);

    expect(result.code).toBe(0);
    const call = result.frames.find((f) => (f as { id?: unknown }).id === 2) as
      | { error?: { code?: number } }
      | undefined;
    expect(call?.error?.code).toBe(-32602);
  });

  test("accepts Antigravity JSONL initialize request", async () => {
    const initialize = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "antigravity-client", version: "v1.0.0" },
        protocolVersion: "2025-11-25",
        capabilities: {
          elicitation: { form: {}, url: {} },
          roots: { listChanged: true },
        },
      },
    })}\n`;

    const child = spawn(
      process.execPath,
      [
        "-e",
        'import("./src/hooks/mcp-server.ts").then(({ runMcpServer }) => runMcpServer())',
      ],
      {
        cwd: CLI_PACKAGE_DIR,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(initialize);
    const code = await new Promise<number | null>((resolve) => {
      child.on("close", resolve);
    });

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(parseJsonLines(stdout)).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "petdex-mcp-server", version: "0.1.0" },
        },
      },
    ]);
  });
});
