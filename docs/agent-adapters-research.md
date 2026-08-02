# Agent adapter research: OpenClaw, Kimi Code, CodeBuddy, OMP

Research for #289, #290, #291 and #559. No adapter code shipped yet; this
decides which are worth building and in what order.

Everything below was verified against upstream docs and live registries on
2026-08-02. Claims that could not be sourced are marked as such.

## Verdicts

| Issue | Agent | Verdict | Failure event | Config format |
| --- | --- | --- | --- | --- |
| #290 | Kimi Code | Build it | `PostToolUseFailure`, distinct | TOML |
| #291 | CodeBuddy | Build it | field on `PostToolUse` | JSON |
| #559 | OMP | Build it | `isError` on `tool_result` | TS extension |
| #289 | OpenClaw | Decline | none | JSON |

Three of the four are viable. OpenClaw is not, for a structural reason
rather than a missing feature.

## Why OpenClaw does not fit

OpenClaw is real and very much alive (github.com/openclaw/openclaw, pushed
the same day this was written). It has a hook system, JSON config at
`~/.openclaw/openclaw.json`, and four discovery roots.

The problem is what its events describe. The documented set covers
commands, sessions, the gateway lifecycle, and messages:
`command:new`, `session:compact:before`, `gateway:startup`,
`message:received`, and so on. There is no tool-level event anywhere in it.
No tool name appears in any payload, and nothing fires when a tool
succeeds or fails.

Petdex's entire model is tool-driven. `PreToolUse` gives `running` and
`review`, `PostToolUse` gives `idle`, a failure gives `failed`. Without
tool events we could drive `jumping` on a new command and `waving` on
shutdown, and the pet would sit idle through all the work in between.

There is a second reason worth stating plainly: OpenClaw is a gateway that
orchestrates Claude Code, Codex and OpenCode as backends. It is not a peer
to them. A user running OpenClaw is already running one of the agents
Petdex supports, and the pet already reacts to that agent directly.
Integrating the orchestrator would double-count the same work.

## The three that work

### Kimi Code (#290)

The closest to what Petdex already knows how to do.

- Config: `~/.kimi-code/config.toml`, overridable with `KIMI_CODE_HOME`
- Hooks: a `[[hooks]]` array inside `config.toml`, with `event`,
  `matcher`, `command`, `timeout`
- Events include `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
  `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Notification`
- Payload arrives as JSON on stdin with `hook_event_name`, `session_id`,
  `cwd`, `tool_name`, `tool_input`

`PostToolUseFailure` is a distinct event, exactly like Qoder's, so the
`failed` sprite row lights up for free.

Two things to encode. There is a deprecated predecessor, `kimi-cli`, whose
config lives at `~/.kimi/config.toml`; build against the new root and treat
the old one as a legacy fallback at most. And `UserPromptSubmit` delivers
`prompt` as a `ContentPart[]` array rather than a string
(MoonshotAI/kimi-code#917), so the text has to be joined out of it. The
docs are misleading on that point.

### CodeBuddy (#291)

Tencent's CLI, derived from Claude Code rather than compatible with it.

- Config: `~/.codebuddy/settings.json`, plus project and project-local
  variants
- Hooks: `hooks.<EventName>` with matcher and command arrays, the same
  shape as Claude's
- Core events overlap Claude almost exactly: `PreToolUse`, `PostToolUse`,
  `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`,
  `SessionEnd`, `Notification`, `PreCompact`
- Payload carries `session_id`, `transcript_path`, `cwd`,
  `permission_mode`, `hook_event_name`, plus `tool_name` and `tool_input`

It recognizes `${CLAUDE_PLUGIN_ROOT}` and reads `.claude-plugin/` for
plugin interop, but it does not read Claude's `settings.json`, so pointing
the existing adapter at a different directory is not enough.

Failure detection is the weak spot: there is no distinct failure event, so
it has to be inferred from the `tool_response` field on `PostToolUse`.

It also declares 27+ events, but only the core set has documented payload
schemas. Wire against the core and leave the rest alone.

### OMP (#559)

The most interesting of the three, and the most different.

OMP has no shell-command-per-event mechanism. Its docs call the legacy hook
subsystem legacy and point at an extension API instead: an in-process
TypeScript module that default-exports `(pi: ExtensionAPI) => void`. So
this adapter is a TS extension we ship, not a config file we edit.

- Events: `session_start`, `input`, `tool_call`, `tool_result`,
  `tool_approval_requested`, `tool_approval_resolved`, `agent_end`,
  `session_shutdown`, all confirmed against `docs/extensions.md`
- `tool_result` carries `isError`, set true on failure before the error is
  rethrown, which is our `failed` row
- `pi.registerCommand` exists and is documented, so the `/petdex` command
  the issue asks for is achievable

Config discovery is the hard part and cannot assume one path. Three
variables stack: `PI_CODING_AGENT_DIR` relocates the whole agent base, the
default is `~/.omp/agent/`, named profiles live at
`~/.omp/profiles/<name>/agent/`, and there is a project-local
`<project>/.omp/settings.json`.

A third-party bridge exists (ZeR020/omp-hooks) that reimplements Claude's
`settings.json` hooks on top of OMP events. We do not need it, and its own
README says to write a native extension when you only target OMP.

Before writing the payload parser, pull
`src/extensibility/extensions/types.ts` and `docs/extension-loading.md`
from the repo. The markdown docs describe behavior rather than exhaustive
field lists, and guessing field names is how this goes wrong.

## The blocker that comes first

None of these can ship until the icon registry has room.

`src/runtime/canvas_limits.zig:105` in the SDK sets
`max_registered_canvas_images = 16`, and slots are runtime-wide. Petdex
already uses 1 for the spritesheet, 9/10/11/15/16 for agent icons, 13 for
the avatar and 14 for the bubble tail. Slot 16 went to Qoder in #629, so
a sixth agent has nowhere to put its icon.

Three ways out:

1. Atlas the agent icons into one image, indexed by x-offset, the way
   `thumb_atlas_id` already packs pet thumbnails. Frees four slots
   immediately and scales to any number of agents. Icons are 40px, so
   even sixteen of them make a 640x40 strip, far inside the 512x512 and
   1MB per-image ceilings.
2. Raise the cap in the SDK. We own that fork and just merged into it, so
   it is available, but it is a runtime-wide limit and this is a
   Petdex-specific packing problem.
3. Register only the agents actually installed. Most machines have one or
   two. Correct in spirit, but it adds churn to a path that runs once and
   still breaks for someone with six agents installed.

Option 1 is the one to take. It is local to Petdex, follows a pattern
already in the file, and removes the ceiling rather than raising it.

## Cost

Measured against Qoder (`b8f274b`, PR #629), the most recent adapter:
13 files, +730/-28. Of the 448 lines in `agent_hooks.zig`, 121 mention
Qoder. So roughly 180 lines are plumbing and the rest was understanding
the agent.

That ratio matters for scoping. The mechanical part is small and the
compiler enforces it: `AgentKind` is an exhaustive enum with six switches
over it, so a missing case is a build error rather than a silent gap. The
expensive part is the reverse engineering, and this document is most of
it.

Kimi and CodeBuddy should land close to the Qoder number. OMP will cost
more, because it is a TypeScript extension rather than a config edit and
the config discovery has three variables.

## Order

1. Atlas the agent icons. Blocks everything else.
2. Kimi Code. Closest to the existing pattern, distinct failure event.
3. CodeBuddy. Same shape, minus clean failure detection.
4. OMP. Different mechanism, needs the type files read first.
5. Close #289 with the reason above.
