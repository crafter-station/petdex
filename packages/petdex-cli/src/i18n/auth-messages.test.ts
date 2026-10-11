import { describe, expect, test } from "bun:test";

import { authMessagesByLocale } from "./auth-messages";
import { CLI_LOCALES } from "./locale";

type MessageKey = keyof ReturnType<typeof authMessagesByLocale>["en"];

const FN_KEYS: MessageKey[] = [
  "callbackTimeout",
  "tokenRequestFailed",
  "tokenRequestHttp",
  "userinfoRequestFailed",
  "userinfoRequestHttp",
];
const STRING_KEYS: MessageKey[] = ["callbackClosed"];

describe("cli auth messages", () => {
  test("every locale defines the same keys", () => {
    const reference = Object.keys(authMessagesByLocale().en).sort();
    for (const locale of CLI_LOCALES) {
      expect(Object.keys(authMessagesByLocale()[locale]).sort()).toEqual(
        reference,
      );
    }
  });

  test("no translation is left empty", () => {
    for (const locale of CLI_LOCALES) {
      const messages = authMessagesByLocale()[locale];
      for (const key of STRING_KEYS) {
        expect(messages[key].length).toBeGreaterThan(0);
      }
      for (const key of FN_KEYS) {
        const built = (messages[key] as (arg: never) => string)(1 as never);
        expect(built.length).toBeGreaterThan(0);
      }
    }
  });

  test("interpolates the value rather than dropping it", () => {
    for (const locale of CLI_LOCALES) {
      const messages = authMessagesByLocale()[locale];
      expect(messages.callbackTimeout(4200)).toContain("4200");
      expect(messages.tokenRequestHttp(503)).toContain("503");
      expect(messages.userinfoRequestHttp(500)).toContain("500");
      expect(messages.tokenRequestFailed("boom")).toContain("boom");
      expect(messages.userinfoRequestFailed("boom")).toContain("boom");
    }
  });

  test("each locale reads differently", () => {
    const sentences = CLI_LOCALES.map(
      (locale) => authMessagesByLocale()[locale].callbackClosed,
    );
    expect(new Set(sentences).size).toBe(CLI_LOCALES.length);
  });
});
