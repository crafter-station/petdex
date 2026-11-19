import { describe, expect, it } from "bun:test";

import {
  contentLengthExceeds,
  PayloadTooLargeError,
  readBodyCapped,
} from "@/lib/request-body";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("readBodyCapped", () => {
  it("returns the full text when under the cap", async () => {
    const stream = streamOf([
      new TextEncoder().encode('{"a":'),
      new TextEncoder().encode("1}"),
    ]);
    expect(await readBodyCapped(stream, 1024)).toBe('{"a":1}');
  });

  it("aborts with PayloadTooLargeError the moment a streamed body crosses the cap", async () => {
    // No content-length on this path: the ceiling has to hold while reading.
    const chunk = new Uint8Array(64 * 1024).fill(65);
    const stream = streamOf([chunk, chunk, chunk]);
    const attempt = readBodyCapped(stream, 128 * 1024);
    await expect(attempt).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("returns an empty string for a null body", async () => {
    expect(await readBodyCapped(null, 1024)).toBe("");
  });
});

describe("contentLengthExceeds", () => {
  function reqWithLength(value: string | null): Request {
    const headers = new Headers();
    if (value !== null) headers.set("content-length", value);
    return new Request("https://petdex.dev/x", { headers });
  }

  it("flags only a declared length above the cap", () => {
    expect(contentLengthExceeds(reqWithLength("2048"), 2048)).toBe(false);
    expect(contentLengthExceeds(reqWithLength("2049"), 2048)).toBe(true);
    expect(contentLengthExceeds(reqWithLength(null), 2048)).toBe(false);
  });

  it("ignores a non-numeric declaration instead of trusting it", () => {
    expect(contentLengthExceeds(reqWithLength("banana"), 2048)).toBe(false);
  });
});
