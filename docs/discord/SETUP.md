# Petdex Community Discord setup

End-to-end checklist. Total time: ~10 min once you have the bot token.

## 1. Get the bot token

1. https://discord.com/developers/applications/1501142945909440592/bot
2. Click **Reset Token** (or **View Token** if you've made one before).
3. Copy the token (looks like `MTEx...:G...:H...`). **Don't share it
   publicly** (different from the public Application ID).

## 2. Invite the bot to your server

1. Create the server first if you haven't: open Discord → "+" → Create
   My Own → For me and my friends → name it "Petdex Community".
2. Open Discord Settings → Advanced → enable **Developer Mode**.
3. In the Developer Portal, go to **OAuth2 → URL Generator**.
4. Scopes: `bot`, `applications.commands`.
5. Bot permissions: `Administrator` (we'll trim these once the server
   is built. For the initial template apply we want full access).
6. Copy the generated URL, open it in your browser, pick "Petdex
   Community" from the dropdown, authorize.

## 3. Boot the MCP server

```bash
cd ~/Programming/oss/discord-mcp
cp .env.petdex.template .env.petdex
# edit .env.petdex and paste the bot token from step 1
./start-petdex.sh
```

Verify it's up:

```bash
docker logs -f discord-mcp
# expect: "Started DiscordApplication" + "Tomcat started on port 8085"
curl -sf http://localhost:8085/actuator/health || echo "not ready yet"
```

## 4. Register the MCP in Claude Code

```bash
claude mcp add discord -t http http://localhost:8085/mcp
claude mcp list
# expect to see "discord" in the list
```

## 5. Get your guild ID + put it in .env

In Discord, right-click the **Petdex Community** server icon → "Copy
Server ID". Paste it into `~/Programming/oss/discord-mcp/.env.petdex`
as `DISCORD_GUILD_ID=...`, then restart:

```bash
cd ~/Programming/oss/discord-mcp
./start-petdex.sh
```

## 6. Apply the server template

In a Claude Code session inside the petdex repo, paste the contents of
`docs/discord/apply-template.md` as a single message. Claude will read
the JSON spec and call the discord-mcp tools to create everything:
roles, categories, channels, permission overrides.

When it finishes, verify by hand in Discord that:

- Roles appear in the right order under Server Settings → Roles
- All 7 categories exist with the right channels inside
- The 🔒 STAFF category is invisible to @everyone
- @Verified can send messages, @everyone (no role) cannot

## 7. Manual followups

Things the MCP can't do. Finish these in the Discord UI:

- Server Settings → Enable Community → set rules + community updates
  channels + safety email
- Server Settings → AutoMod → enable profanity filter + mention spam
  (5+ mentions in 60s) + sus-link blocker
- Server Settings → Onboarding → set up the new-member flow:
  - Welcome screen with #welcome + #showcase + #help
  - Default channels: #general, #showcase, #wip
  - Question: "What's your role?" → checkbox grants @Creator if "I
    make pets" is picked (the bot also auto-grants when an approved
    pet lands)
- Server Settings → Overview → upload `public/brand/discord-icon.png`
  if the MCP didn't (the petdex repo has it).

## 8. Wire the webhook from petdex.dev

Once the server is up, we'll add a webhook handler at
`/api/discord/webhook` that the petdex backend hits on:

- pet_approved → bot posts to #showcase + grants @Creator
- collection_featured → bot posts to #ip-spotlight
- pet_install_milestone (3, 10, 50) → bot DMs the installer with @Collector

That's a separate task. We'll do it after the server template lands.

## 9. Add the Discord invite to the website

Last step: take the permanent invite URL from #welcome → channel
settings → "Invites" → create a non-expiring invite. Paste it into
`.env.local` as `NEXT_PUBLIC_DISCORD_INVITE_URL=https://discord.gg/...`.
The site's footer Join button reads from there.
