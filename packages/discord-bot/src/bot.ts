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

// discord.js constructs its client with `captureRejections: true`, so an async
// listener that rejects is re-emitted as an `error` event instead of crashing
// on the spot — but only if something is listening. With no `error` listener
// Node/Bun throws on the unhandled `error` event and the process exits, taking
// the gateway and the webhook server with it. The interaction handler below is
// async and awaits `interaction.reply` outside any try (the unknown-command
// branch, and the catch's own reply), and Discord can reject either — a token
// past its 3s window, a REST 429/5xx, or content over the 2000-char limit.
client.on(Events.Error, (err) => {
  console.error("[bot] client error", err);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
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
  } catch (err) {
    // The replies above can themselves reject (interaction token past its 3s
    // window, content over Discord's limit, a REST error). One catch above
    // them turned "the error reply failed" into a process-wide exit.
    console.error("[bot] interaction reply failed", err);
  }
});

await client.login(token);

// Webhook server runs in the same process so we share the client. It
// only listens locally — the petdex.dev side fires through a
// Cloudflare tunnel or fly.io edge, never directly to the bot host.
// Bind loopback explicitly: relying on the platform's default bind made
// the "only listens locally" comment a hope rather than a guarantee.
const PORT = Number(process.env.PORT ?? 8086);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  // Fail with a message naming the variable, not a bare RangeError from
  // .listen(NaN) that looks like an internal bug.
  throw new Error("PORT must be an integer between 1 and 65535");
}
createServer((req, res) => {
  // Belt and suspenders: handleWebhook is written not to reject, but an
  // unhandled rejection from this callback kills the whole process.
  void handleWebhook(req, res, client).catch((err) => {
    console.error("[webhook] handler error", err);
    try {
      res.writeHead(500).end("internal error");
    } catch {
      /* socket already gone */
    }
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`[bot] webhook listening on 127.0.0.1:${PORT}`);
});
