// Webhook receiver for petdex.dev events. Validates the HMAC
// signature, dispatches by `event` field, and pushes messages into
// Discord channels via the live gateway client.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  type Client,
  EmbedBuilder,
  escapeMarkdown,
  type TextChannel,
} from "discord.js";

import { plainEmbedText } from "./embed-text";

const SECRET = process.env.PETDEX_WEBHOOK_SECRET;
const PETDEX_API_BASE = process.env.PETDEX_API_BASE ?? "https://petdex.dev";
// Runtime guild scope. With it, an invite to a second guild cannot redirect
// announcements; channel lookup is confined to that guild. Without it the
// lookup walks every guild the bot is in and posts to whichever one holds the
// first channel named `showcase` — the cross-server leak this scope exists to
// prevent. `.env.example` ships the value blank, and a blank string is falsy
// here, so the filter would be skipped silently: warn instead, without
// refusing to boot (a single-guild bot that never sets it is still valid).
const GUILD_ID = process.env.DISCORD_GUILD_ID;
if (!GUILD_ID) {
  console.warn(
    "[webhook] DISCORD_GUILD_ID is unset — announcements are not scoped to a " +
      "guild and will post into whichever server holds the first #showcase.",
  );
}

// Resend-sized events are a few KB. The signature covers the raw body, so the
// body is read before the caller is trusted; without a ceiling an anonymous
// request decides how much this process buffers.
const MAX_BODY_BYTES = 64 * 1024;

type PetApprovedEvent = {
  event: "pet_approved";
  pet: {
    slug: string;
    displayName: string;
    description: string;
    kind: string;
    tags: string[];
    discordUserId?: string;
  };
};

type CollectionFeaturedEvent = {
  event: "collection_featured";
  collection: { slug: string; title: string; description: string };
};

type Event = PetApprovedEvent | CollectionFeaturedEvent;

class PayloadTooLargeError extends Error {}

// plainEmbedText moved to embed-text.ts so commands.ts can import it
// without pulling this module's load-time env reads into the test order.

async function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > maxBytes) throw new PayloadTooLargeError();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function verify(
  rawBody: string,
  signature: string | string[] | undefined,
): boolean {
  if (!SECRET || !signature || Array.isArray(signature)) return false;
  const mac = createHmac("sha256", SECRET).update(rawBody).digest("hex");
  const a = Buffer.from(mac);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function findChannel(
  client: Client,
  name: string,
): Promise<TextChannel | null> {
  // The startup warning covers the misconfiguration, but the leak itself is
  // what matters: with no scope and more than one joined guild, the lookup
  // would post into whichever server happens to hold the first channel of
  // this name. Fail closed in that shape — a single-guild bot stays valid,
  // a multi-guild bot must set DISCORD_GUILD_ID to announce at all.
  const guilds = [...client.guilds.cache.values()];
  if (!GUILD_ID && guilds.length > 1) {
    console.warn(
      "[webhook] DISCORD_GUILD_ID is unset and the bot is in " +
        `${guilds.length} guilds — refusing to pick a channel by name ` +
        "across servers.",
    );
    return null;
  }
  for (const guild of guilds) {
    if (GUILD_ID && guild.id !== GUILD_ID) continue;
    const channel = guild.channels.cache.find(
      (c) => c.isTextBased() && c.name === name,
    );
    if (channel?.isTextBased()) return channel as TextChannel;
  }
  return null;
}

export async function postPetApproved(
  client: Client,
  ev: PetApprovedEvent,
): Promise<void> {
  const channel = await findChannel(client, "showcase");
  if (!channel) {
    console.warn("[webhook] #showcase channel not found");
    return;
  }
  const mention = ev.pet.discordUserId
    ? `<@${ev.pet.discordUserId}>`
    : "a creator";
  const embed = new EmbedBuilder()
    // NOT escaped: Discord renders markdown only in an embed's description and
    // field values (discord-api-docs#6088 — "markdown support for embeds was
    // only implemented in description and fields"), and masked links never
    // work in a title. Escaping here only injected visible backslashes into
    // any name containing `*`, `_`, `` ` `` or `~`. The title's link comes
    // from setURL below, which is the only way a title can be clickable.
    .setTitle(ev.pet.displayName)
    .setURL(`${PETDEX_API_BASE}/pets/${ev.pet.slug}`)
    // Creator-supplied markdown WOULD render as links here — this is a
    // description, and a description does render markdown — in a message that
    // carries the official bot's name, so neutralize it before it goes out.
    // plainEmbedText (not bare escapeMarkdown): the library's masked-link
    // escape only catches the first `[text](url)` per line.
    .setDescription(plainEmbedText(ev.pet.description.slice(0, 200)))
    .setColor(0x5266ea)
    .setImage(`${PETDEX_API_BASE}/pets/${ev.pet.slug}/opengraph-image`)
    .addFields(
      // `kind` is a fixed vocabulary (creature|object|character) and needs no
      // escaping; the tags are free text, and a field value renders markdown.
      { name: "kind", value: ev.pet.kind, inline: true },
      {
        name: "tags",
        value:
          ev.pet.tags
            .slice(0, 4)
            .map((tag) => plainEmbedText(tag))
            .join(" · ") || "—",
        inline: true,
      },
      { name: "install", value: `\`npx petdex install ${ev.pet.slug}\`` },
    );
  await channel.send({
    content: `🎉 **${escapeMarkdown(ev.pet.displayName)}** just landed on Petdex — submitted by ${mention}.`,
    embeds: [embed],
    // Pet names are user-supplied, and mention parsing in regular messages
    // defaults to all types — a name containing `<@&role-id>` or
    // `@everyone` would ping when this lands. `parse: []` suppresses every
    // mention type; the explicit `users` list then re-allows the one
    // mention the line above constructs on purpose. The only invalid mix
    // per Discord's docs is `parse: ["users"]` together with `users`.
    allowedMentions: ev.pet.discordUserId
      ? { parse: [], users: [ev.pet.discordUserId] }
      : { parse: [] },
  });
}

export async function postCollectionFeatured(
  client: Client,
  ev: CollectionFeaturedEvent,
): Promise<void> {
  const channel = await findChannel(client, "ip-spotlight");
  if (!channel) return;
  const embed = new EmbedBuilder()
    // Title: not escaped, for the same reason as postPetApproved — a title
    // renders literally, and only markdown is at issue there.
    .setTitle(ev.collection.title)
    .setURL(`${PETDEX_API_BASE}/collections/${ev.collection.slug}`)
    // Description: escaped — a collection description is owner-supplied free
    // text and a description renders markdown, so a `[click here](evil)` would
    // otherwise become a link under the bot's name. Length only is validated
    // upstream (collection-input.ts), not markdown.
    .setDescription(plainEmbedText(ev.collection.description.slice(0, 240)))
    .setColor(0x5266ea)
    .setImage(
      `${PETDEX_API_BASE}/collections/${ev.collection.slug}/opengraph-image`,
    );
  await channel.send({
    content: "✨ New featured collection on Petdex.",
    embeds: [embed],
    // Same reasoning as postPetApproved: the embed's title and description are
    // owner-supplied, and mention suppression should never depend on the
    // renderer's treatment of embed text. `parse: []` allows no mention type
    // anywhere in the message.
    allowedMentions: { parse: [] },
  });
}

// A response is best-effort: the client may already be gone (aborted upload,
// closed socket), and writing to a dead socket throws. Never let that — or
// anything else in this handler — surface as a rejected promise, because the
// server callback in bot.ts awaits this without a catch and Bun terminates the
// whole process on an unhandled rejection.
function safeEnd(res: ServerResponse, status: number, body?: string): void {
  try {
    res.writeHead(status).end(body);
  } catch {
    /* socket already gone */
  }
}

export async function handleWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  client: Client,
): Promise<void> {
  try {
    if (req.method !== "POST" || req.url !== "/webhook") {
      safeEnd(res, 404);
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        safeEnd(res, 413, "payload too large");
        return;
      }
      // The upload aborted mid-body (ECONNRESET). The socket is unusable, so
      // there is nobody to answer — swallow it rather than reject.
      safeEnd(res, 400, "bad request");
      return;
    }

    if (!verify(raw, req.headers["x-petdex-signature"])) {
      safeEnd(res, 401, "invalid signature");
      return;
    }

    let payload: Event;
    try {
      payload = JSON.parse(raw) as Event;
    } catch {
      safeEnd(res, 400, "invalid json");
      return;
    }

    // Acknowledge fast (Discord and our own retry policy alike prefer a
    // sub-second 2xx) and process the event in the background.
    safeEnd(res, 202);

    void (async () => {
      try {
        if (payload.event === "pet_approved") {
          await postPetApproved(client, payload);
        } else if (payload.event === "collection_featured") {
          await postCollectionFeatured(client, payload);
        } else {
          console.warn("[webhook] unknown event", payload);
        }
      } catch (err) {
        console.error("[webhook] handler error", err);
      }
    })();
  } catch (err) {
    console.error("[webhook] unexpected error", err);
    safeEnd(res, 500, "internal error");
  }
}
