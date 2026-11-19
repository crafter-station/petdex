import { describe, expect, it } from "bun:test";

import JSZip from "jszip";

import {
  assertZipEntriesWithinLimits,
  MAX_ZIP_ENTRIES,
  readZipEntryBuffer,
  zipEntryUncompressedSize,
} from "./zip-guard";

async function makeZip(build: (zip: JSZip) => void): Promise<JSZip> {
  const zip = new JSZip();
  build(zip);
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  return JSZip.loadAsync(buffer);
}

describe("assertZipEntriesWithinLimits", () => {
  it("accepts a normal pet bundle", async () => {
    const zip = await makeZip((z) => {
      z.file("pet.json", "{}");
      z.file("spritesheet.webp", Buffer.alloc(64));
    });
    expect(() => assertZipEntriesWithinLimits(zip)).not.toThrow();
  });

  it("rejects an archive with too many entries", async () => {
    const zip = await makeZip((z) => {
      for (let i = 0; i <= MAX_ZIP_ENTRIES; i++) z.file(`file-${i}.txt`, "x");
    });
    expect(() => assertZipEntriesWithinLimits(zip)).toThrow("maximum is 80");
  });

  it("rejects a zip bomb whose entry declares more than the ceiling", async () => {
    // 40 MB of zeros compresses to a few KB, but the entry's declared
    // uncompressed size is 40 MB — over MAX_ZIP_ENTRY_BYTES.
    const zip = await makeZip((z) => {
      z.file("bomb.bin", Buffer.alloc(40 * 1024 * 1024));
    });
    expect(() => assertZipEntriesWithinLimits(zip)).toThrow("maximum is");
  });
});

describe("readZipEntryBuffer", () => {
  it("reads an entry under the ceiling", async () => {
    const zip = await makeZip((z) => {
      z.file("pet.json", '{"id":"boba"}');
    });
    const buffer = await readZipEntryBuffer(
      zip.file("pet.json") as JSZip.JSZipObject,
      1024,
      "pet.json",
    );
    expect(buffer.toString("utf8")).toBe('{"id":"boba"}');
  });

  it("aborts the inflate once the real bytes exceed the ceiling", async () => {
    const zip = await makeZip((z) => {
      z.file("big.txt", "y".repeat(200_000));
    });
    await expect(
      readZipEntryBuffer(
        zip.file("big.txt") as JSZip.JSZipObject,
        1024,
        "big.txt",
      ),
    ).rejects.toThrow("exceeds 1024 bytes uncompressed");
  });

  it("reports the declared uncompressed size", async () => {
    const zip = await makeZip((z) => {
      z.file("pet.json", "abc");
    });
    expect(
      zipEntryUncompressedSize(zip.file("pet.json") as JSZip.JSZipObject),
    ).toBe(3);
  });
});
