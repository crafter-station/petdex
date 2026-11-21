import { describe, expect, test } from "bun:test";

import { CLI_LOCALES, resolveCliLocale } from "./locale";

function env(values: Partial<Record<string, string>>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

describe("cli locale resolution", () => {
  test("reads a plain language tag", () => {
    expect(resolveCliLocale(env({ LANG: "zh" }))).toBe("zh");
    expect(resolveCliLocale(env({ LANG: "es" }))).toBe("es");
    expect(resolveCliLocale(env({ LANG: "en" }))).toBe("en");
  });

  test("reads the region, encoding and modifier forms", () => {
    expect(resolveCliLocale(env({ LANG: "zh_CN.UTF-8" }))).toBe("zh");
    expect(resolveCliLocale(env({ LANG: "es_MX.UTF-8@euro" }))).toBe("es");
    expect(resolveCliLocale(env({ LANG: "en_US.UTF-8" }))).toBe("en");
    expect(resolveCliLocale(env({ LANG: "zh-CN" }))).toBe("zh");
  });

  test("prefers LC_ALL, then LC_MESSAGES, then LANG", () => {
    expect(
      resolveCliLocale(
        env({
          LC_ALL: "zh_CN.UTF-8",
          LC_MESSAGES: "es_ES.UTF-8",
          LANG: "en_US",
        }),
      ),
    ).toBe("zh");
    expect(
      resolveCliLocale(env({ LC_MESSAGES: "es_ES.UTF-8", LANG: "en_US" })),
    ).toBe("es");
    expect(resolveCliLocale(env({ LANG: "zh_CN.UTF-8" }))).toBe("zh");
  });

  test("falls back to english when nothing names a language", () => {
    // POSIX and C are libc's "unset" spellings, not languages.
    expect(resolveCliLocale(env({}))).toBe("en");
    expect(resolveCliLocale(env({ LANG: "C" }))).toBe("en");
    expect(resolveCliLocale(env({ LANG: "POSIX" }))).toBe("en");
    expect(resolveCliLocale(env({ LANG: "fr_FR.UTF-8" }))).toBe("en");
    expect(resolveCliLocale(env({ LANG: "" }))).toBe("en");
  });

  test("every advertised locale resolves", () => {
    for (const locale of CLI_LOCALES) {
      expect(resolveCliLocale(env({ LANG: locale }))).toBe(locale);
    }
  });
});
