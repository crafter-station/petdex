import { describe, expect, test } from "bun:test";

import { generateMcpConfig, generateSkillMd } from "./antigravity-skill";
import { PERSIST_PATH } from "./persist-binary";

describe("Antigravity MCP config", () => {
  test("uses the current Node executable instead of PATH lookup", () => {
    expect(generateMcpConfig()).toEqual({
      mcpServers: {
        petdex: {
          command: process.execPath,
          args: [PERSIST_PATH, "mcp-server"],
        },
      },
    });
  });

  test("does not document a bare node command", () => {
    const skill = generateSkillMd();
    expect(skill).toContain(process.execPath);
    expect(skill).not.toContain("node ~/.petdex/bin/petdex.js mcp-server");
  });
});
