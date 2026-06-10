# @petdex/discord-bot

Bot for the Petdex Community Discord. Slash commands + webhook receiver.

## Setup

```bash
cd packages/discord-bot
bun install
cp .env.example .env
# fill DISCORD_TOKEN, DISCORD_GUILD_ID, PETDEX_WEBHOOK_SECRET
bun run register   # uploads slash commands to the guild
bun run start
```

## What it does

- **Slash commands**: `/install <slug>`, `/featured`, `/leaderboard`,
  `/collection <slug>`. See `src/commands.ts`.
- **Webhook receiver** at `:8086/webhook` for events from
  petdex.dev:
  - `pet_approved` → posts to `#showcase` with embed + image OG
  - `collection_featured` → posts to `#ip-spotlight`
  - HMAC-signed with `PETDEX_WEBHOOK_SECRET`.

## Auto-roles (planned, not yet wired)

When the petdex backend grows a `discord_user_id` link on
`user_profiles`, we'll add `pet_approved` → grant `@Creator`,
`install_milestone` → grant `@Collector`. The bot already has the
`GuildMembers` intent for it.

## Local dev

```bash
# bot only (no webhook needed)
bun run dev

# expose webhook for prod testing
cloudflared tunnel --url http://localhost:8086
# then point petdex.dev/api/discord/webhook at the temp URL
```
