import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { GetObjectCommand } from "@aws-sdk/client-s3";

import { R2_PUBLIC_HOSTS, R2_TRUSTED_HOSTS } from "@/lib/r2-public-url";

// `publishPetPublicArtifacts` gates on the pet's stored spritesheet URL, and a
// URL stored under a legacy public host is deliberately absent from the asset
// allowlist — so checking it as stored refused the pet and it never got a
// thumbnail, preview, or sticker, even though the object was still readable.
// The fix is the one `install-script.ts` carries: rewrite before validating,
// so the value that is checked is the value that is served.
//
// This drives the real function. The R2 stub answers the source GET and each
// HEAD; when the stored `petdex-source-sha256` matches the source, all three
// artifacts are skipped and the function returns before any sharp work — the
// assertion is about which URL passes the gate, not how images are built.
//
// `r2.send` is replaced in place (an own property shadowing the prototype
// method) and restored afterward, NOT `mock.module`-ed. `mock.module` is
// process-wide and `mock.restore()` did not reliably undo it for a later file
// on Bun 1.4.2: this suite loaded before `r2.test.ts`, the stub's `r2` (a bare
// `{ send }`) reached it, and `getSignedUrl` died on
// `client.config.endpointProvider` — three failures in a file that never
// touched this stub. Patching the singleton leaves the real client, its
// `config`, and every other export intact, which is the same reason
// `asset-size-guard.test.ts` takes this route.

const legacyHost = [...R2_PUBLIC_HOSTS].find((h) => !R2_TRUSTED_HOSTS.has(h));
if (!legacyHost) {
  throw new Error(
    "no legacy public host to test with: R2_PUBLIC_HOSTS has no entry " +
      "outside R2_TRUSTED_HOSTS, so this guard has nothing to check",
  );
}

// A real (tiny) spritesheet-shaped image. The decode-dimension gate added
// after this suite was written reads metadata before anything else, so the
// stub's source has to survive `sharp(...).metadata()` — arbitrary bytes do
// not, and the gate would answer `spritesheet_unreadable` before the URL
// assertions below could run.
const SOURCE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4GKgImahoEACNonD3aGmKcAAAAASUVORK5CYII=",
  "base64",
);
const SOURCE_SHA = createHash("sha256").update(SOURCE_PNG).digest("hex");

// Mutable so a test can prove that art rendered from an older spritesheet is
// NOT skipped (the #590 staleness fix). Default: every artifact is current.
let storedSourceSha = SOURCE_SHA;

const r2mod = await import("@/lib/r2");
type R2Like = { send: (command: unknown) => Promise<unknown> };
const client = r2mod.r2 as unknown as R2Like;
const originalSend = client.send;

client.send = async (command: unknown) => {
  if (command instanceof GetObjectCommand) {
    return {
      Body: { transformToByteArray: async () => new Uint8Array(SOURCE_PNG) },
    };
  }
  return { Metadata: { "petdex-source-sha256": storedSourceSha } };
};

const { publishPetPublicArtifacts } = await import("./pet-public-artifacts");

afterAll(() => {
  client.send = originalSend;
});

describe("publishPetPublicArtifacts source gate", () => {
  test("a legacy public host passes the gate", async () => {
    const result = await publishPetPublicArtifacts({
      slug: "byte-bunny",
      spritesheetUrl: `https://${legacyHost}/pets/abc/sprite.webp`,
    });

    expect(result.failed.map((f) => f.reason)).not.toContain(
      "unsupported_source",
    );
    expect(result.ok).toBe(true);
    // Reached the publish loop: the three artifact keys were checked.
    expect(result.skipped.length).toBe(3);
  });

  test("the canonical host passes the gate", async () => {
    const result = await publishPetPublicArtifacts({
      slug: "byte-bunny",
      spritesheetUrl: "https://assets.petdex.dev/pets/abc/sprite.webp",
    });

    expect(result.failed.map((f) => f.reason)).not.toContain(
      "unsupported_source",
    );
  });

  test("a host that is not ours is still refused", async () => {
    // The rewrite only maps hosts it recognizes, so the allowlist still does
    // its job for an attacker-supplied URL — the security property the
    // reorder must not weaken.
    const result = await publishPetPublicArtifacts({
      slug: "byte-bunny",
      spritesheetUrl: "https://evil.example.com/pets/abc/sprite.webp",
    });

    expect(result.ok).toBe(false);
    expect(result.failed.map((f) => f.reason)).toContain("unsupported_source");
  });

  test("stale artifacts from an older spritesheet are not skipped (#590)", async () => {
    // Existence alone used to be the skip test, so approving new art under an
    // unchanged slug left the old preview/thumb/sticker live forever. With a
    // stored source hash that no longer matches, the artifacts must be
    // republished instead of skipped.
    storedSourceSha = "0".repeat(64);
    try {
      const result = await publishPetPublicArtifacts({
        slug: "byte-bunny",
        spritesheetUrl: "https://assets.petdex.dev/pets/abc/sprite.webp",
      });
      // The source decodes (it must, to pass the dimension gate) but is not a
      // real spritesheet, so rendering the artifacts fails — the point is that
      // the stale objects were NOT taken as a reason to skip.
      expect(result.skipped.length).toBe(0);
    } finally {
      storedSourceSha = SOURCE_SHA;
    }
  });

  test("an oversized-header spritesheet is refused with a dimension reason", async () => {
    // The real attack shape: a 972KB PNG declaring 16000x16000 (256MP) sits
    // under the 8MB byte cap AND under sharp's default ~268MP limit — sharp
    // accepts the metadata and a resize decodes ~200MB of RGBA (measured).
    // The pipeline's own ceiling is 31.6MP (4608x6864), enforced at this
    // gate before any renderer sees the bytes, so the gate is the only line
    // of defense for this shape, and the reason names the refused
    // dimensions. (Above the default limit, sharp itself rejects with
    // "exceeds pixel limit" — that path lands in spritesheet_unreadable.)
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAPoAAAD6ACAYAAABBft/eAAABD0lEQVR4nO3BMQEAAADCoPVPbQhfoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfgPoMQABcaRUcgAAAABJRU5ErkJggg==",
      "base64",
    );
    const pngSha = createHash("sha256").update(png).digest("hex");
    const originalGet = client.send;
    client.send = async (command: unknown) => {
      if (command instanceof GetObjectCommand) {
        return {
          Body: { transformToByteArray: async () => new Uint8Array(png) },
        };
      }
      return originalGet(command);
    };
    try {
      const result = await publishPetPublicArtifacts({
        slug: "byte-bunny",
        spritesheetUrl: "https://assets.petdex.dev/pets/abc/sprite.webp",
      });
      expect(result.ok).toBe(false);
      expect(result.failed[0]?.reason).toBe(
        "spritesheet_dimensions_out_of_range:16000x16000",
      );
      expect(result.published).toEqual([]);
      expect(pngSha).toHaveLength(64);
    } finally {
      client.send = originalGet;
    }
  });
});
