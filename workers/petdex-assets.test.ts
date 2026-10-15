// The Referer check is the worker's only gate in front of the whole bucket.
// It is a hotlink gate, not access control — but as a hotlink gate it has to
// reject hosts that merely *start with* an allowed prefix, and every response
// has to carry nosniff so a mislabeled object never renders as a document on
// this origin. There was no test for any of it.
import { describe, expect, it } from "bun:test";

import worker from "./petdex-assets.js";

const objectBody = {
  body: new ReadableStream({
    start(c) {
      c.close();
    },
  }),
  httpEtag: '"etag-1"',
  writeHttpMetadata(headers: Headers) {
    headers.set("Content-Type", "image/webp");
  },
};

const env = {
  PETDEX_PETS: {
    get: async (_key: string) => objectBody,
  },
};

function get(path: string, headers: Record<string, string> = {}): Response {
  return worker.fetch(
    new Request(`https://assets.petdex.dev${path}`, { headers }),
    env,
  );
}

describe("petdex-assets referer gate", () => {
  it("rejects a missing referer", async () => {
    expect((await get("/pets/boba/sprite.webp")).status).toBe(403);
  });

  it("accepts the site itself and localhost on any port", async () => {
    expect(
      (
        await get("/pets/boba/sprite.webp", {
          Referer: "https://petdex.dev/pets/boba",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await get("/pets/boba/sprite.webp", {
          Referer: "http://localhost:3100/",
        })
      ).status,
    ).toBe(200);
  });

  it("rejects hosts that only prefix-match an allowed entry", async () => {
    // The old implementation compared with startsWith on
    // "http://localhost", so this passed it.
    expect(
      (
        await get("/pets/boba/sprite.webp", {
          Referer: "http://localhost.evil.com/",
        })
      ).status,
    ).toBe(403);
    // hostname is petdex.dev but the *userinfo* is a lie — URL parsing
    // resolves the authority to evil.com, which must not pass.
    expect(
      (
        await get("/pets/boba/sprite.webp", {
          Referer: "https://petdex.dev@evil.com/",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await get("/pets/boba/sprite.webp", {
          Referer: "https://evil.com/?x=petdex.dev/",
        })
      ).status,
    ).toBe(403);
  });

  it("rejects a malformed referer instead of throwing", async () => {
    expect(
      (await get("/pets/boba/sprite.webp", { Referer: "not a url" })).status,
    ).toBe(403);
  });
});

describe("petdex-assets response hardening", () => {
  it("serves 200s with nosniff and a sandboxing CSP", async () => {
    const res = await get("/pets/boba/sprite.webp", {
      Referer: "https://petdex.dev/",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(res.headers.get("ETag")).toBe('"etag-1"');
    // The object's own metadata still wins for content type, and the
    // immutable default still applies when the object carries none.
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("serves errors as no-store + nosniff", async () => {
    const res = await get("/pets/boba/sprite.webp");
    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("reflects CORS only for allowlisted origins", async () => {
    const allowed = await get("/pets/boba/sprite.webp", {
      Referer: "https://petdex.dev/",
      Origin: "https://petdex.dev",
    });
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://petdex.dev",
    );
    const denied = await get("/pets/boba/sprite.webp", {
      Referer: "https://petdex.dev/",
      Origin: "https://evil.com",
    });
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
