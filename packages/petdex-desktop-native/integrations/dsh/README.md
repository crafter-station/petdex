# Petdex for DeepSeek Harness

This bundled plugin mirrors normalized DeepSeek Harness Web session events into the local Petdex desktop app.

The first release supports macOS and the DSH `web` profile. Petdex must be running with hooks enabled. Installation requires `npx` and network access to the npm registry; it supplies its own pinned DSH CLI and `pnpm`, so a global `pnpm` installation is not required.

## Install from Petdex

Start DSH Web as usual:

```bash
npx @deepseek-ai/dsh web
```

Open Petdex Settings, find DeepSeek Harness under Agents, and select Install. When the command finishes, restart DSH Web manually and start or continue a task.

The installed profile is not hot-loaded. Petdex shows `Connected` only after the restarted plugin receives and forwards a real DSH event; installation by itself reports that a restart is required.

## Custom DSH home

Petdex reads the DSH Web profile from `$DSH_HOME/profiles/web` when `DSH_HOME` is present in the Petdex process environment. Otherwise it uses `~/.dsh/profiles/web`.

A Finder-launched app does not inherit variables defined only in an interactive shell. If DSH uses a custom home, make the same `DSH_HOME` available to Petdex before installing or checking the integration.

## State mapping

| DSH | Petdex |
| --- | --- |
| Turn started | `jumping`, starting card |
| Step, tool, workflow, goal, or compaction activity | `running`, busy card |
| Approval requested | `waiting`, attention card |
| Approval resolved | `running`, unless another approval remains open |
| Turn completed | `waving`, expiring card |
| Turn blocked or out of tokens | `waiting`, attention card |
| Turn failed or stopped | `failed`, expiring card |

Approvals are informational. Petdex does not approve or reject requests; it shows the orange attention state and leaves the action in DSH Web.

## Runtime behavior

Each top-level DSH session owns one Petdex task card. Subagent sessions resolve to their top-level parent, and workflow, goal, and compaction events update that parent card instead of creating separate cards.

The plugin listens only to official session lifecycle events. It forwards a strict, content-free projection containing normalized state, display text, session identifiers, sequence number, and event kind. Prompts, tool arguments, model output, and approval contents are not forwarded. Requests go only to Petdex's token-gated loopback hook server.

Events are ordered per source session. Duplicate or stale sequence numbers are ignored, replaceable progress updates may be coalesced, and intervention or final turn events remain prioritized.

Clicking the pet activates the currently running macOS default browser. It does not identify the browser or tab that owns a DSH session, navigate to a session URL, or create a new tab.

## Remove

Select Remove from the same Petdex Settings row. The command removes only `@petdex/dsh-plugin` from the DSH `web` profile. It does not modify DSH profiles, sessions, models, or other plugins.

Restart DSH Web after removal so the running process unloads the plugin.

## Troubleshooting

- If DSH is not detected, confirm that the `web` profile exists under `$DSH_HOME/profiles/web` or `~/.dsh/profiles/web`.
- If installation fails, confirm that `npx` is available to a macOS login shell and that the npm registry is reachable. Installing global `pnpm` should not be necessary.
- If Petdex still requests a restart, restart DSH Web and generate a real session event. Opening DSH Web without task activity does not complete the handshake.
- If clicking the pet activates a different browser or tab than expected, this is the current fallback behavior; exact DSH session targeting is not available.

## Local development

Run the plugin and embedded archive tests from this directory:

```bash
bun test
```

The checked-in archive under `../../src/assets` is the exact plugin bundled into the desktop binary. Tests verify that its runtime files stay in sync with this directory.
