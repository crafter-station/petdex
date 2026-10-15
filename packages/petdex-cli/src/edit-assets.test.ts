import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";

import JSZip from "jszip";

import {
  inspectSpriteBuffer,
  MAX_EDIT_ASSET_BYTES,
  parseMetadataBuffer,
  readEditSpriteAsset,
  validateZipBuffer,
} from "./edit-assets";

/** A PNG with a valid IHDR and one IDAT chunk whose raw stream is `raw`. */
function png(width: number, height: number, raw: Buffer): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colorType: grayscale
  ihdr[12] = 0; // interlace: none
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([len, typed, crc]);
  };
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

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

  it("accepts a well-formed ZIP bundle", async () => {
    const zip = new JSZip();
    zip.file("pet.json", "{}");
    zip.file("spritesheet.webp", WEBP_FIXTURE);
    const buffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });
    await expect(validateZipBuffer(buffer)).resolves.toBeUndefined();
  });

  it("rejects a zip bomb before inflating it", async () => {
    // 40 MB of zeros compresses to a few KB, so the compressed file is well
    // under the 8 MB asset cap — only the declared-size check can stop it
    // before the CLI tries to hold 40 MB in memory.
    const zip = new JSZip();
    zip.file("bomb.bin", Buffer.alloc(40 * 1024 * 1024));
    const buffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });
    expect(buffer.length).toBeLessThan(MAX_EDIT_ASSET_BYTES);
    await expect(validateZipBuffer(buffer)).rejects.toThrow("maximum is");
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

  // The byte cap above bounds the COMPRESSED file, so the parser reads the
  // IHDR and the IDAT itself. Two shapes a small file can carry:
  //   - a header whose DEFLATE stream inflates far past the size it declares,
  //     where the inflate allocated the whole output before the length check
  //     ran (measured: 400 MB of output for a ~400 KB file);
  //   - a u32 height, where the row-builder allocated one array entry per row
  //     before anything checked the size (measured: a 68-byte file declaring
  //     4294967295 rows never returned).
  // Both must be refused quickly, as a malformed sprite.
  it("refuses a PNG whose IDAT inflates past its declared size", () => {
    // Declared 1x1 (2 bytes expected) but the stream inflates to 64 MB: the
    // cap must stop the inflate rather than materialize it and then reject.
    const bomb = png(1, 1, Buffer.alloc(64 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(MAX_EDIT_ASSET_BYTES);
    const before = process.memoryUsage().rss;
    expect(() => inspectSpriteBuffer(bomb)).toThrow("valid PNG or WebP");
    const grewMb = (process.memoryUsage().rss - before) / (1024 * 1024);
    // Uncapped, the inflate alone added hundreds of MB; the cap keeps it near
    // the file's own size. A generous bound still separates the two by an
    // order of magnitude, and does not depend on the allocator's exact figure.
    expect(grewMb).toBeLessThan(32);
  });

  it("refuses a PNG that declares an impossible height", () => {
    const tall = png(1, 0xffffffff, Buffer.alloc(16));
    expect(tall.length).toBeLessThan(1024);
    expect(() => inspectSpriteBuffer(tall)).toThrow("valid PNG or WebP");
  });
});
