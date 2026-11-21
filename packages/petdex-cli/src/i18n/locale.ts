/**
 * Locale resolution for the CLI's own output.
 *
 * The app resolves locale from the URL and the website's i18n bundle; a
 * terminal has neither, so this reads the POSIX environment instead:
 * `LC_ALL` wins over `LC_MESSAGES`, which wins over `LANG`, matching how
 * libc decides. Anything unrecognized falls back to English rather than
 * guessing.
 *
 * This is deliberately independent of the website's `src/i18n/messages/*`
 * bundle. The CLI is published as a standalone package and the root
 * tsconfig excludes `packages/`, so importing that bundle is not possible
 * — and even if it were, it would pull every UI string into the CLI bundle
 * to serve a handful of error messages.
 */

export const CLI_LOCALES = ["en", "es", "zh"] as const;
export type CliLocale = (typeof CLI_LOCALES)[number];

/** Value is `ll` or `ll_CC` (optionally `.encoding` / `@modifier`). */
function parseLocaleTag(value: string | undefined): CliLocale | null {
  if (!value) return null;
  const language = value
    .split(".")[0]
    .split("@")[0]
    .split("_")[0]
    .split("-")[0]
    .trim()
    .toLowerCase();
  if (language === "en" || language === "es" || language === "zh")
    return language;
  return null;
}

/**
 * The locale to print CLI messages in.
 *
 * `POSIX` and `C` are libc's "no locale configured" values, and a trailing
 * `UTF-8` suffix is common; neither names a language, so both fall through
 * to English.
 */
export function resolveCliLocale(
  env: NodeJS.ProcessEnv = process.env,
): CliLocale {
  return (
    parseLocaleTag(env.LC_ALL) ??
    parseLocaleTag(env.LC_MESSAGES) ??
    parseLocaleTag(env.LANG) ??
    "en"
  );
}
