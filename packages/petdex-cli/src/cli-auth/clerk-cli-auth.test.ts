import { describe, expect, it } from "bun:test";

import { browserOpenCommand, normalizeIssuer } from "./clerk-cli-auth.js";

describe("normalizeIssuer", () => {
  it("accepts an https issuer and strips trailing slashes", () => {
    expect(normalizeIssuer("https://clerk.petdex.dev///")).toBe(
      "https://clerk.petdex.dev",
    );
  });

  it("accepts an http issuer only on loopback", () => {
    expect(normalizeIssuer("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
    expect(normalizeIssuer("http://127.0.0.1:8787")).toBe(
      "http://127.0.0.1:8787",
    );
  });

  it("refuses a plain http issuer on a public host", () => {
    expect(() => normalizeIssuer("http://clerk.petdex.dev")).toThrow("https");
    expect(() => normalizeIssuer("http://evil.example")).toThrow("https");
  });

  it("refuses a non-http(s) scheme", () => {
    expect(() => normalizeIssuer("ftp://clerk.petdex.dev")).toThrow();
    expect(() => normalizeIssuer("not a url")).toThrow("valid URL");
  });
});

describe("browserOpenCommand", () => {
  it("uses the shell-less Windows file handler, never cmd.exe", () => {
    const { command, args } = browserOpenCommand(
      "win32",
      "https://clerk.petdex.dev/oauth/authorize?client_id=x&state=y",
    );
    expect(command).toBe("explorer.exe");
    // The URL is a single argv entry, so `&` is not a command separator.
    expect(args).toEqual([
      "https://clerk.petdex.dev/oauth/authorize?client_id=x&state=y",
    ]);
  });

  it("uses open on macOS and xdg-open elsewhere", () => {
    expect(browserOpenCommand("darwin", "https://x.test/a?b=1&c=2")).toEqual({
      command: "open",
      args: ["https://x.test/a?b=1&c=2"],
    });
    expect(browserOpenCommand("linux", "https://x.test/a?b=1&c=2")).toEqual({
      command: "xdg-open",
      args: ["https://x.test/a?b=1&c=2"],
    });
  });
});
