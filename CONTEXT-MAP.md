# Context Map

Petdex operates as five bounded contexts inside this repository.

## Contexts

- [Catalog](./CONTEXT.md#catalog): public discovery, search, taxonomy, and distribution of approved Pets.
- [Submission & Curation](./CONTEXT.md#submission--curation): submission intake, automated safety and similarity review, human moderation, pending edits, and asset licensing.
- [Creator & Collections](./CONTEXT.md#creator--collections): creator identity, attribution, claim flow, curated collections, and profile ordering.
- [Runtime & Agent Bridge](./CONTEXT.md#runtime--agent-bridge): local desktop and CLI execution, coding agent hook integration, durable session recovery, remote SSH hosts, and on-screen pet rendering.
- [Distribution & Community](./CONTEXT.md#distribution--community): sticker and theme exports, community pet requests, votes, leaderboard, feedback, notifications, email preferences, and the Built With registry.

## Relationships

- **Submission & Curation -> Catalog**: approving a Submission or Pending Edit publishes the active Pet version to Catalog and invalidates public snapshots.
- **Creator & Collections <-> Catalog**: Catalog references Creator attribution; Collections group ordered Pet slugs.
- **Catalog -> Runtime & Agent Bridge**: Runtime consumes public manifests and `petdex://<slug>` links from `https://petdex.dev` to install and activate Pets.
- **Distribution & Community -> Submission & Curation**: an approved Submission can fulfill an open Pet Request.
