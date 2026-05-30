/**
 * Bubble templates: tool_name + lifecycle phase → human-readable bubble text.
 *
 * Codex-style: deterministic templates, no LLM. Hooks pass tool_name +
 * tool_input (or session event), this module renders the bubble. Zero
 * latency, zero cost, predictable across sessions.
 *
 * The key trick is the running/done split — same tool emits two
 * different strings depending on whether we're entering or leaving the
 * tool call. "Reading server.ts" while it's working, "Read server.ts"
 * once it returns. This is what makes Codex's mascot feel alive.
 */

export type BubblePhase = "running" | "done";

export type BubbleEvent =
  | { kind: "tool"; phase: BubblePhase; toolName: string; toolInput?: unknown }
  | { kind: "session.start" } // user submitted a prompt
  | { kind: "session.end" } // assistant turned mic back to user
  | { kind: "session.waiting" }; // permission/notification

/**
 * Map agent-specific tool names to a canonical kind so a single
 * template covers Claude Code's "Read", Codex's "shell read_file",
 * etc. Unknown tools fall through to the generic "Calling X" /
 * "Called X" templates.
 */
function canonicalToolKind(
  toolName: string,
):
  | "read"
  | "edit"
  | "write"
  | "bash"
  | "grep"
  | "glob"
  | "webfetch"
  | "task"
  | "unknown" {
  const lower = toolName.toLowerCase();
  if (lower === "read") return "read";
  if (lower === "edit" || lower === "multiedit") return "edit";
  if (lower === "write") return "write";
  if (lower === "bash" || lower === "shell") return "bash";
  if (lower === "grep") return "grep";
  if (lower === "glob") return "glob";
  if (lower === "webfetch" || lower === "websearch") return "webfetch";
  if (lower === "task" || lower === "agent") return "task";
  return "unknown";
}

/** Pull a string field out of an unknown tool_input shape, safely. */
function fieldFrom(input: unknown, key: string): string | null {
  if (input == null || typeof input !== "object") return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/** Truncate a path to its basename so bubbles stay short. */
function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** Truncate to N chars with ellipsis so no bubble overflows the WebView. */
function clip(text: string, max = 40): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function formatBubble(event: BubbleEvent): string {
  if (event.kind === "session.start") return "Thinking…";
  if (event.kind === "session.end") return "Done.";
  if (event.kind === "session.waiting") return "Waiting for you…";

  const { toolName, phase, toolInput } = event;
  const kind = canonicalToolKind(toolName);
  const past = phase === "done";

  switch (kind) {
    case "read": {
      const path =
        fieldFrom(toolInput, "file_path") ?? fieldFrom(toolInput, "path");
      const name = path ? clip(basename(path)) : null;
      if (name) return past ? `Read ${name}` : `Reading ${name}`;
      return past ? "Read file" : "Reading file";
    }
    case "edit":
    case "write": {
      const path =
        fieldFrom(toolInput, "file_path") ?? fieldFrom(toolInput, "path");
      const name = path ? clip(basename(path)) : null;
      if (name) return past ? `Edited ${name}` : `Editing ${name}`;
      return past ? "Edited file" : "Editing file";
    }
    case "bash": {
      const cmd = fieldFrom(toolInput, "command");
      if (cmd) {
        const head = clip(cmd.split(/\s+/)[0] ?? cmd, 24);
        return past ? `Ran ${head}` : `Running ${head}`;
      }
      return past ? "Ran command" : "Running command";
    }
    case "grep": {
      const pattern = fieldFrom(toolInput, "pattern");
      if (pattern) {
        return past
          ? `Searched "${clip(pattern, 28)}"`
          : `Searching "${clip(pattern, 28)}"`;
      }
      return past ? "Searched files" : "Searching files";
    }
    case "glob": {
      const pattern = fieldFrom(toolInput, "pattern");
      if (pattern) {
        return past
          ? `Listed ${clip(pattern, 28)}`
          : `Listing ${clip(pattern, 28)}`;
      }
      return past ? "Listed files" : "Listing files";
    }
    case "webfetch": {
      const url = fieldFrom(toolInput, "url");
      if (url) {
        try {
          const host = new URL(url).hostname;
          return past
            ? `Fetched ${clip(host, 28)}`
            : `Fetching ${clip(host, 28)}`;
        } catch {}
      }
      return past ? "Fetched web" : "Searching web";
    }
    case "task": {
      const desc =
        fieldFrom(toolInput, "description") ?? fieldFrom(toolInput, "subject");
      if (desc) return past ? `Subagent done` : `Spawning ${clip(desc, 28)}`;
      return past ? "Subagent done" : "Spawning subagent";
    }
    default: {
      // Generic fallback for MCP tools, custom tools, etc. Use the raw
      // tool name so the user can still tell what's happening.
      const name = clip(toolName, 28);
      return past ? `Called ${name}` : `Calling ${name}`;
    }
  }
}
