// The webhook receiver is the one unauthenticated entry point in this
// package: the signature covers the raw body, so the body is read before the
// caller is trusted. These tests pin the two things that used to let an
// anonymous request hurt the process — an unbounded body, and an aborted
// upload rejecting out of handleWebhook with nobody to catch it (Bun exits on
// unhandled rejections, killing the gateway connection with it).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { type AddressInfo, connect } from "node:net";

import type { Client } from "discord.js";

const SECRET = "test-secret";

process.env.PETDEX_WEBHOOK_SECRET = SECRET;
process.env.DISCORD_GUILD_ID = "guild_a";

const { handleWebhook, findChannel, postPetApproved, postCollectionFeatured } =
  await import("./webhook.js");

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

// Enough of a Client for the paths under test: findChannel walks guilds, and
// a verified event only reaches the poster after the 202 is already written.
const client = {
  guilds: { cache: new Map() },
} as unknown as Client;

let server: ReturnType<typeof createServer>;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    void handleWebhook(req, res, client);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("handleWebhook", () => {
  it("413s a body past the ceiling before buffering it", async () => {
    const body = "x".repeat(65 * 1024);
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: { "x-petdex-signature": sign(body) },
      body,
    });
    expect(res.status).toBe(413);
    expect(await res.text()).toBe("payload too large");
  });

  it("401s a bad signature on a small body", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: { "x-petdex-signature": "deadbeef".repeat(8) },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("404s anything that is not POST /webhook", async () => {
    expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
    expect(
      (await fetch(`http://127.0.0.1:${port}/webhook`, { method: "GET" }))
        .status,
    ).toBe(404);
  });

  it("acknowledges a signed event with 202", async () => {
    const body = JSON.stringify({ event: "unknown_event_type" });
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: { "x-petdex-signature": sign(body) },
      body,
    });
    expect(res.status).toBe(202);
    await res.text();
  });

  it("survives an upload that aborts mid-body", async () => {
    // Pre-fix this rejected out of handleWebhook; the server callback awaits
    // without a catch, so Bun would take the whole process down.
    await new Promise<void>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          "POST /webhook HTTP/1.1\r\nHost: x\r\n" +
            "Content-Length: 100000\r\n" +
            "x-petdex-signature: 00\r\n\r\n" +
            "y".repeat(1000),
        );
        // Abort halfway through the declared body.
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 20);
      });
      socket.once("error", () => resolve());
    });
    await new Promise((r) => setTimeout(r, 50));
    // The server is still accepting: a clean request still works.
    const res = await fetch(`http://127.0.0.1:${port}/other`);
    expect(res.status).toBe(404);
  });
});

describe("findChannel", () => {
  it("skips guilds outside the configured scope", async () => {
    const wrong = { name: "showcase", guild: "b", isTextBased: () => true };
    const right = { name: "showcase", guild: "a", isTextBased: () => true };
    function guild(id: string, channel: unknown) {
      return {
        id,
        channels: { cache: { find: () => channel } },
      };
    }
    // guild_b comes first in cache order; without the scope filter it would
    // win and announcements would leak to the wrong server.
    const scoped = {
      guilds: {
        cache: new Map([
          ["b", guild("guild_b", wrong)],
          ["a", guild("guild_a", right)],
        ]),
      },
    } as unknown as Client;
    expect(await findChannel(scoped, "showcase")).toBe(right as never);
  });
});

// Discord renders markdown only in an embed's description and field values,
// and masked links never work in a title (discord-api-docs#6088). The escaping
// has to follow that split: an unescaped description lets a creator's
// `[click](url)` become a link under the official bot's name, while escaping a
// title only injects visible backslashes into a pet name containing `*`/`_`.
// These drive the real poster against a channel stub that captures the embed.
describe("embed escaping matches where Discord renders markdown", () => {
  function capturingClient(channelName: string) {
    const sent: Array<{
      content?: string;
      embeds: Array<Record<string, unknown>>;
      allowedMentions?: { parse: string[] };
    }> = [];
    const channel = {
      isTextBased: () => true,
      name: channelName,
      send: async (msg: {
        content?: string;
        embeds: Array<{ toJSON: () => Record<string, unknown> }>;
        allowedMentions?: { parse: string[] };
      }) => {
        sent.push({
          content: msg.content,
          embeds: msg.embeds.map((e) => e.toJSON()),
          allowedMentions: msg.allowedMentions,
        });
      },
    };
    const client = {
      guilds: {
        cache: new Map([
          [
            "guild_a",
            { id: "guild_a", channels: { cache: { find: () => channel } } },
          ],
        ]),
      },
    } as unknown as Client;
    return { client, sent };
  }

  it("keeps a markdown pet name literal in the title but escapes the description", async () => {
    const { client, sent } = capturingClient("showcase");
    await postPetApproved(client, {
      event: "pet_approved",
      pet: {
        slug: "boba",
        displayName: "Bob*a*_b_",
        description: "[click here](https://evil.example)",
        kind: "creature",
        tags: ["co*zy"],
      },
    });
    const embed = sent[0]?.embeds[0] as
      | {
          title: string;
          description: string;
          fields: Array<{ name: string; value: string }>;
        }
      | undefined;
    // Title: literal, no injected backslashes.
    expect(embed?.title).toBe("Bob*a*_b_");
    expect(embed?.title).not.toContain("\\");
    // Description: masked link neutralized — escapeMaskedLink prefixes the
    // opening bracket with a backslash, which is what breaks the link.
    expect(embed?.description).toContain("\\[click here](");
    // Field value (tags) renders markdown too.
    const tags = embed?.fields.find((f) => f.name === "tags");
    expect(tags?.value).toContain("co\\*zy");
  });

  it("escapes a featured collection's description and leaves its title literal", async () => {
    const { client, sent } = capturingClient("ip-spotlight");
    await postCollectionFeatured(client, {
      event: "collection_featured",
      collection: {
        slug: "cozy-deck",
        title: "Cozy *Deck*",
        description: "[win](https://evil.example) a pet",
      },
    });
    const embed = sent[0]?.embeds[0] as
      | { title: string; description: string }
      | undefined;
    expect(embed?.title).toBe("Cozy *Deck*");
    expect(embed?.description).toContain("\\[win](");
  });

  it("suppresses mentions when posting a featured collection", async () => {
    // The collection's title/description are owner-supplied and only
    // length-checked upstream, so a `Cozy <@everyone>` title must not be able
    // to ping. `postPetApproved` sets `allowedMentions` on its send for the
    // same reason; this poster had no guard and its producer does not exist
    // yet, so the gap would have shipped with the producer. The assertion
    // reads the payload the stub captured — the same shape the live send
    // passes to `channel.send`.
    const { client, sent } = capturingClient("ip-spotlight");
    await postCollectionFeatured(client, {
      event: "collection_featured",
      collection: {
        slug: "cozy-deck",
        title: "Cozy <@&12345> <@everyone>",
        description: "say hi @everyone",
      },
    });
    expect(
      (sent[0] as { allowedMentions?: { parse: string[] } }).allowedMentions,
    ).toEqual({ parse: [] });
  });

  it("neutralizes every masked link, not just the first on a line", async () => {
    // `escapeMarkdown(…, { maskedLink: true })` neutralizes only the FIRST
    // masked link per line: its `\[.+]\(.+\)` pattern is greedy, so on
    // "[a](u) [b](u)" it matches the whole span once. A description can hold
    // several, so a second live link under the bot's name must not survive.
    const { client, sent } = capturingClient("showcase");
    await postPetApproved(client, {
      event: "pet_approved",
      pet: {
        slug: "boba",
        displayName: "Boba",
        description:
          "[a](https://evil1.example) mid [b](https://evil2.example)",
        kind: "creature",
        tags: ["[t](https://evil3.example)"],
      },
    });
    const embed = sent[0]?.embeds[0] as
      | {
          description: string;
          fields: Array<{ name: string; value: string }>;
        }
      | undefined;
    // No unescaped `[` may remain anywhere in a region Discord renders.
    expect(embed?.description).not.toMatch(/(?<!\\)\[/);
    const tags = embed?.fields.find((f) => f.name === "tags");
    expect(tags?.value).not.toMatch(/(?<!\\)\[/);
    expect(embed?.description).toContain("\\[b](");
  });
});
