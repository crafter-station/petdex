import type { Readable } from "node:stream";

import type JSZip from "jszip";

// Client-side mirrors of the server review limits: submission-review.ts caps a
// submission zip at 80 entries and every asset at PET_ASSET_MAX_BYTES (8 MB).
// Enforcing them locally turns a doomed upload into an immediate error and,
// more importantly, keeps a zip bomb out of local memory — JSZip's
// `.async()` buffers a whole entry, and a few hundred KB of deflate can
// expand past a gigabyte.
export const MAX_ZIP_ENTRIES = 80;
export const MAX_ZIP_ENTRY_BYTES = 8 * 1024 * 1024;
// Total declared uncompressed size we are willing to hand to the inflater at
// all. Well above any real pet bundle; low enough that a dishonest archive
// cannot make us allocate for long.
export const MAX_ZIP_TOTAL_BYTES = 64 * 1024 * 1024;

type ZipEntryWithData = { _data?: { uncompressedSize?: number } };

/** The size the entry's own header claims, or null when it cannot be read. */
export function zipEntryUncompressedSize(
  entry: JSZip.JSZipObject,
): number | null {
  const size = (entry as unknown as ZipEntryWithData)._data?.uncompressedSize;
  return typeof size === "number" && Number.isFinite(size) ? size : null;
}

/**
 * Refuse an archive whose declared shape already exceeds what we will read.
 * Runs before any entry is decompressed, so the ordinary zip bomb — an honest
 * header describing a gigabyte — costs nothing but a header read.
 */
export function assertZipEntriesWithinLimits(zip: JSZip): void {
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error(
      `zip contains ${entries.length} entries; the maximum is ${MAX_ZIP_ENTRIES}`,
    );
  }
  let total = 0;
  for (const entry of entries) {
    const size = zipEntryUncompressedSize(entry);
    if (size === null) continue;
    if (size > MAX_ZIP_ENTRY_BYTES) {
      throw new Error(
        `zip entry "${entry.name}" expands to ${size} bytes; the maximum is ${MAX_ZIP_ENTRY_BYTES}`,
      );
    }
    total += size;
  }
  if (total > MAX_ZIP_TOTAL_BYTES) {
    throw new Error(
      `zip expands to ${total} bytes in total; the maximum is ${MAX_ZIP_TOTAL_BYTES}`,
    );
  }
}

/**
 * Read one entry into a Buffer, aborting the inflate as soon as it exceeds
 * `maxBytes`. The declared size is only a claim, and this bounds the bytes
 * that actually come out — the part that costs memory — so a header that
 * under-reports its size cannot get past the ceiling either.
 */
export function readZipEntryBuffer(
  entry: JSZip.JSZipObject,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const stream = entry.nodeStream("nodebuffer") as Readable;
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    stream.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        stream.destroy();
        fail(new Error(`${label} exceeds ${maxBytes} bytes uncompressed`));
        return;
      }
      chunks.push(buffer);
    });
    stream.on("error", () => fail(new Error(`${label} could not be read`)));
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });
  });
}
