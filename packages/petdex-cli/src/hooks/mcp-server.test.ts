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
  return { beforeInputStdout, code, frames: parseFrames(stdout), stderr };
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
