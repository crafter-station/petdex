import { expect, test } from "bun:test";

import { browserCommand } from "./browser-command";

const url =
  "https://clerk.petdex.dev/oauth/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcallback&state=xyz&code_challenge=c&code_challenge_method=S256";

test("win32 hands the URL to rundll32 as one argv entry, never through cmd", () => {
  const { command, args } = browserCommand(url, "win32");
  expect(command).toBe("rundll32");
  expect(args).toEqual(["url.dll,FileProtocolHandler", url]);
  expect(command).not.toBe("cmd");
  expect(args).not.toContain("/c");
  expect(args.at(-1)).toBe(url);
});

test("darwin and linux pass the URL as the only argument", () => {
  expect(browserCommand(url, "darwin")).toEqual({
    command: "open",
    args: [url],
  });
  expect(browserCommand(url, "linux")).toEqual({
    command: "xdg-open",
    args: [url],
  });
});
