import { readFile, stat } from "node:fs/promises";
import { inflateSync } from "node:zlib";

import JSZip from "jszip";

export const MAX_EDIT_ASSET_BYTES = 8 * 1024 * 1024;

export type SpriteFormat = "png" | "webp";

export type ValidatedSprite = {
  buffer: Buffer;
  format: SpriteFormat;
  contentType: "image/png" | "image/webp";
  width: number;
  height: number;
};

type ImageDimensions = { width: number; height: number };

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const ADAM7_PASSES = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;
const PNG_CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < PNG_CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  PNG_CRC_TABLE[index] = value >>> 0;
}

function isPngSignature(buffer: Buffer): boolean {
  return (
    buffer.length >= PNG_SIGNATURE.length &&
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  );
}

function isWebpSignature(buffer: Buffer): boolean {
  if (
    buffer.length < 16 ||
    buffer.subarray(0, 4).toString("ascii") !== "RIFF" ||
    buffer.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    return false;
  }
  const riffSize = buffer.readUInt32LE(4);
  return riffSize >= 4 && riffSize + 8 <= buffer.length;
}

function pngCrc(type: Buffer, data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of type) {
    crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  for (const byte of data) {
    crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChannels(colorType: number): number | null {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 3:
      return 1;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      return null;
  }
}

function pngBitDepthAllowed(colorType: number, bitDepth: number): boolean {
  const allowed: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  return allowed[colorType]?.includes(bitDepth) ?? false;
}

function pngPassRows(
  width: number,
  height: number,
  bitsPerPixel: number,
  interlace: number,
): number[] {
  if (interlace === 0) {
    const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
    return Array.from({ length: height }, () => rowBytes);
  }

  const rows: number[] = [];
  for (const [xStart, yStart, xStep, yStep] of ADAM7_PASSES) {
    const passWidth = width > xStart ? Math.ceil((width - xStart) / xStep) : 0;
    const passHeight =
      height > yStart ? Math.ceil((height - yStart) / yStep) : 0;
    if (passWidth === 0 || passHeight === 0) continue;
    const rowBytes = Math.ceil((passWidth * bitsPerPixel) / 8);
    for (let row = 0; row < passHeight; row += 1) rows.push(rowBytes);
  }
  return rows;
}

function parsePng(buffer: Buffer): ImageDimensions | null {
  if (!isPngSignature(buffer)) return null;

  let offset = PNG_SIGNATURE.length;
  let header: {
    width: number;
    height: number;
    bitDepth: number;
    colorType: number;
    interlace: number;
  } | null = null;
  const idat: Buffer[] = [];
  let sawIend = false;

  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) return null;
    const length = buffer.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > buffer.length) return null;
    const type = buffer.subarray(offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const actualCrc = buffer.readUInt32BE(offset + 8 + length);
    if (pngCrc(type, data) !== actualCrc) return null;

    const name = type.toString("ascii");
    if (name === "IHDR") {
      if (offset !== PNG_SIGNATURE.length || length !== 13) return null;
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
      if (data[10] !== 0 || data[11] !== 0) return null;
    } else if (!header) {
      return null;
    } else if (name === "IDAT") {
      idat.push(data);
    } else if (name === "IEND") {
      if (length !== 0) return null;
      sawIend = true;
      offset = chunkEnd;
      break;
    }
    offset = chunkEnd;
  }

  if (!sawIend || offset !== buffer.length || !header || idat.length === 0) {
    return null;
  }
  if (
    header.width === 0 ||
    header.height === 0 ||
    !pngChannels(header.colorType) ||
    !pngBitDepthAllowed(header.colorType, header.bitDepth) ||
    (header.interlace !== 0 && header.interlace !== 1)
  ) {
    return null;
  }

  const channels = pngChannels(header.colorType);
  if (channels === null) return null;
  const rows = pngPassRows(
    header.width,
    header.height,
    channels * header.bitDepth,
    header.interlace,
  );
  const expectedBytes = rows.reduce(
    (total, rowBytes) => total + rowBytes + 1,
    0,
  );
  if (expectedBytes > 128 * 1024 * 1024) return null;

  let decoded: Buffer;
  try {
    decoded = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  if (decoded.length !== expectedBytes) return null;
  let cursor = 0;
  for (const rowBytes of rows) {
    if (decoded[cursor] > 4) return null;
    cursor += rowBytes + 1;
  }
  return { width: header.width, height: header.height };
}

type RiffChunk = { type: string; data: Buffer };

function readRiffChunks(buffer: Buffer): RiffChunk[] | null {
  if (!isWebpSignature(buffer)) return null;
  const end = 8 + buffer.readUInt32LE(4);
  if (end !== buffer.length) return null;
  const chunks: RiffChunk[] = [];
  let offset = 12;
  while (offset < end) {
    if (offset + 8 > end) return null;
    const size = buffer.readUInt32LE(offset + 4);
    const dataEnd = offset + 8 + size;
    const paddedEnd = dataEnd + (size & 1);
    if (paddedEnd > end) return null;
    chunks.push({
      type: buffer.subarray(offset, offset + 4).toString("ascii"),
      data: buffer.subarray(offset + 8, dataEnd),
    });
    offset = paddedEnd;
  }
  return offset === end ? chunks : null;
}

function parseVp8(data: Buffer): ImageDimensions | null {
  if (
    data.length < 10 ||
    data[3] !== 0x9d ||
    data[4] !== 0x01 ||
    data[5] !== 0x2a
  ) {
    return null;
  }
  const width = data.readUInt16LE(6) & 0x3fff;
  const height = data.readUInt16LE(8) & 0x3fff;
  return width > 0 && height > 0 ? { width, height } : null;
}

function parseVp8l(data: Buffer): ImageDimensions | null {
  if (data.length < 5 || data[0] !== 0x2f) return null;
  const width = 1 + ((data[1] | ((data[2] & 0x3f) << 8)) >>> 0);
  const height =
    1 + (((data[2] >> 6) | (data[3] << 2) | ((data[4] & 0x0f) << 10)) >>> 0);
  return width > 0 && height > 0 ? { width, height } : null;
}

function parseAnimatedFrame(data: Buffer): boolean {
  let offset = 16;
  while (offset < data.length) {
    if (offset + 8 > data.length) return false;
    const type = data.subarray(offset, offset + 4).toString("ascii");
    const size = data.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    const paddedEnd = end + (size & 1);
    if (paddedEnd > data.length) return false;
    const payload = data.subarray(offset + 8, end);
    if (type === "VP8 " && parseVp8(payload)) return true;
    if (type === "VP8L" && parseVp8l(payload)) return true;
    offset = paddedEnd;
  }
  return false;
}

function parseWebp(buffer: Buffer): ImageDimensions | null {
  const chunks = readRiffChunks(buffer);
  if (!chunks) return null;
  const vp8x = chunks.find((chunk) => chunk.type === "VP8X");
  const vp8 = chunks.find((chunk) => chunk.type === "VP8 ");
  const vp8l = chunks.find((chunk) => chunk.type === "VP8L");

  if (!vp8x)
    return vp8 ? parseVp8(vp8.data) : vp8l ? parseVp8l(vp8l.data) : null;
  if (vp8x.data.length !== 10) return null;

  const dimensions = {
    width:
      1 + ((vp8x.data[4] | (vp8x.data[5] << 8) | (vp8x.data[6] << 16)) >>> 0),
    height:
      1 + ((vp8x.data[7] | (vp8x.data[8] << 8) | (vp8x.data[9] << 16)) >>> 0),
  };
  if (dimensions.width <= 0 || dimensions.height <= 0) return null;
  if (vp8 && parseVp8(vp8.data)) return dimensions;
  if (vp8l && parseVp8l(vp8l.data)) return dimensions;
  const anmf = chunks.find((chunk) => chunk.type === "ANMF");
  return anmf && parseAnimatedFrame(anmf.data) ? dimensions : null;
}

function parseSpriteBuffer(
  buffer: Buffer,
): (ImageDimensions & { format: SpriteFormat }) | null {
  const png = parsePng(buffer);
  if (png) return { ...png, format: "png" };
  const webp = parseWebp(buffer);
  if (webp) return { ...webp, format: "webp" };
  return null;
}

export function parseImageDims(buffer: Buffer): ImageDimensions {
  const parsed = parseSpriteBuffer(buffer);
  return parsed
    ? { width: parsed.width, height: parsed.height }
    : { width: 0, height: 0 };
}

export function inspectSpriteBuffer(buffer: Buffer): ValidatedSprite {
  const parsed = parseSpriteBuffer(buffer);
  if (!parsed) throw new Error("sprite must be a valid PNG or WebP file");

  return {
    buffer,
    format: parsed.format,
    contentType: parsed.format === "png" ? "image/png" : "image/webp",
    width: parsed.width,
    height: parsed.height,
  };
}

export function parseMetadataBuffer(buffer: Buffer): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error("metadata is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("metadata must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export async function validateZipBuffer(buffer: Buffer): Promise<void> {
  try {
    await JSZip.loadAsync(buffer, { checkCRC32: true });
  } catch {
    throw new Error("zip is not a valid archive");
  }
}

export async function readEditAsset(filePath: string): Promise<Buffer> {
  const file = await stat(filePath);
  if (!file.isFile()) throw new Error(`not a file: ${filePath}`);
  if (file.size <= 0 || file.size > MAX_EDIT_ASSET_BYTES) {
    throw new Error(
      `asset is ${(file.size / (1024 * 1024)).toFixed(1)} MB; maximum is 8 MB`,
    );
  }
  const buffer = await readFile(filePath);
  if (buffer.length <= 0 || buffer.length > MAX_EDIT_ASSET_BYTES) {
    throw new Error("asset changed while it was being read");
  }
  return buffer;
}

export async function readEditSpriteAsset(
  filePath: string,
): Promise<ValidatedSprite> {
  return inspectSpriteBuffer(await readEditAsset(filePath));
}

export async function readEditMetadataAsset(filePath: string): Promise<Buffer> {
  const buffer = await readEditAsset(filePath);
  parseMetadataBuffer(buffer);
  return buffer;
}

export async function readEditZipAsset(filePath: string): Promise<Buffer> {
  const buffer = await readEditAsset(filePath);
  await validateZipBuffer(buffer);
  return buffer;
}
