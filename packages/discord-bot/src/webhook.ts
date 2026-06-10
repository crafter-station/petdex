// Webhook receiver for petdex.dev events. Validates the HMAC
// signature, dispatches by `event` field, and pushes messages into
// Discord channels via the live gateway client.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { type Client, EmbedBuilder, type TextChannel } from "discord.js";

const SECRET = process.env.PETDEX_WEBHOOK_SECRET;
const PETDEX_API_BASE = process.env.PETDEX_API_BASE ?? "https://petdex.dev";

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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
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

async function findChannel(
  client: Client,
  name: string,
): Promise<TextChannel | null> {
  for (const guild of client.guilds.cache.values()) {
    const channel = guild.channels.cache.find(
      (c) => c.isTextBased() && c.name === name,
    );
    if (channel?.isTextBased()) return channel as TextChannel;
  }
  return null;
}

async function postPetApproved(
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
    .setTitle(ev.pet.displayName)
    .setURL(`${PETDEX_API_BASE}/pets/${ev.pet.slug}`)
    .setDescription(ev.pet.description.slice(0, 200))
    .setColor(0x5266ea)
    .setImage(`${PETDEX_API_BASE}/pets/${ev.pet.slug}/opengraph-image`)
    .addFields(
      { name: "kind", value: ev.pet.kind, inline: true },
      {
        name: "tags",
        value: ev.pet.tags.slice(0, 4).join(" · ") || "—",
        inline: true,
      },
      { name: "install", value: `\`npx petdex install ${ev.pet.slug}\`` },
    );
  await channel.send({
    content: `🎉 **${ev.pet.displayName}** just landed on Petdex — submitted by ${mention}.`,
    embeds: [embed],
  });
}

async function postCollectionFeatured(
  client: Client,
  ev: CollectionFeaturedEvent,
): Promise<void> {
  const channel = await findChannel(client, "ip-spotlight");
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setTitle(ev.collection.title)
    .setURL(`${PETDEX_API_BASE}/collections/${ev.collection.slug}`)
    .setDescription(ev.collection.description.slice(0, 240))
    .setColor(0x5266ea)
    .setImage(
      `${PETDEX_API_BASE}/collections/${ev.collection.slug}/opengraph-image`,
    );
  await channel.send({
    content: "✨ New featured collection on Petdex.",
    embeds: [embed],
  });
}

export async function handleWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  client: Client,
): Promise<void> {
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404).end();
    return;
  }

  const raw = await readBody(req);
  if (!verify(raw, req.headers["x-petdex-signature"])) {
    res.writeHead(401).end("invalid signature");
    return;
  }

  let payload: Event;
  try {
    payload = JSON.parse(raw) as Event;
  } catch {
    res.writeHead(400).end("invalid json");
    return;
  }

  // Acknowledge fast (Discord and our own retry policy alike prefer a
  // sub-second 2xx) and process the event in the background.
  res.writeHead(202).end();

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
}
