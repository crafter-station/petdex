# Petdex for Herdr

This Herdr plugin mirrors normalized agent attention into the local Petdex desktop app.

It requires `bun` and `herdr` on the Herdr process PATH. Petdex must be running with hooks enabled.

Direct Petdex hooks remain the richer source for Claude, Codex, Gemini, OpenCode, Qoder, Kimi, CodeBuddy, OMP, and Hermes. The bridge defaults to agents outside that set so it does not replace tool names, approval events, failures, or assistant previews with coarse Herdr states.

## Install from GitHub

```bash
herdr plugin install crafter-station/petdex/packages/petdex-desktop-native/integrations/herdr
herdr plugin list --plugin dev.petdex.bridge --json
```

Review Herdr's trust preview before confirming the install. Use `--ref desktop-vX.Y.Z` to pin a released Petdex desktop version.

## Local development

```bash
herdr plugin link packages/petdex-desktop-native/integrations/herdr
herdr plugin list
```

Start Petdex and test the bridge:

```bash
herdr plugin action invoke test
```

To opt a directly supported agent into the bridge, create `config.json` in the plugin config directory:

```bash
herdr plugin config-dir dev.petdex.bridge
```

```json
{
  "includeAgents": ["claude", "codex", "opencode"]
}
```

When `includeAgents` is present, only those normalized names are bridged. `"*"` enables every detected agent. Without it, the bridge covers agents that do not have direct Petdex hooks. `excludeAgents` can add names to the default exclusion set.

## State mapping

| Herdr | Petdex |
| --- | --- |
| `working` | `running`, busy card |
| `blocked` | `waiting`, attention card |
| `idle` | `idle`, expiring card |
| `done` | `idle`, expiring card |
| `unknown` | ignored |

Herdr `done` means idle and not yet seen. It is not treated as verified task completion.

## Runtime behavior

Herdr starts one bridge process per status event. The plugin serializes those processes through `HERDR_PLUGIN_STATE_DIR` and queries Herdr again after taking the lock, so an older event cannot overwrite a newer live state.

The startup snapshot always publishes the aggregate state, including `idle` when Herdr has no active agents, before it restores active cards.

The aggregate includes every agent visible to Herdr. A directly hooked agent running outside Herdr is not visible to that aggregate and can briefly have its global state replaced by a bridged agent. Its next direct hook restores the richer state.

Click-to-focus targets active Herdr agent panes. If the agent was released or Herdr cannot resolve the pane, Petdex falls back to the originating application.
