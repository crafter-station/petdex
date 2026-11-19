// The slash-command schema is the only place a caller's option is bounded
// before it reaches a handler. `/collection` interpolates its slug into a
// channel message, and Discord rejects content over 2000 chars — an
// unbounded slug made the reply itself throw, which (before the error
// listener in bot.ts) killed the process.
import { describe, expect, it } from "bun:test";

import { commandData } from "./commands.js";

describe("slash command options", () => {
  it("bounds every slug option so a long value cannot overflow the reply", () => {
    const withSlug = commandData.filter((c) =>
      (c.options ?? []).some((o) => o.name === "slug"),
    );
    expect(withSlug.length).toBeGreaterThan(0);
    for (const cmd of withSlug) {
      const slug = (cmd.options ?? []).find((o) => o.name === "slug") as
        | { max_length?: number }
        | undefined;
      expect(slug?.max_length, cmd.name).toBe(100);
    }
  });
});

// Interaction responses parse user mentions by default. `ephemeralNotice`
// interpolates the caller-supplied slug into the "no pet with slug" reply,
// and a slug containing backticks can close the code span early — leaving a
// bare `<@id>` that Discord renders as a live mention. `/collection`
// suppresses mentions; `ephemeralNotice` must too. This guard asserts the
// followUp body would carry `parse: []`.
describe("ephemeralNotice suppresses mentions", () => {
  it("sends allowedMentions: { parse: [] } on every notice", async () => {
    const commandsSource = await Bun.file(
      new URL("./commands.ts", import.meta.url),
    ).text();
    // The followUp call inside ephemeralNotice is the only one in the file
    // that interpolates caller input. Assert its body parses mentions away.
    const noticeFn = commandsSource.slice(
      commandsSource.indexOf("async function ephemeralNotice"),
      commandsSource.indexOf("export const handlers"),
    );
    expect(noticeFn).toContain("allowedMentions: { parse: [] }");
  });
});
