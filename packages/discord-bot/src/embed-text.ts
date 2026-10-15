// Creator-text hardening shared by the webhook receiver and the
// slash-command handlers. Kept out of webhook.ts: that module reads
// PETDEX_WEBHOOK_SECRET at load time, and importing it from commands.ts
// would bake an unset secret into the module cache for whichever test
// file loads first.

import { escapeMarkdown } from "discord.js";

// Discord renders markdown in an embed's description and field values, so
// creator text must not be able to form a link under the bot's name.
// `escapeMarkdown(…, { maskedLink: true })` neutralizes only the FIRST masked
// link on each line — its `\[.+]\(.+\)` pattern is greedy, so on
// `[a](u) [b](u)` it matches the whole span once and leaves `[b](u)` live
// (measured against @discordjs/formatters). After it runs, escape any `[`
// that is not already escaped, counting backslash runs so a literal `\\`
// the library itself wrote is not double-escaped. Ordinary text renders
// unchanged (`\[x]` displays as `[x]`); it just can no longer become a link.
export function plainEmbedText(text: string): string {
  const escaped = escapeMarkdown(text, { maskedLink: true });
  let out = "";
  let slashes = 0;
  for (const ch of escaped) {
    if (ch === "\\") {
      slashes += 1;
      out += ch;
      continue;
    }
    out += ch === "[" && slashes % 2 === 0 ? "\\[" : ch;
    slashes = 0;
  }
  return out;
}
