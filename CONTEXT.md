# Petdex

Petdex (`https://petdex.dev`) is an open-source index and runtime ecosystem of animated pixel companions for coding agents, created by Railly Hugo at Crafter Station.

## Language

### Catalog

**Pet**:
An animated creature, object, or character with nine operational states that accompanies coding sessions and installs into supported tools.
_Avoid_: Mascot, avatar, character (for the general entity), sprite.

**Sprite Atlas**:
The animated frame sheet and state manifest that visually define a Pet at a specific version.
_Avoid_: Spritesheet, sheet, image.

**Pet Pack**:
The distributable bundle containing a Pet's Sprite Atlas, state manifest, optional sound, and declared Pet License.
_Avoid_: Zip, bundle, asset.

**Pet Kind**:
Structural classification of a Pet: `creature`, `object`, or `character`.
_Avoid_: Category, type.

**Vibe**:
Controlled aesthetic or tonal attribute describing a Pet's personality (`cozy`, `playful`, `focused`, `mystical`, `wholesome`).
_Avoid_: Mood, tag (tags are free-form; vibes are controlled vocabulary).

**Pet License**:
The creator's explicit declaration of artwork rights (`cc0`, `cc-by`, `cc-by-sa`, `cc-by-nc`, `all-rights-reserved`, or `unspecified` when never declared).
_Avoid_: Repo license (code is MIT; artwork belongs to its Creator).

### Submission & Curation

**Submission**:
A proposed Pet sent by a Creator or indexed through curation (`discover`) awaiting review before entering Catalog.
_Avoid_: Upload, draft, pet (while unapproved).

**Pending Edit**:
An owner-proposed change to an approved Pet's metadata or Sprite Atlas awaiting re-approval without mutating the live Catalog version.
_Avoid_: Revision, update, patch.

**Intake Source**:
How a Pet entered Petdex: `submit` (uploaded by its author), `discover` (indexed for an external author), or `claimed` (discovered and later claimed by its original author).
_Avoid_: Origin, import type.

### Creator & Collections

**Creator**:
A person credited as the author or maintainer of one or more Pets, identified publicly by handle.
_Avoid_: User, account, owner (owner refers only to edit permissions; a Creator can exist before signing in via `discover`).

**Collection**:
A curated, ordered grouping of Pets around a theme, franchise, or creator selection.
_Avoid_: Deck, pack, playlist, folder, list.

**Catch**:
A user's registered installation of a Pet, counted toward personal collection progress.
_Avoid_: Download, favorite.

### Runtime & Agent Bridge

**Coding Agent**:
An external AI coding tool (Claude Code, Codex, Gemini CLI, OpenCode, Hermes, Qoder, Kimi Code, CodeBuddy, OMP, DeepSeek Harness) that emits activity signals to Petdex.
_Avoid_: Provider, tool, IDE, client.

**Agent Session**:
An active or recent unit of work inside a Coding Agent with an operational status (`idle`, `running`, `needs_input`, `completed`, `failed`).
_Avoid_: Task, conversation, thread, job.

**Attention Signal**:
An event emitted by an installed hook or recovered from durable local logs indicating that an Agent Session changed state or needs human input.
_Avoid_: Webhook, ping, notification.

**Bubble**:
An ephemeral on-screen message anchored to the Pet that surfaces Agent Session context or prompts for attention.
_Avoid_: Toast, tooltip, popup, dialog.

**Remote Host**:
An external POSIX machine reachable over SSH whose Coding Agents forward Attention Signals to the local Pet.
_Avoid_: Server, node, remote agent.

### Distribution & Community

**Pet Request**:
A community proposal for a Pet not yet in Catalog, eligible for votes and fulfillment by a Submission.
_Avoid_: Idea, ticket, bounty.

**Canonical Origin**:
`https://petdex.dev` is the single canonical public origin for Petdex web pages, manifests, and syndication.
_Avoid_: `petdex.crafter.run` as a public canonical URL.
