export function getWebpDimensions(bytes: Uint8Array) {
  if (
    bytes.length < 30 ||
    readAscii(bytes, 0, 4) !== "RIFF" ||
    readAscii(bytes, 8, 12) !== "WEBP"
  ) {
    return null;
  }

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunk = readAscii(bytes, offset, offset + 4);
    const size = readUint32Le(bytes, offset + 4);
    const dataOffset = offset + 8;

    if (dataOffset + size > bytes.length) return null;

    if (chunk === "VP8X" && size >= 10) {
      return {
        width: 1 + readUint24Le(bytes, dataOffset + 4),
        height: 1 + readUint24Le(bytes, dataOffset + 7),
      };
    }

    if (chunk === "VP8L" && size >= 5 && bytes[dataOffset] === 0x2f) {
      const b1 = bytes[dataOffset + 1] ?? 0;
      const b2 = bytes[dataOffset + 2] ?? 0;
      const b3 = bytes[dataOffset + 3] ?? 0;
      const b4 = bytes[dataOffset + 4] ?? 0;
      return {
        width: 1 + (((b2 & 0x3f) << 8) | b1),
        height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
      };
    }

    if (chunk === "VP8 " && size >= 10) {
      const frameOffset = dataOffset + 3;
      if (
        bytes[frameOffset] === 0x9d &&
        bytes[frameOffset + 1] === 0x01 &&
        bytes[frameOffset + 2] === 0x2a
      ) {
        return {
          width: readUint16Le(bytes, frameOffset + 3) & 0x3fff,
          height: readUint16Le(bytes, frameOffset + 5) & 0x3fff,
        };
      }
    }

    offset = dataOffset + size + (size % 2);
  }

  return null;
}

function readAscii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.slice(start, end));
}

function readUint16Le(bytes: Uint8Array, offset: number) {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint24Le(bytes: Uint8Array, offset: number) {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16)
  );
}

function readUint32Le(bytes: Uint8Array, offset: number) {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}
