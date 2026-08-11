import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  inspectSpriteBuffer,
  parseMetadataBuffer,
  readEditSpriteAsset,
  validateZipBuffer,
} from "./edit-assets";

const PNG_FIXTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVR4nGP4z8DwHwwZ/v8HIwYQ6////wCgeQ3zoUQgUwAAAABJRU5ErkJggg==",
  "base64",
);
const WEBP_FIXTURE = Buffer.from(
  "UklGRmQAAABXRUJQVlA4IFgAAADwAQCdASoDAAIAAUAmJagCdAW6qZlK9VAA/th5DzX7l8P4Nf/5cgAcIzM+Gthl/eFQuO2G/+aL/7yZfaP+5v//2Dj/n3/vJl9o/7m/961OIEem+GhSkMAA",
  "base64",
);

function riffChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([
    header,
    data,
    data.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0),
  ]);
}

function animatedWebp(frameData: Buffer): Buffer {
  const chunks = [
    riffChunk("VP8X", Buffer.from([0, 0, 0, 0, 2, 0, 0, 1, 0, 0])),
    riffChunk("ANMF", frameData),
  ];
  const body = Buffer.concat([Buffer.from("WEBP", "ascii"), ...chunks]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

const VP8_PAYLOAD = Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a, 0x03, 0, 0x02, 0]);
const VALID_ANIMATED_WEBP = animatedWebp(
  Buffer.concat([Buffer.alloc(16), riffChunk("VP8 ", VP8_PAYLOAD)]),
);
const FAKE_VP8_IN_JUNK = animatedWebp(
  Buffer.concat([
    Buffer.alloc(16),
    riffChunk(
      "JUNK",
      Buffer.concat([
        Buffer.from("VP8 ", "ascii"),
        Buffer.from([VP8_PAYLOAD.length, 0, 0, 0]),
        VP8_PAYLOAD,
      ]),
    ),
  ]),
);

describe("CLI edit asset validation", () => {
  it("rejects JPEG bytes even when the sprite file is renamed to WebP", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "petdex-edit-assets-"));
    try {
      const spritePath = path.join(dir, "renamed.webp");
      await writeFile(spritePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      await expect(readEditSpriteAsset(spritePath)).rejects.toThrow(
        "valid PNG or WebP",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid metadata JSON before upload", () => {
    expect(() => parseMetadataBuffer(Buffer.from('{"broken"'))).toThrow(
      "valid JSON",
    );
  });

  it("rejects invalid ZIP data before upload", async () => {
    await expect(validateZipBuffer(Buffer.from("not a zip"))).rejects.toThrow(
      "valid archive",
    );
  });

  it("derives the sprite MIME type from a complete PNG", () => {
    expect(inspectSpriteBuffer(PNG_FIXTURE)).toMatchObject({
      format: "png",
      contentType: "image/png",
      width: 3,
      height: 2,
    });
  });

  it("accepts a complete WebP container with an image payload", () => {
    expect(inspectSpriteBuffer(WEBP_FIXTURE)).toMatchObject({
      format: "webp",
      contentType: "image/webp",
      width: 3,
      height: 2,
    });
  });

  it("accepts an animated WebP with an aligned VP8 frame subchunk", () => {
    expect(inspectSpriteBuffer(VALID_ANIMATED_WEBP)).toMatchObject({
      format: "webp",
      contentType: "image/webp",
      width: 3,
      height: 2,
    });
  });

  it("rejects a VP8 marker hidden inside a different animation subchunk", () => {
    expect(() => inspectSpriteBuffer(FAKE_VP8_IN_JUNK)).toThrow(
      "valid PNG or WebP",
    );
  });

  it("rejects header-only and truncated PNG or WebP data", () => {
    expect(() => inspectSpriteBuffer(PNG_FIXTURE.subarray(0, 33))).toThrow(
      "valid PNG or WebP",
    );
    expect(() => inspectSpriteBuffer(WEBP_FIXTURE.subarray(0, 30))).toThrow(
      "valid PNG or WebP",
    );
  });
});
