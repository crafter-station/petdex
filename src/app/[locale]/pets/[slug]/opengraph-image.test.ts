import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

import { PNG } from "pngjs";

mock.module("server-only", () => ({}));
// The route module's import chain reaches the db client, which hard-fails at
// import without a connection string; nothing in these specs touches it.
process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/test";

// The OG route is the last place the sprite-decode gate was added (the
// publish, color-extract and dhash paths had it first). This suite pins the
// gate at the loader level: an 8MB-budget flat-color PNG declaring a huge
// canvas must return null without reaching the extract/resize pipeline, and
// a real atlas-sized sprite must decode. Without the metadata check the
// oversize branch would throw on the narrow crop instead of returning null —
// the assertion is on the outcome either path exposes.

const realFetch = globalThis.fetch;
const fetchCalls: string[] = [];

const REAL_W = 768;
const REAL_H = 864;

function pngBuffer(width: number, height: number): Buffer {
  const raw = PNG.sync.write({
    width,
    height,
    data: Buffer.alloc(width * height * 4, 128),
  } as never);
  return raw as Buffer;
}

beforeAll(async () => {
  const oversize = pngBuffer(8000, 8000);
  const legit = pngBuffer(REAL_W, REAL_H);
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    fetchCalls.push(url);
    const body = url.includes("oversize") ? oversize : legit;
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

async function load(url: string): Promise<string | null> {
  const { loadFirstFrameAsDataUrl } = await import(
    "@/app/[locale]/pets/[slug]/opengraph-image"
  );
  return loadFirstFrameAsDataUrl(url);
}

describe("OG sprite loader decode gate", () => {
  it("refuses a flat PNG declaring 8000x8000 (inside sharp's default ceiling)", async () => {
    const out = await load(
      "https://assets.petdex.dev/pets/oversize/sprite.webp",
    );
    expect(out).toBeNull();
  });

  it("decodes an atlas-sized sprite to a data URL", async () => {
    const out = await load("https://assets.petdex.dev/pets/boba/sprite.webp");
    expect(out).not.toBeNull();
    expect(out?.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("never fetches a URL outside the asset allowlist", async () => {
    fetchCalls.length = 0;
    await load("https://evil.example/pets/x/sprite.webp");
    expect(fetchCalls).toEqual([]);
  });
});
