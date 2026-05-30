/**
 * Antigravity Agent Skill generator.
 *
 * Generates a Petdex Agent Skill that tells the Antigravity agent how to
 * communicate with the petdex desktop mascot via MCP tools.
 *
 * The skill is installed to ~/.gemini/antigravity/skills/petdex/ and follows
 * the open Agent Skills format (SKILL.md + optional scripts).
 */
import { homedir } from "node:os";
import path from "node:path";

import { PERSIST_PATH } from "./persist-binary.js";

export function antigravitySkillDir(): string {
  return path.join(homedir(), ".gemini", "antigravity", "skills", "petdex");
}

/**
 * Generate the SKILL.md content for the Petdex Agent Skill.
 *
 * This skill tells the Antigravity agent to:
 * 1. Before tool use: call petdex_set_state + petdex_show_bubble
 * 2. After tool use: call petdex_set_state with "idle"
 * 3. On session end: call petdex_set_state with "waving"
 * 4. On error: call petdex_set_state with "failed"
 */
export function generateSkillMd(): string {
  return `---
name: petdex
description: >
  Coordinates with the petdex desktop mascot to reflect agent activity.
  The pet is a transparent, always-on-top companion that animates based
  on what the agent is doing. Call these MCP tools before/after every
  tool use so the pet stays in sync.
---

# Petdex Desktop Mascot

When this skill is active, call the petdex MCP tools at the points below.
**Important:** Do NOT call Petdex MCP tools around calls to Petdex MCP tools
themselves (petdex_set_state, petdex_show_bubble, petdex_status). Only
wrap non-Petdex tool calls — otherwise every state update would trigger
another update in a recursive loop.

## Before every non-Petdex tool use

Call \`petdex_set_state\` with:
  - state: "running"
  - duration: (no duration — will be updated on tool completion)

Call \`petdex_show_bubble\` with a brief description of what you're about
to do. Examples:
  - "Reading server.ts"
  - "Searching for patterns"
  - "Running git status"
  - "Editing auth middleware"
  - "Writing unit tests"

The bubble text should be short (under 40 chars) and in present tense
("Reading", "Running", "Editing" — never past tense for pre-tool calls).

## After every non-Petdex tool use

Call \`petdex_set_state\` with:
  - state: "idle"

## On session end / task completion

Call \`petdex_set_state\` with:
  - state: "waving"
  - duration: 1500

## On error

If you encounter an error mid-task (from a non-Petdex tool), call
\`petdex_set_state\` with:
  - state: "failed"
  - duration: 2500

## On waiting for user input

Call \`petdex_set_state\` with:
  - state: "waiting"

## Available MCP tools

All tools are exposed via the "petdex" MCP server (configured in
mcp_config.json):

  - \`petdex_set_state\`: Set animation state (idle, running, waving,
    jumping, failed, review, waiting)
  - \`petdex_show_bubble\`: Show a speech bubble with text
  - \`petdex_status\`: Check if the mascot is reachable

  **Do not** wrap these tools with Petdex calls. Only non-Petdex tools
  should trigger petdex_set_state / petdex_show_bubble.

## Configuration

This skill requires the petdex MCP server to be running.
Configure it in Antigravity: Agent Panel → ... → MCP Servers.
The server command is installed with the same Node.js runtime that ran
\`petdex hooks install\`: \`${process.execPath}\`

Make sure petdex-desktop is running (\`petdex up\`) for the mascot to
appear.
`;
}

/**
 * Generate the MCP config snippet to inject into Antigravity's mcp_config.json.
 */
export function generateMcpConfig(): Record<string, unknown> {
  return {
    mcpServers: {
      petdex: {
        command: process.execPath,
        args: [PERSIST_PATH, "mcp-server"],
      },
    },
  };
}
