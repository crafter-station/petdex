// Petdex Discord bot. Runs the gateway connection, dispatches slash
// commands, and exposes a small HTTP server (port 8086) for webhooks
// from petdex.dev (pet-approved → post to #showcase).

import { createServer } from "node:http";

import { Client, Events, GatewayIntentBits } from "discord.js";

import { handlers } from "./commands.js";
import { handleWebhook } from "./webhook.js";

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN is not set");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] ready as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const handler = handlers[interaction.commandName];
  if (!handler) {
    await interaction.reply({
      content: `Unknown command \`${interaction.commandName}\`.`,
      ephemeral: true,
    });
    return;
  }
  try {
    await handler(interaction, client);
  } catch (err) {
    console.error("[bot] handler error", err);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({
        content: "Something went wrong handling that command.",
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: "Something went wrong handling that command.",
        ephemeral: true,
      });
    }
  }
});

await client.login(token);

// Webhook server runs in the same process so we share the client. It
// only listens locally — the petdex.dev side fires through a
// Cloudflare tunnel or fly.io edge, never directly to the bot host.
const PORT = Number(process.env.PORT ?? 8086);
createServer((req, res) => {
  void handleWebhook(req, res, client);
}).listen(PORT, () => {
  console.log(`[bot] webhook listening on :${PORT}`);
});
